# Implementation status and next steps

## Implemented

- Pi 0.85.1 extension and controlled launcher, with exactly ten script tools.
- Static operating prompt; context-file/skill/template discovery disabled.
- SQLite repository and evidence adapter behind domain interfaces, immutable
  references, optimistic revisions, idempotent publication, and logical hierarchy.
- QuickJS compiled to WASM, with bounded memory and execution, no guest host APIs
  beyond the explicit JSON bridge, and no container/Bubblewrap dependency.
- Shared ToolService for Pi and scripts: nested search/read/write/edit/verify/run,
  inherited declarations and grants, aggregate budgets, cancellation, and traces.
- Pi-independent runtime modules with optional Pi loaders, frozen catalogs, module restrictions,
  cancellation and disposal; fake SRE, clock, catalog, and HTTP JSON foundations.
- API-sourced work context and optional runtime policy.
- Optional fixture verification. Untested/failed-test drafts can execute within
  grants; review never confers runtime authority.
- Tests using SQLite in memory and on disk, adversarial WASM guest code, nested
  tool calls, and the actual Pi loader/agent loop with a scripted provider.

The Python/PydanticAI prototype, dependencies, environment, and guide were removed.

## Deliberately not implemented

Git-backed publication and human review, HTTP event intake, durable workflows,
platform-specific SDK adapters, live grant revocation/approval UI, alternative storage
backends, retention/garbage collection, and real-model benchmark results.
The design documents specify extension points; they are not claims those
integrations exist. Runtime policy is fixed at runtime creation; work budgets reset per user prompt.

## Next validation: real-model reuse

Compare paired tasks using the same model and settings:

1. Baseline Pi with equivalent direct fake SRE tools and no saved-script registry.
2. Cold Bionic with an empty registry, including creation costs.
3. Warm Bionic in fresh sessions carrying over only the registry and APIs.

Use held-out incidents, parameter variations, misleading search results, failed
scripts, and cases where reuse is inappropriate. Measure correctness, reuse
without rewriting, incorrect reuse, actual tokens/model turns, latency, host
calls, and registry growth. Include creation and verification costs.

A proposed initial gate is at least 30 paired tasks, no lower observed accuracy,
20% lower median model tokens, and successful reuse on 70% of designated reusable
tasks. Report uncertainty; these are targets, not achieved results.

## Future integrations

Deployment APIs now use [Pi-independent runtime modules](runtime-modules.md), with
clock, fake SRE, catalog and controlled HTTP JSON foundations. Validate a deployment
against its real platform before relying on it operationally. Mutation APIs need
idempotency and uncertain-outcome semantics before implementation.
Add Git storage and ReviewGateway when reviewed publication is needed; decisions
must bind to exact hashes and remain separate from permissions. Add HTTP intake
and WorkRepository when external events are needed, including durable receipts,
deduplication, leases, restart recovery, and uncertain-effect handling.

WASM remains the execution boundary. Future runtime/backend implementations must
pass the same contract, authorization, nested-budget, and containment tests.
