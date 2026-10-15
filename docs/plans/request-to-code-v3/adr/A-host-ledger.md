# ADR A: Planning host, reservation ledger, Build bridge and task guards

- Status: proposed (design investigator A), 2026-10-13
- Target: PRD v3, `docs/plans/2026-10-13-ccc-fusion-request-to-code-prd-v3.md`
- Code base read: worktree `/Users/ryanpappal/03_CODE/ccc-fusion/.worktrees/request-to-code-v3`, branch `agent/request-to-code-v3`, HEAD `589c293c7` (parent `origin/main` `d5fd9e87d`). Every `path:line` below is relative to that worktree.
- Answers critic points 1, 2, 3, 7, 10 and parts of 13 and 14 in `scratchpad/i0-gap-and-critic.md`.

## Decisions at a glance

| Question | Decision | New durable things |
|---|---|---|
| Q1 host | The planning run is one native workflow work item on the planning task. It reuses the existing processor, lease, abort, durable frontier and terminal compare-and-set. Stages are `gate` nodes routed to an injected `runCccPlanningStage` handler. No driver lease, no second scheduler. | None beyond Q2's anchor row. |
| Q2 ledger | Per-call history uses the provider-attempt pattern: append-only `run_audit_events` rows under a `ccc-plan:` run id. Counters live on one anchor row per run, in a new table `project.ccc_planning_runs`, the pre-import twin of `ccc_prd_imports.request_count`. A trigger makes the counters monotonic. `ccc_effect_receipts` stays for tool effects only. The Pi seam is widened by type only. | Table `ccc_planning_runs` (migration 0042), with a monotonic trigger. No reservations table. |
| Q3 Build bridge | Implementation allocation becomes campaign `maxRequests` (clamped to the 10,000 import ceiling); `request_count` is the implementation spend. Writer caps are added inside `reserveCccProviderAttempt`, only for planning-linked imports. Per-task review (G7) and the final judge (G8) run inside the campaign work item by composing the proof-suite handler. They spend review/proof on the anchor. Global repair is one anchor counter. The fit check and an import-intent row come before the importer runs. | Columns on the same anchor row. |
| Q4 guards | Marker: `lineageId = ccc-plan:<24 hex>`, equal to the run id. A store-level refusal in core `moveTask`/`pauseTask`/`updateTask`/archive/delete covers dashboard, `fn task`, triage, self-healing and scheduler from I1 on. `isCccCampaignTask` is extended. The executor defers planning tasks. The drain routes planning items to the planning processor. Triage excludes planning tasks. The dashboard guard is kept. | None. |

Plain terms used below:
- **Run:** one request-to-code attempt, id `ccc-plan:<24 hex>`.
- **Planning task:** the one ordinary native task that owns the run before import (PRD §3).
- **Work item:** a row in `project.workflow_work_items`, leased by one engine at a time.
- **Fence:** the tuple `(workItemId, runId, attempt, leaseOwner)` that proves the caller still holds the live lease.
- **Node attempt:** one try at one graph node, with its own turn key.
- **Iteration:** one model call inside a node attempt that processes action feedback.
- **Lineage:** the stable identity of a node that survives rename and is inherited across split.

---

## Q1. Execution host

### Decision

Host every planning run as **exactly one native workflow work item on the planning task**. Use the same machinery that already hosts a CCC campaign as one held work item.

| Shape | Planning run | Existing campaign (for comparison) |
|---|---|---|
| Owning task | Planning task, lineage `ccc-plan:<24hex>` | Imported tasks, lineage `ccc-prd:<24hex>:…` |
| Work item | `kind:"task"`, `runId = stableWorkflowRunId = <run id>`, `irHash` = sha256 of canonical planning IR, `waitReason:"planning"` | `runId ccc-prd:<importId>`, same shape (`packages/core/src/ccc-prd/importer.ts:1238-1285`) |
| Graph | Planning IR: `start → gate(stage)… → end`, sequential | Compiled PRD IR (`importer.ts:775-1054`) |
| Executor | `processDueWorkflowWorkItem` → `WorkflowTaskRuntime.run` → `WorkflowGraphExecutor` | Same (`packages/engine/src/workflow-work-processor.ts:334-386`) |
| Lease | Existing work-item lease: acquire, renew every lease/3, abort on loss | Same (`workflow-workitems-ops-2.ts:227-326`, `:328-387`; `workflow-work-processor.ts:213, 583-613`) |

**How a run maps onto native objects:**
- **One planning task.** It has the held shape described in Q4.
- **One planning workflow definition**, pinned to the planning task. It is written with the same storage calls the importer uses (`importer.ts:550-607`).
- **One work item per run.** Revisions, pauses and resumes keep the same work-item row. Resume and recovery raise `attempt` by one, so every older fence dies.
- **Build mode.** The last planning stage (`import`) imports and activates the campaign while still holding the planning lease. The planning item then ends `succeeded`, and the anchor state becomes `building`. The campaign then runs under its own existing `ccc-prd:` work item. The two items run one after the other, never at the same time. Per-task review and the final judge run inside the campaign item (Q3), so there is still one execution authority at any moment.

**How stage functions are invoked:**
- Each planning stage is a `gate` node whose open `config` carries `cccPlanningStage` and `cccPlanningLineageId`. `config` is an open record (`packages/core/src/workflow-ir-types.ts`), so no new node kind is needed.
- `recordingHandlers` already routes gate nodes with `cccProofSuite`/`cccProofGate`/`cccProofPhase` to an injected `runCccProofSuite` (`packages/engine/src/workflow-task-runtime.ts:1090-1122`). Add the same override for `cccPlanningStage` → injected `runCccPlanningStage`.
- Cross-use fails closed. A proof gate under planning custody fails, and a planning gate under campaign custody fails.
- `runCccPlanningStage` is built by `createCccPlanningStageHandler`. It looks the stage function up in a fixed registry and gives it a context: run custody, the fence (from `context.execution.executionFence`), the abort signal, the ledger port, the artifact port, a Pi session factory whose `cccProviderAttemptBinding` is backed by the planning ledger, and a descendant registry.
- Stage outcomes are mapped as follows:
  - `committed` → node success.
  - Every hold (`awaiting-intent`, `blocked`, `unknown-effect`, `paused`) → a `PermanentError` with a hold context key.
  - Making `isCccCampaignTask` cover planning tasks (Q4) also turns on the existing rule that "permanent CCC failures stop after their first real invocation" (`workflow-graph-executor.ts:2170-2175`). So holds are never retried in-process.

**Custody seam (the one structural change).** Today any fenced run needs a campaign context:
- `workflow-work-processor.ts:171-186` throws "workflow required campaign custody is missing".
- `workflow-task-runtime.ts:514-555` refuses with `ccc-campaign-custody-missing`.
- `workflow-task-runtime.ts:725-791` requires `cccPrdTaskId` on every node.

Add a custody discriminator, `"campaign" | "planning"`. The planning branch:
- loads `CccPlanningRunCustody` by task id;
- requires `workItem.runId === custody.runId`;
- uses a planning node-execution resolver, where the semantic task is the planning task and the visit identity is the lineage;
- skips live-execution approval, which is campaign-only (`workflow-task-runtime.ts:692-723`); G0 grant admission replaces it.

**Durable frontier.** It comes for free. `isCccCampaignTask(task)` gates the CCC sequential frontier (`workflow-graph-executor.ts:951-1007`), and Q4 extends that predicate to planning tasks. Completed stages are skipped on resume. Each stage is also idempotent on its own: if a committed artifact exists for `(revision, stage, inputDigest)`, the stage returns `committed` without any call.

### Restart and resume

- **Startup.** A new `recoverCccPlanningWorkItems` runs next to the campaign startup recovery call (`packages/engine/src/runtimes/in-process-runtime.ts:467-478`). For each `ccc-plan:` item in `running` whose lease owner is not this engine instance:
  1. Fold the run's ledger history.
  2. A reservation with no `dispatched` event never left the process. Settle it as `proved_failed` through the "not dispatched" proof (the same rule as `provider-attempt.ts:1506-1530`). The spend is not refunded.
  3. If any `dispatched` reservation has no terminal event, transition `running → manual-required` with `blockedReason ccc-planning:unknown-effect` and set the anchor state to `unknown_effect`.
  4. Otherwise compare-and-set `running → retrying` with `expectedLeaseOwner = old owner` and `attempt + 1`.
- **Existing gap, closed for planning only.** The drain lists only `runnable`/`retrying` (`in-process-runtime.ts:2224-2228`). Startup recovery parks only items with unknown effects. So a `running` item whose lease expired is never picked up again today. The same planning recovery also runs on each drain pass for planning items whose lease has expired. Campaign behaviour does not change.
- **Resume.** Resume skips committed stages through the frontier and through artifact idempotency. Every stage admission and every reservation re-checks, inside one transaction holding the fence row lock:
  - the deadline (database clock, with the existing 30 s launch headroom, `provider-attempt.ts:1161`);
  - the phase remaining;
  - the grant digest against the admitted G0 grant artifact (authority);
  - the target base commit against the repository-snapshot artifact. Drift invalidates the affected stages instead of continuing.

### Pause, cancel and stale fences

