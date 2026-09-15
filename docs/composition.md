# Scripts can compose agent tools

Composition is implemented through the shared ToolService and WASM JSON bridge.

## One tool service, two callers

Every Bionic agent tool is also callable from a script through the same typed
ToolService. Pi's extension handlers are adapters to that service, not the
implementation a script calls. This does not require invoking Pi internals or
starting another model turn.

```text
Pi tool adapter ───────────────────┐
                                 ├─ ToolService → domain services
script → worker IPC → tool broker ┘                  ├─ registry
                                                    └─ execution
```

Expose all eleven tool contracts through `host.tools.invoke(name, args)`: read,
write, edit, ls, find, grep, search, verify, execute, capabilities, and runs. The script
uses `host.invoke(name, args)` for environment APIs. Both surfaces share trusted
invocation identity and resource accounting but have distinct names and schemas.
The capabilities result includes permitted tool contracts as well as environment
API contracts, so discovery still works entirely through APIs.

Add a core ToolService interface with `definitions(context)` and
`invoke(name, args, context, signal)`. Context is injected by the application,
never accepted from script JSON. Registry access, exact script execution, and
policy checks use the same implementation for both callers. Scripts receive
structured JSON results rather than Pi rendering objects; the Pi adapter wraps
those results for display. Do not route calls through a generic Pi tool dispatcher.

## Example: a one-off batch

Illustrative source, using `match.ref` as the immutable reference returned by search:

```javascript
export async function main(host, input) {
  const found = await host.tools.invoke('search', {
    query: 'service latency diagnosis',
  });
  const match = found.items.find((x) => x.path === 'sre/diagnose-latency.js');
  if (!match) return { status: 'missing-script' };

  const results = [];
  for (const service of input.services) {
    const run = await host.tools.invoke('execute', {
      ref: match.ref,
      input: { service },
    });
    results.push({ service, run });
  }
  return { results };
}
```

Pi can save and execute this wrapper in two tool calls, instead of performing
a model turn for each service. The wrapper can also inspect source, edit or
write another script, and execute the exact returned revision. It supplies
source as data; these tools do not themselves generate code or invoke an LLM.
Test results, code review, and publication status remain independent of authority.

## One-offs are saved scripts too

Keep `execute` reference-only. Use an ordinary scope such as
`scratch/batch-latency.js` for the wrapper, with ordinary versioned storage. Retention metadata is a future extension. Scratch is a catalog convention, not a different execution privilege.
Saving there is autonomous under the existing registry grant and does not publish
the wrapper into a reviewed shared library. Search can exclude scratch by default
unless that scope is requested; all entries remain discoverable through ls/find.

No mandatory promotion, tests, or review before running a one-off. A useful
wrapper can later be published through the normal library process. The initial
implementation retains scratch revisions indefinitely; any later garbage
collection must respect active runs, durable workflow references, and configured
audit retention. Never delete live artifacts solely because a TTL has elapsed.

## Authority cannot grow through composition

The parent broker authenticates each nested call using the original principal
and current work item. Effective child authority is the intersection of the
parent envelope, any narrower child declaration, and current service policy.
Script ownership, shared-library status, or a review signature grants no additional
rights. Writing a script with broader capability requests does not authorize them.

The declaration includes requested tool operations as well as environment APIs.
Invoking execute or verify starts a child run through the normal execution service,
with an exact immutable reference. Dynamic selection is allowed inside current
grants; scopes that require pinned dependencies can impose that explicit policy.
The selected reference is logged for every nested call.

- All calls share aggregate time, spending, output, and API-call budgets.
- Child deadlines cannot exceed the parent's, and cancellation propagates.
- Bound nesting, concurrent children, source size, and registry growth. Prevent
  unbounded recursion and fan-out; use deterministic defaults, not prompts.
- Never hold repository transactions or publication locks while executing a
  child. Avoid scheduler deadlocks when a parent waits for child capacity.
- Writes and edits retain idempotent publication and stale-revision checks.
  A running script always uses its pinned source even if it edits its own path.
- Read/write grants apply to logical registry scopes. Workers have no direct
  registry filesystem access; authorized mutation is possible only via the broker.
- Tool errors and partial batch outcomes return structured results. No implicit
  rollback of earlier effects and no blind retry of an uncertain mutation.

Record parent run ID, child run ID, tool operation, artifact reference, request
ID, and policy outcome. These nested operations need not be separate Pi tool
calls: the execute renderer can show their progress and provide a trace link.
Permission expansion is reported through the root invocation's normal grant
flow; scripts cannot create approval dialogs or approve themselves.

## Acceptance criteria

Both Pi and script callers exercise the same ToolService contract tests. Verify
search/read/write/edit/verify/execute composition, explicit child references,
self-edit snapshot behavior, scope-denied registry mutations, and equivalent
permission decisions for both callers. Test nested cancellation, shared retry
budgets, recursion/fan-out bounds, concurrent edits, and scheduler saturation.
No test or review requirement is added solely because a caller is a script.

## Saved results

Scripts can declare `runs` to retrieve retained inputs and outputs from earlier runs,
including across sessions. `execute` supports reference results for later processing.
History access inherits principal and path restrictions, consumes cumulative budgets,
and is unavailable during fixture verification. See [run history](run-history.md).
