import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime } from '../support/runtime.mjs';

async function withRuntime(options, run) {
  const runtime = await createRuntime(options);
  try { await runtime.start(); await run(runtime); }
  finally { await runtime.dispose(); }
}

test('ANP-S01 the installed disabled adapter registers no ANP tools or identities', { timeout: 180000 }, t => withRuntime({ subjectEnabled: false }, async runtime => {
  assert.equal(runtime.evidence.identityVersion, '0.1.16');
  const installation = runtime.evidence.installation;
  assert.equal(installation.subject.version, runtime.evidence.candidateVersion);
  assert.equal(installation.identity.version, runtime.evidence.identityVersion);
  assert.equal(installation.platform, process.platform);
  assert.equal(installation.arch, process.arch);
  assert.match(installation.subject.tarballSha256, /^[a-f0-9]{64}$/u);
  assert.match(installation.native.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(installation.native.version, installation.native.wrapperVersion);
  assert.ok(installation.native.path.startsWith(runtime.profile + '/node_modules/'));
  t.diagnostic(JSON.stringify(installation));
  assert.equal((await runtime.rpc('tools')).some(name => name.startsWith('anp_')), false);
  assert.deepEqual(await runtime.rpc('manager/listIdentities'), []);
}));

test('ANP-S02 actual DSH tools discover the root domain and retain linked agent references', { timeout: 180000 }, () => withRuntime({}, async runtime => {
  const tools = await runtime.rpc('tools');
  assert.ok(tools.includes('anp_discover'));
  const result = await runtime.rpc('tool', { name: 'anp_discover', arguments: { domain: 'agent-network-protocol.com' } });
  assert.equal(result.isError, false);
  assert.equal(result.value.ok, true);
  const discovered = result.value.value;
  assert.equal(discovered.complete, true);
  assert.ok(discovered.agents.length > 0);
  assert.ok(discovered.agents.every(agent => typeof agent.agentRef === 'string' && agent.agentRef.length > 0));
  assert.ok(discovered.agents.some(agent => agent.url === 'https://agent.agent-network-protocol.com/agents/official/ad.json'));
  assert.deepEqual(await runtime.rpc('manager/listIdentities'), []);
}));

test('ANP-S09 a real DSH restart invalidates old discovery references', { timeout: 180000 }, () => withRuntime({}, async runtime => {
  const discover = () => runtime.rpc('tool', { name: 'anp_discover', arguments: { domain: 'agent-network-protocol.com' } });
  const first = await discover();
  assert.equal(first.value.ok, true);
  const reference = first.value.value.agents[0].agentRef;
  const pid = runtime.evidence.pid;
  await runtime.stop(); await runtime.start();
  assert.notEqual(runtime.evidence.pid, pid);
  const stale = await runtime.rpc('tool', { name: 'anp_describe', arguments: { agentRef: reference } });
  assert.equal(stale.value.ok, false);
  assert.equal(stale.value.error, 'unknown_agent');
  const renewed = await discover();
  assert.equal(renewed.value.ok, true);
  assert.notEqual(renewed.value.value.agents[0].agentRef, reference);
  assert.deepEqual(await runtime.rpc('manager/listIdentities'), []);
}));
