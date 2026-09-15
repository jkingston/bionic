# Core interfaces and integration adapters

Interface specification. Script, evidence, capability, execution, and tool
boundaries are implemented; Git review and event intake remain future work.

## Boundary decisions

Pi and scripts are clients of the same ToolService, as specified in
[script composition](composition.md). Pi is one client of the Bionic application service. An HTTP event receiver can
be another. Neither owns script storage, review rules, or execution policy.
Core services depend on domain operations, not filesystem paths, SQL, Git refs,
HTTP requests, or Pi context objects. The script-only Pi tool surface remains.

```text
Pi tools ────────────────┐
HTTP event adapter ──────┼─> Bionic application services
Review adapter ─────────┘       ├─ ScriptRepository
                               ├─ EvidenceRepository
                               ├─ ReviewGateway
                               ├─ ExecutionBackend
                               ├─ CapabilityProvider
                               └─ WorkRepository (event-enabled deployments)
```

These are logical boundaries, not separate deployed services. One SQLite
adapter can implement several persistence interfaces. Start with one backend;
do not build a generic database abstraction or a universal event bus.

## Identity, hierarchy, and references

A script has a stable script ID within a registry. Its logical path is a mutable
catalog entry. Folders are inferred from path prefixes. Revisions contain source,
contracts, fixtures, and provenance; their content hash excludes the current
path and mutable discovery metadata. Moving a script does not change executable
content or invalidate verification. A recorded creation path may remain provenance.

An execution reference is `{ registryId, scriptId, revision, contentHash }`.
The revision is opaque to clients: a backend may map it to an integer or a Git
object. Reads return this reference; execute and verify accept it and validate
its hash. Human-facing paths are selectors, never execution identity. Existing
path/version tools should resolve and check an expected reference before acting.

There are independent pointers: the latest authored revision and the active
revision per execution scope. Activation selects a revision for reuse and may require library review; it does
not grant runtime authority. Quality requirements on execution are opt-in by scope. A new draft never
displaces the active revision. No need for multiple branches in v1. The
[lifecycle specification](lifecycle.md) defines transitions and API-sourced context.

## Interface sketches

The following signatures describe domain operations, not a finished TypeScript
SDK. Named request/result types are serialized domain records. Each call also
receives a trusted context containing principal, scope, request ID, and optional
cancellation signal. Authentication adapters construct this context; model input
cannot choose its own principal or permissions.

```typescript
interface ToolService {
  definitions(context: InvocationContext): Promise<ToolDefinition[]>;
  invoke(
    name: string,
    args: JsonValue,
    context: InvocationContext,
    signal: AbortSignal,
  ): Promise<ToolResult>;
}

interface ScriptRepository {
  resolve(selector: ScriptSelector): Promise<ScriptSummary>;
  read(ref: ScriptRef): Promise<ScriptArtifact>;
  list(query: ListQuery): Promise<Page<ScriptSummary>>;
  search(query: SearchQuery): Promise<Page<SearchHit>>;
  publish(request: PublishRevision): Promise<Publication>;
}

interface EvidenceRepository {
  append(record: EvidenceRecord): Promise<void>;
  query(query: EvidenceQuery): Promise<Page<EvidenceRecord>>;
}

interface ReviewGateway {
  request(request: ReviewRequest): Promise<ReviewHandle>;
  decision(review: ReviewHandle): Promise<ReviewDecision>;
}

interface ExecutionBackend {
  execute(request: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult>;
}

interface CapabilityProvider {
  definitions(scope: CapabilityScope): Promise<CapabilityDefinition[]>;
  invoke(request: AuthorizedCapabilityCall): Promise<JsonValue>;
}

interface WorkRepository {
  accept(event: ExternalEvent): Promise<EventReceipt>;
  claim(request: ClaimWork): Promise<LeasedWork | null>;
  complete(request: CompleteWork): Promise<void>;
  retry(request: RetryWork): Promise<void>;
}
```

### Repository semantics

`publish` atomically records an immutable revision and changes the draft pointer
only if the expected current revision still matches. New paths use create-only
semantics. Unique paths, stale-write detection, and read-after-publication must
hold across backend implementations. A request ID makes retrying an uncertain
publication return the original result, not create a second revision.

No separate generic catalog/blob-store interfaces initially: coordinating their
transactions would leak into callers. A backend can split them internally. An
object-store adapter must upload immutable content before atomically exposing its
catalog reference; orphan cleanup is internal and cannot delete live content.

`list` supports prefix, bounded page size, opaque cursor, and deterministic order.
Search indexes are derived, may lag, and never authorize execution. Search and
read apply access filtering before returning any metadata or source. `grep` is
literal bounded source search; `find` uses the same defined glob subset on every
backend. Do not expose backend-specific query syntax or claim identical relevance
scores across search engines. Tags are optional discovery metadata, not policy.

