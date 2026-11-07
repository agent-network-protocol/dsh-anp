# DSH ANP

Apache-2.0 TypeScript plugin for DeepSeek Harness. Discover the agents published
by a domain, read their descriptions and linked information with a locally
authorized DID, then invoke operations described by JSON OpenAPI 3.x documents.

## Install and build

Use Node.js 22.13 or later. The plugin targets Cordis 4.1 and the Harness tools
registry. Source is public; the package is private to prevent accidental npm
publication.

```sh
npm ci
npm run build
npm test
```

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

Only configured HTTPS origins are accessible. References live in the current
plugin instance; after a reload, discover the domain again. Redirects, pagination
cycles and incomplete discovery fail explicitly. POST requests are not retried.

## Library usage

`AnpClient` accepts an `authenticatedDispatch(Request)` supplied by the Host's
authorized identity. `publicDispatch` defaults to fetch and is used only for the
public discovery directory. Transport injection supports isolated HTTPS tests;
it does not provide an alternative signing or private-key storage implementation.
