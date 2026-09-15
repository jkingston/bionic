# Script and workflow lifecycle

Lifecycle specification; script execution implemented, review/workflow services pending. This refines the policy and
context boundaries in [interfaces.md](interfaces.md).

## Context comes from APIs

Operational facts, work inputs, policies, prior outcomes, and environment state
must be available through authenticated APIs. Do not inject incident summaries,
registry inventories, private memories, or selected documents into the system
prompt. The static [agent operating prompt](agent-prompt.md) supplies operating
instructions, not operational memory. No per-task prompt rewriting or
compaction-driven memory mechanism.

A task instruction or event/work reference supplies intent. Tool schemas supply
the calling contract. The agent discovers script artifacts through registry
APIs and environment capabilities through `capabilities`. It obtains operational
context by executing scripts against authorized APIs. Tool results necessarily
enter the model input; the requirement concerns their authoritative source and
explicit retrieval, not eliminating model input altogether.

Reserve runtime-supplied read-only capabilities such as `work.current`,
`events.read`, `runs.read`, and `policy.describe` for the corresponding implemented
services. `work.current` is scoped to the current invocation and returns a
structured task envelope; raw event payloads are data, not privileged directions.
API responses carry source identifiers, relevant versions, and observation times.
Missing facts produce unavailable/unknown results rather than invented context.
Authorization is checked server-side; policy descriptions are not authorization.

Bootstrap through the existing tools: `capabilities` reveals contracts, then
`read` obtains an appropriate verified context-fetching script, or the agent
writes and executes one within its grant; verification is optional. Ship minimal verified retrieval scripts for initial
work-context APIs to avoid circular discovery. These scripts are ordinary
versioned artifacts, not hidden prompt instructions. The application binds work
identity and authorization; script arguments cannot impersonate another work item.

Fresh-session evaluation uses only the task reference, tool schemas, registry,
and authorized APIs. Existing Pi history may aid conversation, but is never the
sole source of facts needed for execution. Recheck time-sensitive facts before
acting. No workflow depends on conversation replay for durable recovery.

## Independent quality and authority

[Scripts can compose agent tools](composition.md), including authoring and
executing other scripts, under the same authority and aggregate budgets.

The agent may produce incorrect code. The system must contain its effects.
Safety comes from enforced permissions and isolation, not confidence in code.
Within an existing grant the agent can write, persist, execute, inspect failures,
and retry corrected revisions without human approval or passing tests first.
A draft is a quality/publication status, not an execution prohibition.

Two independent lifecycles:

```text
Quality:   saved revision → optional tests/review → published library revision
Execution: saved revision + input → authorize → run within limits → record outcome
```

Tests and code review produce evidence about an exact content hash. New revisions
do not inherit that evidence. A shared library can require review for publication,
while the same draft remains runnable within the author's existing authority.
A published revision carries no ambient permissions. Activation selects the
revision used by a library or trigger; it does not create an execution grant.

An execution policy may explicitly require quality evidence for a particular
scope, such as production unattended workflows. That is a configured requirement,
not the default for every execution. No fixtures, failing tests, or unavailable
review services do not by themselves block otherwise authorized exploratory runs.
Malformed artifacts, invalid API arguments, and unsupported runtimes are still
rejected as interface/runtime failures rather than approval requests.

## Safety envelope and autonomous behavior

The application derives the effective execution envelope from the caller's
existing grants, workflow limits, and script-requested capabilities. A script
can narrow its authority, never expand it. Checks apply to every capability call
and actual target, not just the initial declared capability list.

Enforce outside generated code:

- WASM isolation: no guest filesystem, network, process, WASI, or native-object
  imports. Registry mutations and environment access go through authorized
  JSON tool/API calls. One-offs use logical scratch script paths, not guest files.
- Capability policy: permitted operations, resource identities, argument/value
  constraints, and authorized data destinations.
- Resource limits: runtime, memory, processes, output, API rate, and expenditure.
- Aggregate limits across retries and related runs; spawning another script or
  restarting a run cannot reset the work item's budget or escalate authority.
- Mutating APIs: scoped effects, atomic server-side validation, and idempotency
  or explicit reconciliation for uncertain outcomes.

