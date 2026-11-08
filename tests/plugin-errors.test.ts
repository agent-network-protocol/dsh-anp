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
