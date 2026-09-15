# Bionic for Pi

A script-only Pi agent. Pi can discover, write, edit, and execute versioned
JavaScript scripts. Scripts can call the same tools to compose one-off work.
The Python/PydanticAI proof of concept has been removed.

Use Bionic as a dependency without an npm release:

```bash
npm install 'git+https://github.com/jkingston/bionic.git#main'
```

Requires Node 24+ and enabled install scripts. Pin a commit or tag for deployments;
see [Git installation and local development](docs/runtime-modules.md#install-from-git-or-develop-locally).

## Run

With mise, use your existing Pi login and model configuration:

```bash
mise install
mise run setup
mise run models
mise run pi --model 'provider/model-id'
```

Both `mise run pi` and `npm start` use the controlled Bionic launcher and retain
your saved Pi credentials/models (`PI_CODING_AGENT_DIR` is honored). The core loads by default; add runtime modules through explicit `-e` Pi loaders. `/bionic`
shows status; `/bionic runs` opens run history. Shell `!`/`!!` commands are
disabled. Each user prompt begins a shared work budget.

Requires **Node 24+** and npm. `npm ci` installs pinned dependencies and builds the
runtime; no global Pi install is needed. For temporary Pi configuration with
credentials from the environment, use `npm start -- --isolated --model YOUR_MODEL`.

To load deployment-specific APIs:

```bash
mise run pi -e ./examples/local-extension/hello.mjs --model 'provider/model-id'
```

See [runtime module authoring](docs/runtime-modules.md) for external
packages, module configuration, standalone execution, and the HTTP JSON example. Built-in tools,
ambient extension discovery, context files, skills, and templates stay disabled.

For a complete local example, follow
[a local module and its Pi loader](docs/runtime-modules.md#a-local-module-and-its-pi-loader).

This controls the agent's tools. The trusted Pi process itself is not sandboxed;
only generated scripts run inside the WASM guest. Do not load arbitrary extensions
into this profile. Human attachments or manually entered task text remain user
input, not automatically retrieved operational context.

Try the implementation without a model or API key:

```bash
npm run demo
npm run check
npm test
```

The demo saves an untested diagnostic script and executes it against the fake SRE
API in WASM. Tests include Pi's actual loader and agent loop with a scripted
provider, fresh-session reuse, nested tool composition, and isolation failures.
They do not establish real-model task quality or benchmark gains.

## Development checks

```bash
npm run validate      # formatting, lint, typecheck, and all tests
npm run format        # apply Prettier formatting
npm run lint:fix      # apply safe ESLint fixes
```

`npm run lint` fails on warnings as well as errors. ESLint covers TypeScript and
JavaScript; Prettier covers source, configuration, and Markdown. Editor defaults
are recorded in `.editorconfig`. Dependencies are pinned in the lockfile.

## Tools

| Tool                           | Operates on                                                          |
| ------------------------------ | -------------------------------------------------------------------- |
| `read`, `write`, `edit`        | Script source and contracts in the logical hierarchy                 |
| `ls`, `find`, `grep`, `search` | Script discovery; no host filesystem access                          |
| `execute`                      | Exact immutable script reference plus JSON input                     |
| `verify`                       | Saved fixtures and quality evidence; optional for ordinary execution |
| `runs`                         | Run history, saved input/output, and nested call summaries           |
| `capabilities`                 | Authorized API/tool contracts, scopes, and limits                    |

Scripts export `main(host, input)`. Pi saves source through `write`, then supplies
its returned `ref` to `execute`. Scripts use those same argument schemas:

```javascript
export async function main(host, input) {
  const script = await host.tools.invoke('read', {
    path: 'sre/diagnose-latency.js',
  });
  const results = [];
  for (const service of input.services) {
    results.push(
      await host.tools.invoke('execute', {
        ref: script.ref,
        input: { service },
      }),
    );
  }
  return results;
}
```

Declare requested `tools` and `{name, version}` API `capabilities` in the script
contract, along with description, JSON input/output schemas, and fixtures (which
may be empty). Child scripts can only narrow the parent's declared authority;
wrappers must declare the union of tool/API access they need. `write` creates
with `expectedVersion: null`; edits require a `baseVersion`. Imports and package
installation are unsupported. Contracts support structural JSON Schema (types, properties, items, required,
additionalProperties, enum/const, and size/numeric bounds). Regex, format, refs,
and combinators are unsupported so generated validators cannot consume unbounded
host CPU. Schema depth/size and the validator cache are bounded.

`system/current-work.js` is seeded at startup and retrieves the current task
through `work.current`. `capabilities()` exposes its API contract. Scratch scripts
use ordinary paths such as `scratch/batch.js`; they are excluded from default
ranked search but remain visible to `ls`/`find`. There is no automatic deletion.

## Run history

`execute({ ref, input, result: "reference" })` saves the result and returns its run
metadata without inline output. The default `"inline"` mode still returns output.
Both are ordinary executions; retrieving history never reruns a script.

```js
await host.tools.invoke('runs', { action: 'list', path: 'sre/', status: 'error' });
await host.tools.invoke('runs', { action: 'get', runId: input.runId });
await host.tools.invoke('runs', { action: 'output', runId: input.runId, pointer: '/service' });
```

Declare `runs` in the calling script's tools. Humans can use `/bionic runs [path]`
and `/bionic run <id>` to inspect input, output, calls and child runs. Runtime
embeddings use `runtime.history(request)` with the same policy checks.
See [run history](docs/run-history.md) for filters, result states and limits.

## Runtime and authority

JavaScript runs in **QuickJS compiled to WebAssembly**, hosted in a disposable
Node worker thread. Guest code is never evaluated by Node/V8. There is no WASI,
filesystem, network, process API, module loader, or native-object exposure in the
guest. Only the explicit JSON tool/API bridge is provided. No containers or
Bubblewrap are used.

Each guest has a 32 MiB QuickJS heap limit, stack and execution limits, and a
parent-enforced deadline. Worker threads provide scheduling/cancellation, not the
security boundary; the WASM guest and explicit imports provide containment.
This remains dependent on the correctness of QuickJS, its WASM binding, and the
bridge implementation, rather than a claim of formal security verification.

Explicitly loaded modules define available platform APIs and resource restrictions.
The runtime supplies default execution budgets; embeddings may add a narrower
`RuntimePolicy`. Scripts cannot load modules, access credentials or change host
configuration. Nested calls share cumulative budgets and declarations can only
narrow access. Script quality and review confer no authority.

## Storage and interfaces

`.bionic/registry.sqlite` stores the catalog, immutable revisions, idempotent
publication records, and summary evidence. Logical paths never become model-chosen
host paths. Transactions enforce stale-write checks across connections; quotas
bound revision count and artifact bytes. Run history retains bounded script inputs and final outputs by default; intermediate
API payloads are not captured. See [run history](docs/run-history.md) for retention
and access settings. Pi sessions live in `.bionic/sessions` and can contain tool results.

`ScriptRepository`, `EvidenceRepository`, `ExecutionBackend`, `CapabilityProvider`,
and `ToolService` separate the core from Pi and SQLite. SQLite is the first
adapter; tests exercise it in memory and on disk. Git review, remote stores, HTTP
event intake, durable workflows, and real-model evaluation remain future work.

## Design

- [Architecture](docs/architecture.md)
- [Interfaces and future integrations](docs/interfaces.md)
- [Lifecycle and autonomy](docs/lifecycle.md)
- [Script composition](docs/composition.md)
- [Agent prompt](docs/agent-prompt.md)
- [Implementation status and next steps](docs/future.md)
- [Runtime modules and Pi loaders](docs/runtime-modules.md)
