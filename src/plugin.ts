import type { Context } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import { AnpClient, AnpError, type AnpReadEvidence } from "./index.js";

export const name = "@agent-network-protocol/dsh-anp/plugin";
export const inject = ["anpIdentity", "tools"];
export interface Config {
  enabled?: boolean;
  /** Use the Host's single global domain-access policy instead of per-domain configuration. */
  autoConnect?: boolean;
  allowedOrigins?: string[];
  identityRef?: { storeId: string; identityId: string; did: string };
  grantId?: string;
  approvalWaitMs?: number;
  approvalPollMs?: number;
}
interface Access {
  id: string;
  status: string;
  grantId?: string;
  mode?: string;
  version?: number;
}
interface IdentityClient {
  findAccessGrant?(input: object): Promise<string | undefined>;
  requestAccess(input: object): Promise<Access>;
  getAccessRequest(id: string): Promise<Access>;
  cancelAccessRequest?(id: string, version: number): Promise<Access>;
  openAuthorizedIdentity(
    id: string,
  ): Promise<{
    authenticatedHttp: { dispatch(request: Request): Promise<Response> };
  }>;
}
const identityFailures: Record<string, string> = {
  domain_access_disabled: 'domain_access_disabled',
  domain_access_expired: 'domain_access_expired',
  published_identity_required: 'published_identity_required',
  default_identity_required: 'default_identity_required',
  capability_forbidden: 'identity_operation_not_permitted',
  request_previously_denied: 'identity_authorization_denied',
  provider_disposed: 'identity_authorization_unavailable',
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
/** Wait for an owner decision without sending, re-approving, or replaying a request. */
async function awaitDecision(identity: IdentityClient, request: Access, signal: AbortSignal, waitMs: number, pollMs: number): Promise<Access> {
  let current = request;
  const deadline = Date.now() + waitMs;
  while (current.status === 'pending' && Date.now() < deadline) {
    await new Promise<void>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new AnpError('unavailable')); };
      const timer = setTimeout(finish, Math.min(pollMs, Math.max(0, deadline - Date.now())));
      signal.addEventListener('abort', abort, {once:true});
      if (signal.aborted) abort();
    });
    current = await identity.getAccessRequest(current.id);
  }
  return current;
}
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return;
  const waitMs = config.approvalWaitMs ?? (config.autoConnect ? 120000 : 0);
  const pollMs = config.approvalPollMs ?? 1000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 600000 || !Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 10000) throw new AnpError('invalid_configuration');
  const controller = new AbortController();
  const service = ctx.get('anpIdentity') as {
    bindUserConsumer(ctx: Context): IdentityClient;
    publicDiscovery(request: Request): Promise<Response>;
    bindAnpDomainConsumer(ctx: Context): {dispatchRead(request: Request, evidence: AnpReadEvidence): Promise<Response>};
    resolveDomainAccess(ctx: Context, profile: 'anp'): Promise<{ identityRef: NonNullable<Config['identityRef']> }>;
  };
  // Global reads and exact owner-approved operations use separate Host capabilities.
  let userClient: IdentityClient | undefined;
  const identity = () => userClient ??= service.bindUserConsumer(ctx);
  let grantId = config.grantId;
  let selectedIdentity: Config['identityRef'];
  const pending = new Map<string, string>();
  const client = new AnpClient({
    allowedOrigins: config.allowedOrigins ?? (config.autoConnect ? ['*'] : []),
    ...(config.autoConnect ? { publicDispatch: (request: Request) => service.publicDiscovery(request) } : {}),
    authenticatedTimeoutMs: waitMs + 10000,
    authenticatedDispatch: async (request, evidence) => {
      if (config.autoConnect && !evidence.requiresApproval && ['GET','HEAD'].includes(request.method)) {
        if (typeof service.bindAnpDomainConsumer !== 'function') throw new AnpError('identity_provider_incompatible');
        return service.bindAnpDomainConsumer(ctx).dispatchRead(request, evidence);
      }
      const reference = config.autoConnect
        ? (await service.resolveDomainAccess(ctx, 'anp')).identityRef : config.identityRef;
      if (!reference) throw new AnpError('published_identity_required');
      if (selectedIdentity && JSON.stringify(selectedIdentity) !== JSON.stringify(reference)) {
        grantId = undefined;
        pending.clear();
      }
      selectedIdentity = reference;
      if (!config.autoConnect && !grantId) grantId = await identity().findAccessGrant?.({ identity: reference, operation: { action: 'http', request } });
      if (config.autoConnect || !grantId) {
        const user = identity();
        const key = JSON.stringify([request.method, request.url, [...request.headers], await request.clone().text()]);
        const old = pending.get(key);
        let access = old
          ? await identity().getAccessRequest(old)
          : await identity().requestAccess({
              requestId: `anp-${randomUUID()}`,
              identity: reference,
              purpose: `${config.autoConnect ? 'ANP exact operation approval' : 'ANP'} ${request.method} ${new URL(request.url).origin}`,
              operation: { action: "http", request },
            });
        if (access.status === 'pending') {
          pending.set(key, access.id);
          try { access = await awaitDecision(user, access, AbortSignal.any([request.signal, controller.signal]), waitMs, pollMs); }
          catch (error) {
            pending.delete(key);
            if (typeof access.version === 'number') await user.cancelAccessRequest?.(access.id, access.version).catch(() => undefined);
            throw error;
          }
        }
        if (request.signal.aborted || controller.signal.aborted) throw new AnpError('unavailable');
        if (access.status !== 'approved' || !access.grantId) {
          if (access.status !== 'pending') pending.delete(key);
          if (access.status === 'denied' || access.status === 'cancelled') throw new AnpError('identity_authorization_denied');
          if (access.status === 'expired') throw new AnpError('identity_authorization_expired');
          throw new AnpError('identity_authorization_required', access.id);
        }
        if (config.autoConnect && access.mode !== 'once') throw new AnpError('identity_operation_not_permitted');
        pending.delete(key);
        if (!config.autoConnect && access.mode === 'permanent') grantId = access.grantId;
        const authorized = await identity().openAuthorizedIdentity(
          access.grantId,
        );
        try { return await authorized.authenticatedHttp.dispatch(request); }
        catch (error) {
          if (config.autoConnect && !['GET','HEAD'].includes(request.method)
            && !(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && Object.hasOwn(identityFailures,error.code))) throw new AnpError('operation_result_unknown');
          throw error;
        }
      }
      return (
        await identity().openAuthorizedIdentity(grantId)
      ).authenticatedHttp.dispatch(request);
    },
  });
  let stopped = false;
  ctx.effect(() => () => {
    stopped = true;
    controller.abort();
    pending.clear();
  });
  const tools = ctx.get("tools") as { register(definition: object): unknown };
  const descriptions: Record<string, string> = {
    anp_discover: 'ANP 发现入口。输入域名，不是 ad.json URL；返回 agentRef。示例 agent-network-protocol.com 支持 MCP/ANP/PAP。先发现，再 describe/read/call。若还没有公共身份，使用 identity_status / identity_request_creation；不要查源码、私钥目录或 awiki-cli。',
    anp_describe: '使用 anp_discover 返回的 agentRef 读取并验签智能体描述，获得 information/interface 的 resourceRef；不要把 URL 或 DID 当作 agentRef。域名模式的已发现只读请求使用全局许可，不重复弹窗。需要额外权限时会自动显示授权对话框；等待用户点击，不要求用户去设置页，不换协议绕过。',
    anp_read: '只读取发现描述中提供的 resourceRef。读取 OpenAPI interface 后才会产生可调用的 operationRef；不要猜测引用、路径或改用普通 curl 绕过 DID 签名。',
    anp_call: '调用 anp_read(OpenAPI) 生成的 operationRef，按该操作声明提供 path/query/body。先只读验证；发帖等写入必须用户明确要求。写入或额外权限会自动弹出仅本次操作的授权对话框并等待用户决定；不得绕过、不授予永久写权限。未发布先完成身份创建。网络结果不确定时绝不重发 POST。',
  };
  const register = (
    toolName: string,
    properties: object,
    required: string[],
    run: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
  ) => {
    const dispose = tools.register({
      name: toolName,
      description: descriptions[toolName],
      timeoutMs: waitMs + 30000,
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
          const signal = AbortSignal.any([controller.signal, ...(execution.signal ? [execution.signal] : [])]);
          const value = await run(args, signal);
          return stopped
            ? { ok: false, error: "unavailable" }
            : { ok: true, value };
        } catch (error) {
          return {
            ok: false,
            error:
              failureCode(error),
            ...(error instanceof AnpError && error.requestId ? {authorization:{requestId:error.requestId,presentation:'dialog',status:'pending'}} : {}),
          };
        }
      },
    });
    if (typeof dispose === 'function') ctx.effect(() => () => { dispose(); });
  };
  const string = { type: "string" };
  register("anp_discover", { domain: string }, ["domain"], (args, signal) =>
    client.discover(String(args.domain), signal),
  );
  register("anp_describe", { agentRef: string }, ["agentRef"], (args, signal) =>
    client.describe(String(args.agentRef), signal),
  );
  register("anp_read", { resourceRef: string }, ["resourceRef"], (args, signal) =>
    client.read(String(args.resourceRef), signal),
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
    (args, signal) => client.call(String(args.operationRef), args, signal),
  );
}
