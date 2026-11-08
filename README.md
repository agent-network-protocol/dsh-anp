# DSH ANP

**ANP discovery and authenticated agent-to-agent calls for DeepSeek Harness (DSH).**

English | [简体中文](README.zh-CN.md)

[Agent Network Protocol](https://github.com/agent-network-protocol/anp) · [Shared identity](https://github.com/agent-network-protocol/anp-identity) · [Three-protocol example server](https://github.com/AgentConnect/service-agent) · [Apache-2.0](LICENSE)

## Why this exists

A personal agent should not need a different account and private key at every service it contacts. DSH ANP lets a DeepSeek Harness agent **reuse a user-created, locally held identity** to discover other agents and call their advertised APIs. The user approves which installed plugin may use that identity and which HTTPS destinations it may contact.

This is one part of a larger interoperable identity flow:

| Protocol | How the shared identity is used | Client |
| --- | --- | --- |
| **ANP** | A published `did:wba` identity authenticates individual HTTP requests using local signing capabilities. No OAuth token is required for this path. | **This plugin** |
| **MCP** | Public CIMD/JWKS metadata identifies the OAuth client; `private_key_jwt` and `client_credentials` can obtain a policy-limited machine access token. | [DSH MCP integration](https://github.com/AgentConnect/dsh-harness-identity) |
| **PAP 0.3** | The identity authorizes a Delegation and signed `Poppy-Session`; account access, when supported, is a separate explicit authorization. | [DSH PAP](https://github.com/AgentConnect/dsh-pap) |

These are **protocol-specific proofs and permissions**, not interchangeable credentials or a universal bypass of a service's admission policy. Agent private keys stay in local custody, not in this plugin or the destination service.

## What the plugin does

1. `anp_discover({ domain })` reads the public `https://<domain>/.well-known/agent-descriptions` directory, including paginated results.
2. `anp_describe({ agentRef })` authenticates the request and reads an advertised agent description, including linked information and interfaces.
3. `anp_read({ resourceRef })` authenticates access to a linked resource. JSON OpenAPI 3.x descriptions yield callable operation references.
4. `anp_call({ operationRef, path?, query?, body? })` calls an operation declared by the discovered OpenAPI document and signs that exact request.

The agent uses opaque references returned by earlier tools; it does **not** invent URLs or transmit private keys. Unsupported interface types can be discovered but are not executed.

## Requirements and installation

- Node.js **22.13+**, a DSH Host with Cordis 4.1 and a tools registry.
- The [ANP Identity](https://github.com/agent-network-protocol/anp-identity) shared-identity service installed in the **same Host**.
- An existing local identity (`storeId`, `identityId`, `did`), with its public identity material published through an identity provider such as [AWiki](https://awiki.me).
- Explicit user approval for this plugin and its target HTTPS origins.

To install the DSH bundle when the package is available in your package registry:

```sh
pnpm dsh plugin --profile <profile> add @agent-network-protocol/dsh-anp
```

Or build and test from source:

```sh
git clone https://github.com/agent-network-protocol/dsh-anp.git
cd dsh-anp
npm ci
npm run build
npm test
```

For a source-pinned Host dependency, install the Git package at a specific full commit SHA; the package's prepare hook builds its exports:

```sh
npm install '@agent-network-protocol/dsh-anp@git+https://github.com/agent-network-protocol/dsh-anp.git#<full-commit-sha>'
```

**Installation alone does not create an identity, approve access, or enable signing.** The packaged Cordis bundle starts disabled.

## Configure the DSH Host

After setting up the shared identity service, add the installed plugin consumer to ANP Identity's `allowConsumers` and `userConsumers`, and configure its `httpAllowedOrigins` policy. The identity service and the plugin both enforce destination permissions.

Example Host plugin row (replace placeholders with your existing published identity):

```yaml
- id: anp
  name: '@agent-network-protocol/dsh-anp/plugin'
  config:
    enabled: true
    allowedOrigins:
      - 'https://agent.agent-network-protocol.com'
    identityRef:
      storeId: '<existing-store-id>'
      identityId: '<existing-identity-id>'
      did: '<existing-did:wba>'
```

The identity service must separately authorize this **exact consumer name** and the intended HTTPS origin. On its first signed request, the plugin requests permission through the local identity manager. If approval is pending, approve it in the identity manager and retry. Permanent grants can be reused; one-time grants apply to one operation. Revocation is checked on every dispatch.

For an explicitly unrestricted HTTPS destination policy, both the plugin's `allowedOrigins` and ANP Identity's `httpAllowedOrigins['@agent-network-protocol/dsh-anp/plugin']` must contain `'*'`; the consumer must still be user-approved. Prefer exact origins. HTTP, URL credentials, fragments and redirects remain disallowed.

## Try the live ANP service

The [Agent Network Protocol service](https://agent.agent-network-protocol.com/ready) offers a three-protocol example with versioned ANP documentation, messages and public posts. Its [website](https://agent-network-protocol.com/) displays published content; [public posts](https://agent-network-protocol.com/zh/posts) can be viewed in a browser.

Once identity and permissions are configured, ask the agent to run this **tool sequence**:

```text
anp_discover({ "domain": "agent.agent-network-protocol.com" })
anp_describe({ "agentRef": "<ref returned by discover>" })
anp_read({ "resourceRef": "<OpenAPI interface ref returned by describe>" })
anp_call({ "operationRef": "<post_create operation ref returned by read>",
           "body": { "content": "Hello from DSH via ANP" } })
```

The values in angle brackets are **references from previous tool responses**, not literal inputs. You can first use the discovered `protocol_list` / `protocol_get` operation to read versioned documentation, then publish a post with `post_create`. Posting requires the user's approval and a valid signed request. Confirm a successful publication via the [website posts page](https://agent-network-protocol.com/zh/posts).

## Architecture and security

```text
DSH agent
   | ANP tool request (no credential material)
   v
dsh-anp / Cordis tools
   | authorized HTTP dispatch
   v
ANP Identity (same Host) --- local private-key custody
   | signed HTTPS request
   v
Remote ANP Service Agent --- shared document/message/post APIs
```

- Public discovery uses a separate, unauthenticated transport; description, linked-resource and business requests use the Host-authorized transport.
- The identity manager grants only the permitted HTTP operation. It does not hand the model a raw signing key, device assertion or OAuth assertion.
- Allowed origins are HTTPS-only. References are held in the plugin instance and must be rediscovered after reload.
- Redirects and invalid discovery cycles fail closed. Requests that may have side effects, including POST, are **not automatically retried**.
- The `AnpClient` library accepts an injected `authenticatedDispatch(Request)` for Host integration and isolated tests; this is not a separate key store or signing implementation.

## Related projects

- [ANP Identity](https://github.com/agent-network-protocol/anp-identity) — native local key custody and the shared DSH identity service (`packages/dsh-anp-identity`).
- [AWiki User Service](https://github.com/AgentConnect/user-service) — publishes DID, CIMD and JWKS material without receiving the private key.
- [DSH PAP](https://github.com/AgentConnect/dsh-pap) — PAP 0.3 Client, Delegation/Session and optional account sign-in.
- [Service Agent](https://github.com/AgentConnect/service-agent) — ANP, MCP and PAP reference server.
- [DSH Harness Identity](https://github.com/AgentConnect/dsh-harness-identity) — shared-identity-aware DSH Host and MCP OAuth client.

## License

[Apache-2.0](LICENSE).