An allowed broad capability can still do damage if called incorrectly. Therefore
choose grants whose worst permitted effects are acceptable: for example, changing
a test service within a bounded environment rather than unconstrained production
administration. Read access also needs appropriate data scope and destination
controls. Tests cannot repair an overbroad grant. This contains bad code; it does
not promise perfect business outcomes for every authorized operation.

If the sandbox or authorization service cannot enforce the envelope, stop the
affected execution with an actionable error. Do not ask for permission to bypass
containment. Normal code failures return diagnostics so the agent can fix and
rerun within the same grant.

## Human involvement

| Situation                                                          | Behavior                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------- |
| Save/edit a draft or inspect scripts                               | Autonomous within registry scope and quota                    |
| Run an untested or failed-test revision                            | Autonomous within the existing envelope                       |
| Repeat an authorized bounded mutation                              | Autonomous; respect idempotency and cumulative limits         |
| Publish into a reviewed shared library                             | Follow its code-review policy, separately from runtime access |
| Need a new resource, operation, data destination, or higher budget | Request a concrete grant change                               |
| Create a trigger covered by an existing trigger-management grant   | Autonomous within that grant                                  |
| Enable unattended work outside existing grants                     | Request bounded trigger/execution authority                   |

Grants describe principal, scope, capabilities, resource/input constraints,
budgets, duration, and revocation. They may cover many authored revisions and
runs; edits alone do not force permission renewal. Revision-specific approval
is optional for scopes that explicitly demand it. The model cannot issue its
own grants, approve its own code review, or weaken policy.

Revocation blocks new admissions and subsequent capability checks. Cancellation
of in-flight calls cannot undo effects already committed. Record authoritative
policy decisions and quality evidence separately. Rollback changes a selected
revision under current policy without overwriting history or renewing authority.

## Workflows now

The current implementation uses Pi and a WASM script runtime, with no durable
workflow engine or human-review integration. It supports one request and explicit
script runs, including nested composition. A script can sequence several allowed API calls; it
has no durable mid-script checkpoints. Record exact input references, artifact,
policy decision, outcome, and correlation ID for each run. If it crashes after
an external effect, return unknown and reconcile rather than replay blindly.

A Pi conversation is an interactive authoring and diagnosis session. It is not
the persisted definition of a workflow. A work item may propose scripts, but
creating those drafts does not automatically activate them or create triggers.

## Future durable workflows

Distinguish an immutable WorkflowDefinition from each WorkflowRun. A definition
pins script references, input mappings, allowed capabilities, time/budget limits,
retry/idempotency rules, and trigger configuration. Store and review definitions
behind a WorkflowRepository when this feature is implemented; do not add a DAG
engine or workflow-authoring tools to the initial ten-tool surface.

Definition lifecycle: draft → structurally validated → enabled within a trigger
grant → retired or revoked. Code review is optional unless publication or the
execution scope explicitly requires it. Workflow definitions cannot grant capabilities their caller lacks.
Changes require a new revision. A trigger runs only an active definition and
captures exact references at admission; updating a script does not silently
change an already active workflow or its in-flight runs.

Run lifecycle:

```text
received → durably queued → admitted → running
                               ├─ waiting for review/input/event
                               ├─ retry scheduled
                               └─ succeeded / failed / cancelled / unknown
```

Admission failure is a recorded terminal rejection. Waiting work releases its
worker and stores a structured continuation; a verified decision or event queues
resumption. Review of a newly proposed script does not retroactively authorize
an old run: recheck policy on resumption and admit the selected exact revision.
Retries preserve pinned artifacts and recorded inputs, and distinguish retryable
reads from uncertain external effects. Lease fencing prevents stale workers from
committing authoritative progress; it cannot reverse side effects.

An event may invoke an existing workflow directly, without an LLM, or start a
bounded agent work item. In both cases context is fetched through APIs. The HTTP
receiver authenticates and persists events, and returns an intake receipt. It
does not turn arbitrary event text into a privileged prompt or grant execution.

Start with durable single-script jobs when events arrive. Add multi-step durable
orchestration only when restart/resumption requirements justify it. Independent
steps can checkpoint results and input references; exactly-once external effects
still require cooperation from the affected API or reconciliation.
