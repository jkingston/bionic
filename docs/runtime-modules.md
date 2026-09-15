# Runtime modules

A runtime module extends what a WASM script can do through `host.invoke()`. It has
no Pi, model, prompt, or UI dependency. Pi extensions are optional loaders for these
modules; other backends use the same modules through `createRuntime()`.

```text
Pi → Bionic tools → runtime → WASM script → module → platform API
                         ↑
                 standalone application
```

## Run with Pi

Use Pi's explicit extension arguments through the Bionic launcher:

```bash
mise run setup
mise run pi -e ./examples/local-extension/hello.mjs \
  --provider dgx-spark --model qwen3.8
```

The launcher automatically loads the Bionic core and forwards each `-e` or
`--extension` to Pi. Add multiple `-e` arguments to compose your environment:

```bash
mise run pi -e ./extensions/fake-sre.ts -e ./extensions/clock.ts \
  -e ./extensions/catalog.ts --provider dgx-spark --model qwen3.8
```

With no `-e`, only Bionic's core work/policy APIs are available. Ambient extension,
context-file, skill and template discovery remains disabled, and Pi's built-in
tools remain replaced by the eleven script tools. Saved Pi credentials/models are
retained; `--isolated` uses temporary Pi configuration and environment credentials.

## Install from Git or develop locally

No npm publication is needed. Use Node 24+:

```bash
mkdir my-agent
cd my-agent
npm init -y
npm install 'git+https://github.com/jkingston/bionic.git#main'
```

For Git installs npm installs build-time dependencies and runs `prepare`, which
builds the JavaScript runtime, declarations and WASM worker. Leave install scripts
enabled. Pin a commit or tag instead of `main` for deployments, and commit your
lockfile. A Git dependency is a snapshot; explicitly install a new ref to update it.

For side-by-side development, run `npm ci` in the Bionic checkout, then
`npm install ../bionic` in your deployment project. This normally links the local
checkout. Rebuild Bionic with `npm run build` after changing its source, then
restart Pi. Do not commit a machine-specific local path into a shared deployment
lockfile unless that directory layout is intentional.

To consume a tarball instead: run `npm run build && npm pack` in Bionic, then
`npm install /path/to/bionic-pi-0.1.0.tgz` in the deployment. Tarballs contain the
compiled runtime; consumers do not need TypeScript or tsx to execute it.

## A local module and its Pi loader

The complete example has two files:

- [`module.mjs`](../examples/local-extension/module.mjs): plain runtime module.
- [`hello.mjs`](../examples/local-extension/hello.mjs): thin Pi loader.

Copy them from an installed package and run:

```bash
cp node_modules/bionic-pi/examples/local-extension/module.mjs ./module.mjs
cp node_modules/bionic-pi/examples/local-extension/hello.mjs ./hello.mjs
./node_modules/.bin/bionic -e ./hello.mjs --provider dgx-spark --model qwen3.8
```

The loader contains only:

```js
import { registerModule } from 'bionic-pi/pi';
import hello from './module.mjs';
export default function extension(pi) {
  registerModule(pi, hello);
}
```

The module is ordinary host code (TypeScript version shown):

```ts
import type { RuntimeModule } from 'bionic-pi/runtime';

export default {
  id: 'example.local',
  capabilities: [
    {
      name: 'local.hello',
      version: 1,
      effect: 'read',
      description: 'Read a greeting from the local environment.',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
        additionalProperties: false,
      },
    },
  ],
  async invoke() {
    return { message: 'Hello from my runtime module' };
  },
} satisfies RuntimeModule;
```

Ask the agent: “Discover local.hello, save a script that calls it, and execute it.”
Scripts declare `local.hello@1` and call `host.invoke('local.hello', {})`.

Local `.mjs` files need no build. Pi also loads `.ts` extensions directly. If your
own build emits JavaScript, point `-e` at the emitted loader file and rebuild it
before restarting. Restart to pick up a changed extension list; `/reload` rebuilds
the runtime for the loaded extensions. Run from your deployment directory so its
scripts and sessions live in its own `.bionic/` folder.

## Use the same module without Pi

```js
import { createRuntime } from 'bionic-pi/runtime';
import hello from './module.mjs';

const runtime = await createRuntime({ root: './script-data', modules: [hello] });
try {
  const work = runtime.beginWork({ task: 'Call the local API' });
  const script = await work.invoke('write', {
    path: 'hello.js',
    expectedVersion: null,
    source: 'export async function main(host){return host.invoke("local.hello",{})}',
    contract: {
      description: 'Read a greeting',
      inputSchema: {},
      outputSchema: {},
      capabilities: [{ name: 'local.hello', version: 1 }],
      tools: [],
      fixtures: [],
    },
  });
  console.log(await work.invoke('execute', { ref: script.ref, input: {} }));
} finally {
  await runtime.dispose();
}
```

