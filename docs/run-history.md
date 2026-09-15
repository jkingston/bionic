# Run history and reusable results

Run history serves recovery, debugging, result reuse and human inspection. It is
not an automatic cache or resumable workflow engine. Reading a result never
executes a script, and a successful historical observation may no longer be true.

## Execute and inspect

```js
const run = await host.tools.invoke('execute', {
  ref: input.ref,
  input: input.arguments,
  result: 'reference',
});
const saved = await host.tools.invoke('runs', {
  action: 'output',
  runId: run.runId,
  pointer: '/items',
});
return saved.output;
```

Declare both `execute` and `runs` in the wrapper's tools, plus the capabilities
and tools needed by its child. Reference mode omits inline output; it does not
change execution, storage, or work output budgets. Default inline mode returns
output as before. Both responses include a durable run ID, exact script reference,
path at execution, work/parent IDs, principal, timestamps, status, call/child counts,
and input/output availability. Storage completes before the result is returned.
If retention is disabled or a payload exceeds its storage limit, reference mode
reports `not_retained`; use inline mode when you need that value immediately.

Saved input is the script's JSON argument, not the conversation or full work context.
Call traces record names, kind, timing, outcome and bounded errors, not API payloads.

## The runs tool

| Action   | Parameters                                                                                                                      | Result                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `list`   | Optional `path`, exact `ref`, `workId`, `parentRunId`, `includeChildren`, `kind`, `status`, `since`, `until`, `limit`, `cursor` | Paginated run summaries; no payload bodies          |
| `get`    | `runId`, optional `limit`, `cursor`                                                                                             | Run metadata and paginated completed call summaries |
| `input`  | `runId`, optional `pointer`                                                                                                     | Retained input and provenance/availability          |
| `output` | `runId`, optional `pointer`                                                                                                     | Retained output and provenance/availability         |

Paths select a script (`sre/check.js`) or folder (`sre/`). A reference matches one
exact revision. Time filters are inclusive UTC ISO timestamps, e.g.
`2026-09-15T09:00:00.000Z`. Defaults are ten newest top-level execution runs;
`kind: 'fixture'` selects fixture runs and `kind: 'all'` includes both kinds.
`includeChildren: true` includes nested executions; `parentRunId` selects direct
children. A parent can succeed after catching a child's failure; inspect both.

Lists and calls use newest-first cursor pagination, at most 50 records per page.
Keep the query unchanged when following a cursor. New insertions do not duplicate
previously listed records. Retention can remove older records while browsing.
`get.calls.nextCursor` continues that run's calls; use `list` with `parentRunId`
for its children. Call order is completion order; timestamps show when each began.

Payloads support JSON Pointer: an empty pointer selects the whole value;
`/items/0` selects an array item; `~1` escapes `/` and `~0` escapes `~` in keys.
Responses are limited to 64 KiB and charged to the work's output budget. Oversize
responses return a limit error; choose a smaller page or field. JSON is never
silently truncated. Arbitrary queries, transformations and slice syntax are not
supported; use scripts to process retrieved values.

## Lifecycle and result states

A record is written before the WASM worker starts. Its status is `running`, then
`success`, `error`, `cancelled`, or `timeout`. Rejected requests (unknown references,
invalid inputs, missing permissions or capacity) return tool errors before a run
starts; they do not pretend an execution took place.

An unfinished record observed after its persisted execution deadline reports
`unknown`, with no invented completion timestamp. Opening a second runtime does
not interrupt active runs. A late completion can still finalize the record. This
is conservative crash visibility, not restart recovery or automatic replay.

Payload availability is independent of execution status:

- `pending`: the run has not produced an output yet.
- `available`: the exact JSON value is retained, including JSON `null`.
- `not_retained`: host policy or the per-payload size limit prevented storage.
- `expired`: TTL or the total payload quota removed a previously stored value.
- `absent`: no output was produced, or the run's outcome is unknown.

Availability includes byte size and, when applicable, expiry time. Metadata remains
queryable after payload expiry until the metadata quota removes that run.

## Human interface

`execute` renders status, script/revision, duration, call/child counts, output
availability and a run ID. Expand the tool result for structured detail; use
`/bionic run <id>` for inspection without another agent turn. UI expansion does not
change model context size; reference mode does.

`/bionic runs [script or folder]` opens a selectable, paginated history list with
refresh. Selecting a run opens input, output, completed calls and child navigation.
Payload views accept a JSON Pointer. Escape/back leaves the view. Run IDs remain
visible for copying into tools and scripts. Noninteractive commands show summaries.

## Runtime, access and retention

The Pi-independent `RunRepository` contract lives in `lib/runs.ts`. SQLite implements
it alongside the script repository, with separate metadata, call and payload tables.
Other adapters can store payloads separately without changing the tool interface.
Embeddings call `runtime.history(request)`; scripts call `host.tools.invoke('runs',
request)`. Both use the same authorization and response limits as the Pi tool.

By default callers can see only their principal's runs within their readable script
prefixes. Explicit host `RuntimePolicy.historyPrincipals` can add shared principals.
Run IDs alone confer no access. Unknown and inaccessible runs return the same error.
Scripts must declare `runs`; access inherits through composition and is unavailable
in fixture verification so tests cannot depend on live history. Historical payload
access is an explicit data permission; it does not re-invoke module authorization.

```ts
const runtime = await createRuntime({
  root: './script-data',
  modules: [],
  policy: { principal: 'analyst', historyPrincipals: ['scheduled-reader'] },
  history: {
    retainInputs: true,
    retainOutputs: true,
    ttlMs: 7 * 86400000,
    maxPayloadBytes: 262144,
    maxTotalBytes: 64 * 1024 * 1024,
    maxRuns: 5000,
  },
});
```

These are the default retention settings. `createBionicExtension(policy, history)`
accepts the same settings for programmatic Pi embeddings. Payload expiry is cleaned
up on history access or execution; there is no background worker. Quota pressure
removes the oldest payloads first, then oldest non-live run records when the run
count limit is reached. If all record slots are occupied by live runs, new runs
fail before executing. Per-run call traces are limited to 1000 calls. SQLite reuses
freed pages; deletion does not promise secure erasure or immediate file shrinking.
Pi session transcripts have separate retention and can contain inline tool results.

Metadata/output retention, shared access and budgets are host configuration, never
agent-authored options. No per-run review or approval is required. Live streaming,
visual comparisons, exports and durable workflow resumption remain future work.
