import { randomUUID } from "node:crypto";

type Json = Record<string, unknown>;
export type Dispatch = (request: Request) => Promise<Response>;
export interface AnpClientOptions {
  allowedOrigins: string[];
  authenticatedDispatch: Dispatch;
  publicDispatch?: Dispatch;
}
interface Resource {
  url: string;
  kind: "agent" | "information" | "interface";
  protocol?: string;
}
interface Operation {
  url: string;
  method: string;
  parameters: Json[];
  hasBody: boolean;
}
export class AnpError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const requireValue = (condition: unknown, code = "invalid_document"): void => {
  if (!condition) throw new AnpError(code);
};
const object = (value: unknown): Json => {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Json;
};

/** Public references contain no signing capabilities. The Host owns the dispatcher. */
export class AnpClient {
  private readonly origins: Set<string>;
  private readonly resources = new Map<string, Resource>();
  private readonly operations = new Map<string, Operation>();
  constructor(private readonly options: AnpClientOptions) {
    this.origins = new Set(
      options.allowedOrigins.map((value) => {
        const url = new URL(value);
        requireValue(
          url.protocol === "https:" && url.origin === value,
          "invalid_origin",
        );
        return url.origin;
      }),
    );
  }
  private target(value: string, base?: string): string {
    const url = new URL(value, base);
    requireValue(
      url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.hash &&
        this.origins.has(url.origin),
      "origin_not_approved",
    );
    return url.href;
  }
  private add(resource: Resource): string {
    const entry = [...this.resources].find(
      ([, value]) => value.url === resource.url && value.kind === resource.kind,
    );
    if (entry) return entry[0];
    const ref = randomUUID();
    this.resources.set(ref, resource);
    return ref;
  }
  private async request(
    url: string,
    init: RequestInit = {},
    signed = true,
  ): Promise<{ url: string; contentType: string; content: unknown }> {
    const request = new Request(this.target(url), {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      credentials: "omit",
    });
    const response = await (
      signed
        ? this.options.authenticatedDispatch
        : (this.options.publicDispatch ?? fetch)
    )(request);
    requireValue(response.ok && !response.redirected, "http_request_failed");
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new AnpError("response_too_large");
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const contentType = response.headers.get("content-type") ?? "text/plain";
    const text = Buffer.concat(chunks).toString("utf8");
    return {
      url,
      contentType,
      content: /json/i.test(contentType) ? JSON.parse(text) : text,
    };
  }
  async discover(domain: string) {
    requireValue(
      typeof domain === "string" && !!domain && !/[/?#@\\]/.test(domain),
      "invalid_domain",
    );
    let url: string | undefined = this.target(
      `https://${domain}/.well-known/agent-descriptions`,
    );
    const visited = new Set<string>();
    const agents = new Map<
      string,
      { agentRef: string; name: string; url: string }
    >();
    while (url) {
      requireValue(
        !visited.has(url) && visited.size < 64,
        "invalid_pagination",
      );
      visited.add(url);
      const page = object((await this.request(url, {}, false)).content);
      requireValue(
        page["@type"] === "CollectionPage" && Array.isArray(page.items),
      );
      for (const value of page.items as unknown[]) {
        const item = object(value);
        requireValue(
          typeof item["@id"] === "string" && typeof item.name === "string",
        );
        const target = this.target(item["@id"] as string, url);
        agents.set(target, {
          agentRef: this.add({ url: target, kind: "agent" }),
          name: item.name as string,
          url: target,
        });
      }
      requireValue(page.next === undefined || typeof page.next === "string");
      url =
        page.next === undefined
          ? undefined
          : this.target(page.next as string, url);
    }
    return { count: agents.size, complete: true, agents: [...agents.values()] };
  }
  async describe(agentRef: string) {
    const resource = this.resources.get(agentRef);
    requireValue(resource?.kind === "agent", "unknown_agent");
    const result = await this.request(resource!.url);
    const document = object(result.content);
    requireValue(
      document.protocolType === "ANP" && document.type === "AgentDescription",
    );
    const links: {
      resourceRef: string;
      kind: string;
      description: unknown;
      protocol?: string;
    }[] = [];
    for (const [field, kind] of [
      ["Infomations", "information"],
      ["interfaces", "interface"],
    ] as const) {
      requireValue(
        document[field] === undefined || Array.isArray(document[field]),
      );
      for (const value of (document[field] as unknown[]) ?? []) {
        const link = object(value);
        if (typeof link.url !== "string") continue;
        const target = this.target(link.url, resource!.url);
        const protocol =
          typeof link.protocol === "string" ? link.protocol : undefined;
        links.push({
          resourceRef: this.add({ url: target, kind, protocol }),
          kind,
          description: link.description,
          protocol,
        });
      }
    }
    return { ...result, links };
  }
  async read(resourceRef: string) {
    const resource = this.resources.get(resourceRef);
    requireValue(resource && resource.kind !== "agent", "unknown_resource");
    const result = await this.request(resource!.url);
    const operations: {
      operationRef: string;
      operationId: string;
      method: string;
      url: string;
    }[] = [];
    if (
      resource!.kind === "interface" &&
      /openapi/i.test(resource!.protocol ?? "")
    ) {
      const spec = object(result.content);
      requireValue(
        typeof spec.openapi === "string" && spec.openapi.startsWith("3."),
      );
      const servers =
        spec.servers === undefined
          ? [{ url: new URL(resource!.url).origin }]
          : spec.servers;
      requireValue(Array.isArray(servers) && servers.length > 0);
      const base = this.target(
        String(object((servers as unknown[])[0]).url),
        resource!.url,
      ).replace(/\/$/, "");
      for (const [path, value] of Object.entries(object(spec.paths))) {
        requireValue(
          path.startsWith("/") &&
            !path.startsWith("//") &&
            !/[?#\\]/.test(path),
        );
        const item = object(value);
        requireValue(
          item.servers === undefined && item.$ref === undefined,
          "unsupported_openapi",
        );
        for (const method of [
          "get",
          "post",
          "put",
          "patch",
          "delete",
          "head",
          "options",
        ]) {
          if (item[method] === undefined) continue;
          const operation = object(item[method]);
          requireValue(
            operation.servers === undefined && operation.$ref === undefined,
            "unsupported_openapi",
          );
          const parameters = [
            ...((item.parameters as unknown[]) ?? []),
            ...((operation.parameters as unknown[]) ?? []),
          ].map(object);
          requireValue(
            parameters.every(
              (p) =>
                p.$ref === undefined &&
                ["path", "query"].includes(String(p.in)),
            ),
            "unsupported_openapi",
          );
          const operationRef = randomUUID();
          const target = this.target(base + path);
          this.operations.set(operationRef, {
            url: target,
            method: method.toUpperCase(),
            parameters,
            hasBody: operation.requestBody !== undefined,
          });
          operations.push({
            operationRef,
            operationId: String(operation.operationId ?? `${method} ${path}`),
            method: method.toUpperCase(),
            url: target,
          });
        }
      }
    }
    return { ...result, operations };
  }
  async call(
    operationRef: string,
    args: { path?: Json; query?: Json; body?: unknown } = {},
  ) {
    const operation = this.operations.get(operationRef);
    requireValue(operation, "unknown_operation");
    let target = operation!.url;
    for (const [location, supplied] of [
      ["path", args.path ?? {}],
      ["query", args.query ?? {}],
    ] as const) {
      for (const key of Object.keys(supplied))
        requireValue(
          operation!.parameters.some(
            (p) => p.in === location && p.name === key,
          ),
          "unknown_parameter",
        );
      for (const parameter of operation!.parameters.filter(
        (p) => p.in === location,
      )) {
        const value = supplied[String(parameter.name)];
        requireValue(
          value !== undefined || parameter.required !== true,
          "missing_parameter",
        );
        if (value === undefined) continue;
        requireValue(
          ["string", "number", "boolean"].includes(typeof value),
          "invalid_parameter",
        );
        if (location === "path") {
          requireValue(value !== "." && value !== "..", "invalid_parameter");
          target = target
            .replace(`{${parameter.name}}`, encodeURIComponent(String(value)))
            .replace(
              `%7B${parameter.name}%7D`,
              encodeURIComponent(String(value)),
            );
        }
      }
    }
    requireValue(!/[{}]/.test(decodeURI(target)), "missing_parameter");
    const url = new URL(target);
    for (const [key, value] of Object.entries(args.query ?? {}))
      url.searchParams.set(key, String(value));
    requireValue(
      args.body === undefined || operation!.hasBody,
      "unexpected_body",
    );
    return this.request(url.href, {
      method: operation!.method,
      ...(args.body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(args.body),
          }),
    });
  }
}
