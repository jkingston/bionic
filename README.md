# Bionic for Pi

A script-only Pi agent. Pi can discover, write, edit, and execute versioned
JavaScript scripts. Scripts can call the same tools to compose one-off work.
The Python/PydanticAI proof of concept has been removed.

## Run

With mise, use your existing Pi login and model configuration:

```bash
mise install
mise run setup
mise run models
mise run pi --model 'provider/model-id'
```

The `pi` task loads only Bionic and disables built-in tools, context files, skills,
and prompt templates. It retains your normal Pi configuration directory (or your
`PI_CODING_AGENT_DIR` override). Additional Pi arguments are passed through;
use this task with trusted arguments. `mise run demo` runs without credentials,
`mise run validate` runs all development checks, and `mise run format` formats files.

Alternatively, run with npm and credentials from the environment:

Requires **Node 24+**, npm, and a model provider API key. Pi 0.85.1 is pinned in
the package; no separate global Pi install is required.

```bash
npm ci
export ANTHROPIC_API_KEY=...
npm start -- --provider anthropic --model YOUR_MODEL
```

`npm start` uses a dedicated temporary Pi configuration, disables built-in tools,
context files, skills, prompt templates, and extension discovery, and loads only
Bionic. Model credentials are read from the environment; the launcher does not
reuse your global Pi login. `/bionic` shows status; `/bionic runs` shows recent
evidence. Shell `!`/`!!` commands are disabled. Each user prompt begins a work
budget; nested calls and agent repair attempts within that prompt share it.

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

The default grant permits all ten script tools over the local registry and only
fake SRE services (`checkout`, `payments`, `auth`) plus `work.current` and
`policy.describe`. There are **no real external service integrations**.
The broker checks declarations, grants, API schemas, and actual target services.
Nested calls share cumulative calls, writes, source/output, time, and worker limits.
Untested or failed-test scripts may run within those limits. Code review grants
no authority, and there is no automatic permission escalation.

A human can supply `.bionic/grant.json` matching the `Grant` type in
[contracts.ts](lib/contracts.ts). It is loaded at the start of each user prompt;
changes apply to the next work item. For immediate interruption, cancel the
current Pi turn. The model cannot edit this file through script tools. Interactive
grant approval and live revocation services are not implemented.

## Storage and interfaces

`.bionic/registry.sqlite` stores the catalog, immutable revisions, idempotent
publication records, and summary evidence. Logical paths never become model-chosen
host paths. Transactions enforce stale-write checks across connections; quotas
bound revision count and artifact bytes. Evidence excludes raw inputs/outputs by
default. Pi sessions live in `.bionic/sessions` and can contain tool results.

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
