import { test } from "node:test";
import assert from "node:assert/strict";
import { AnpClient } from "../src/index.js";

test("discovers all pages, follows description links and calls an OpenAPI operation", async () => {
  const sent: Request[] = [];
  const docs: Record<string, unknown> = {
    "/.well-known/agent-descriptions": {
      "@type": "CollectionPage",
      items: [{ "@id": "/ad.json", name: "Official" }],
      next: "/page2",
    },
    "/page2": {
      "@type": "CollectionPage",
      items: [{ "@id": "/ad.json", name: "Official" }],
    },
    "/ad.json": {
      protocolType: "ANP",
      type: "AgentDescription",
      Infomations: [{ url: "/info.md" }],
      interfaces: [{ url: "/openapi.json", protocol: "OpenAPI" }],
    },
    "/openapi.json": {
      openapi: "3.1.0",
      paths: {
        "/api/specs/{version}": {
          get: {
            operationId: "protocol_get",
            parameters: [
              { name: "version", in: "path", required: true },
              { name: "language", in: "query" },
            ],
          },
        },
      },
    },
  };
  const dispatch = async (request: Request) => {
    sent.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/info.md")
      return new Response("# Protocol", {
        headers: { "content-type": "text/markdown" },
      });
    return Response.json(docs[path] ?? { version: "1.1" });
  };
  const client = new AnpClient({
    allowedOrigins: ["https://service.example"],
    publicDispatch: dispatch,
    authenticatedDispatch: dispatch,
  });
  const discovered = await client.discover("service.example");
  assert.equal(discovered.count, 1);
  assert.equal(discovered.complete, true);
  const ad = await client.describe(discovered.agents[0]!.agentRef);
  assert.equal(
    (await client.read(ad.links[0]!.resourceRef)).content,
    "# Protocol",
  );
  const api = await client.read(ad.links[1]!.resourceRef);
  const result = await client.call(api.operations[0]!.operationRef, {
    path: { version: "1.1" },
    query: { language: "zh" },
  });
  assert.deepEqual(result.content, { version: "1.1" });
  assert.equal(
    sent.at(-1)!.url,
    "https://service.example/api/specs/1.1?language=zh",
  );
  await assert.rejects(
    client.call(api.operations[0]!.operationRef, {
      query: { undeclared: "value" },
    }),
  );
});

test("rejects unapproved domains, pagination loops and redirects", async () => {
  const client = new AnpClient({
    allowedOrigins: ["https://service.example"],
    authenticatedDispatch: fetch,
    publicDispatch: async () =>
      Response.json({
        "@type": "CollectionPage",
        items: [],
        next: "/.well-known/agent-descriptions",
      }),
  });
  await assert.rejects(client.discover("other.example"));
  await assert.rejects(client.discover("service.example"));
  const redirect = new AnpClient({
    allowedOrigins: ["https://service.example"],
    authenticatedDispatch: fetch,
    publicDispatch: async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://other.example" },
      }),
  });
  await assert.rejects(redirect.discover("service.example"));
});
