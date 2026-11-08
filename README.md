# DSH ANP

Apache-2.0 TypeScript plugin for DeepSeek Harness. Discover the agents published
by a domain, read their descriptions and linked information with a locally
authorized DID, then invoke operations described by JSON OpenAPI 3.x documents.

## Install and build

Use Node.js 22.13 or later. The plugin targets Cordis 4.1 and the Harness tools
registry. The public npm package declares a DSH bundle, disabled until configured.

```sh
npm ci
npm run build
npm test
```

Install the published bundle into a Harness profile:

```sh
pnpm dsh plugin --profile <profile> add @agent-network-protocol/dsh-anp
```

Then configure the identity consumer and the bundle row described below before
setting `enabled: true`. Installing alone does not create an identity, grant
access, or send signed requests.

To install from source into a Harness runtime, add the Git package to that
runtime's dependencies and pin a full commit:

```sh
npm install '@agent-network-protocol/dsh-anp@git+https://github.com/agent-network-protocol/dsh-anp.git#<full-commit>'
```

The prepare hook builds the exported plugin files during Git installation.

## Host configuration

Install `@agent-network-protocol/dsh-anp/plugin` in the same Host as the shared
`anpIdentity` service and `tools` registry. Configure this exact consumer in the
identity service's `allowConsumers` and `userConsumers`, and set its `httpAllowedOrigins` to the
origins the user approved. Use an existing published local identity reference:

```yaml
- id: anp
  name: '@agent-network-protocol/dsh-anp/plugin'
  config:
    enabled: true
    allowedOrigins: ['https://agent-network-protocol.com']
    identityRef:
      storeId: '<existing store ID>'
      identityId: '<existing identity ID>'
      did: '<existing did:wba identity>'
```

The first signed operation requests access through the existing identity manager.
Shared protocol identities that hold only a device authentication key use the
identity Host's `ordinary-http/1` approval: public reads and exact HTTP request
authentication only, never raw device assertions or OAuth assertions. A missing
compatible identity provider is reported as `identity_provider_incompatible`,
without leaking native errors or credential material.
Approve it there and retry the operation. A permanent grant is reused; a one-time
grant is consumed by that operation. A previously approved grant for this exact
installed consumer may also be supplied as `grantId`. Revocation remains enforced
by the identity service on every dispatch. Loading with `enabled: false` registers
no tools and performs no discovery or signing. No private key or signature header
is supplied by the model.

## Tools

1. `anp_discover({domain})` reads `/.well-known/agent-descriptions` and all `next`
   pages. The deduplicated count covers the public directory only.
2. `anp_describe({agentRef})` signs the description request and returns information
   and interface references from `Infomations` and `interfaces`.
3. `anp_read({resourceRef})` signs a linked resource request. JSON OpenAPI 3.x
   interfaces produce callable operation references.
4. `anp_call({operationRef, path?, query?, body?})` constructs and signs the
   described operation. Parameters must be declared path/query primitives; bodies
   use JSON. Other interface protocols remain visible but are not executed.

To allow arbitrary HTTPS domains, explicitly set `allowedOrigins: ['*']` on
this plugin and set `httpAllowedOrigins['@agent-network-protocol/dsh-anp/plugin']`
to `['*']` on the identity service. The consumer must remain in `userConsumers`.
This removes the destination allowlist, not identity approval: the manager shows
all HTTPS domains as the permission scope. Permanent approval covers that scope;
one-time approval remains bound to the exact operation. Existing exact-origin
grants do not expand automatically, and revocation is checked before dispatch.
HTTP, URL credentials, fragments and redirects remain rejected.

Without the explicit wildcard, only configured HTTPS origins are accessible. References live in the current
plugin instance; after a reload, discover the domain again. Redirects, pagination
cycles and incomplete discovery fail explicitly. POST requests are not retried.

## Library usage

`AnpClient` accepts an `authenticatedDispatch(Request)` supplied by the Host's
authorized identity. `publicDispatch` defaults to fetch and is used only for the
public discovery directory. Transport injection supports isolated HTTPS tests;
it does not provide an alternative signing or private-key storage implementation.

## Service Agent example

https://agent-network-protocol.com is the project's example Service Agent for
MCP, ANP and PAP. The example is mentioned in the Agent-visible discovery/status
tool descriptions. To see ANP in action, discover `agent-network-protocol.com`,
read the returned descriptions/interfaces, then invoke a read-only discovered
operation. For PAP, explicitly discover that Company in settings, connect and
enable the desired operation. MCP uses a separately configured server connection.
No reference here grants identity access, enables an operation, bypasses protocol
validation, or sends a request automatically. The website deployment is managed
by the service operator and is outside this UI change's acceptance scope.
