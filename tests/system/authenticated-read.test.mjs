import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withPublishedIdentity } from '../support/published-identity.mjs';

test('ANP-S03 a published awiki.me identity authenticates description and interface reads', { timeout: 240000 }, () =>
  withPublishedIdentity('e1', async (runtime) => {
    async function tool(name, args) {
      const result = await runtime.rpc('tool', { name, arguments: args });
      assert.equal(result.isError, false);
      assert.equal(result.value.ok, true, result.value.error);
      return result.value.value;
    }
    const directory = await tool('anp_discover', { domain: 'agent-network-protocol.com' });
    const agent = directory.agents.find(value => value.url === 'https://agent.agent-network-protocol.com/agents/official/ad.json');
    assert.ok(agent);
    const description = await tool('anp_describe', { agentRef: agent.agentRef });
    assert.equal(description.content.type, 'AgentDescription');
    const link = description.links.find(value => value.kind === 'interface' && value.protocol === 'OpenAPI');
    assert.ok(link);
    const api = await tool('anp_read', { resourceRef: link.resourceRef });
    assert.match(api.content.openapi, /^3\./u);
    assert.ok(api.operations.some(value => value.operationId === 'protocol_list'));
    assert.ok(api.operations.some(value => value.operationId === 'post_create'));
  }));
