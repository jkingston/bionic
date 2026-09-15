# Bionic: a durable program library for Pi

Architecture · 2026-09-15 · Pi/WASM vertical slice implemented; see [status](future.md)

## Product boundary

Pi owns reasoning, model credentials, conversation, and the terminal interface.
Bionic owns reusable executable procedures and evidence for trusting them.
There is no second agent loop or Python service in the target design.

The invariant becomes **capability survives a fresh session**. Normal Pi sessions
retain history. Bionic must discover and run programs without that history.
The default demo uses separate fake SRE, clock and catalog provider extensions.
Deployments can load their own API extensions through the public provider SDK;
see [provider authoring](provider-extensions.md).

## Pi integration

Use a TypeScript extension factory, `pi.registerTool`, and `pi.registerCommand`.
Initialize project state on `session_start`; clean up workers on
`session_shutdown`. Use the static [agent operating prompt](agent-prompt.md);
do not inject operational context or rewrite prompts per task. Return concise
text in tool `content` and structured records in `details`.

Package discovery uses `"pi": { "extensions": ["./dist/extensions/bionic.js"] }`
in package.json. Pinned Pi 0.85.1 uses `@earendil-works/pi-coding-agent` and
`typebox`; the installed package versions are locked in package-lock.json. See the official [extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
and [package format](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md).

Disable all Pi built-in tools and expose only the controlled script tools below.
Keep ordinary conversation history; operational context must be retrieved through
authorized APIs, not injected summaries or memory. The launcher loads only the trusted Bionic extension and checks
the exact active tool allowlist on startup and reload; an unexpected tool causes
startup to fail. Other extensions must not introduce alternative access paths.
Do not register each saved script as its own tool.

## Components

[Core interfaces and integration adapters](interfaces.md) specifies the backend
contracts, Git review workflow, and future HTTP event intake.
[Lifecycle and autonomy policy](lifecycle.md) defines activation, review, durable
work, and API-sourced context. Pi is one client
of the application services; storage and review are independent adapters.

```text
Pi agent + controlled script tools
  └─ Bionic extension
       ├─ Program registry + verification records
       └─ Execution supervisor
            └─ Disposable worker
                 └─ Named host capabilities via IPC
```

Implemented layout:

```text
bin/bionic.mjs            Controlled Pi launcher
extensions/bionic.ts     Pi lifecycle, tool adapters, rendering, status
lib/contracts.ts         Domain interfaces and grants
lib/schemas.ts           Shared tool parameter schemas
lib/service.ts           Tool dispatch, verification, nested execution
lib/policy.ts            Work grants and aggregate budgets
lib/validation.ts        Paths, source shape, JSON contracts, content hashes
lib/worker.mjs           QuickJS WASM guest and JSON bridge
lib/adapters/sqlite.ts   Transactional script and evidence repositories
lib/adapters/wasm.ts     Worker scheduling, deadlines, cancellation
lib/adapters/fake-sre.ts Deterministic read-only capabilities
lib/application.ts      Dependency wiring and work-context bootstrap
lib/prompt.ts           Static agent operating instructions
tests/                  Registry, WASM, composition, actual Pi integration
```

Pi context objects stay in the adapter; core services use JSON and cancellation
signals, so they can be tested independently.

## Agent interface

All paths are logical script paths, such as `sre/checkout/diagnose.js`, not host
filesystem paths. The model sees a hierarchy of script artifacts, not `.bionic`
implementation files, run logs, or arbitrary workspace files.

| Tool                                               | Behavior                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `read(path, revision?)`                            | Read script source and contract; return the resolved version/hash                           |
| `write(path, source, contract, expectedVersion)`   | Create a script or publish a new draft version; null expectedVersion means create-only      |
| `edit(path, baseVersion, edits, contractChanges?)` | Apply exact source replacements or contract changes to that version and publish a new draft |
| `ls(path?)`                                        | List logical script folders and script summaries                                            |
| `find(pattern, path?)`                             | Match script paths within the hierarchy                                                     |
| `grep(pattern, path?)`                             | Search script source and descriptive contract fields, with bounded results                  |
| `search(query, path?)`                             | Rank scripts by purpose, tags, capabilities, and compatibility                              |
| `verify(ref)`                                      | Execute saved script fixtures with fake adapters and record evidence                        |
| `execute(ref, input)`                              | Execute an exact saved script version with JSON input within existing grants                |
| `capabilities()`                                   | List the API contracts available to scripts; does not invoke them                           |

This is the complete ten-tool surface. `read`, `write`, and `edit` are custom
script-registry operations, not wrappers granting general filesystem access.
There is no bash, shell command string, inline-code execution, or host-path
argument. The discovery tools operate over scripts; verification and execution
accept saved script references only. `capabilities` supplies script-authoring
metadata. Environment interaction happens through executing scripts.

Writes and edits preserve immutable history. Require the current version to
match expectedVersion/baseVersion under the publication lock; reject conflicts
with the current version so the agent can reread and retry. Edits require each
replacement target to match exactly once. Changed source or contract invalidates
verification for the new version. Discovery defaults to one current version per
script and reports verification state; `read` can select historical versions.
`read` returns an immutable registry/script/revision/hash reference. `execute`
and `verify` pin that reference (or validate it alongside a path/version selector);
they never execute a moving latest. Revisions are opaque outside the backend.

`/bionic` shows status; `/bionic inspect path@version` shows evidence;
`/bionic runs` shows recent outcomes. These user commands do not grant additional
model tools. Non-interactive use returns structured results without UI prompts.

## Artifact and verification contracts

Each immutable artifact contains:

- Format version, stable script ID, opaque immutable revision, timestamp, and
  provenance (origin session and optional parent artifact). Logical paths and
  optional discovery tags live in the catalog; moves do not change script identity.
- Description and usage guidance, carried with the revision.
- Runtime `javascript` and ES module source exporting `async main(host, input)`.
- Valid JSON Schema input/output contracts.
- Required capabilities as explicit name/version pairs.
- Fixtures: input, expected host calls and responses, and expected output.
- A content hash over the canonical artifact payload excluding the hash field.

Programs use `await host.invoke(name, args)` for environment APIs and
`await host.tools.invoke(name, args)` for the same ten tools exposed to Pi.
[Script composition](composition.md) specifies nested execution, one-offs, and
shared permission/budget enforcement. No dependency installation or imports in
v1. TypeScript is used for the extension;
JavaScript artifacts avoid requiring a transpilation pipeline.

Verification checks source shape, schema validity, capabilities, fixture calls,
and output. Records bind to artifact hash, runner version, and capability
versions. Missing or failing fixtures are quality evidence, not a default execution
ban. Drafts may execute within existing grants. Review or passing verification
is required only where the execution scope explicitly configures that condition.
A passing fixture is limited evidence, not proof of general correctness.

Results contain status (`success`, `error`, `cancelled`, `timeout`, `unknown`),
run ID, artifact hash, duration, JSON output or typed error, and host-call summary.
An interrupted external effect may be unknown; do not automatically retry it.

## Registry

The application depends on ScriptRepository, not a storage path. A local backend
may use `<Pi cwd>/.bionic/`; remote backends expose a registry identity. Status
shows the configured registry and scope. Backend selection does not change the
script hierarchy or grant model access to the underlying filesystem or network.

Expose `/` as the logical folder separator. Require nonempty relative paths;
reject absolute paths, backslashes, empty segments, `.` and `..`, invalid revisions,
and control characters. Folder segments use letters, digits, `_`, and `-`; leaves
add `.js`. Use case-sensitive paths and infer folders from prefixes. Resolve paths
to stable script IDs through the catalog, never by joining arbitrary host paths.

The catalog owns mutable path mappings and draft/accepted revision pointers.
Immutable revisions and evidence are authoritative records; search indexes are
rebuildable. Publication must atomically enforce unique paths, expected revision,
and idempotency regardless of storage backend. File adapters need race-safe
containment and cross-process publication; database adapters use transactions;
Git adapters own ref coordination. Corrupt records are reported explicitly.

Rank path, description, and capability matches; optional tags can be added later.
Return bounded results with explicit verification/review state. Historical
revisions remain readable by reference. Search may lag publication; exact reads
must work once publication succeeds. Search results never authorize execution.

Program text is data, never system instructions. Run logs default to summaries;
exclude credentials and unrestricted host payloads. Artifacts may be committed
for deliberate sharing; ignore local configuration and run records in Git.

## Execution and trust

Safety is enforced containment, independent of code quality. Untested scripts
can run autonomously within their existing envelope. The parent checks each
actual API operation, target, input, and cumulative work budget. Code edits and
retries neither renew permissions nor reset limits. Only a concrete expansion
of authority requires a new grant; ordinary failures return repairable errors.

Scripts run in QuickJS compiled to WebAssembly, inside a disposable Node worker
thread. They are never evaluated by Node/V8. There are no guest filesystem,
network, process, WASI, module-loading, or native-object imports. The only bridge
accepts bounded JSON tool/API calls and applies permission checks outside WASM.
No OS container backend is required or used.

The QuickJS runtime enforces a 32 MiB heap limit and bounded stack. Interpreter
interrupts and a parent timer bound execution; cancellation terminates the worker
and drains nested calls. All descendants share work-level calls, writes, source,
output, deadlines, and concurrent-worker limits. No worker waits indefinitely for
child capacity: excess nesting/concurrency returns a limit error.

Authorized registry writes use the broker, not direct storage access. Every
child executes an immutable reference even if a script edits its own path.
Quality status does not confer access or gate ordinary execution.

The first provider exposes only fake read-only SRE APIs and work/policy context.
CapabilityProvider requires target authorization as well as invocation; a future
real adapter must implement its own resource checks. Grants are loaded from
trusted configuration at the start of each user prompt. Live revocation and
interactive grant issuance remain future integrations; cancellation stops the
current work. The trusted Pi host itself is not a WASM guest.

## Sessions and recovery

The configured repository and evidence stores are authoritative. Session records link to program/run IDs but
are never required to restore capability. Forking or navigating history does not
rewind published versions or replay executions. Shutdown cancels workers; reload
must not duplicate handlers or leak processes. A source or schema change creates
a new version with no inherited quality evidence; permissions remain governed
by existing grants rather than code changes. Verification is optional unless
explicitly required by the execution scope.

## Migration decisions

| Original                       | Redesign                                          |
| ------------------------------ | ------------------------------------------------- |
| PydanticAI loop and CLI        | Pi owns loop and UI                               |
| Five exclusive tools           | Ten exclusive tools over a script hierarchy       |
| No history each prompt         | Ordinary sessions; fresh-session benchmark        |
| Python in-process execution    | QuickJS WASM with explicit JSON imports           |
| Schemas/API lists are metadata | Enforced contracts and capability checks          |
| Save implies availability      | Draft, verification, compatibility                |
| Temporal/WASM roadmap          | Prove reuse, then expand execution infrastructure |

The Python prototype and its environment have been removed. This repository now
ships only the Pi implementation; scripts use JavaScript.
