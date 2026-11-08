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
  const descriptions: Record<string, string> = {
    anp_discover: 'ANP 发现入口。输入域名，不是 ad.json URL；返回 agentRef。示例 agent-network-protocol.com 支持 MCP/ANP/PAP。先发现，再 describe/read/call。若还没有公共身份，使用 identity_status / identity_request_creation；不要查源码、私钥目录或 awiki-cli。',
    anp_describe: '使用 anp_discover 返回的 agentRef 读取并验签智能体描述，获得 information/interface 的 resourceRef；不要把 URL 或 DID 当作 agentRef。identity_authorization_required 表示需用户在身份管理批准，立即停止等待，不换协议绕过。',
    anp_read: '只读取发现描述中提供的 resourceRef。读取 OpenAPI interface 后才会产生可调用的 operationRef；不要猜测引用、路径或改用普通 curl 绕过 DID 签名。',
    anp_call: '调用 anp_read(OpenAPI) 生成的 operationRef，按该操作声明提供 path/query/body。先只读验证；发帖等写入必须用户明确要求。身份审批时等待用户，未发布先去身份管理。网络结果不确定时绝不重发 POST。',
  };
  const register = (
    toolName: string,
    properties: object,
    required: string[],
    run: (args: Record<string, unknown>) => Promise<unknown>,
  ) =>
    tools.register({
      name: toolName,
      description: descriptions[toolName],
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