- **Where requests live.** Durable requests sit on the anchor row (Q2): `control_seq`, `control_request ∈ {pause, cancel, resume}`, `control_revision`, `control_requested_at`, `awaiting_decision_id`. Each request also writes one bounded audit event `ccc-planning:control` with `{seq, request, revision}`.
- **Revision binding.** The CLI reads the revision and submits it as `expectedRevision`. The operation compare-and-sets on `revision`, so a request against an old revision is refused (exit 1).
- **Answers.** `fn plan answer` publishes the answer value as an immutable planning artifact, a task document from the I1 artifact card. Only its digest goes on the audit event. In one transaction the operation also:
  - checks `state = awaiting_intent`;
  - checks `awaiting_decision_id = --decision`;
  - checks the revision;
  - sets the anchor state to `running`;
  - compare-and-sets the work item `held → runnable` with `attempt + 1`.
- **If the work item is not running** (runnable, retrying or held), the CLI operation moves it directly by compare-and-set, for example `runnable → held` (pause) or `→ cancelled`, with no engine round-trip.
- **If the work item is running:**
  - Every planning reservation reads `control_request` under the anchor row lock. A pending pause or cancel refuses the next model call at once with `control-pending`. No new dispatch can start after the request commits.
  - The runner also polls `control_seq` on each lease renewal tick, then aborts its `AbortController`.
- **Settlement order** (PRD §9 "Cancel registered descendants, flush state, then release ownership"), enforced in `settleCccPlanningRun`:
  1. `descendants.cancelAll()` waits for every registered Pi session and `superviseSpawn` group to settle.
  2. Flush: in-flight calls that cannot be reconciled are recorded as `dispatched_unknown` (never refunded), and pending artifacts are published or marked abandoned.
  3. Only then does the terminal transition run:
     - pause → `held` (`blockedReason ccc-planning:paused`);
     - cancel → `cancelled`;
     - awaiting intent → `held` (`ccc-planning:awaiting-intent:<decisionId>`).
  
  Step 3 releases the lease.
- **New processor mapping.** The processor needs one new mapping for planning custody: a hold context key leads to state `held`. Today `transitionCampaignTerminal` maps only to `succeeded | manual-required | cancelled | failed` (`workflow-work-processor.ts:401-415`).
- **Stale fences cannot publish.** Every artifact publish, ledger reservation, dispatch, settlement and control-driven transition runs in a transaction that first runs `SELECT … FROM project.workflow_work_items WHERE id, task_id, run_id, state='running', lease_owner, attempt, lease_expires_at > clock_timestamp() FOR UPDATE`. This is the same predicate as `assertCccCampaignWorkflowLeaseFenceImpl` (`workflow-workitems-ops-2.ts:56-85`), but held inside the transaction as `recordFencedCccCampaignProofAuditImpl` does (`:389-426`). Because resume and recovery raise `attempt`, an old holder's fence can never match again, even with the same lease owner string.
- **Watchdogs.** Each node attempt gets an `AbortSignal.timeout` of 30 min (planning/review), 60 min (writer) or 20 min (heavy check), per PRD §6. A timeout ends that node attempt. The attempt still counts as dispatched and is not refunded.

### Rejected alternatives

