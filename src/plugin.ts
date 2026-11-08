import type { Context } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import { AnpClient, AnpError } from "./index.js";

export const name = "@agent-network-protocol/dsh-anp/plugin";
export const inject = ["anpIdentity", "tools"];
export interface Config {
  enabled?: boolean;
  allowedOrigins: string[];
  identityRef: { storeId: string; identityId: string; did: string };
  grantId?: string;
}
interface Access {
  id: string;
  status: string;
  grantId?: string;
  mode?: string;
}
interface IdentityClient {
  requestAccess(input: object): Promise<Access>;
  getAccessRequest(id: string): Promise<Access>;
  openAuthorizedIdentity(
    id: string,
  ): Promise<{
    authenticatedHttp: { dispatch(request: Request): Promise<Response> };
  }>;
}
const identityFailures: Record<string, string> = {
  provider_incompatible: "identity_provider_incompatible",
  consumer_forbidden: "identity_consumer_forbidden",
  operation_not_permitted: "identity_operation_not_permitted",
  grant_inactive: "identity_authorization_unavailable",
  grant_conflict: "identity_authorization_unavailable",
};
function failureCode(error: unknown): string {
  if (error instanceof AnpError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return Object.hasOwn(identityFailures, error.code) ? identityFailures[error.code]! : "anp_request_failed";
  }
  return "anp_request_failed";
}
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return;
  const identity = (
    ctx.get("anpIdentity") as { bindUserConsumer(ctx: Context): IdentityClient }
  ).bindUserConsumer(ctx);
  let grantId = config.grantId;
  const pending = new Map<string, string>();
  const client = new AnpClient({
    allowedOrigins: config.allowedOrigins,
    authenticatedDispatch: async (request) => {
      if (!grantId) {
        const key = `${request.method} ${request.url} ${await request.clone().text()}`;
        const old = pending.get(key);
        const access = old
          ? await identity.getAccessRequest(old)
          : await identity.requestAccess({
              requestId: `anp-${randomUUID()}`,
              identity: config.identityRef,
              purpose: `ANP ${request.method} ${new URL(request.url).origin}`,
              operation: { action: "http", request },
            });
        if (access.status !== "approved" || !access.grantId) {
          if (access.status === "pending") pending.set(key, access.id);
          else pending.delete(key);
          throw new AnpError("identity_authorization_required");
        }
        pending.delete(key);
        if (access.mode === "permanent") grantId = access.grantId;
        const authorized = await identity.openAuthorizedIdentity(
          access.grantId,
        );
        return authorized.authenticatedHttp.dispatch(request);
      }
      return (
        await identity.openAuthorizedIdentity(grantId)
      ).authenticatedHttp.dispatch(request);
    },
  });
  let stopped = false;
  ctx.effect(() => () => {
    stopped = true;
    pending.clear();
  });
  const tools = ctx.get("tools") as { register(definition: object): unknown };
  const register = (
    toolName: string,
    properties: object,
    required: string[],
    run: (args: Record<string, unknown>) => Promise<unknown>,
  ) =>
    tools.register({
      name: toolName,
      description: `ANP ${toolName.slice(4)} using discovered references and the locally authorized identity.`,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args: unknown, value: unknown) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      execute: async (
        args: Record<string, unknown>,
        execution: { agent?: unknown; signal?: AbortSignal },
      ) => {
        if (stopped || !execution.agent || execution.signal?.aborted)
          return { ok: false, error: "unavailable" };
        try {
          const value = await run(args);
          return stopped
            ? { ok: false, error: "unavailable" }
            : { ok: true, value };
        } catch (error) {
          return {
            ok: false,
            error:
              failureCode(error),
          };
        }
      },
    });
  const string = { type: "string" };
  register("anp_discover", { domain: string }, ["domain"], (args) =>
    client.discover(String(args.domain)),
  );
  register("anp_describe", { agentRef: string }, ["agentRef"], (args) =>
    client.describe(String(args.agentRef)),
  );
  register("anp_read", { resourceRef: string }, ["resourceRef"], (args) =>
    client.read(String(args.resourceRef)),
  );
  register(
    "anp_call",
    {
      operationRef: string,
      path: { type: "object" },
      query: { type: "object" },
      body: {},
    },
    ["operationRef"],
    (args) => client.call(String(args.operationRef), args),
  );
}
