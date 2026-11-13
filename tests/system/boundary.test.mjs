import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime } from '../support/runtime.mjs';
import { withPublishedIdentity } from '../support/published-identity.mjs';
import { tool, request } from '../support/protocol-tools.mjs';

const allowed = ['https://agent-network-protocol.com', 'https://agent.agent-network-protocol.com'];
async function rejected(runtime, name, arguments_, code) {
  const result = await runtime.rpc('tool', { name, arguments: arguments_ });
  assert.equal(result.isError, false);
  assert.equal(result.value.ok, false);
  if (result.value.error !== code) assert.equal(result.value.error, code, JSON.stringify({
    tool: name, expected: code, actual: result.value.error,
    trace: await runtime.rpc('network/trace').catch(() => [{ event: 'diagnostic-unavailable' }]),
    fault: await runtime.rpc('fault/boundary-status').catch(() => ({ unavailable: true })),
  }));
}

test('ANP-S08 installed clients reject foreign discovery references, unapproved origins and authenticated redirects', { timeout: 300000 }, () =>
  withPublishedIdentity('e1', async runtime => {
    await runtime.rpc('network/trace-enable');
    await rejected(runtime, 'anp_discover', { domain: 'http://agent-network-protocol.com' }, 'invalid_domain');
    await rejected(runtime, 'anp_discover', { domain: 'acceptance-disallowed.invalid' }, 'origin_not_approved');
    await rejected(runtime, 'anp_describe', { agentRef: 'https://agent.agent-network-protocol.com/agents/official/ad.json' }, 'unknown_agent');
    await rejected(runtime, 'anp_call', { operationRef: 'fabricated-operation' }, 'unknown_operation');
    const directory = await tool(runtime, 'anp_discover', { domain: 'agent-network-protocol.com' });
    const agent = directory.agents[0];
    const other = await createRuntime({ anpAllowedOrigins: allowed });
    try {
      await other.start();
      const foreign = await tool(other, 'anp_discover', { domain: 'agent.agent-network-protocol.com' });
      await runtime.rpc('network/reset');
      await rejected(runtime, 'anp_describe', { agentRef: foreign.agents[0].agentRef }, 'unknown_agent');
      assert.equal((await runtime.rpc('network/status')).businessRequests, 0);
    } finally { await other.dispose(); }
    await runtime.rpc('fault/boundary', 'description-origin');
    await rejected(runtime, 'anp_describe', { agentRef: agent.agentRef }, 'origin_not_approved');
    assert.equal((await runtime.rpc('fault/boundary-status')).applied, true);
    const description = await tool(runtime, 'anp_describe', { agentRef: agent.agentRef });
    const link = description.links.find(value => value.kind === 'interface' && value.protocol === 'OpenAPI');
    const api = await tool(runtime, 'anp_read', { resourceRef: link.resourceRef });
    const read = api.operations.find(value => value.operationId === 'protocol_list');
    await runtime.rpc('network/reset');
    await runtime.rpc('fault/boundary', 'signed-redirect');
    await rejected(runtime, 'anp_call', { operationRef: read.operationRef }, 'http_request_failed');
    assert.equal((await runtime.rpc('fault/boundary-status')).applied, true);
    assert.equal((await runtime.rpc('network/status')).businessRequests, 1);
    await runtime.rpc('fault/boundary', 'anonymous-redirect');
    await rejected(runtime, 'anp_discover', { domain: 'agent-network-protocol.com' }, 'http_request_failed');
    const audit = await runtime.rpc('fault/boundary-status');
    assert.equal(audit.applied, true);
    assert.equal(audit.forbiddenOriginRequests, 0);
    assert.ok((await request(runtime, read)).versions.length > 0);
  }, { anpAllowedOrigins: allowed }));
