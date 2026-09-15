# Deployment APIs through Pi extensions

Bionic accepts capabilities from separate Pi extensions. A deployment can add APIs
without modifying Bionic. The public SDK is `bionic-pi/providers`; the package root
exports the core Pi extension. The package is packable/installable but has not been
published to npm.

## Run a deployment

From this repository:

```bash
mise run setup
mise run pi --deployment examples/deployment/deployment.json \
  --provider dgx-spark --model qwen3.8
```

The example expects `GET http://127.0.0.1:8090/health?service=checkout` to return
`{"status":"healthy"}`. To use your service, set `PLATFORM_ORIGIN` to its HTTPS
origin and optionally `PLATFORM_TOKEN`. No live platform is contacted at startup.

Without `--deployment`, the launcher selects the demo fake SRE, clock, and catalog
extensions. With it, only the core plus the listed local extension files load.
Paths resolve relative to the deployment JSON, not the current directory.
Built-in tools, ambient extension discovery, context files, skills and templates
remain disabled. Saved Pi credentials/models are retained; `--isolated` opts into
a temporary Pi configuration with environment credentials.

```json
{
  "extensions": ["./node_modules/my-platform/extension.mjs"],
  "requiredProviders": ["acme.platform"],
  "grant": { "...": "complete Grant; see the runnable example" }
}
```

Use a complete grant, as in [the example](../examples/deployment/deployment.json).
If omitted, only core work/policy APIs are granted. `.bionic/grant.json`, when
present, overrides the deployment grant. Grants refresh on each user prompt;
extension files and provider catalogs change only on reload/restart. Restart the
launcher after changing the deployment's extension list. Registration never grants
an API automatically.

## Install from Git or develop locally

Bionic does not need to be published to npm. In an independent deployment project:

```bash
npm install 'git+https://github.com/jkingston/bionic.git#main'
```

Use a commit SHA or tag instead of `main` for reproducible deployments, and commit
your package lockfile. A Git dependency is an installed snapshot, not a live link;
install the desired new ref explicitly when updating it.

For Git installation, npm installs build-time dependencies and then runs Bionic's
`prepare` script to build the runtime, declarations, and WASM worker into `dist`.
Use Node 24+ and leave install scripts enabled (do not use `--ignore-scripts`).
Then import the SDK normally:

```js
import { registerBionicProvider } from 'bionic-pi/providers';
```

To work on Bionic and a deployment side by side:

```bash
# In the Bionic checkout:
npm ci
# In the sibling deployment directory:
npm install ../bionic
```

Install dependencies in the Bionic checkout first. Re-run `npm run build` there
after source changes, then restart Bionic to load the rebuilt extensions. The
default npm local-directory install links the checkout; the Git dependency above
does not. Keep this local path out of a shared deployment lockfile unless every
developer uses that directory layout.

Alternatively, install a built tarball plus your platform package:

```bash
# In the Bionic checkout:
npm run build
npm pack
# In your deployment directory (use the actual tarball path):
npm install /path/to/bionic-pi-0.1.0.tgz ./my-platform
./node_modules/.bin/bionic --deployment deployment.json --model provider/model
```

Source installs need development dependencies to build; the tarball includes the
compiled runtime and WASM worker. Consumers do not need TypeScript or tsx to run it.
Pin your platform package and the compatible Pi/Bionic versions in your lockfile.

## Build a local extension and run it with Bionic

A complete, credential-free example is in
[`examples/local-extension/`](../examples/local-extension/hello.mjs). It exposes
`local.hello`, with an explicit grant in the accompanying deployment file.

In the Bionic checkout, build and run it:

```bash
mise run setup
mise run pi --deployment examples/local-extension/deployment.json \
  --provider dgx-spark --model qwen3.8
```

To develop outside this repo, start a Node 24+ project and copy the installed
example into your project:

```bash
mkdir my-agent
cd my-agent
npm init -y
npm install 'git+https://github.com/jkingston/bionic.git#main'
cp node_modules/bionic-pi/examples/local-extension/hello.mjs ./hello.mjs
cp node_modules/bionic-pi/examples/local-extension/deployment.json ./deployment.json
./node_modules/.bin/bionic --deployment ./deployment.json \
  --provider dgx-spark --model qwen3.8
```

