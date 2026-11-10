import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { apply } from '../src/plugin.js';

test('tool errors retain closed identity failure codes without exposing native details', async () => {
  for (const [code, expected] of [['provider_incompatible', 'identity_provider_incompatible'], ['consumer_forbidden', 'identity_consumer_forbidden'], ['constructor', 'anp_request_failed']]) {
    const ctx = new Context();
    const tools = new Map<string, { description: string; execute(args: object, execution: object): Promise<any> }>();
    ctx.provide('tools', { register(definition: { name: string; description: string; execute(args: object, execution: object): Promise<any> }) { tools.set(definition.name, definition); } });
    ctx.provide('anpIdentity', { bindUserConsumer() { return { requestAccess: async () => { throw Object.assign(new Error('must-not-be-exposed'), { code }); } }; } });
    const original = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ '@type': 'CollectionPage', items: [{ '@id': 'https://service.example/ad.json', name: 'Agent' }] });
    try {
      apply(ctx, { enabled: true, allowedOrigins: ['https://service.example'], identityRef: { storeId: 'store', identityId: 'agent', did: 'did:web:identity.example' } });
      assert(tools.get('anp_discover')!.description.includes('agent-network-protocol.com'));
      assert(tools.get('anp_discover')!.description.includes('MCP/ANP/PAP'));
      const discovered = await tools.get('anp_discover')!.execute({ domain: 'service.example' }, { agent: {} });
      const result = await tools.get('anp_describe')!.execute({ agentRef: discovered.value.agents[0].agentRef }, { agent: {} });
      assert.deepEqual(result, { ok: false, error: expected });
      assert(!JSON.stringify(result).includes('must-not-be-exposed'));
    } finally { globalThis.fetch = original; await ctx.fiber.dispose(); }
  }
});

test('domain mode discovers publicly and uses only the Host read capability across domains', async () => {
  const ctx = new Context();
  const tools = new Map<string, { execute(args: object, execution: object): Promise<any> }>();
  let enabled = false, resolutions = 0, accessRequests = 0, signed = 0;
  const reference = { storeId: 'store', identityId: 'identity', did: 'did:wba:identity.example' };
  const user = {
    async findAccessGrant() { return 'existing-permanent-grant'; },
    async requestAccess() { accessRequests++; throw new Error('Unexpected approval request'); },
    async openAuthorizedIdentity(grant: string) {
      assert.equal(grant, 'existing-permanent-grant');
      return { authenticatedHttp: { async dispatch() { signed++; return Response.json({ protocolType:'ANP', type:'AgentDescription' }); } } };
    },
  };
  ctx.provide('tools', { register(definition: any) { tools.set(definition.name, definition); return () => { tools.delete(definition.name); }; } });
  ctx.provide('anpIdentity', {
    bindUserConsumer() { return user; },
    bindAnpDomainConsumer() { return { async prepareOperation(request:Request,evidence:{url:string;requiresApproval:boolean}) {
      resolutions++; if (!enabled) throw Object.assign(new Error('Disabled'),{code:'domain_access_disabled'});
      assert.equal(evidence.url,request.url);assert.equal(evidence.requiresApproval,false);
      return {decision:'allow',version:0};
    },async dispatchOperation() {
      signed++;return Response.json({protocolType:'ANP',type:'AgentDescription'});
    } }; },
    async publicDiscovery(request: Request) { return Response.json({'@type':'CollectionPage',items:[{'@id':new URL('/ad.json',request.url).href,name:'Agent'}]}); },
    async resolveDomainAccess() { resolutions++; if (!enabled) throw Object.assign(new Error('Disabled'), {code:'domain_access_disabled'}); return {identityRef:reference}; },
  });
  apply(ctx, { enabled:true, autoConnect:true });
  const execute = (name: string, args: object) => tools.get(name)!.execute(args,{agent:{}});
  try {
    const first = await execute('anp_discover', {domain:'one.example'});
    assert.equal(first.ok,true); assert.equal(resolutions,0);
    assert.deepEqual(await execute('anp_describe', {agentRef:first.value.agents[0].agentRef}),{ok:false,error:'domain_access_disabled'});
    enabled = true;
    assert.equal((await execute('anp_describe', {agentRef:first.value.agents[0].agentRef})).ok,true);
    const other = await execute('anp_discover', {domain:'two.example'});
    assert.equal((await execute('anp_describe', {agentRef:other.value.agents[0].agentRef})).ok,true);
    assert.equal(signed,2); assert.equal(accessRequests,0);
    const cached = tools.get('anp_discover')!;
    await ctx.fiber.dispose(); assert.equal(tools.size,0);
    assert.deepEqual(await cached.execute({domain:'one.example'},{agent:{}}),{ok:false,error:'unavailable'});
  } finally { await ctx.fiber.dispose(); }
});

test('model-visible operation failures retain HTTP status and omit private remote bodies', async () => {
  const ctx = new Context(), tools = new Map<string, { execute(args: object, execution: object): Promise<any> }>();
  ctx.provide('tools', { register(tool: any) { tools.set(tool.name, tool); } });
  ctx.provide('anpIdentity', {
    publicDiscovery: async () => Response.json({ '@type': 'CollectionPage', items: [{ '@id': 'https://service.example/ad.json', name: 'Service' }] }),
    bindAnpDomainConsumer() { return {
      prepareOperation: async () => ({ decision: 'allow', version: 0 }),
      dispatchOperation: async (request: Request) => request.url.endsWith('/ad.json')
        ? Response.json({ protocolType: 'ANP', type: 'AgentDescription', interfaces: [{ url: '/openapi.json', protocol: 'OpenAPI' }] })
        : request.url.endsWith('/openapi.json') ? Response.json({ openapi: '3.1.0', paths: { '/query': { get: { operationId: 'query' } } } })
        : Response.json({ token: 'private-remote-body' }, { status: 404 }),
    }; },
  });
  apply(ctx, { enabled: true, autoConnect: true });
  const call = (name: string, args: object) => tools.get(name)!.execute(args, { agent: {} });
  try {
    const directory = await call('anp_discover', { domain: 'service.example' });
    const ad = await call('anp_describe', { agentRef: directory.value.agents[0].agentRef });
    const api = await call('anp_read', { resourceRef: ad.value.links[0].resourceRef });
    const result = await call('anp_call', { operationRef: api.value.operations[0].operationRef });
    assert.equal(result.error, 'http_request_failed');
    assert.equal(result.response.status, 404);
    assert.equal(result.response.outcome, 'response_received');
    assert(!JSON.stringify(result).includes('private-remote-body'));
  } finally { await ctx.fiber.dispose(); }
});