`work.invoke()` is the same permission-checked tool path used by Pi. Work items
share cumulative budgets across their calls and nested scripts. `work.cancel()`
interrupts a work item; `runtime.dispose()` stops all work, disposes modules and
closes storage. Call these when your application finishes with their resources.
`npm run demo` exercises this path with the fake SRE module and no model.

## Authority and resource configuration

Explicitly loading a trusted module authorizes its exposed APIs by default.
Modules configure their
own clients, credentials, resource restrictions and optional `authorize()` checks.
Scripts cannot install/load modules or change this host configuration.

Included module factories from `bionic-pi/runtime`:

| Factory                          | Configuration boundary                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `createClockModule()`            | UTC time only.                                                                                               |
| `createFakeSreModule(services?)` | Deterministic fake SRE; configured service IDs. Defaults to checkout/payments/auth.                          |
| `createCatalogModule(entries)`   | Only the supplied non-secret entries exist. No ambient filesystem/environment discovery.                     |
| `createHttpJsonModule(options)`  | Fixed origin/routes, configured credentials, encoded query parameters and per-operation resource allowlists. |

The [HTTP example module](../examples/deployment/platform-module.mjs) configures
`GET /health?service=checkout` with `resource: { argument: 'service', allowed:
['checkout'] }`. Its [Pi loader](../examples/deployment/platform.mjs) just registers
it. Run it with `-e ./examples/deployment/platform.mjs`. It expects
`{"status":"healthy"}` from a local service on port 8090 by default; set
`PLATFORM_ORIGIN` to your HTTPS origin and optionally `PLATFORM_TOKEN` for a real
endpoint. Nothing contacts that endpoint at startup.

The HTTP helper rejects redirects and arbitrary script-selected URLs/headers,
bounds streamed responses, and propagates cancellation and timeouts. Plain HTTP
requires explicit configuration. Credentials stay in host closures, and errors
omit native client details and HTTP response bodies. Successful outputs and
intentional `BionicError` messages must contain only agent-visible data.

Describe resource restrictions in API schemas/descriptions so agents can discover
them through `capabilities()`. Operational context still comes through APIs, not
injected prompts.

## Optional runtime policy

An embedding can narrow authority without duplicating module configuration:

```js
const runtime = await createRuntime({
  root: './script-data',
  modules: [hello],
  policy: {
    principal: 'worker-a',
    capabilities: ['local.hello', 'work.current', 'policy.describe'],
    writePrefixes: ['scratch/'],
    limits: { calls: 100, runMs: 5000 },
    async authorize(name, args, context) {
      // Optional additional deployment rule. Throw a safe BionicError to deny.
    },
  },
});
```

All fields are optional. Defaults permit the eleven script tools, all logical script
paths and loaded capabilities, within bounded execution limits. Policy can restrict
tools, API names and script prefixes; it cannot bypass a module's own restrictions.
Authorization hooks are awaited before invocation. For programmatic Pi embeddings,
the package root also exports `createBionicExtension(policy)`.

Default limits: 200 calls, 30 script writes, 1 MiB source and 2 MiB output per work
item; 120 seconds per work item, 10 seconds per execution, nesting depth 8 and 12
concurrent workers. Logical script paths never grant host filesystem access.
Script quality/review remains separate from authority: untested scripts can run.

## Lifecycle and trust

Register modules during the Pi extension factory, after awaited configuration.
All factories finish before discovery, so load order and duplicate SDK installations
do not determine behavior. The event bus is only an adapter registration mechanism;
the runtime does not import Pi. Module catalogs freeze at startup. Invalid schemas,
duplicate IDs/names and reserved core names prevent the runtime becoming ready.
Unknown or unloaded capabilities remain unavailable.

Modules optionally implement `authorize(name, args, context)` and
`dispose(signal)`. Invocation context contains host-created principal, work/run/call
IDs, deadline, signal and remaining byte allowance. Both module and optional runtime
policy authorization must pass. Cleanup is attempted once per module instance with
a one-second bound, including failed initialization.

Modules and Pi extensions are trusted host code. WASM contains generated scripts,
not these modules. Cancellation stops waiting for uncooperative asynchronous host
code; it cannot preempt synchronous blocking code or undo remote effects. Providers
must cooperate with cancellation and use bounded I/O. Read APIs are supported;
mutations still need operation-specific idempotency and uncertain-outcome semantics.

Git storage/review, HTTP event intake and durable workflows remain separate future
backends. They can use the runtime without adopting Pi's extension lifecycle.
