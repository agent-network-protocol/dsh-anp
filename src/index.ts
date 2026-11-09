import { randomUUID } from "node:crypto";

type Json = Record<string, unknown>;
export type Dispatch = (request: Request) => Promise<Response>;
export interface AnpReadEvidence {
  profile: 'anp-discovered/1';
  kind: 'agent' | 'information' | 'interface' | 'operation';
  source: string;
  url: string;
  requiresApproval: boolean;
  discoveryOrigin: string;
  policyEvidence?: {hasRequestBody:boolean;security?:unknown;declaredEffect?:unknown;annotations?:unknown};
}
export interface AnpClientOptions {
  /** Exact HTTPS origins, or an explicit '*' to allow any HTTPS origin. */
  allowedOrigins: string[];
  authenticatedDispatch: (request: Request, evidence: AnpReadEvidence) => Promise<Response>;
  /** Includes time awaiting an owner decision; the Host transport separately bounds network I/O. */
  authenticatedTimeoutMs?: number;
  publicDispatch?: Dispatch;
}
interface Resource {
  discoveryOrigin: string;
  url: string;
  kind: "agent" | "information" | "interface";
  protocol?: string;
  source: string;
}
interface Operation {
  discoveryOrigin: string;
  policyEvidence: NonNullable<AnpReadEvidence['policyEvidence']>;
  url: string;
  method: string;
  parameters: Json[];
  hasBody: boolean;
  source: string;
  requiresApproval: boolean;
}
export class AnpError extends Error {
  constructor(readonly code: string, readonly requestId?: string) {
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
        if (value === "*") return value;
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
        (this.origins.has("*") || this.origins.has(url.origin)),
      "origin_not_approved",
    );
    return url.href;
  }
  private add(resource: Resource): string {
    const entry = [...this.resources].find(
      ([, value]) => value.url === resource.url && value.kind === resource.kind && value.discoveryOrigin === resource.discoveryOrigin,
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
    evidence?: Omit<AnpReadEvidence, "profile" | "url">,
  ): Promise<{ url: string; contentType: string; content: unknown }> {
    const request = new Request(this.target(url), {
      ...init,
      redirect: "manual",
      signal: AbortSignal.any([AbortSignal.timeout(signed ? this.options.authenticatedTimeoutMs ?? 10000 : 10000), ...(init.signal ? [init.signal] : [])]),
      credentials: "omit",
    });
    requireValue(!signed || evidence, 'missing_discovery_evidence');
    const sensitive=!['GET','HEAD'].includes(request.method)||evidence?.requiresApproval===true;
    const response = signed
      ? await this.options.authenticatedDispatch(request, { ...evidence!, profile: 'anp-discovered/1', url: request.url })
      : await (this.options.publicDispatch ?? fetch)(request);
    requireValue(response.ok && !response.redirected, sensitive ? 'operation_result_unknown' : 'http_request_failed');
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
      } catch (error) {
        if (sensitive) throw new AnpError('operation_result_unknown');
        throw error;
      } finally {
        reader.releaseLock();
      }
    }
    const contentType = response.headers.get("content-type") ?? "text/plain";
    const text = Buffer.concat(chunks).toString("utf8");
    let content: unknown;
    try { content = /json/i.test(contentType) ? JSON.parse(text) : text; }
    catch { throw new AnpError(sensitive ? 'operation_result_unknown' : 'invalid_document'); }
    return { url, contentType, content };
  }
  async discover(domain: string, signal?: AbortSignal) {
    requireValue(
      typeof domain === "string" && !!domain && !/[/?#@\\]/.test(domain),
      "invalid_domain",
    );
    let url: string | undefined = this.target(
      `https://${domain}/.well-known/agent-descriptions`,
    );
    const discoveryOrigin=new URL(url).origin;
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
      const page = object((await this.request(url, { signal }, false)).content);
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
          agentRef: this.add({ url: target, kind: "agent", source: url, discoveryOrigin }),
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
  async describe(agentRef: string, signal?: AbortSignal) {
    const resource = this.resources.get(agentRef);
    requireValue(resource?.kind === "agent", "unknown_agent");
    const result = await this.request(resource!.url, { signal }, true, {kind:resource!.kind, source:resource!.source, discoveryOrigin:resource!.discoveryOrigin, requiresApproval:false});
    const document = object(result.content);
    requireValue(
      document.protocolType === "ANP" && document.type === "AgentDescription",
    );
    const links: {
      resourceRef: string;
      kind: string;
      description?: unknown;
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
          resourceRef: this.add({ url: target, kind, protocol, source: resource!.url, discoveryOrigin:resource!.discoveryOrigin }),
          kind,
          ...(link.description === undefined ? {} : { description: link.description }),
          ...(protocol === undefined ? {} : { protocol }),
        });
      }
    }
    return { ...result, links };
  }
  async read(resourceRef: string, signal?: AbortSignal) {
    const resource = this.resources.get(resourceRef);
    requireValue(resource && resource.kind !== "agent", "unknown_resource");
    const result = await this.request(resource!.url, { signal }, true, {kind:resource!.kind, source:resource!.source, discoveryOrigin:resource!.discoveryOrigin, requiresApproval:false});
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
            source: resource!.url,
            discoveryOrigin: resource!.discoveryOrigin,
            policyEvidence:structuredClone({hasRequestBody:operation.requestBody!==undefined,
              ...(operation.security===undefined?(spec.security===undefined?{}:{security:spec.security}):{security:operation.security}),
              ...(operation['x-agent-effect']===undefined?{}:{declaredEffect:operation['x-agent-effect']}),
              ...(operation['x-agent-annotations']===undefined?{}:{annotations:operation['x-agent-annotations']})}),
            requiresApproval: !['get','head'].includes(method) || operation.requestBody !== undefined
              || requiresEffectReview(operation)
              || requiresExtraAuthorization(operation.security === undefined ? spec.security : operation.security),
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
    signal?: AbortSignal,
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
      signal,
      method: operation!.method,
      ...(args.body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(args.body),
          }),
    }, true, {kind:'operation',source:operation!.source,discoveryOrigin:operation!.discoveryOrigin,policyEvidence:operation!.policyEvidence,requiresApproval:operation!.requiresApproval});
  }
}

/** Conservative outcome handling for unsafe or contradictory semantics, including mutations transported by GET. */
function requiresEffectReview(operation:Json):boolean {
  if(operation['x-agent-effect']!==undefined&&operation['x-agent-effect']!=='read')return true;
  const raw=operation['x-agent-annotations'];
  if(raw===undefined)return false;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return true;
  const annotations=raw as Json;
  return annotations.readOnlyHint===false||annotations.destructiveHint===true||annotations.paymentHint===true
    || ['readOnlyHint','destructiveHint','paymentHint'].some(key=>annotations[key]!==undefined&&typeof annotations[key]!=='boolean');
}

/** OAuth scopes or malformed security requirements are not global read permission. */
function requiresExtraAuthorization(security: unknown): boolean {
  if (security === undefined) return false;
  if (!Array.isArray(security)) return true;
  return security.some(requirement => !requirement || typeof requirement !== 'object' || Array.isArray(requirement)
    || Object.values(requirement).some(scopes => !Array.isArray(scopes) || scopes.length > 0));
}
