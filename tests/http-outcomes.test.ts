import assert from 'node:assert/strict';
import test from 'node:test';
import { AnpClient, AnpError } from '../src/index.js';

async function fixture(dispatch: (request: Request) => Promise<Response>) {
  const client = new AnpClient({ allowedOrigins: ['https://service.example'],
    publicDispatch: async () => Response.json({ '@type': 'CollectionPage', items: [{ '@id': 'https://service.example/ad.json', name: 'Service' }] }),
    authenticatedDispatch: async request => {
      if (request.url.endsWith('/ad.json')) return Response.json({ protocolType: 'ANP', type: 'AgentDescription', interfaces: [{ url: '/openapi.json', protocol: 'OpenAPI' }] });
      if (request.url.endsWith('/openapi.json')) return Response.json({ openapi: '3.1.0', paths: {
        '/drafts': { get: { operationId: 'get', parameters: [{ name: 'request_id', in: 'query', required: true }] },
          post: { operationId: 'create', requestBody: {} } },
      } });
      return dispatch(request);
    } });
  const discovered = await client.discover('service.example');
  const description = await client.describe(discovered.agents[0]!.agentRef);
  const api = await client.read(description.links[0]!.resourceRef);
  return { client, operations: Object.fromEntries(api.operations.map(operation => [operation.operationId, operation.operationRef])) };
}

test('a query returning 404 retains the HTTP response without exposing its error body', async () => {
  let sent = 0, cancelled = false;
  const f = await fixture(async request => {
    sent++;
    assert.equal(new URL(request.url).searchParams.get('request_id'), 'missing + 中文');
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 404 });
  });
  await assert.rejects(f.client.call(f.operations.get!, { query: { request_id: 'missing + 中文' } }), error => {
    assert(error instanceof AnpError);
    assert.equal(error.code, 'http_request_failed');
    assert.deepEqual(error.response, { status: 404, outcome: 'response_received', bodyComplete: false, mutationOutcome: 'not_applicable' });
    return true;
  });
  assert.equal(sent, 1);
  assert.equal(cancelled, true);
});

test('a rejected write retains its HTTP status and an unknown mutation outcome without replaying', async () => {
  let sent = 0;
  const body = { text: '第一行\n第二行', structured: { skills: ['Python', 'TypeScript'] }, idempotency_key: 'isolated-exact-operation' };
  const f = await fixture(async request => {
    sent++;
    assert.equal(await request.text(), JSON.stringify(body));
    return Response.json({ secret: 'never-expose-remote-error-data' }, { status: 409 });
  });
  await assert.rejects(f.client.call(f.operations.create!, { body }), error => {
    assert(error instanceof AnpError);
    assert.equal(error.code, 'operation_result_unknown');
    assert.deepEqual(error.response, { status: 409, outcome: 'response_received', bodyComplete: false, mutationOutcome: 'unknown' });
    assert(!JSON.stringify(error).includes('never-expose'));
    return true;
  });
  assert.equal(sent, 1);
});

test('a lost success body reports the received status and remains unsafe to repeat', async () => {
  let sent = 0;
  const f = await fixture(async () => {
    sent++;
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error('private transport details')); } }), { status: 201 });
  });
  await assert.rejects(f.client.call(f.operations.create!, { body: { text: 'draft' } }), error => {
    assert(error instanceof AnpError);
    assert.equal(error.code, 'operation_result_unknown');
    assert.equal(error.response?.status, 201);
    assert.equal(error.response?.bodyComplete, false);
    assert(!JSON.stringify(error).includes('private transport'));
    return true;
  });
  assert.equal(sent, 1);
});
