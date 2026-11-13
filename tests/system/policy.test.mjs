import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withPublishedIdentity } from '../support/published-identity.mjs';
import { operations, request, ownedPost, tool } from '../support/protocol-tools.mjs';
import { postOperator } from '../support/post-operator.mjs';

test('ANP-S07 saved write permission needs no grant and saved read denial survives restart', { timeout: 240000 }, () =>
  withPublishedIdentity('e1', async (runtime, published) => {
    const original = (await runtime.rpc('manager/protocolManagement')).policy;
    async function save(read, write) {
      const current = (await runtime.rpc('manager/protocolManagement')).policy;
      await runtime.rpc('manager/configureProtocolPolicy', { expectedVersion: current.version, policy: { read, write } });
    }
    try {
      const available = await operations(runtime);
      const before = new Set((await runtime.rpc('manager/listRequests', true)).map(request => request.id));
      await save(original.read, { ...original.write, mode: 'allow_all' });
      await ownedPost(runtime, published, async scope => {
        const receipt = await request(runtime, available.find(operation => operation.operationId === 'post_create'), { body: { content: scope.marker } });
        assert.equal(receipt.content, scope.marker);
        assert.equal((await postOperator({ action: 'observe', ...scope, id: receipt.id })).matches, 1);
        assert.equal((await runtime.rpc('manager/listRequests', true)).some(request => request.kind === 'access' && !before.has(request.id)), false);
      });
      await save({ ...original.read, mode: 'deny' }, original.write);
      const pid = runtime.evidence.pid;
      await runtime.stop(); await runtime.start();
      assert.notEqual(runtime.evidence.pid, pid);
      assert.equal((await runtime.rpc('manager/protocolManagement')).policy.read.mode, 'deny');
      await runtime.rpc('network/reset');
      const discovery = await tool(runtime, 'anp_discover', { domain: 'agent-network-protocol.com' });
      const denied = await runtime.rpc('tool', { name: 'anp_describe', arguments: { agentRef: discovery.agents[0].agentRef } });
      assert.equal(denied.value.ok, false);
      assert.equal(denied.value.error, 'protocol_permission_denied');
      assert.equal((await runtime.rpc('network/status')).businessRequests, 0);
      await save(original.read, original.write);
      const restored = await operations(runtime);
      assert.ok((await request(runtime, restored.find(operation => operation.operationId === 'protocol_list'))).versions.length > 0);
      // The deployed target advertises no extra OAuth scopes. Inject this
      // negative metadata declaration after the real TLS response explicitly.
      await runtime.rpc('fault/extra-scope');
      const scoped = await operations(runtime);
      assert.equal((await runtime.rpc('fault/status')).applied, true);
      await runtime.rpc('network/reset');
      let settled = false;
      const executing = runtime.rpc('tool', { name: 'anp_call', arguments: {
        operationRef: scoped.find(operation => operation.operationId === 'protocol_list').operationRef } }).finally(() => { settled = true; });
      executing.catch(() => {});
      let pending;
      const deadline = Date.now() + 10000;
      while (!settled && Date.now() < deadline) {
        pending = (await runtime.rpc('manager/listRequests')).find(request => request.kind === 'access' && request.status === 'pending');
        if (pending) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(pending, 'An extra-scope GET incorrectly inherited persistent read permission');
      await runtime.rpc('manager/decide', { requestId: pending.id, expectedVersion: pending.version, decision: 'deny' });
      const rejected = await executing;
      assert.equal(rejected.value.ok, false);
      assert.equal((await runtime.rpc('network/status')).businessRequests, 0);
      assert.equal((await runtime.rpc('network/status')).oauthRequests, 0);
    } finally { await save(original.read, original.write); }
  }));