The launcher starts Pi with Bionic **and** `hello.mjs`; do not put the Bionic core
in the deployment's `extensions` array. Your saved Pi provider/model configuration
is used. Substitute another configured provider/model if needed. Run from your
deployment directory so its scripts and sessions live in its own `.bionic/` folder.

Ask the agent: “Discover local.hello, save a script that calls it, and execute it.”
The script should call `host.invoke('local.hello', {})`; the result is
`{"message":"Hello from my local extension"}`. Registration makes the API
available, while the deployment's `capabilities` grant makes it callable.

Edit `hello.mjs` to add your implementation and schemas. Update the deployment
grant for any new capability names or resource scopes. `.mjs` needs no compilation;
Pi also accepts local `.ts` extensions directly. If your own build emits JavaScript,
point `extensions` at the emitted file and rebuild before restarting. Rebuild
Bionic with `npm run build` in its checkout only when changing Bionic itself.
Restart after edits to reliably pick up both the extension code and deployment
list; grant-only changes apply at the next user prompt. An existing
`.bionic/grant.json` overrides the grant in `deployment.json`.

## Write a provider extension

```js
import { registerBionicProvider, BionicError } from 'bionic-pi/providers';

export default function platform(pi) {
  registerBionicProvider(pi, {
    protocolVersion: 1,
    id: 'acme.platform',
    scopeSchema: {
      type: 'object',
      properties: { services: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    },
    provider: {
      definitions: () => [
        {
          name: 'acme.health',
          version: 1,
          effect: 'read',
          description: 'Read service health.',
          inputSchema: {
            type: 'object',
            properties: { service: { type: 'string' } },
            required: ['service'],
            additionalProperties: false,
          },
          outputSchema: {
            type: 'object',
            properties: { healthy: { type: 'boolean' } },
            required: ['healthy'],
            additionalProperties: false,
          },
        },
      ],
      authorize(name, args, grant) {
        const allowed = grant.resources?.['acme.platform']?.services ?? [];
        if (!allowed.includes(args.service)) {
          throw new BionicError('permission_required', 'Service not granted');
        }
      },
      async invoke(name, args, context) {
        // Use your platform client here, passing context.signal to every I/O call.
        // This minimal example returns static demo data.
        return { healthy: true };
      },
    },
  });
}
```

The grant must include `acme.health` in `capabilities` and the allowed service IDs
under `resources["acme.platform"].services`. The legacy `services` grant field is
retained for the fake SRE adapter; new integrations should use namespaced resources.

Agents discover the API through `capabilities`, declare `acme.health@1` in a script
contract, then call `host.invoke('acme.health', { service: 'checkout' })`. They still
have exactly ten Bionic tools. Providers do not register ordinary Pi tools or
inject operational context into prompts.

## Contract and lifecycle

- `definitions()` returns bounded, versioned API metadata and structural JSON
  Schemas. Unsupported schemas, duplicate provider IDs/capability names, and the
  reserved `work.current`/`policy.describe` names fail initialization atomically.
  One implementation is allowed per capability name, with exact script-version
  matching. Protocol version is separate from capability version.
- `scopeSchema` validates the provider's resource grant. Missing scope is `{}`;
  missing resource entries must never mean unrestricted access. Without a scope
  schema, the provider accepts only an empty resource object.
- `authorize(name, args, grant, context)` may be synchronous or asynchronous. It
  completes before invocation, including during fixture verification. It receives
  copies of the grant/arguments. Pass the supplied signal to any authorization I/O.
- `invoke(name, args, context)` receives host-created principal, work/run/call IDs,
  deadline, concrete signal, resource scopes and remaining output-byte allowance.
  Scripts cannot create or override that context.
- Optional `dispose(signal)` belongs to the registry after acceptance. It is called
  once on shutdown/reload, including failed initialization. Unclaimed providers are
  cleaned up by their helper. Cleanup has a one-second deadline and reports failure.
  Make cleanup idempotent and cooperate with cancellation.

Register from the extension factory, after any awaited configuration. Pi awaits
factories, so synchronous discovery at session start works regardless of extension
load order and across independent SDK copies. Do not register from a later
`session_start` hook or a background timer. Open clients lazily on first authorized
invocation; if you open them in the factory, supply disposal.

