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
  /** Network/response allowance in addition to the bounded owner wait. */
  requestTimeoutMs?: number;
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
interface AnpManagedClient {
  prepareOperation(request:Request,evidence:AnpReadEvidence):Promise<{decision:'allow'|'ask'|'deny';version:number}>;
  dispatchOperation(request:Request,evidence:AnpReadEvidence,admission:{policyVersion:number;grantId?:string}):Promise<Response>;
}
const identityFailures: Record<string, string> = {
  protocol_permission_denied: 'protocol_permission_denied',
  protocol_policy_changed: 'protocol_policy_changed',
  protocol_policy_unavailable: 'protocol_policy_unavailable',
  protocol_policy_invalid_target: 'protocol_policy_invalid_target',
  protocol_policy_target_revoked: 'protocol_policy_target_revoked',
  operation_result_unknown: 'operation_result_unknown',
  http_request_timeout: 'http_request_timeout',
  domain_access_disabled: 'domain_access_disabled',
  domain_access_expired: 'domain_access_expired',
  published_identity_required: 'published_identity_required',
  default_identity_required: 'default_identity_required',
  default_identity_changed: 'default_identity_changed',
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
  const requestTimeoutMs = config.requestTimeoutMs ?? 60000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 600000 || !Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 10000
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 120000) throw new AnpError('invalid_configuration');
  const controller = new AbortController();
  const service = ctx.get('anpIdentity') as {
    bindUserConsumer(ctx: Context): IdentityClient;
    publicDiscovery(request: Request): Promise<Response>;
    bindAnpDomainConsumer(ctx: Context): AnpManagedClient;
    resolveDomainAccess(ctx: Context, profile: 'anp'): Promise<{ identityRef: NonNullable<Config['identityRef']> }>;
  };
  // Global reads and exact owner-approved operations use separate Host capabilities.
  let userClient: IdentityClient | undefined;
  let managedClient: AnpManagedClient | undefined;
  const identity = () => userClient ??= service.bindUserConsumer(ctx);
  let grantId = config.grantId;
  let selectedIdentity: Config['identityRef'];
  const pending = new Map<string, string>();
  const client = new AnpClient({
    allowedOrigins: config.allowedOrigins ?? (config.autoConnect ? ['*'] : []),
    ...(config.autoConnect ? { publicDispatch: (request: Request) => service.publicDiscovery(request) } : {}),
    authenticatedTimeoutMs: waitMs + requestTimeoutMs + 30000,
    authenticatedDispatch: async (request, evidence) => {
      let admission:{decision:'allow'|'ask'|'deny';version:number}|undefined;
      if (config.autoConnect) {
        if (typeof service.bindAnpDomainConsumer !== 'function') throw new AnpError('identity_provider_incompatible');
        managedClient??=service.bindAnpDomainConsumer(ctx);
        if(typeof managedClient.prepareOperation!=='function'||typeof managedClient.dispatchOperation!=='function')throw new AnpError('identity_provider_incompatible');
        admission=await managedClient.prepareOperation(request.clone(),evidence);
        if(admission.decision==='deny')throw new AnpError('protocol_permission_denied');
        if(admission.decision==='allow')return managedClient.dispatchOperation(request,evidence,{policyVersion:admission.version});
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
        const key = JSON.stringify([reference,admission?.version,request.method, request.url, [...request.headers], await request.clone().text()]);
        const old = pending.get(key);
        let access = old
          ? await identity().getAccessRequest(old)
          : await identity().requestAccess({
              requestId: `anp-${randomUUID()}`,
              identity: reference,
              purpose: `${config.autoConnect ? 'ANP exact operation approval' : 'ANP'} ${request.method} ${new URL(request.url).origin}${admission ? '; policy '+admission.version : ''}`,
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
        if(config.autoConnect)return managedClient!.dispatchOperation(request,evidence,{policyVersion:admission!.version,grantId:access.grantId});
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
    anp_describe: '使用 anp_discover 返回的 agentRef 读取并验签智能体描述，获得 information/interface 的 resourceRef；不要把 URL 或 DID 当作 agentRef。域名模式使用统一协议管理规则；允许的已发现只读请求不重复弹窗，询问时自动显示对话框，禁止时不发送。需要额外权限时会自动显示授权对话框；等待用户点击，不要求用户去设置页，不换协议绕过。',
    anp_read: '只读取发现描述中提供的 resourceRef。读取 OpenAPI interface 后才会产生可调用的 operationRef；不要猜测引用、路径或改用普通 curl 绕过 DID 签名。',
    anp_call: '调用 anp_read(OpenAPI) 生成的 operationRef，按该操作声明提供 path/query/body。先只读验证；发帖等写入必须用户明确要求。按统一协议管理规则，allow 直接执行，ask 自动弹出仅本次操作授权框，deny 不发送；不更改持续规则，不绕过禁止，支付、未知及额外权限仍单独确认。operation_result_unknown 不证明失败或未落库；先查同一身份的结果，不重发或换协议试写。相同 idempotency_key 也不保证跨身份、跨协议或修改正文后的重试安全。response.status 表示真实 HTTP 响应，404 不证明查询参数或签名失败。',
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
      timeoutMs: waitMs + requestTimeoutMs + 30000,
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
            ...(error instanceof AnpError && error.response ? { response: error.response } : {}),
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