- **A dedicated planning controller with its own driver lease** (draft cards C2/C3/C8). It duplicates about 300 lines of lease, abort and terminal logic that already exist and are tested (`workflow-work-processor.ts:95-386, 401-569`). It adds a second lease system and a second scheduler, against PRD §2/§13 (critic #3).
- **One work item per stage.** `workflow-task-runtime.ts:793-983` (`runWorkItem`) refuses campaign items and has no fenced chaining between items. It would also need new per-stage scheduling and a stage-to-stage handoff protocol.
- **A new IR node kind `planning-stage`.** It is not needed: the open `config` plus the existing gate override cover it. A new kind would touch the IR validators and compiler.
- **Keeping the planning task unpaused so the drain sees it.** The pause flag is the cheapest broad shield against triage (`triage.ts:1112`), the scheduler and self-healing. It is better to teach the drain about planning items.
- **Cancel by waiting for the next unleased boundary**, as campaign `fn prd` control does (`packages/engine/src/ccc-campaign-operator-control.ts:184-195`). A planning stage can run for 30 minutes or more, and PRD §9 requires active cancellation.

### New and changed signatures

```ts
// packages/engine/src/workflow-work-processor.ts (changed)
export type WorkflowWorkCustodyKind = "campaign" | "planning";
export interface WorkflowWorkProcessorOptions {
  leaseOwner: string;
  leaseDurationMs: number;
  now?: string;
  kinds?: WorkflowWorkItemKind[];
  exactCandidate?: ExactWorkflowWorkCandidate;
  /** Replaces campaignRequired; `campaignRequired: true` stays as an alias of custody "campaign". */
  custody?: WorkflowWorkCustodyKind;
  campaignRequired?: boolean;
}
export interface WorkflowWorkProcessorStore /* existing members unchanged */ {
  getCccPlanningRunForTask?(taskId: string): Promise<CccPlanningRunCustody | null>;
}

// packages/engine/src/workflow-task-runtime.ts (changed)
export interface WorkflowTaskRuntimeRunOptions /* existing members unchanged */ {
  custody?: WorkflowWorkCustodyKind;
}
export interface WorkflowTaskRuntimeDeps /* existing members unchanged */ {
  store: /* existing */ & {
    getCccPlanningRunForTask?: (taskId: string) => Promise<CccPlanningRunCustody | null>;
  };
  /** Planning-only stage executor; gate nodes with config.cccPlanningStage route here. */
  runCccPlanningStage?: WorkflowNodeHandler;
}
export const CCC_PLANNING_HOLD_CONTEXT_KEY = "ccc:planning:hold" as const;

// packages/core/src/ccc-planning/types.ts (new)
export type CccPlanningRunCustody = Readonly<{
  kind: "planning";
  projectId: string;
  runId: string;               // ccc-plan:<24hex>
  planningTaskId: string;
  revision: number;
  state: CccPlanningRunState;
  mode: "spec" | "build";
  budgetProfile: "standard" | "large";
  deadlineAt: string;
  grantDigest: string;
  controlSeq: number;
}>;
export type CccPlanningWorkItemFence = Readonly<{
  workItemId: string; runId: string; attempt: number; leaseOwner: string; originTaskId: string;
}>;

// packages/engine/src/ccc-planning/controller.ts (new)
export type CccPlanningStageId =
  | "admit" | "intent" | "research" | "design-a" | "design-b" | "critique"
  | "adjudicate" | "prd" | "graph" | "verifier-prep" | "verifier-audit" | "final-judge" | "import";
export type CccPlanningStageOutcome =
  | Readonly<{ kind: "committed"; artifactIds: readonly string[] }>
  | Readonly<{ kind: "awaiting-intent"; decisionId: string }>
  | Readonly<{ kind: "blocked"; code: string }>
  | Readonly<{ kind: "unknown-effect"; attemptKeys: readonly string[] }>
  | Readonly<{ kind: "rejected"; code: string }>;
export interface CccPlanningDescendantRegistry {
  register(handle: Readonly<{ id: string; cancel(reason: Error): Promise<void> }>): () => void;
  cancelAll(reason: Error): Promise<void>;   // resolves only after every handle settled
}
export interface CccPlanningStageContext {
  readonly run: CccPlanningRunCustody;
  readonly stageId: CccPlanningStageId;
  readonly lineageId: string;
  readonly fence: CccPlanningWorkItemFence;
  readonly signal: AbortSignal;
  readonly ledger: CccPlanningLedgerPort;          // Q2
  readonly artifacts: CccPlanningArtifactPort;     // I1 artifact card
  readonly sessions: CccPlanningSessionFactory;    // Pi sessions bound to the ledger
  readonly descendants: CccPlanningDescendantRegistry;
}
export type CccPlanningStageFn = (ctx: CccPlanningStageContext) => Promise<CccPlanningStageOutcome>;
export function createCccPlanningStageHandler(input: Readonly<{
  stages: Readonly<Record<CccPlanningStageId, CccPlanningStageFn>>;
  ledger: CccPlanningLedgerPort;
  artifacts: CccPlanningArtifactPort;
  sessions: CccPlanningSessionFactory;
  now?: () => number;
}>): WorkflowNodeHandler;
export function buildCccPlanningWorkflowIr(mode: "spec" | "build"): WorkflowIr; // sequential gates, maxRetries 0
export async function settleCccPlanningRun(input: Readonly<{
  descendants: CccPlanningDescendantRegistry;
  flush: () => Promise<void>;
  release: () => Promise<void>;
  reason: Error;
}>): Promise<void>; // strictly cancelAll → flush → release

// packages/engine/src/ccc-planning/recovery.ts (new)
export async function recoverCccPlanningWorkItems(input: Readonly<{
  store: TaskStore; engineLeaseOwner: string; now?: string;
}>): Promise<ReadonlyArray<{ workItemId: string; outcome: "requeued" | "unknown-effect" | "skipped" }>>;

// packages/core/src/task-store/ccc-planning-ops.ts (control ops; new)
export async function requestCccPlanningControl(layer: AsyncDataLayer, input: Readonly<{
  runId: string; request: "pause" | "cancel" | "resume"; expectedRevision: number;
}>): Promise<Readonly<{ controlSeq: number; appliedDirectly: boolean }>>;
export async function answerCccPlanningDecision(layer: AsyncDataLayer, input: Readonly<{
  runId: string; decisionId: string; expectedRevision: number; answerArtifactId: string; answerDigest: string;
}>): Promise<Readonly<{ controlSeq: number }>>;
```

### Files (card H1, engine host)

`packages/engine/src/workflow-work-processor.ts`, `packages/engine/src/workflow-task-runtime.ts`, `packages/engine/src/runtimes/in-process-runtime.ts` (drain classification, planning runtime wiring, recovery call), new `packages/engine/src/ccc-planning/{controller,recovery,workflow-ir}.ts`, plus tests `packages/engine/src/__tests__/ccc-planning-host.test.ts` and `packages/engine/src/__tests__/ccc-planning-host.real-pg.test.ts`. The control operations in `ccc-planning-ops.ts` belong to card L1 (Q2).

### Behavioural RED tests

1. **"A planning run executes as one work item and resumes from the frontier"** (real PG). Setup: two stages that count their calls and publish one artifact each. Run until stage 2 starts, then simulate a crash: the lease expires and a new runtime with a different `engineInstanceId` starts. Assert:
   - stage 1's call count stays 1;
   - stage 2 completes;
   - exactly one `workflow_work_items` row exists for the run;
   - `attempt` went up by exactly 1.
   
   *Non-vacuous:* today the processor throws "required campaign custody is missing", or the drain sends the item to `executor.execute`. The expired `running` item is also never re-picked by the drain filter. The test must observe stage 2 completing.
2. **"A stale fence cannot reserve or publish."** Holder A's lease expires and holder B acquires it (`attempt + 1`). A then calls `reserveCccPlanningCall` and `publishArtifact` with its old fence. Assert both refuse with `CCC_PLANNING_FENCE_REFUSED` and that the audit-event and artifact row counts are unchanged.
   
   *Non-vacuous:* positive control. B makes the identical calls and they succeed, so the only difference is the fence.
3. **"Cancel order: descendants, then flush, then release."** A fake descendant's `cancel` resolves after 200 ms and records a `dispatched_unknown` settlement. Issue cancel while running. Assert:
   - the work item stays `running` with the same lease owner until the descendant settles, then becomes `cancelled`;
   - `planning_spent` is unchanged after cancel.
   
   *Non-vacuous:* timestamps recorded by an ordering spy. Releasing early fails the assertion.
4. **"A pause request blocks the next reservation immediately."** With a stage running, commit `pause`. The next `reserveCccPlanningCall` refuses with `control-pending` and writes no event row.
   
   *Non-vacuous:* the same reservation succeeds just before the pause commits.
5. **"Resume re-checks deadline and base."** Case A: create a run with a 3 s deadline, pause it, wait, resume. The stage admission refuses with `deadline`, the anchor becomes `exhausted`, and no reservation row is written. Case B: change the target `HEAD` while paused. Resume invalidates the affected stages and refuses with `base-drift`.
   
   *Non-vacuous:* a control run that resumes within the deadline on an unchanged base proceeds.
6. **"Planning and campaign gates do not cross."** Under planning custody, a `cccProofSuite` gate fails with `ccc-planning-proof-gate-refused`. Under campaign custody, a `cccPlanningStage` gate fails. A planning gate never reaches `ordinaryGate`.
   
   *Non-vacuous:* spies on `ordinaryGate` and `runCccProofSuite` show zero calls, while `runCccPlanningStage` shows one.

### Risks

- **Shared hot files.** `in-process-runtime.ts`, `workflow-task-runtime.ts` and `workflow-work-processor.ts` are also campaign-critical. H1 must run the campaign processor suites unchanged.
- **One work item caps parallelism inside a run to in-stage parallelism.** For example, designer A and designer B run as two sealed Pi sessions inside one stage under a reservation concurrency limit. A general DAG across stages is I3 (existing split/join with branch persistence).
- **Pause latency** while no model call is in flight is bounded by the lease renewal tick (about 200 s). Acceptable for I2. A future change could listen on the anchor instead of polling.

---

## Q2. Reservation ledger

### Can an existing ledger be generalized to a pre-import scope?

| Candidate | Verdict | Code evidence |
|---|---|---|
| Provider-attempt ledger, as is | **Its mechanism generalizes; its anchor does not.** | Bound audit rows must carry a full campaign binding plus a foreign key to `ccc_prd_imports`, checked all or nothing (`packages/core/src/postgres/schema/campaign-governance.ts:119-126`). The counter is `ccc_prd_imports.request_count` (`provider-attempt.ts:1377-1397`). History is keyed by `campaignImportId` (`:1121-1144`). `lockedContext` requires a campaign context (`:1399-1409`). Creating an import row before planning would create a partial campaign that status and recovery would see (PRD criterion 2). |
| `ccc_effect_receipts` | **No.** | Rows are updated in place through four states, there are no route or receipt columns, and the only store is bound to `cli_sessions` with one open turn per scope (`packages/core/src/cli-session-store.ts:731, 750-860, 878-913`). It also stays the tool-effect ledger. Reusing it for model calls would add a third reader of call status and give every Pi stream a CLI-session dependency. |
| Pure event sourcing, with no anchor row | **No.** | Retention deletes every non-campaign, task-bound audit row older than `operationalLogRetentionDays` (default 30 and operator-settable, `packages/core/src/settings-schema.ts:781`). This happens in `packages/core/src/task-store/async-maintenance.ts:95-101`, called from `packages/engine/src/self-healing.ts:2760`. Pre-import planning events are exactly such rows. A short retention setting would erase spent counts, which is a refund. Even with a retention exclusion, counting by scan offers no database-level check that spend ≤ allocation. |

### Decision

1. **Per-call history: the provider-attempt pattern, extended.**
   - Events are append-only `run_audit_events` rows with `runId = <run id>`, `taskId = planning task`, domain `database`, and these mutation types:
     - `ccc-planning:call:reserved | :dispatched | :terminal`;
     - `ccc-planning:lineage:created`;
     - `ccc-planning:control`;
     - `ccc-planning:repair-chunk`;
     - `ccc-planning:import-intent | :import-linked`.
   - The state machine is the existing one: `reserved → dispatched_unknown → committed | proved_failed`, plus `reserved → proved_failed` when not dispatched. History folding reuses the existing route receipt validators (`assertCccProviderAttemptEffectiveRoute`, `provider-attempt.ts:489`).
   - Event ids are deterministic (`ccc-plan-event-<sha256(attemptKey:stage)>`). They are inserted with `ON CONFLICT (project_id, id) DO NOTHING`, then the stored row is compared. Replays are therefore idempotent and need no change to `run_audit_events`.
2. **One anchor row per run** in a new table `project.ccc_planning_runs`. It holds:
   - immutable identity, mode, profile, digests, deadline and phase allocations;
   - monotonic counters: `planning_spent`, `review_proof_spent`, `repair_chunks_used`, `control_seq`, `revision`;
   - the control and import-link fields.
   
   This is the exact role `ccc_prd_imports` plays for a campaign (`request_count` CAS). It is **not a ledger**: per-call state lives only in append-only events. A trigger forbids decreasing any counter or changing identity, deadline or allocations, except that allocations and the deadline may grow by an authorized amendment (`amendment_seq + 1` with a new `grant_digest`).
3. **Retention exclusion.** `async-maintenance.ts` gets `AND events.run_id NOT LIKE 'ccc-plan:%'`. Planning receipts are durable model and budget receipts (PRD §3).
4. **Pi seam: widen by type only.** No second binding and no second stream path; see the signatures below. `pi.ts` checks and compares only `attemptKey, controllerToken, taskId, semanticTaskId, campaignDeadlineAt, turnKey, dispatchKey, attemptOrdinal, requestCount, binding{taskId, providerId, modelId, transport}`, plus `state` and `terminal` (`packages/engine/src/pi.ts:868-910, 916-952`). It spreads the scope into the settlement (`:1068-1094`). A planning scope fills each field truthfully:
   - `semanticTaskId` is the lineage;
   - `campaignDeadlineAt` is the run deadline (the field name is kept to avoid a runtime change);
   - `binding` is a planning route binding.

### How each required property is enforced atomically

All of the following run in one `transactionImmediate`:
1. Lock the fence row (`FOR UPDATE`).
2. Lock the anchor row (`SELECT … FOR UPDATE`).
3. Read the database clock.
4. Fold the run's history: `run_id = $run AND mutation_type LIKE 'ccc-planning:%'`, using `idxRunAuditEventsRunIdTimestamp`, bounded to `3 × (allocations) + lineage + control` rows.
5. Check the rules below.
6. Append the event.
7. Compare-and-set the phase counter.

| Property | Rule |
|---|---|
| Phase allocations | `UPDATE … SET <phase>_spent = <phase>_spent + 1 WHERE … AND <phase>_spent = $seen AND <phase>_spent < <phase>_allocation`. Planning stages may spend only `planning`. Review and judge calls spend only `review_proof`. `implementation` is never spent on the anchor; it moves to the campaign (Q3). The CHECK `spent BETWEEN 0 AND allocation` is a database backstop. |
| Deadline | `db_now + 30 s < deadline_at`, else `deadline`. The deadline is immutable unless amended. |
| 10 iterations per node attempt | A node attempt is one `turnKey`. Its calls are its reservations, with dispatch keys `pi-stream:0..`. Refuse when the attempt already has `1 + 10` reservations: one initial call plus 10 calls that process action feedback, per PRD §5. **Leader decision D1:** a stricter reading allows only 10 calls; the constant `CCC_PLANNING_MAX_CALLS_PER_ATTEMPT` is the single switch. Tool-only work never creates a reservation, so it cannot reset the count. |
| 3 dispatch attempts per node lineage, counted at reservation | A node attempt counts from its **first reservation**, whatever happens later. `dispatchAttempts(L)` = inherited count from L's `lineage:created` event plus the number of distinct turn keys reserved with `lineageId = L`. Refuse attempt 4. The planning turn key embeds an explicit `nodeAttemptOrdinal ∈ {1,2,3}`, so retries cannot reuse a key. |
| Lineage survives split and rename | A rename keeps `lineageId`. A split writes one immutable `ccc-planning:lineage:created` event per child, with `{lineageId, parentLineageId, inheritedDispatchAttempts = parent's count at split}`. Children start from that number. Spend is never per-lineage, so a split cannot free phase spend either. |
| Global repair: 1 epoch, ≤ 4 chunks, shared | `UPDATE … SET repair_chunks_used = repair_chunks_used + 1, repair_epoch_state = 'open' WHERE … AND repair_chunks_used < 4 AND repair_epoch_state IN ('unopened','open')`. Closing the epoch is one-way (trigger). The same column serves planning rejections and coding rejections (Q3). |
| No refund after dispatch | Counters only go up (trigger). Cancel, pause, restart and model change never touch them. |
| `dispatched_unknown` blocks retry until reconciled | Refuse any new reservation in lineage L while any L attempt is `dispatched_unknown`. Other lineages proceed (PRD §9: blocked domains do not stop independent work). |
| Release only after descendants settle | `transferCccPlanningImplementationAllocation`, `closeCccPlanningRun` and the terminal settlement refuse while any reservation in the run is `reserved` or `dispatched_unknown`. |
| Bounded audit content | The metadata schema `ccc-planning-call/v1` has exact keys: ids, digests, integers, enum outcomes, and the route receipt reused from provider-attempt. Strings are capped at 256 characters. Prompts, outputs and answers go to artifacts only. |

### SQL: migration `packages/core/src/postgres/migrations/0042_ccc_planning_runs.sql`

```sql
-- FNXC:CccPlanningRuns 2026-10-13: pre-import anchor for one request-to-code run.
-- Not a ledger: per-call history stays append-only in project.run_audit_events.
CREATE TABLE IF NOT EXISTS project.ccc_planning_runs (
  project_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
  run_id text NOT NULL,
  planning_task_id text NOT NULL,
  mode text NOT NULL,
  budget_profile text NOT NULL,
  policy_version text NOT NULL,
  request_digest text NOT NULL,
  grant_digest text NOT NULL,
  amendment_seq integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 1,
  state text NOT NULL,
  deadline_at text NOT NULL,
  planning_allocation integer NOT NULL,
  implementation_allocation integer NOT NULL,
  review_proof_allocation integer NOT NULL,
  planning_spent integer NOT NULL DEFAULT 0,
  review_proof_spent integer NOT NULL DEFAULT 0,
  repair_epoch_state text NOT NULL DEFAULT 'unopened',
  repair_chunks_used integer NOT NULL DEFAULT 0,
  control_seq integer NOT NULL DEFAULT 0,
  control_request text,
  control_revision integer,
  control_requested_at text,
  awaiting_decision_id text,
  import_intent_digest text,
  import_idempotency_key text,
  import_id text,
  implementation_transferred integer,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, run_id),
  CONSTRAINT ccc_planning_runs_task_unique UNIQUE (project_id, planning_task_id),
  CONSTRAINT ccc_planning_runs_import_unique UNIQUE (project_id, import_id),
  CONSTRAINT ccc_planning_runs_run_id_check CHECK (run_id ~ '^ccc-plan:[0-9a-f]{24}$'),
  CONSTRAINT ccc_planning_runs_mode_check CHECK (mode IN ('spec', 'build')),
  CONSTRAINT ccc_planning_runs_profile_check CHECK (budget_profile IN ('standard', 'large')),
  CONSTRAINT ccc_planning_runs_state_check CHECK (state IN (
    'admitted', 'running', 'awaiting_intent', 'blocked', 'exhausted', 'unknown_effect',
    'paused', 'cancelling', 'cancelled', 'spec_ready', 'importing', 'building',
    'verification_failed', 'accepted', 'delivered', 'failed')),
  CONSTRAINT ccc_planning_runs_planning_spend_check CHECK (planning_spent BETWEEN 0 AND planning_allocation),
  CONSTRAINT ccc_planning_runs_review_spend_check CHECK (review_proof_spent BETWEEN 0 AND review_proof_allocation),
  CONSTRAINT ccc_planning_runs_allocation_check CHECK (
    planning_allocation > 0 AND implementation_allocation >= 0 AND review_proof_allocation >= 0
    AND (mode = 'build' OR (implementation_allocation = 0 AND review_proof_allocation = 0))),
  CONSTRAINT ccc_planning_runs_repair_check CHECK (
    repair_epoch_state IN ('unopened', 'open', 'closed') AND repair_chunks_used BETWEEN 0 AND 4),
  CONSTRAINT ccc_planning_runs_control_check CHECK (
    (control_request IS NULL OR control_request IN ('pause', 'cancel', 'resume'))
    AND ((control_request IS NULL) = (control_revision IS NULL))),
  CONSTRAINT ccc_planning_runs_import_link_check CHECK (
    (import_id IS NULL OR (import_idempotency_key IS NOT NULL AND import_intent_digest IS NOT NULL))
    AND (implementation_transferred IS NULL
         OR implementation_transferred BETWEEN 1 AND implementation_allocation)),
  CONSTRAINT ccc_planning_runs_import_fkey FOREIGN KEY (project_id, import_id)
    REFERENCES project.ccc_prd_imports(project_id, import_id)
);

CREATE OR REPLACE FUNCTION project.ccc_planning_runs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.run_id <> OLD.run_id OR NEW.planning_task_id <> OLD.planning_task_id
     OR NEW.mode <> OLD.mode OR NEW.budget_profile <> OLD.budget_profile
     OR NEW.policy_version <> OLD.policy_version OR NEW.request_digest <> OLD.request_digest
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'ccc_planning_runs identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.planning_spent < OLD.planning_spent OR NEW.review_proof_spent < OLD.review_proof_spent
     OR NEW.repair_chunks_used < OLD.repair_chunks_used OR NEW.control_seq < OLD.control_seq
     OR NEW.revision < OLD.revision OR NEW.amendment_seq < OLD.amendment_seq THEN
    RAISE EXCEPTION 'ccc_planning_runs counters never decrease' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.deadline_at <> OLD.deadline_at OR NEW.planning_allocation <> OLD.planning_allocation
      OR NEW.implementation_allocation <> OLD.implementation_allocation
      OR NEW.review_proof_allocation <> OLD.review_proof_allocation
      OR NEW.grant_digest <> OLD.grant_digest)
     AND NOT (NEW.amendment_seq = OLD.amendment_seq + 1
              AND NEW.grant_digest <> OLD.grant_digest
              AND NEW.deadline_at >= OLD.deadline_at
              AND NEW.planning_allocation >= OLD.planning_allocation
              AND NEW.implementation_allocation >= OLD.implementation_allocation
              AND NEW.review_proof_allocation >= OLD.review_proof_allocation) THEN
    RAISE EXCEPTION 'ccc_planning_runs grant changes only by an authorized enlarging amendment'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.repair_epoch_state = 'closed' AND NEW.repair_epoch_state <> 'closed' THEN
    RAISE EXCEPTION 'ccc_planning_runs repair epoch cannot reopen' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.import_intent_digest IS NOT NULL AND NEW.import_intent_digest IS DISTINCT FROM OLD.import_intent_digest)
     OR (OLD.import_idempotency_key IS NOT NULL AND NEW.import_idempotency_key IS DISTINCT FROM OLD.import_idempotency_key)
     OR (OLD.import_id IS NOT NULL AND NEW.import_id IS DISTINCT FROM OLD.import_id)
     OR (OLD.implementation_transferred IS NOT NULL
         AND NEW.implementation_transferred IS DISTINCT FROM OLD.implementation_transferred) THEN
    RAISE EXCEPTION 'ccc_planning_runs import link is write-once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ccc_planning_runs_guard ON project.ccc_planning_runs;
CREATE TRIGGER ccc_planning_runs_guard
  BEFORE UPDATE ON project.ccc_planning_runs
  FOR EACH ROW EXECUTE FUNCTION project.ccc_planning_runs_guard();

ALTER TABLE project.ccc_planning_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.ccc_planning_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.ccc_planning_runs;
CREATE POLICY fusion_project_isolation ON project.ccc_planning_runs
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.ccc_planning_runs;
CREATE TRIGGER fusion_assign_project_id
  BEFORE INSERT OR UPDATE OF project_id ON project.ccc_planning_runs
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
```

**Retention exclusion** (changed, `packages/core/src/task-store/async-maintenance.ts:95-101`):

```sql
DELETE FROM project.run_audit_events AS events
WHERE events.timestamp < ${cutoff}
  AND events.campaign_import_id IS NULL
  AND events.run_id NOT LIKE 'ccc-plan:%'
  AND events.task_id IN (SELECT id FROM project.tasks WHERE project_id = ${projectId})
RETURNING 1
```

**Reservation compare-and-set** (inside `reserveCccPlanningCall`):

```sql
UPDATE project.ccc_planning_runs
   SET planning_spent = planning_spent + 1, updated_at = $now      -- or review_proof_spent
 WHERE project_id = $project AND run_id = $run
   AND planning_spent = $seenSpent AND planning_spent < planning_allocation
   AND state IN ('running', 'building') AND control_request IS NULL
RETURNING planning_spent;
```

### TypeScript signatures

```ts
// packages/core/src/ccc-campaign/types.ts (additive, type-level only)
export type CccProviderAttemptRouteBindingView = Readonly<{
  taskId: string; providerId: string; modelId: string; transport: CccCampaignTransport;
}>;
export type CccProviderAttemptScopeView = Readonly<
  Omit<CccProviderAttemptScope, "binding"> & { binding: CccProviderAttemptRouteBindingView }
>;
export type CccProviderControllerDecisionView<S extends CccProviderAttemptScopeView = CccProviderAttemptScopeView> =
  | Readonly<{ kind: "dispatch-permit"; scope: S }>
  | Readonly<{ kind: "hold"; reason: CccCampaignProviderControllerHoldReason; scope: S }>;
// CccProviderAttemptLimitError.reason widens (additive):
//   "deadline" | "max-requests" | "max-concurrency"
//   | "iteration-cap" | "dispatch-cap" | "unreconciled-dispatch" | "control-pending" | "phase-allocation"

// packages/engine/src/agent-runtime.ts (changed, generic with default; CccProviderAttemptScope still satisfies it)
export type CccProviderAttemptController<S extends CccProviderAttemptScopeView = CccProviderAttemptScopeView> = Readonly<{
  preDispatch(input: CccCampaignProviderDispatchInput): Promise<CccProviderControllerDecisionView<S>>;
  reconcile(input: CccProviderAttemptReconciliation & S): Promise<S>;
}>;
export type CccProviderAttemptBinding<S extends CccProviderAttemptScopeView = CccProviderAttemptScopeView> = Readonly<{
  turnKey: string;
  controller: CccProviderAttemptController<S>;
  receiptAdapterId?: CccCampaignRouteReceiptAdapterId;
  terminalRouteMembers?: readonly CccCampaignTerminalRouteMember[];
}>;
// packages/engine/src/pi.ts: CccProviderAttemptSubmittedReconciliation, assertCccProviderAttemptScopeAssociation,
// assertCccProviderAttemptPermitScope and assertCccProviderAttemptReconciledScope take CccProviderAttemptScopeView.
// No runtime change.

// packages/core/src/ccc-planning/types.ts (new)
export type CccPlanningPhase = "planning" | "implementation" | "review_proof";
export type CccPlanningRunState =
  | "admitted" | "running" | "awaiting_intent" | "blocked" | "exhausted" | "unknown_effect"
  | "paused" | "cancelling" | "cancelled" | "spec_ready" | "importing" | "building"
  | "verification_failed" | "accepted" | "delivered" | "failed";
export type CccPlanningRouteBinding = Readonly<{
  projectId: string; runId: string; revision: number; taskId: string; lineageId: string;
  phase: Exclude<CccPlanningPhase, "implementation">; providerId: string; modelId: string;
  transport: "pi"; grantDigest: string;
}>;
export type CccPlanningCallScope = CccProviderAttemptScopeView & Readonly<{ binding: CccPlanningRouteBinding }>;
export type CccPlanningCallRequest = Readonly<{
  runId: string;
  phase: Exclude<CccPlanningPhase, "implementation">;
  lineageId: string;
  nodeAttemptOrdinal: 1 | 2 | 3;
  turnKey: string;
  dispatchKey: string;              // "pi-stream:N", produced by pi.ts
  providerId: string; modelId: string; transport: "pi";
  fence: CccPlanningWorkItemFence;  // planning item, or the linked campaign item in Build (Q3)
}>;

// packages/core/src/ccc-planning/policy.ts (new)
export const CCC_PLANNING_MAX_CALLS_PER_ATTEMPT = 11 as const;      // 1 initial + 10 iterations (D1)
export const CCC_PLANNING_MAX_DISPATCH_ATTEMPTS_PER_LINEAGE = 3 as const;
export const CCC_PLANNING_MAX_REPAIR_CHUNKS = 4 as const;
export function cccPlanningTurnKey(input: Readonly<{
  projectId: string; runId: string; revision: number; stageId: string; lineageId: string; nodeAttemptOrdinal: number;
}>): string; // "ccc-plan-turn-" + sha256("ccc-plan-turn/v1\0" + canonical)
export function cccPlanningAttemptKey(input: Readonly<{
  projectId: string; runId: string; turnKey: string; dispatchKey: string;
}>): string; // "ccc-plan-attempt-" + sha256; the fence is metadata, not identity, so a replay under a new fence is a collision

// packages/core/src/task-store/ccc-planning-ops.ts (new; the PostgreSQL PlanningStorePort/PlanningReservationPort)
export async function createCccPlanningRun(layer: AsyncDataLayer, input: CccPlanningRunCreateInput): Promise<CccPlanningRunCustody>; // anchor + held task + workflow + work item in one tx
export async function getCccPlanningRunForTask(layer: AsyncDataLayer, taskId: string): Promise<CccPlanningRunCustody | null>;
export async function reserveCccPlanningCall(layer: AsyncDataLayer, request: CccPlanningCallRequest): Promise<CccPlanningCallScope>;
export async function beginCccPlanningCallDispatch(layer: AsyncDataLayer, scope: CccPlanningCallScope): Promise<CccPlanningCallScope>;
export async function proveCccPlanningCallNotDispatched(layer: AsyncDataLayer, scope: CccPlanningCallScope, evidenceDigest: string): Promise<CccPlanningCallScope>;
export async function reconcileCccPlanningCall(layer: AsyncDataLayer, settlement: CccProviderAttemptReconciliation & CccPlanningCallScope): Promise<CccPlanningCallScope>;
export async function recordCccPlanningLineageSplit(layer: AsyncDataLayer, input: Readonly<{
  runId: string; parentLineageId: string; childLineageIds: readonly string[]; fence: CccPlanningWorkItemFence;
}>): Promise<void>;
export async function claimCccPlanningRepairChunk(layer: AsyncDataLayer, input: Readonly<{
  runId: string; source: "planning-rejection" | "coding-rejection"; candidateDigest: string; fence: CccPlanningWorkItemFence;
}>): Promise<Readonly<{ chunkOrdinal: 1 | 2 | 3 | 4 }>>;    // refuses "repair-exhausted" | "repair-epoch-closed"
export async function closeCccPlanningRepairEpoch(layer: AsyncDataLayer, input: Readonly<{ runId: string; fence: CccPlanningWorkItemFence }>): Promise<void>;
export async function inspectCccPlanningRun(layer: AsyncDataLayer, runId: string): Promise<CccPlanningRunStatus>; // one projection for CLI and dashboard
export function createCccPlanningAttemptController(input: Readonly<{
  layer: AsyncDataLayer; request: Omit<CccPlanningCallRequest, "dispatchKey" | "providerId" | "modelId" | "transport">;
}>): CccProviderAttemptController<CccPlanningCallScope>;

// packages/core/src/postgres/data-layer.ts (changed)
export interface RunAuditEventInput /* existing members unchanged */ {
  /** Non-campaign deterministic id; must match /^ccc-plan-event-[0-9a-f]{64}$/; insert ON CONFLICT DO NOTHING then compare. */
  readonly eventId?: string;
}
```

### Files (cards L1 and P1)

- **L1 (core ledger):**
  - `packages/core/src/postgres/migrations/0042_ccc_planning_runs.sql`
  - new `packages/core/src/postgres/schema/ccc-planning.ts` (Drizzle)
  - `packages/core/src/postgres/schema-applier.ts` (register 0042; `SCHEMA_BASELINE_VERSION` "0041" → "0042" at `:66`)
  - **the four tests that pin "0041"**, which L1 must own: `packages/core/src/__tests__/postgres/schema-applier.test.ts` and the `ccc-prd-import-migration`, `ccc-campaign-execution-authorization-migration` and `ccc-campaign-semantic-proof-v2-migration` `.pg` tests (critic #5)
  - new `packages/core/src/ccc-planning/{types,policy}.ts`
  - new `packages/core/src/task-store/ccc-planning-ops.ts`
  - `packages/core/src/postgres/data-layer.ts`
  - `packages/core/src/types/run-audit.ts` (mutation literals, if the union is closed)
  - `packages/core/src/task-store/async-maintenance.ts`
  - tests `packages/core/src/__tests__/postgres/ccc-planning-ledger.pg.test.ts`
  
  L1 must also check whether `0000_initial.sql` (the consolidated baseline that already contains `ccc_effect_receipts`) needs the new table for fresh installs.
- **P1 (Pi seam types):** `packages/core/src/ccc-campaign/types.ts`, `packages/core/src/ccc-campaign/provider-controller.ts`, `packages/engine/src/agent-runtime.ts`, `packages/engine/src/pi.ts` (types only), plus a typecheck fixture.

### Behavioural RED tests

1. **"Concurrent reservations never exceed the phase allocation."** `planning_allocation = 5`; 20 reservations on 20 separate pooled connections, each in a different lineage. Exactly 5 succeed, `planning_spent = 5`, and there are exactly 5 `reserved` events.
   
   *Non-vacuous:* real concurrency on separate connections, plus a recorded mutant (drop the `FOR UPDATE` and the `spent = $seen` predicate) that must over-admit.
2. **"The iteration cap refuses call 12 in one node attempt."** Calls 1-11 under one turn key, each committed, succeed. Call 12 refuses with `iteration-cap`.
   
   *Non-vacuous:* boundary pair (11 succeeds, 12 fails). A second turn key in the same lineage succeeds afterwards.
3. **"The dispatch cap counts at reservation and survives split and rename."** Lineage L: attempts 1 and 2 are each reserved, then `proved_failed`. Split L into L1 and L2 (both inherit 2). L1 attempt 3 succeeds; L1 attempt 4 refuses with `dispatch-cap`. Renaming L1 (same lineage id) still refuses. L2 attempt 3 succeeds once.
   
   *Non-vacuous:* without the inheritance event, L1 and L2 would each get 3 fresh attempts. A reservation that is never dispatched still counts.
4. **"Unknown dispatch blocks retry until reconciled."** `begin dispatch` with no terminal event: the next reservation in lineage L refuses with `unreconciled-dispatch`, while a reservation in lineage M succeeds. After `reconcileCccPlanningCall(committed)`, L can reserve again.
   
   *Non-vacuous:* the lineage-M control and the after-reconcile control.
5. **"No refund."** Cancel after dispatch leaves `planning_spent` unchanged. Raw SQL `UPDATE … SET planning_spent = planning_spent - 1` fails with `check_violation`, and so does a direct `deadline_at` edit without an amendment.
   
   *Non-vacuous:* the same raw SQL succeeds on a fixture table without the trigger, which proves the trigger is what refuses.
6. **"Release only after descendants settle."** `closeCccPlanningRun` refuses while one reservation is `reserved` and another is `dispatched_unknown`. It succeeds after both settle.
7. **"Retention never prunes planning receipts."** Old planning events and an old ordinary task event; `pruneOperationalLogsAsync(1)`. The ordinary event is deleted; every planning event remains.
   
   *Non-vacuous:* the positive-control deletion proves pruning actually ran.
8. **"Audit metadata stays bounded."** Recording a call with a 300-character string or an unknown key such as `prompt` refuses.
9. **"The Pi seam accepts a planning scope."**
   - *Typecheck RED:* `pi-planning-scope.typecheck.ts` constructs a `CccProviderAttemptBinding<CccPlanningCallScope>` and passes it to `createFnAgent`'s option type. It fails `tsc --noEmit` today because `binding` lacks `importId` and the other campaign fields.
   - *Behavioural regression guard (not a RED, since the runtime is unchanged):* with a fake provider, a planning controller round-trips `reserve → dispatch → reconcile`, and a mismatched `binding.modelId` is refused at `pi.ts:933-935`.

### Risks

- **History scan cost.** Each reservation reads up to about `3 × allocation` rows under the anchor lock: about 4.6 k rows for Standard planning, about 37 k for Large. Acceptable for I2 (Standard). Before Large, add a per-lineage expression index or a folded snapshot event.
- **D1 (iteration reading)** changes how often writer and planning attempts park. See Q3.
- **Advisory lock versus row lock.** Planning uses the anchor row lock, not an advisory lock, so the anchor is the single serialization point. Long transactions there delay all reservations of that run. Keep reservation transactions free of network I/O.

---

## Q3. Build bridging

### Decision

1. **Allocation transfer at G6, before dispatch.**
   - `maxRequests := min(implementation_allocation, 10_000)`. The admission ceiling is `packages/core/src/ccc-prd/import-admission.ts:90-96`. The clamp is recorded as `implementation_transferred` and in the import receipt. Build Large (12,288) is therefore clamped, never refused, and never exceeded. **Leader decision D3.**
   - `maxDurationMs := floor(deadline_at − db_now − 30 s)`, so `campaignDeadlineAt ≤ run deadline`.
   - `maxConcurrency := 1` for I2. Pools and ramp are I3.
   - These values go into the sidecar that the controller writes.
   - The importer's floor (`importer.ts:1436`, two requests per provider task) still applies.
   - `request_count` is the implementation spend. It never decreases (`provider-attempt.ts:1377-1397`), so there is still no refund.
2. **Writer caps: the same rules, added where writers already reserve.**
   - Inside `reserveCccProviderAttempt` (`provider-attempt.ts:1419-1479`), after `admittedBounds` and before `createScope`, add a lookup in the same transaction: `SELECT … FROM project.ccc_planning_runs WHERE project_id = $p AND import_id = $context.importId FOR SHARE`.
   - When the import is planning-linked, apply the following to the already-loaded `history.attempts`:
     - at most `CCC_PLANNING_MAX_CALLS_PER_ATTEMPT` reservations per `turnKey`;
     - at most 3 distinct `turnKey`s per `semanticTaskId`;
     - refuse while any attempt for that `semanticTaskId` is `dispatched_unknown`;
     - refuse while the anchor has `control_request` set.
   - Direct `fn prd` imports have no link, so their behaviour is byte-identical. PRD §2 says to preserve direct intake. **Leader decision D2:** whether to extend the caps to all campaigns later.
3. **What a writer "node attempt" is today.**
   - `providerAttemptTurnKey` hashes `(originTaskId, semanticTaskId, executionFence{workItemId, attempt, runId}, visitIdentity)` (`workflow-graph-executor.ts:524-546`). It does not include the in-process retry index of `executeNodeWithRetries` (`:2087-2305`).
   - So a new writer attempt exists only when the campaign work item is re-leased with a higher `attempt`.
   - The phase machine's one REPAIR turn (`packages/engine/src/ccc-phase-machine.ts:102-114`, `executor.ts:19845`) re-prompts in the same session and turn key. It therefore spends iterations of the same attempt. That is correct, because PRD §5 calls pre-submission self-repair ordinary work.
   - Safety holds: caps can only be under-used, never exceeded. Liveness risk: see below.
4. **G7 per-task review and G8 final judge run inside the campaign work item. There is no importer or IR change and no hold node** (critic #3).
   - `in-process-runtime.ts:2109-2112` builds `runCccProofSuite` from `createCccCampaignProofSuiteHandler` (`packages/engine/src/ccc-campaign-proof-execution.ts:2020`). Card B1 adds `composeCccPlanningReviewIntoProofSuite(handler, reviewPort)`. After a task-phase proof gate (`importer.ts:935-949`) or the final suite gate (`importer.ts:972-991`) passes for a **planning-linked** campaign, it:
     1. runs a fresh M3 review session, or the final judge, bound to the planning ledger with phase `review_proof`, lineage `review:<semanticTaskId>` or `judge:final`, and the **campaign item's fence**;
     2. returns the gate's success only if the review approves;
     3. turns a rejection into `PermanentError("ccc-permanent:CCC_PLANNING_REVIEW_REJECTED")`.
   - Successors are gated because they already depend on the task proof gate.
   - The planning ledger accepts a campaign fence only when `fence.runId = 'ccc-prd:' || anchor.import_id` and `state = 'building'`.
   - The review route is not the task's writer route, so it must not use the campaign route binding. The planning binding avoids `route-drift` (`provider-attempt.ts:1188`).
5. **Fit before dispatch.** In stage `import`, before the importer is called:
   - `remaining_implementation ≥ 2·(30·N_impl + 300)`, where `N_impl` = provider tasks in the compiled graph;
   - `remaining_review_proof ≥ 2·(30·N_rev + 300)`, where `N_rev` = one review per provider task + 1 final judge + any model proof/audit nodes;
   - `2 · criticalPath ≤ deadline_at − db_now`, with critical path from p90 durations or the PRD defaults (writer 60 min, review 10 min, heavy check 20 min).
   
   Otherwise refuse with `CCC_PLANNING_BUILD_FIT_INSUFFICIENT` and the exact shortfalls. No import row and no work item are created. The arithmetic for Build Standard is in the table below. The same pure function serves G0 planning fit, which answers critic #13: N ≥ 16 does not fit a 1,536 planning allocation.

   | Allocation | Size | Floor rule | Maximum N |
   |---|---|---|---|
   | Implementation | 3,072 | 2·(30·N + 300) ≤ 3,072 | 41 provider tasks |
   | Review/proof | 1,536 | 2·(30·N + 300) ≤ 1,536 | 15 (`N_rev = tasks + 1 + proofs`, so about 14 provider tasks) |

   **Review/proof, not implementation, is the binding limit for Build Standard.**
6. **Import identity without a second campaign** (critic #7). In stage `import`:
   1. A transaction under the fence compare-and-sets the anchor: `state → importing`, `import_intent_digest = final digest`, `import_idempotency_key = 'ccc-plan:' || run || ':' || digest`. The trigger makes these write-once.
   2. `importCccPrdBundle` runs (its own transaction, `importer.ts:1528-1533`).
   3. A second transaction links `import_id` after reading the `ccc_prd_imports` row by that idempotency key, sets `implementation_transferred`, and sets `state = building`.
   
   On recovery, an `importing` anchor with no `import_id` looks the key up and links it, or re-runs the import with the same stored packet. A different digest cannot be imported because the intent is write-once.
7. **Global repair is shared.**
   - Planning rejection (E→D) and coding rejection (a G7 or G8 rejection of a submitted candidate) both call `claimCccPlanningRepairChunk` on the same anchor columns.
   - In I2, coding-repair execution may not exist yet. In that case a coding rejection does **not** claim a chunk. It parks the campaign with `ccc-planning:coding-repair-not-run`, and the milestone must report "NOT RUN". Claiming a chunk and then not using it would waste the shared allowance.

### Rejected alternatives

- **A G7 hold node released by the planning controller.** It needs an importer or IR change and lets a second actor mutate campaign workflow state (critic #3, PRD §9 "prove mapping and authorization membership").
- **Running reviews on the campaign ledger.** The campaign route binding admits only the task's writer route (`provider-attempt.ts:1188-1202`). Splitting `request_count` into phases would need new columns on `ccc_prd_imports` and a manifest change.
- **Mirroring writer spend onto the anchor.** That would be a second counter for the same calls and a drift risk. Status reads `request_count` directly.
- **Refusing Build Large at G6.** The PRD allows using less than the allocation. Clamping is safe and keeps Large usable.
- **Adding the retry index to `providerAttemptTurnKey` now.** It changes persisted key identity. Exact-key evidence is re-validated on restart, so this needs a version bump plus legacy acceptance. Defer it to I3 or I4 with that migration.

### Signatures

```ts
// packages/core/src/ccc-planning/policy.ts (new, pure; owned by L1)
export function cccPlanningCallFloor(nodes: number): number; // 2 * (30 * nodes + 300)
export type CccBuildFitInput = Readonly<{
  implementationNodes: number; reviewProofNodes: number; criticalPathMs: number;
  remainingImplementation: number; remainingReviewProof: number; remainingDeadlineMs: number;
}>;
export type CccBuildFitResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: "CCC_PLANNING_BUILD_FIT_INSUFFICIENT";
      shortfalls: ReadonlyArray<Readonly<{ dimension: "implementation-calls" | "review-proof-calls" | "time"; required: number; remaining: number }>> }>;
export function assessCccBuildFit(input: CccBuildFitInput): CccBuildFitResult;
export const CCC_PRD_IMPORT_MAX_REQUESTS = 10_000 as const; // mirrors import-admission.ts:96

// packages/core/src/ccc-campaign/provider-attempt.ts (changed; owned by B1)
type CccPlanningImportLink = Readonly<{
  runId: string; controlRequest: "pause" | "cancel" | "resume" | null;
}>;
async function lockedPlanningLinkForImport(tx: DbTransaction, context: CccCampaignTaskContext): Promise<CccPlanningImportLink | null>;
function assertCccLinkedWriterCaps(
  history: ProviderAttemptHistory,
  requested: Readonly<{ turnKey: string; semanticTaskId: string }>,
  link: CccPlanningImportLink,
): void; // throws CccProviderAttemptLimitError("iteration-cap" | "dispatch-cap" | "unreconciled-dispatch" | "control-pending")

// packages/engine/src/ccc-planning/build-bridge.ts (new; owned by B1)
export async function importCccPlanningBuild(input: Readonly<{
  layer: AsyncDataLayer; rootDir: string; runId: string; fence: CccPlanningWorkItemFence;
  finalPacketArtifactId: string; finalDigest: string; compiledGraphSummary: Readonly<{
    providerTasks: number; reviewProofNodes: number; criticalPathMs: number }>;
}>): Promise<Readonly<{ importId: string; maxRequests: number; maxDurationMs: number }>>;
export async function recoverCccPlanningImportLink(layer: AsyncDataLayer, runId: string): Promise<"linked" | "reimport-required" | "none">;

// packages/engine/src/ccc-planning/review-port.ts (new; owned by B1)
export interface CccPlanningReviewPort {
  reviewTask(input: Readonly<{ importId: string; semanticTaskId: string; fence: CccPlanningWorkItemFence; signal?: AbortSignal }>):
    Promise<Readonly<{ verdict: "approve" | "reject"; artifactId: string }>>;
  judgeFinal(input: Readonly<{ importId: string; fence: CccPlanningWorkItemFence; signal?: AbortSignal }>):
    Promise<Readonly<{ verdict: "approve" | "reject"; artifactId: string }>>;
}
export function composeCccPlanningReviewIntoProofSuite(
  proofSuite: WorkflowNodeHandler,
  port: CccPlanningReviewPort,
  isPlanningLinked: (originTaskId: string) => Promise<string | null>, // returns runId or null
): WorkflowNodeHandler;
```

H1 owns `in-process-runtime.ts` and wires `composeCccPlanningReviewIntoProofSuite` at `:2109`.

### Files (card B1)

`packages/core/src/ccc-campaign/provider-attempt.ts`, new `packages/engine/src/ccc-planning/{build-bridge,review-port}.ts`, tests `packages/core/src/__tests__/postgres/ccc-planning-writer-caps.pg.test.ts` and `packages/engine/src/__tests__/ccc-planning-build-bridge.real-pg.test.ts`. B1 depends on L1 (anchor) and P1 (limit reasons, view types).

### Behavioural RED tests

1. **"Linked writer caps."** Two imports with identical seeded history: A is planning-linked, B is a direct `fn prd` import. On one writer `turnKey` with 11 committed calls, the 12th reservation refuses with `iteration-cap` on A and succeeds on B.
   
   *Non-vacuous:* the paired unlinked control proves the link is the cause, and that direct intake is unchanged.
2. **"Writer lineage dispatch cap."** Linked import: three work-item leases (fence attempts 1-3) each reserve one call for the same `semanticTaskId`. The fourth refuses with `dispatch-cap`. On an unlinked import it succeeds.
3. **"Unknown writer dispatch blocks the lineage."** Linked: a `dispatched_unknown` on task X blocks the next X reservation, while task Y proceeds.
4. **"Transfer bounds and the deadline."** Import from a run with 3,072 implementation and a 5-hour remaining deadline. Assert `maxRequests = 3072`, `campaignDeadlineAt ≤ deadline_at`, and `implementation_transferred = 3072`. For a Large run assert `maxRequests = 10000` and a recorded clamp.
   
   *Non-vacuous:* the deadline assertion fails with today's default `maxDurationMs` from policy.
5. **"Lost acknowledgement never makes a second campaign."** Inject a crash after `importCccPrdBundle` commits and before the link. Then run recovery. Assert `ccc_prd_imports` has 1 row for the run, `import_id` is linked, and a retry with a different final digest refuses with a trigger `check_violation`.
   
   *Non-vacuous:* without the intent row, the second digest creates a second import row. Count rows.
6. **"Fit before dispatch."** A compiled graph with 15 provider tasks against 1,536 review/proof: `2·(30·16 + 300) = 1,560 > 1,536`, so the import refuses with `CCC_PLANNING_BUILD_FIT_INSUFFICIENT`, and zero import and work-item rows are created. With 14 tasks (N_rev = 15, floor 1,500) it proceeds. A critical path of 3 hours against 5 remaining hours refuses on time.
   
   *Non-vacuous:* boundary pair on both dimensions.
7. **"G7 gates successors and spends review/proof."** Linked campaign, task proof passes, fake M3 review rejects. Assert the successor node is never visited, `review_proof_spent` went up, `request_count` is unchanged by the review, and the gate is not retried (one review reservation per rejection).
   
   *Non-vacuous:* with an approving review, the successor runs.
8. **"Global repair is shared."** Planning claims 3 chunks; coding claims chunk 4; the next claim from either source refuses with `repair-exhausted`. After `closeCccPlanningRepairEpoch`, the epoch cannot reopen.

### Risks

- **I2 liveness.** Live writers have cost 9-13 calls per task (`packages/core/src/ccc-campaign/request-budget.ts:10-15`), counting MUTATE plus REPAIR in one turn key. Expect some writers to hit the 11-call cap and park. That is PRD-correct, but it can make the I2 run fail its milestone. Measure on the offline slice first, then decide D1.
- **In-process retries.** Retries under the same `turnKey` either replay the committed reservation or collide on `(turnKey, dispatchKey)` (`provider-attempt.ts:1433-1448`). So in practice a writer gets one attempt per work-item lease. Caps are never exceeded, but retries are weaker than the PRD intends until the turn-key v2 migration.
- **Pause and cancel during Build** (I2 scope). New writer calls are refused (`control-pending`), and the campaign ends `manual-required`. `fn plan resume` then re-arms through the existing campaign resume at the safe boundary. Full cancellation semantics for a running writer belong to the I4 fault matrix.
- **Hot shared file.** `provider-attempt.ts` is a 1,708-line safety module. Keep the linked check additive, and run the whole provider-attempt `.pg` suite unchanged.

---

## Q4. Guarding the planning task (I1, not I5)

### Decision

**Marker.**
- `lineageId = <run id>`, which must match `^ccc-plan:[0-9a-f]{24}$`. It is set only by `createCccPlanningRun`.
- `createTask` refuses that lineage prefix from every other caller.
- Custody is still proved only by the anchor row (`planning_task_id`). The lineage marks suspicion, the same contract as the imported campaign lineage (`packages/engine/src/ccc-campaign-routing.ts:3-10`).

**Held shape.** The same pattern as prepared imported tasks (`packages/core/src/ccc-prd/projection.ts:60-114`):
- `column: "triage"`;
- `status: "ccc-planning-held"`;
- `paused: true`, which blocks triage (`packages/engine/src/triage.ts:1112`), recovery (`:820`) and scheduler pickup;
- `userPaused: false`, so the processor does not cancel itself (`workflow-work-processor.ts:111-114`);
- `pausedReason: "ccc-planning-held"`.

**Guards, in order of strength:**
1. **Store-level refusal in core.** This is the choke point that makes the rest defence in depth. For a task whose lineage matches the marker:
   - `moveTaskImpl` / `moveTaskIfImpl` (`packages/core/src/task-store/moves.ts:134, 160`) refuse;
   - `pauseTaskImpl` (`packages/core/src/task-store/branch-group-ops.ts:257`) refuses unpause;
   - `updateTaskImpl` (`packages/core/src/task-store/branch-and-pr-entities.ts:861`) refuses changes to `paused`, `status`, `pausedReason`, `customFields` and `workflowIrPin*`, but allows summary and log-style fields;
   - archive and delete refuse.
   
   Each throws `CccPlanningTaskCustodyError` (code `CCC_PLANNING_TASK_CUSTODY_REFUSED`, with a message naming `fn plan pause|cancel|resume`) unless the call passes `cccPlanningCustody: { runId }` equal to the lineage. Only `ccc-planning-ops.ts` passes it.
   
   This one change covers `fn task` pause, unpause, move, retry and done:
   - pause and unpause are `packages/cli/src/commands/task.ts:1147-1165`, which call `store.pauseTask`;
   - move is `:1168-1190`, which calls `store.moveTask`;
   - retry is `:1314-1374`;
   - done is `packages/cli/src/commands/task-lifecycle.ts:676, 714`.
   
   It also covers every self-healing sweep, triage moves, the scheduler's hold/release moves and every dashboard route. It also closes the dashboard guard's fail-open-on-lookup-error path (`packages/dashboard/src/routes/ccc-campaign-task-guard.ts:76-88`), because the store reads the row itself. Finally, it **avoids editing `self-healing.ts`**, whose line-pinned shellout allowlist is a known trap.
2. **Predicates.** In `packages/engine/src/ccc-campaign-routing.ts`:
   - add `isCccPlanningTask` and `isCccPlanningWorkItem`;
   - extend `isCccCampaignTask` to include planning tasks. This feeds the dashboard guard (`ccc-campaign-task-guard.ts:73`), the CCC durable frontier (`workflow-graph-executor.ts:955`), CCC permanent-failure handling (`:2175`) and executor terminal classification (`executor.ts:6704-6710`);
   - add `isCccCustodyTask = planning || imported`, used for engine automation exclusions. It deliberately leaves out the legacy `cccFusionProfile` custom field, so pre-product profile tasks keep their triage path.
3. **Executor.** The first line of `shouldDeferGenericCccCampaignExecution` (`executor.ts:6289`) becomes `if (isCccPlanningTask(task)) return true;`. This covers all three call sites (`:6337, 6657, 12706`).
4. **Drain.** In `drainWorkflowContinuations` (`in-process-runtime.ts:2229-2297`), classify `isCccPlanningWorkItem(item)` **before** `resolvePlanningContinuationCandidate`, whose paused-skip would otherwise park the item forever (`:133-135`). Then route to `processDueWorkflowWorkItem(…, { custody: "planning", exactCandidate })`. A planning item is never passed to `executor.execute` (`:2295`).
5. **Triage.** `discoverReadyPlanningTasks` (`triage.ts:1108-1120`) and `recoverApprovedTask` (`:812-823`) exclude `isCccCustodyTask`. This is defence in depth for the case where `paused` is ever cleared by a path not yet known.
6. **Dashboard.** Keep `registerCccCampaignTaskMutationGuard` (PRD §10). Change only its message so it names `fn plan` for planning tasks.

### Rejected alternatives

- **Relying on `paused` alone.** This is critic #1. Unpause is one store call away from triage handing the repo to an unconfined generic agent.
- **Setting `customFields.cccFusionProfile` on the planning task to reuse the predicate.** Custom fields are generic, mutable data, and the profile also marks legacy pre-product tasks that must keep triage.
- **Guarding each self-healing sweep one by one.** There are many sweeps, the list keeps growing, the allowlist is line-pinned, and it is easy to miss one. A store choke point is complete by construction.
- **Moving the planning task out of triage into a new column.** That needs new column semantics across board, dashboard and scheduler.

### Signatures

```ts
// packages/core/src/ccc-planning/marker.ts (new; owned by G1 so core and engine can share it)
export const CCC_PLANNING_LINEAGE_PATTERN = /^ccc-plan:[0-9a-f]{24}$/u;
export const CCC_PLANNING_HELD_STATUS = "ccc-planning-held" as const;
export const CCC_PLANNING_HELD_REASON = "ccc-planning-held" as const;
export function isCccPlanningLineage(lineageId: string | null | undefined): boolean;
export class CccPlanningTaskCustodyError extends Error {
  readonly code = "CCC_PLANNING_TASK_CUSTODY_REFUSED";
  constructor(readonly taskId: string, readonly action: "move" | "unpause" | "update" | "archive" | "delete" | "create");
}
export type CccPlanningCustodyToken = Readonly<{ runId: string }>;
// MoveTaskOptions, pauseTask agentOptions, updateTask runContext, archive/delete options gain:
//   cccPlanningCustody?: CccPlanningCustodyToken

// packages/engine/src/ccc-campaign-routing.ts (changed)
export function isCccPlanningTask(task: Pick<Task, "lineageId">): boolean;
export function isCccPlanningWorkItem(workItem: WorkflowWorkItem): boolean; // kind task, stableWorkflowRunId===runId, runId matches pattern, 64-hex irHash
export function isCccCustodyTask(task: Pick<Task, "lineageId">): boolean;   // planning || imported
export function isCccCampaignTask(task: Pick<Task, "customFields" | "lineageId">): boolean; // profile || imported || planning
```

### Files (card G1)

New `packages/core/src/ccc-planning/marker.ts`; `packages/core/src/task-store/{moves,branch-group-ops,branch-and-pr-entities}.ts`, plus the archive and delete implementations (G1 must locate the exact impl files behind `store.ts:2238, 2285`); `packages/engine/src/ccc-campaign-routing.ts`, `packages/engine/src/executor.ts` (one line), `packages/engine/src/triage.ts`, `packages/dashboard/src/routes/ccc-campaign-task-guard.ts`; tests in core, engine, CLI and dashboard.

`packages/cli/src/commands/task.ts` needs no change: the store error reaches it as exit 1. G1 only adds a CLI test. The drain classification at `in-process-runtime.ts` belongs to H1, to keep cards disjoint.

### Behavioural RED tests

1. **"Store refuses generic mutation of a held planning task."** For each of `moveTask(id, "todo")`, `pauseTask(id, false)`, `updateTask(id, {paused: false})`, `updateTask(id, {status: null})`, `archiveTask` and `deleteTask`: the call throws `CCC_PLANNING_TASK_CUSTODY_REFUSED` and the row is byte-identical afterwards.
   
   *Non-vacuous:* an ordinary twin task with the same column, paused flag and status but no lineage succeeds for every call. The same call with the custody token also succeeds.
2. **"`fn task` cannot unpause, move, retry or complete a planning task."** Through `runTaskUnpause`, `runTaskMove`, the retry command and the done command with a real store: exit 1 and a message naming `fn plan`. The twin succeeds.
3. **"The dashboard keeps the generic guard."** `POST`/`PATCH` on `/tasks/:id/*` for the planning task returns 409 `CCC_CAMPAIGN_TASK_MUTATION_BLOCKED`. `GET` returns 200. The twin's `POST` returns 2xx.
4. **"Triage ignores a planning task even if unpaused."** Clear `paused` with raw SQL to simulate an unknown bypass. `discoverReadyPlanningTasks` excludes the planning task and includes the twin.
   
   *Non-vacuous:* `paused` was the only shield before, and the raw-SQL bypass removes it.
5. **"The executor defers planning tasks."** `executor.execute(planningTask)` creates no worktree, session or log entry beyond the deferral line. The twin proceeds into the stubbed planning step.
6. **"The drain routes, never skips and never executes generically."** With a due `ccc-plan:` work item on a paused planning task, the planning processor is called once and `executor.execute` is never called. A paused ordinary item is still skipped.
7. **"Self-healing sweeps leave planning tasks alone."** Use raw SQL to make the planning task "attractive" to each sweep:
   - status null, a worktree and `workflowIrPinNodeId` for `recoverAdvancedTriageTasks` (`self-healing.ts:3184`);
   - in-progress, paused and with followers for `autoReboundPausedScopeDecay` (`:5310`).
   
   Run the sweeps. Planning rows are unchanged. Twins with identical shapes are changed.
   
   *Non-vacuous:* the twins prove that each sweep actually acted.

### Risks

- **Core store change.** It is limited to the planning lineage, so no existing task changes behaviour. G1 must still run the store move, pause and update suites.
- **A planning task stuck by a crash** can be moved only by the planning operations (`fn plan cancel`), never by `fn task`. That is intended. An operator needs `fn plan` working before I2, and C11 in the I1 CLI skeleton covers it.
- **The dashboard guard still fails open on lookup errors** for imported campaign tasks. This ADR does not change that behaviour; the store-level guard covers planning tasks only.

---

## Card map, dependencies and open leader decisions

**Cards** (disjoint file ownership):

| Card | Owns | Depends on | Increment |
|---|---|---|---|
| G1 | Marker and guards (Q4) | — | I1 |
| L1 | Anchor, ledger, control and fit policy (Q2) | G1 (marker) | I1 |
| P1 | Pi seam types (Q2) | — | I1 |
| H1 | Native host and drain (Q1) | L1, G1 | I1 |
| B1 | Build bridge, writer caps, review composition (Q3) | L1, P1; H1 wires it | I2 |

Contested shared files and their owners:
- `in-process-runtime.ts` → H1;
- `ccc-campaign/types.ts` → P1;
- `provider-attempt.ts` → B1;
- `schema-applier.ts` and the "0041" pins → L1.

No card edits `self-healing.ts` or `merger.ts`.

**Leader decisions:**
- **D1, iteration-cap reading:** 11 calls (1 + 10 iterations, recommended) or 10 calls per node attempt.
- **D2, writer caps scope:** planning-linked imports only (recommended for I2) or all campaigns.
- **D3, Build Large:** clamp the transfer to the 10,000 import ceiling (recommended) or raise the ceiling, which needs the history-scan work first.
- **D4, pause/cancel during Build:** in I2, refuse new calls and park the campaign; full semantics come in I4.
- **D5, coding-repair execution:** if it is not built for I2, report "NOT RUN" and do not claim a chunk.

**What this ADR does not decide:** artifact immutability (I1 artifact card), confinement, roles and routes, the import preflight extraction (critic #6), and CI wiring (critic #9).