The registry freezes its catalog before tools become ready. Missing required
providers and initialization errors leave tools blocked even if Pi stays open.
Late registration is rejected; reload rebuilds the registry and invalidates stale
extension APIs. A provider loaded without Bionic displays an explicit diagnostic.

The event bus only exchanges registration callbacks between trusted host extensions.
Actual calls run directly through Bionic's broker: declaration/grant checks, schema
validation, resource authorization, bounded invocation, output validation, and
shared budgets/evidence. It is not a second script-accessible API transport.

`ProviderRegistry` is also exported for embeddings. Embedders must call it through
the Bionic broker or perform the same authorization sequence; its low-level
`invoke` method is not a standalone permission boundary.

## Included foundations

| Foundation | Location                                                       | Behavior                                                                                                                |
| ---------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Clock      | `extensions/clock.ts`, `createClockProvider()`                 | Granted UTC time API; no credentials.                                                                                   |
| Fake SRE   | `extensions/fake-sre.ts`                                       | Existing deterministic demo APIs and service scopes, selected outside core.                                             |
| Catalog    | `extensions/catalog.ts`, `createCatalogProvider(entries)`      | Deployment-supplied non-secret entries; list/get filter against explicit entry IDs.                                     |
| HTTP JSON  | `createHttpJsonProvider()`, `examples/deployment/platform.mjs` | Named GET operations, fixed origin/path, encoded scalar query parameters, resource scope checks and fixed host headers. |

The HTTP helper rejects redirects, bounds streamed response bytes, propagates
cancellation, and enforces a request timeout. HTTPS is the default; plain HTTP
requires an explicit deployment opt-in. HTTP failures do not expose response
bodies, URLs, headers or native client errors. The platform must still ensure
successful responses contain only data the grant permits.

Custom providers may use any SDK. Keep credentials and client objects in host
closures. Throw `BionicError` only with safe, agent-visible messages; unexpected
provider exceptions are converted into a generic error. Do not put credentials
in definitions, grants, descriptions, returned data, or error messages.

## Trust, autonomy and limits

Additional Pi extensions are trusted Node code, just like the Bionic core. They
can access the host and are not confined by Bionic grants. Explicitly installed
extensions must honor the integration contract; Bionic is not a sandbox for them.
Generated scripts remain in QuickJS WASM and only cross the broker's JSON bridge.

Cancellation stops the caller waiting even if a provider ignores its signal. It
cannot forcibly stop arbitrary host code or undo remote effects. Providers must
honor cancellation and implement bounded I/O/cleanup. The included HTTP helper
does so. Synchronous blocking host code cannot be preempted by this runtime.

Only read capabilities are supported in protocol v1. Read APIs run autonomously
within grants; no new approval step is introduced for scripts. Code quality and
publication review remain separate from authority. Before adding a concrete
mutation, define its idempotency, retry and uncertain-outcome semantics.

Git script storage/review, HTTP event intake, durable workflows and live grant
revocation remain separate future interfaces. They are not prerequisites for
adding a platform API.

## Validation and research basis

`npm run validate` checks formatting, lint, types, compilation, broker/WASM tests,
real Pi discovery/reload/fresh-session tests, startup failure, asynchronous denial,
cancellation, bounded cleanup and HTTP fixtures. The package test installs a
built tarball and a separate provider into a temporary deployment, duplicates the
SDK physically, then drives `capabilities → write → execute` through Pi and WASM.
It uses the npm cache populated by `npm ci`; no live model or production platform
is required. Tests need loopback networking for the HTTP fixture.

The initial research compared eager registration, shared SDK singletons,
discovery, explicit injection, ordinary Pi tool adapters and remote RPC. Discovery
avoids load-order loss and singleton identity assumptions. Injection remains an
embedding seam; ordinary Pi tools and generic RPC were not added. The temporary
spike has been replaced by production examples and regression tests.

The design was checked against installed Pi 0.85.1 and the official
[extension API](https://pi.dev/docs/latest/extensions),
[SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md),
and [package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).
Pi's event bus does not await listeners or propagate their exceptions, and
lifecycle errors do not necessarily stop the UI. Hence explicit registration
acknowledgements, required-provider checks, and broker readiness checks.
