import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withPublishedIdentity } from '../support/published-identity.mjs';
import { withUserBrowser } from '../support/browser-actor.mjs';

const catalogCall = result => result.calls.find(call => {
  if (!['anp_read', 'anp_call'].includes(call.name) || call.isError || call.value?.ok !== true) return false;
  const value = call.value.value;
  if (!Array.isArray(value?.content?.versions) || value.content.versions.length === 0
    || !Array.isArray(value.content.documents) || value.content.documents.length === 0) return false;
  try {
    const url = new URL(value.url);
    return url.origin === 'https://agent.agent-network-protocol.com'
      && ['/anp/catalog.json', '/anp/api/protocols'].includes(url.pathname);
  } catch { return false; }
});
const catalogReturned = result => Boolean(catalogCall(result));
const query = '通过 ANP 实际查询 agent-network-protocol.com 的协议文档目录，报告当前可读取的协议版本。只读，不修改权限或使用其他通道。';
async function requireCatalog(runtime, result, phase) {
  const accepted = catalogCall(result);
  if (accepted) {
    console.log(JSON.stringify({ phase, catalogTool: accepted.name, path: new URL(accepted.value.value.url).pathname }));
    return;
  }
  const calls = result.calls.map(call => {
    const code = typeof call.value?.error === 'string' ? call.value.error : call.value?.error?.code;
    return { name: call.name, isError: call.isError, ok: call.value?.ok,
      catalogShape: Array.isArray(call.value?.value?.content?.versions) && Array.isArray(call.value?.value?.content?.documents),
      ...(typeof code === 'string' && /^[a-z0-9_]{1,80}$/u.test(code) ? { code } : {}) };
  });
  assert.ok(false, JSON.stringify({ phase, calls,
    trace: await runtime.rpc('network/trace').catch(() => [{ event: 'diagnostic-unavailable' }]) }));
}

test('ANP-E05 persisted model session rediscovers after restart and obeys UI revocation until restored', { timeout: 900000 }, () =>
  withPublishedIdentity('e1', async (runtime, published) => {
    await runtime.rpc('network/trace-enable');
    const first = await runtime.rpc('model/task', { task: query }, { timeoutMs: 180000 });
    await requireCatalog(runtime, first, 'initial');
    assert.ok((await runtime.rpc('network/status')).businessRequests > 0, 'The observer did not see the real transport');
    const priorPid = runtime.evidence.pid;
    await runtime.stop(); await runtime.start();
    assert.notEqual(runtime.evidence.pid, priorPid);
    await runtime.rpc('network/trace-enable');
    const resumed = await runtime.rpc('model/resume', { sessionId: first.sessionId,
      task: 'DSH 已重启，请继续刚才的网站查询，重新发现并核对当前协议版本。只读。' }, { timeoutMs: 180000 });
    assert.equal(resumed.sessionId, first.sessionId);
    assert.ok(resumed.calls.some(call => call.name === 'anp_discover' && call.value?.ok));
    await requireCatalog(runtime, resumed, 'resume');
    assert.deepEqual((await runtime.rpc('manager/listIdentities')).map(identity => identity.reference), [published.reference]);
    await withUserBrowser(runtime, async actor => {
      await actor.openProtocols();
      assert.equal(await actor.page.getByLabel('读取模式', { exact: true }).inputValue(), 'allow_all');
      await actor.setReadMode('deny');
    });
    const revokePid = runtime.evidence.pid;
    await runtime.stop(); await runtime.start();
    assert.notEqual(runtime.evidence.pid, revokePid);
    await withUserBrowser(runtime, async actor => {
      await actor.openProtocols();
      assert.equal(await actor.page.getByLabel('读取模式', { exact: true }).inputValue(), 'deny');
    });
    await runtime.rpc('network/reset');
    await runtime.rpc('network/trace-enable');
    const denied = await runtime.rpc('model/resume', { sessionId: first.sessionId, task: query }, { timeoutMs: 180000 });
    assert.equal(denied.sessionId, first.sessionId);
    assert.equal(catalogReturned(denied), false);
    assert.ok(denied.calls.some(call => call.name === 'protocol_permissions'
      || (call.name.startsWith('anp_') && call.value?.ok === false)));
    assert.match(denied.output, /权限|禁止|无法|拒绝/u);
    assert.equal((await runtime.rpc('network/status')).businessRequests, 0);
    await withUserBrowser(runtime, async actor => {
      await actor.openProtocols();
      await actor.setReadMode('allow_all');
    });
    const restored = await runtime.rpc('model/followup', { task:
      '我已在协议管理页面恢复读取权限，请重新发现刚才的网站，再实际读取协议目录并报告版本。只读。' }, { timeoutMs: 180000 });
    assert.equal(restored.sessionId, first.sessionId);
    await requireCatalog(runtime, restored, 'restored');
    assert.ok((await runtime.rpc('network/status')).businessRequests > 0);
    assert.deepEqual((await runtime.rpc('manager/listIdentities')).map(identity => identity.reference), [published.reference]);
  }, { web: true, realModel: true }));