Return typed failures: not-found, conflict, invalid-input, forbidden, unavailable,
and unsupported. An adapter that cannot guarantee publication semantics must
reject configuration rather than silently weaken them. Defer rename/delete APIs
until needed, while stable identity permits adding them later.

### Evidence, review, and execution

Evidence includes verification, execution, and review observations with unique
record IDs. Appends are idempotent by ID. Verification is tied to content hash,
runner version, capability contracts, and fixture results. Human acceptance is
separate evidence: tests passing cannot approve a script, and approval cannot
make failed verification pass.

Quality policy is independent from authorization. Local runs have no default
test/review gate; shared publication may require human acceptance. The agent may
submit authored revisions for review through the write workflow, but has no
self-approval operation. Write/edit results report draft and review status.

A review decision identifies the exact artifact hash, reviewer identity, policy
scope, and external evidence reference. Authenticate external decisions. Before
execution, application policy checks the exact revision, caller authorization,
capability scope, inputs, and budgets. Quality evidence is consulted only when
that scope explicitly requires it. If enforcement is unavailable, execution
fails closed; an optional review service outage does not block permitted runs.
New hashes have no inherited review evidence, but need no permission renewal
when the existing grant covers the operation. A rename alone does not invalidate content review, but must not
preserve access if authorization scope changes.

Execution admission records the policy decision used. Revocation blocks future
admissions; cancellation of an already running operation is a separate action
and cannot undo completed external effects. The runner receives an immutable
artifact and bounded permissions, not Git credentials or unrestricted storage.

## Git-backed storage and human review

Git storage and human review are related but independent integrations. A local
Git repository does not require a pull-request service; an HTTP registry could
also use a review provider.

Proposed hosted-Git workflow:

1. `write` or `edit` publishes a draft revision through ScriptRepository.
2. Application policy asks ReviewGateway to create or update a review request.
3. Verification records reference that exact artifact hash.
4. An authenticated review observation establishes acceptance of that hash.
5. Library policy publishes the accepted reference; execution independently
   checks current grants. Draft runs need not wait for shared publication.

The adapter owns branches, commits, patches, and any review-provider API calls.
Pi receives script paths, revision IDs, and review links, with no Git shell tool.
A merge is acceptance only when configured policy says so. If merging or human
editing changes the artifact, re-extract its hash and obtain matching evidence;
never transfer approval blindly from the earlier proposal. Default-branch HEAD
is not an execution reference.

## HTTP events

HTTP is an inbound adapter, not a script store or a host capability by default.
It authenticates the sender, bounds and validates payloads, and converts them to
an ExternalEvent with source, event ID, type, scope, received time, and JSON data.
Return an accepted receipt only after durable `WorkRepository.accept` succeeds.
Deduplicate on scope/source/event ID; reject a duplicate ID with different content.

A configured trigger maps an event type to either:

- a pinned script reference and validated input mapping; or
- an agent work request constrained to an explicit registry/capability scope.

Payloads do not select arbitrary scripts, supply executable source, change
review policy, or become privileged prompt instructions. Resolve any active
script alias once at admission and persist the resulting reference for retries.

Workers lease queued work with expiry and fencing tokens. Completing or retrying
requires the current lease token; crashes permit later recovery. Use an outbox
or equivalent atomic transaction when durable work also needs external dispatch.
Queue delivery is at least once, not exactly-once execution. External effects
need their own idempotency keys or reconciliation; uncertain effects return an
unknown outcome rather than being blindly retried. Track event/run correlation
and bound retries with a failed-work state. HTTP receipts acknowledge intake,
not successful script execution.

## Initial implementation scope

Implement the Pi adapter, ScriptRepository, EvidenceRepository, ExecutionBackend,
and CapabilityProvider with one local storage backend. Provide a bounded
authorization policy with no default quality gate; do not simulate acceptance. Repository
tests cover the SQLite adapter in memory and on disk. An independent reference
backend is not implemented.

Keep ReviewGateway and WorkRepository as specified extension points until a
review or event integration is built. At that point test restart recovery,
duplicate delivery, changed review hashes, stale approvals, and unavailable
authorities. No live HTTP server, Git integration, or review request is created
by this design change.

## Operational context

Expose task envelopes, events, run evidence, and descriptive policy through
scoped read-only capabilities as those services are implemented. Tool results
provide explicit retrieval; prompt injection of background facts, hidden memory,
and conversation-dependent workflow recovery are outside this design. See
[lifecycle.md](lifecycle.md) for bootstrap and future workflow contracts.
