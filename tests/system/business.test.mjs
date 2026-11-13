import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withPublishedIdentity } from '../support/published-identity.mjs';
import { operations, request, ownedPost } from '../support/protocol-tools.mjs';
import { postOperator } from '../support/post-operator.mjs';
import { protocolDocument } from '../support/protocol-document.mjs';
import { createHash } from 'node:crypto';

test('ANP-S04 discovered protocol operations return exact requested document fields', { timeout: 240000 }, () =>
  withPublishedIdentity('e1', async runtime => {
    await runtime.rpc('network/trace-enable');
    const catalog = await operations(runtime);
    const list = await request(runtime, catalog.find(value => value.operationId === 'protocol_list'), { query: { language: 'zh' } });
    assert.equal(list.language, 'zh');
    assert.ok(list.documents.length > 0);
    const document = list.documents[0];
    const read = await request(runtime, catalog.find(value => value.operationId === 'protocol_get'), {
      path: { version: document.version, document: document.document }, query: { language: 'zh' },
    });
    assert.equal(read.version, document.version);
    assert.equal(read.language, 'zh');
    assert.equal(read.document, document.document);
    assert.ok(read.content.length > 0);
    const expected = await protocolDocument({ version: document.version, language: 'zh', document: document.document });
    assert.equal(createHash('sha256').update(read.content).digest('hex'), expected.sha256);
    const operation = catalog.find(value => value.operationId === 'protocol_get');
    await runtime.rpc('network/reset');
    const missing = await runtime.rpc('tool', { name: 'anp_call', arguments: { operationRef: operation.operationRef } });
    assert.equal(missing.value.ok, false);
    assert.equal(missing.value.error, 'missing_parameter');
    assert.equal((await runtime.rpc('network/status')).businessRequests, 0);
    for (const [version, name, language] of [
      ['acceptance-invalid-version', document.document, 'zh'],
      [document.version, 'acceptance-invalid-document', 'zh'],
      [document.version, document.document, 'acceptance-invalid-language'],
    ]) {
      const result = await runtime.rpc('tool', { name: 'anp_call', arguments: { operationRef: operation.operationRef,
        path: { version, document: name }, query: { language } } });
      assert.equal(result.isError, false);
      assert.equal(result.value.ok, false);
      assert.equal(result.value.error, 'http_request_failed');
    }
    const audit = await runtime.rpc('network/status');
    assert.equal(audit.businessRequests, 3);
    assert.equal(audit.postWrites, 0);
    const trace = await runtime.rpc('network/trace');
    assert.ok(trace.some(event => event.event === 'request' && typeof event.callId === 'string'));
    assert.ok(trace.some(event => event.event === 'response' && event.status === 200));
  }));

test('ANP-S05 a user-approved post is submitted once and independently read back then removed', { timeout: 240000 }, () =>
  withPublishedIdentity('e1', async (runtime, published) => {
    const catalog = await operations(runtime);
    await ownedPost(runtime, published, async (scope, decide) => {
      const before = await runtime.rpc('network/status');
      const receipt = await decide('approve', () => request(runtime,
        catalog.find(value => value.operationId === 'post_create'), { body: { content: scope.marker } }));
      assert.equal(receipt.content, scope.marker);
      assert.equal(receipt.identity, scope.subject);
      assert.equal((await postOperator({ action: 'observe', ...scope, id: receipt.id })).matches, 1);
      const list = await request(runtime, catalog.find(value => value.operationId === 'post_list'));
      assert.equal(list.posts.filter(post => post.id === receipt.id && post.content === scope.marker).length, 1);
      const after = await runtime.rpc('network/status');
      assert.equal(after.postWrites - before.postWrites, 1);
      assert.equal(after.postResponses - before.postResponses, 1);
    });
  }));
