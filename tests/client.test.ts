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

test("explicit wildcard supports HTTPS discovery and linked operations across domains", async () => {
  const signed: string[] = [];
  const client = new AnpClient({
    allowedOrigins: ["*"],
    publicDispatch: async () => Response.json({ "@type": "CollectionPage", items: [
      { "@id": "https://agents.second.example/ad.json", name: "Other agent" },
    ] }),
    authenticatedDispatch: async request => {
      signed.push(request.url);
      if (request.url.endsWith("/ad.json")) return Response.json({
        protocolType: "ANP", type: "AgentDescription",
        interfaces: [{ url: "https://interfaces.third.example/openapi.json", protocol: "OpenAPI" }],
      });
      if (request.url.endsWith("/openapi.json")) return Response.json({ openapi: "3.1.0",
        servers: [{ url: "https://api.fourth.example" }], paths: { "/query": { get: { operationId: "query" } } },
      });
      return Response.json({ result: "real dispatch fixture" });
    },
  });
  const directory = await client.discover("directory.first.example");
  const description = await client.describe(directory.agents[0]!.agentRef);
  const api = await client.read(description.links[0]!.resourceRef);
  assert.deepEqual((await client.call(api.operations[0]!.operationRef)).content, { result: "real dispatch fixture" });
  assert.deepEqual(signed.map(url => new URL(url).origin), [
    "https://agents.second.example", "https://interfaces.third.example", "https://api.fourth.example",
  ]);
});

test("wildcard retains HTTPS, credential, fragment and redirect restrictions", async () => {
  for (const url of ["http://insecure.example/ad.json", "https://user:password@example.test/ad.json", "https://example.test/ad.json#fragment"]) {
    let signed = 0;
    const client = new AnpClient({ allowedOrigins: ["*"],
      publicDispatch: async () => Response.json({ "@type": "CollectionPage", items: [{ "@id": url, name: "Invalid" }] }),
      authenticatedDispatch: async () => { signed++; return Response.json({}); },
    });
    await assert.rejects(client.discover("directory.example"));
    assert.equal(signed, 0);
  }
  assert.throws(() => new AnpClient({ allowedOrigins: ["*", "http://insecure.example"], authenticatedDispatch: fetch }));
  const redirect = new AnpClient({ allowedOrigins: ["*"], authenticatedDispatch: fetch,
    publicDispatch: async () => new Response(null, { status: 302, headers: { location: "https://other.example" } }),
  });
  await assert.rejects(redirect.discover("directory.example"));
});
