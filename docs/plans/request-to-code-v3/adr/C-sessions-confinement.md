# ADR C: Model sessions, cross-family review and command confinement

Status: proposed design, read-only investigation. Evidence is from worktree `/Users/ryanpappal/03_CODE/ccc-fusion/.worktrees/request-to-code-v3` at HEAD `589c293c7` (parent `d5fd9e87d` = origin/main). Paths below are relative to that worktree. Pi is `@earendil-works/pi-coding-agent@0.81.1` (the version in `node_modules/.pnpm`).

## How to read this

- **Q1** planning model calls: how a planning session is bound, pinned, settled and limited to a closed tool set.
- **Q2** G7 cross-family review in Build, plus the G6 rejected-identity check on Build routes.
- **Q3** kernel confinement of every model-originated shell command. It also answers whether the Build writer path spawns raw shell today (it does).
- **Q4** the researcher's public-web tool.
- **Q5** model quirks: M3 degenerate output, the Flash tool-fidelity preflight, exact-pin registration, and the serve-startup refresh that rewrites `settings.json`.

**No new table, ledger, lease or scheduler is proposed here.** Planning attempt persistence is ADR A's ledger. This ADR only defines the port the Pi binding calls. Artifact storage is ADR B. The authority receipt, isolated HOME and installed runtime are ADR D. Where this ADR depends on them, it says so.

### Live probes behind Q3 (macOS 26, Darwin 25.6.0)

These probes were non-writing apart from `/dev/null`. The worktree was verified clean afterwards. The ADR relies on these results.

| # | Probe | Result |
|---|---|---|
| P1 | Homebrew node 24.16.0 under `(deny default)` with **no** `mach*`, `ipc-posix-shm*` or `system-socket` | Runs. `child_process.spawn`, `execFileSync`, child IPC (`stdio: "ipc"`) and `worker_threads` all work. Two exceptions: `os.userInfo()` fails (it needs an opendirectoryd mach lookup), so set `USER` and `HOME`; and worker threads need a readable cwd (`uv_cwd` EPERM otherwise). |
| P2 | git under the same profile | The real Cellar binary (`/opt/homebrew/Cellar/git/2.50.1/bin/git`) runs `rev-parse`, `status` and `log` with `GIT_OPTIONAL_LOCKS=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null`. `/opt/homebrew/bin/git` is the SafeExec shim script (`#!/usr/bin/env bash`), so it fails with "bad interpreter: Operation not permitted". |
| P3 | exec and write outside the allowlist | `tail` and `ls` give EPERM when not listed. A write outside the write roots is denied, and the file is not created. |
| P4 | symlink | A literal allow of `/etc/hosts` does not allow reading it, because the real path is `/private/etc/hosts`. Seatbelt checks the resolved path, so a symlink cannot reach an unadmitted real path. |
| P5 | network | Connecting to TEST-NET 192.0.2.1:9, connecting to the unix socket `/var/run/mDNSResponder`, and listening on 127.0.0.1:0 all give EPERM under `(deny network*)`. |
| P6 | signals with `(allow signal (target same-sandbox))` | Signal 0 or SIGKILL to own children and to a **reparented setsid escaper** (ppid 1, own process group) succeed. Signal 0 or SIGCONT to an unowned same-user process gives EPERM. Two `sandbox-exec` instances with identical profile text cannot signal each other (EPERM). With `(target self)` alone, a process cannot signal its own children. |
| P7 | broadcast and zombies | `kill(-1, 0)` succeeds even with no same-sandbox peer, so broadcast kill is not sandbox-scoped and must never be used. A **foreign zombie** (an unrelated `<defunct>` process) answers signal 0 with success, so a signal-0 success does not prove ownership of a zombie. SIGKILL to a zombie does nothing. |
| P8 | full pid sweep `kill(pid, 0)` for pid 2..99999 from inside the sandbox | Takes 218 ms. It found exactly the 3 owned sleepers plus 1 foreign zombie. 1,321 pids returned EPERM. |
| P9 | SBPL rule order | "deny literal, then allow subpath" lets the read through. "allow subpath, then deny literal" denies the read. A deny **inside** an allowed root must therefore be emitted after the allow, and every deny needs its own RED test. |

---

## Q1. Planning model calls

### Decision

1. **The binding is generalized by adding a second scope kind, not by changing the campaign scope.**
   - The campaign scope `CccProviderAttemptScope` (`packages/core/src/ccc-campaign/types.ts:383-397`) stays byte-for-byte unchanged. It is persisted and re-validated by exact keys on restart, so adding a key would break in-flight recovery.
   - A new `CccPlanningProviderAttemptScope` carries `scopeKind: "planning-node"`. The binding's controller may return either kind.
   - `pi.ts` checks the round trip with an identity projection chosen by scope kind:
     - for the campaign kind, today's ten keys (`pi.ts:868-897`);
     - for the planning kind, every key except `state` and `terminal`.
   - The association check (`turnKey`, `dispatchKey`, `binding.taskId`, `binding.providerId`, `binding.modelId`, `binding.transport`) applies to both kinds unchanged. The planning binding therefore keeps those field names.
2. **Exact pin, `maxRetries: 0` and no settings fallback already hold** for any session with `profile: CCC_FUSION_PROFILE`, and a binding is refused without that profile (`pi.ts:3538-3541`). The specific mechanisms:
   - payload model forced to the pinned id and `maxRetries: 0` (`pi.ts:3576-3599`);
   - retry disabled (`pi.ts:3751-3753`);
   - primary-resolution failure throws instead of falling back (`pi.ts:3770-3772`);
   - prompt-time fallback refused (`pi.ts:4232`).

   Planning sessions use that profile, so no new code is needed for this. A RED test pins it for the planning kind.
3. **Receipt mismatch settles as `proved_failed` exactly once.** Today `requireCccOmniRouteReceipt` throws inside `finalResult` before `controller.reconcile` (`pi.ts:1064-1067`, `1094`). A missing or mismatched terminal receipt therefore leaves the attempt `dispatched_unknown`, and a retry of the same `dispatchKey` is held (this behaviour is pinned by `packages/engine/src/__tests__/pi.test.ts:1872-1909`). Change:
   - Before calling `reconcile`, `pi.ts` runs the store's own pure check, `assertCccProviderAttemptEffectiveRoute` (`packages/core/src/ccc-campaign/provider-attempt.ts:489-545`), plus `requireCccOmniRouteReceipt`.
   - On `route-drift`, a missing receipt, or a receipt mismatch, it calls `reconcile` once with `outcome: "proved_failed"`, **no `effectiveRoute`**, and an `evidenceDigest` over a canonical refusal record. It then throws `CccProviderRouteReceiptError`.
   - The store already accepts this with no change. `terminalReceiptRequired` is `outcome === "committed"` (`provider-attempt.ts:1553`), and an absent effective route with a receipt adapter returns `undefined` when no receipt is required (`provider-attempt.ts:498-508`).
   - "Exactly once" holds for two reasons: `finalResult` is memoized per stream (`pi.ts:1050`), and a replay with the same digest is idempotent at the store (`provider-attempt.ts:1558-1566`).
   - A provider stream `error` event (`pi.ts:1114-1118`) is also terminal for a model call, since model calls have no external effects. It settles `proved_failed` the same way.
   - Only a lost connection or an abort without any terminal event stays `dispatched_unknown`.
   - This is a deliberate behaviour change for campaigns too, because the code path is shared. `pi.test.ts:1872` is rewritten to expect it. The store's refusal stays as defense in depth.
4. **Closed per-role tool policy, enforced by the binding.**
   - `CccProviderAttemptBinding` gains an optional frozen `toolPolicy`. It is required when the scope kind is planning, and when the executor builds a request-to-code writer or review binding.
   - When `toolPolicy` is present, `createFnAgent`:
     - ignores `options.tools` and `options.builtinToolsAllowlist`;
     - builds only the tools the policy names, using confined operations (Q3);
     - skips host extensions, plugin skills and RTK;
     - **refuses** session creation (`CCC_SESSION_TOOL_POLICY_REFUSED`) if the caller passes any MCP server, any custom tool outside the policy, or `toolsAllowlist` or `builtinToolsAllowlist` entries outside the policy;
     - after the whole wrapper chain (`pi.ts:4043-4071`), asserts that the final tool-name set **equals** `allowedTools` and that the digest of `{name, parametersSha256}` (the existing `CccExecutionToolAuthority` projection, `packages/engine/src/agent-runtime.ts:59-63`) equals `toolPolicy.toolsetDigest`.

     Using equality rather than a subset check also catches tools that silently fail to appear, and the digest catches Pi schema drift.
5. **Role tool sets.** All file tools use confined operations rooted at the session's read roots. `grep` is a controller implementation that never calls `ensureTool("rg")`, because the Pi grep downloads ripgrep from GitHub when it is missing.

| Role class | Roles (PRD §4, doc lines 79-95) | Tools |
|---|---|---|
| `author` | intent assessor, synthesizer/spec author, execution planner, designer A, designer B | `read`, `ls`, `find`, `grep`, `ccc_submit_artifact` |
| `researcher` | repository/public researcher, source verifier, Flash extraction leaves | author tools + `ccc_research_fetch` (Q4) + `ccc_citation_read` |
| `critic` | product adversary, technical critic, verifier auditor, final judge, G7 reviewer | `read`, `ls`, `find`, `grep`, `ccc_submit_verdict` |
| `writer` | Flash implementation writers; verifier author (its write roots are the verifier-preparation scope) | `read`, `ls`, `find`, `grep`, `edit`, `write`, `bash` (confined, Q3) |

   Critics have no `edit`, `write` or `bash`. This follows PRD line 102: critics deny edit, write and generic shell tools, and models receive no broad MCP control. `WebSearch`, `WebFetch`, `fn_web_fetch`, `fn_task_*`, `fn_insight_*`, `fn_list_agents`, `fn_get_agent_config`, document tools and MCP are never admitted to any role. Today all of these can arrive through `READONLY_ALLOWLIST` (`packages/engine/src/workflow-step-tool-policy.ts:4-18`), `builtinToolsAllowlist` (`pi.ts:4149`) or the executor's `mcpServers` (`packages/engine/src/executor.ts:19253`).
6. **Sealing.** Each planning session gets its own read roots:
   - the run's repository snapshot, made by `git archive <admittedBase>` into run scratch. It holds tracked files only, so there is no `.git`, no ignored `.env`, and no git config with remote URLs;
   - one per-session packet directory that the controller fills only with that session's admitted inputs.

   Designer B's packet never contains designer A's artifact. ADR B enforces the input closure; this ADR makes the filesystem and tool surface unable to reach around it. There are no document tools, and the prompt carries only packet content. Confined `read`, `ls`, `find` and `grep` resolve `realpath` and refuse anything outside the roots, including `..`, absolute paths and symlinks that resolve outside.
7. **Persistence is behind a port.** Planning attempts cannot use the campaign columns of `run_audit_events` before import, because of the foreign key to `ccc_prd_imports` (`packages/core/src/postgres/migrations/0037_*.sql:103`). The binding's controller calls `CccPlanningAttemptLedgerPort`, which ADR A implements. This ADR fixes the port's shape so `pi.ts` can be built and tested against a fake.

### TypeScript (new or changed)

```ts
// packages/core/src/ccc-campaign/types.ts — additive only; CccProviderAttemptScope unchanged
export type CccPlanningRoleClass = "author" | "researcher" | "critic" | "writer";

export type CccPlanningAuthorityBinding = Readonly<{
  scopeKind: "planning-node";
  projectId: string;
  runId: string;
  runRevision: number;
  taskId: string;            // native planning task id; association check requires === scope.taskId
  nodeId: string;
  nodeAttempt: number;
  lineageId: string;
  role: string;              // PRD role name, e.g. "designer-b"
  roleClass: CccPlanningRoleClass;
  providerId: string;        // local custom-provider registry id
  modelId: "glm/glm-5.3" | "glm/glm-5.3-flash" | "minimax/MiniMax-M3";
  transport: "pi";
  receiptAdapterId: "terminal-route-sse-comments.v1";
  toolsetDigest: string;     // lowercase sha256
  policyDigest: string;      // admitted run policy digest
  bindingHash: string;       // sha256 of canonical JSON of every field above
}>;

export type CccPlanningProviderAttemptScope = Readonly<{
  scopeKind: "planning-node";
  attemptKey: string;
  controllerToken: string;
  taskId: string;
  turnKey: string;
  dispatchKey: string;
  attemptOrdinal: number;
  requestCount: number;
  runDeadlineAt: string;
  workItemFence: CccCampaignWorkItemFence;
  state: CccProviderAttemptState;
  terminal?: CccProviderAttemptTerminalEvidence;
  binding: CccPlanningAuthorityBinding;
}>;

export type CccAnyProviderAttemptScope = CccProviderAttemptScope | CccPlanningProviderAttemptScope;

export type CccPlanningProviderAttemptSettlementInput =
  Omit<CccPlanningProviderAttemptScope, "state" | "terminal"> & Readonly<{
    outcome: "committed" | "proved_failed";
    evidenceDigest: string;
    observerId: string;
    effectiveRoute?: CccProviderAttemptEffectiveRouteInput;
  }>;

// packages/core/src/ccc-campaign/provider-controller.ts — widened (campaign callers unchanged)
export type CccProviderControllerDecision<S extends CccAnyProviderAttemptScope = CccAnyProviderAttemptScope> =
  | Readonly<{ kind: "dispatch-permit"; scope: S }>
  | Readonly<{ kind: "hold"; reason: CccCampaignProviderControllerHoldReason; scope: S }>;
```

```ts
// packages/engine/src/agent-runtime.ts — changed
export type CccSessionToolPolicy = Readonly<{
  policyId: `ccc-${CccPlanningRoleClass}-tools.v1`;
  allowedTools: readonly string[];          // frozen, sorted, exact final names
  toolsetDigest: string;                    // sha256 over sorted CccExecutionToolAuthority[]
  readRoots: readonly string[];             // realpaths
  writeRoots: readonly string[];            // realpaths; [] unless roleClass === "writer"
  deniedNames: readonly string[];           // e.g. [".env", ".agentsecrets", "_secrets"]
}>;

export type CccProviderAttemptController = Readonly<{
  preDispatch(input: CccCampaignProviderDispatchInput): Promise<CccProviderControllerDecision>;
  reconcile(
    input: CccProviderAttemptSettlementInput | CccPlanningProviderAttemptSettlementInput,
  ): Promise<CccAnyProviderAttemptScope>;
}>;

export type CccProviderAttemptBinding = Readonly<{
  turnKey: string;
  controller: CccProviderAttemptController;
  receiptAdapterId?: CccCampaignRouteReceiptAdapterId;
  terminalRouteMembers?: readonly CccCampaignTerminalRouteMember[];
  toolPolicy?: CccSessionToolPolicy;        // validator: frozen, exact keys, sorted unique names
}>;
```

```ts
// packages/engine/src/ccc-planning/provider-binding.ts — new
export interface CccPlanningAttemptLedgerPort {          // implemented by ADR A
  reserve(input: Readonly<{
    binding: CccPlanningAuthorityBinding;
    turnKey: string;
    dispatchKey: string;
    workItemFence: CccCampaignWorkItemFence;
  }>): Promise<CccProviderControllerDecision<CccPlanningProviderAttemptScope>>;
  settle(input: CccPlanningProviderAttemptSettlementInput): Promise<CccPlanningProviderAttemptScope>;
}
export function createCccPlanningProviderAttemptBinding(input: Readonly<{
  ledger: CccPlanningAttemptLedgerPort;
  binding: CccPlanningAuthorityBinding;
  workItemFence: CccCampaignWorkItemFence;
  turnKey: string;
  toolPolicy: CccSessionToolPolicy;
}>): CccProviderAttemptBinding;              // frozen; preDispatch refuses if input identity ≠ binding

// packages/engine/src/pi.ts — new, internal
export class CccProviderRouteReceiptError extends Error {
  readonly code: "CCC_PROVIDER_ROUTE_RECEIPT_REFUSED";
  readonly reason: "receipt-missing" | "receipt-mismatch" | "effective-route-drift" | "provider-error-event";
  readonly requested: Readonly<{ provider: string; model: string }>;
  readonly observed: Readonly<{ provider: string; model: string }> | null;
}
// refusal evidence: sha256(canonical({schema:"ccc-provider-route-refusal.v1", reason, requested, observed, adapter}))
```

No SQL in this question. Persistence belongs to ADR A.

### Files that change

- `packages/core/src/ccc-campaign/types.ts` (additive types)
- `packages/core/src/ccc-campaign/provider-controller.ts` (generic decision type)
- `packages/engine/src/agent-runtime.ts` (binding and tool policy types)
- `packages/engine/src/pi.ts`, two disjoint regions:
  - (a) binding validator `744-809`, controlled stream `987-1149` and identity check `868-912`, owned by card C1;
  - (b) tool assembly `3698-3730` and the chain `4043-4160`, owned by card C2.
- `packages/engine/src/__tests__/pi.test.ts:1872-1909` (rewritten expectation, C1)
- new `packages/engine/src/ccc-planning/provider-binding.ts` (C1)
- new `packages/engine/src/ccc-confinement/session-tool-policy.ts` (policy builder and final-set assertion, C2)
- new `packages/engine/src/ccc-confinement/confined-fs-tools.ts` (confined read, ls, find and write/edit operations, plus controller `grep`, C2)

### RED tests (each names what makes it non-vacuous)

| Test | Assertion | Non-vacuous because |
|---|---|---|
| Q1-T1 mismatch settles once | A fake OmniRoute stream for `glm/glm-5.3` ends with trailing SSE route comment `glm/glm-5.2`. The fake ledger records exactly one `settle` with `outcome: "proved_failed"`, no `effectiveRoute`, and zero calls with `committed`. The session throws `CCC_PROVIDER_ROUTE_RECEIPT_REFUSED/receipt-mismatch`. | Control: the same fake with trailing `glm/glm-5.3` produces exactly one `committed`. Before the fix, the mismatch case produces zero `settle` calls. |
| Q1-T2 missing receipt | The stream has no trailing receipt. Exactly one `proved_failed`. | Control as T1. Today this path leaves the attempt dispatched-unknown. |
| Q1-T3 provider error event | The stream yields `{type:"error"}`. Exactly one `proved_failed`. An abort without an event yields zero settles. | The abort sub-case proves the code does not settle on every failure. |
| Q1-T4 permissive caller refused | A critic binding with `tools: "coding"`, `toolsAllowlist: ["bash","edit"]` and one MCP server: `createFnAgent` throws `CCC_SESSION_TOOL_POLICY_REFUSED`, and the fake provider stream is called 0 times. | Control: the same caller without a binding gets `bash` and `edit` (asserted from session tool names). |
| Q1-T5 final set equality | A critic session's tool names deep-equal `["find","grep","ls","read","ccc_submit_verdict"]`, and the toolset digest matches. | A test plugin that injects an extra tool through the extension path makes the assertion fail (control run with the guard disabled shows the tool appears). |
| Q1-T6 sealed designer | Designer B's packet excludes A. Through the session's real tools, `read` of A's artifact path by absolute path, by `../` and by a symlink placed in B's packet all refuse. `find`/`grep` for a unique token in A return nothing. | Positive control: the same token is found when A's directory is added to read roots, and an unconfined `fs.readFile` of the path succeeds. |
| Q1-T7 no rg download | With `PATH` lacking `rg`, grep works and `ensureTool` is never called (spy on the Pi tools-manager module), with no network request. | Control: the stock Pi grep under the same `PATH` calls `ensureTool("rg")`. |
| Q1-T8 pin and fallback | A planning binding with a fallback pair configured: a primary model that is not registered throws, and the fallback model's stream is called 0 times. | Control: the same options without the CCC profile use the fallback. |

### Rejected alternatives

- **Add `scopeKind` to the campaign scope.** Persisted campaign evidence is checked by exact keys on every restart, so in-flight recovery would break and older code would refuse the new rows.
- **Run planning attempts through `run_audit_events` campaign rows.** They are foreign-keyed to `ccc_prd_imports` (`0037:103`) and capped by `request_count` compare-and-set on the import row (`provider-attempt.ts:1377-1397`), which do not exist before import.
- **Enforce tools only through `cccCampaignPhaseToolPolicy`.** These are string heuristics over arguments (`pi.ts:2797-3106`), not a closed set. They also do not remove MCP, extensions or web tools.
- **Use `tools: "readonly"` for critics.** `READONLY_ALLOWLIST` admits `WebFetch`, `fn_web_fetch` and `fn_task_*` (`workflow-step-tool-policy.ts:4-18`).
- **Settle mismatches as `committed` with an error flag.** That would count a wrong-model answer as delivered work and break the "no fallback" rule.

### Risks

- Changing mismatch handling also changes campaign behaviour. Any operator runbook that expects a mismatch to leave a dispatched-unknown attempt must be updated.
- Settling `proved_failed` with no effective route loses the observed model in the ledger row. The observed identity lives only in the refusal record digest and the thrown error. Persist the refusal record as a task artifact (ADR B) if operators need it.
- Prompt-cache or OmniRoute response cache crossover between designers is not a filesystem path. The `X-OmniRoute-No-Cache` header (Q5) is required on every pinned provider.

---

## Q2. G7 cross-family review in Build, and G6 identity admission

### Finding: there are no per-stage routes and no reviewer stage

- The campaign IR emits, per task, one `prompt` node (`packages/core/src/ccc-prd/importer.ts:821`) and a task proof `gate` (`importer.ts:940`, `cccProofGate`), plus split, join and final proof-suite gates (`importer.ts:775-1054`).
- A product route is one per task, with `toolMode` that must be `coding` (`packages/core/src/ccc-campaign/canonical.ts:455`) and `commitPolicy` that must be `required` (`canonical.ts:465`).
- `createCccPrdProductExecutionPlan` already allows a different route per task via `routesByTaskId` (`canonical.ts:1029-1040`).
- The provider binding factory re-derives the task's single route and refuses on mismatch (`packages/engine/src/ccc-campaign-provider-controller.ts:95-125`). The authority binding hash includes `providerId`, `modelId` and `transport` (`types.ts:490-508`, `canonical.ts:1546-1584`). Leases and approvals match `bindingHash`.
- The memory note's `stageOrdinal: 3 (reviewer)` is a misreading. `stageOrdinal` is the attempt lifecycle stage: reserved, dispatched, reconciled (`provider-attempt.ts:1314-1340`).
- The executor recognizes only implementation nodes (`executor.ts:2043-2081`). Its comment at `executor.ts:9748-9754` records that routing campaign nodes through the generic workflow reviewer made a coding model inspect an empty worktree and return REVISE.

### Decision: G7 is a separate sealed review task per implementation task, in series

1. **Compiler.** For each implementation task `T`, the compiler emits a review task `R(T)` with semantic id `${T}--g7` (validated by the existing identifier rules). It adds edge `T → R(T)` and rewires every successor of `T` to depend on `R(T)`. Downstream work therefore consumes only reviewed trees, which satisfies the "accepted predecessor trees" part of PRD G7 (line 205). The final proof-suite gate depends on every `R`.
2. **Route.** `R(T)` gets its own route through `routesByTaskId`, using the new readonly review variant below. All existing per-task machinery then applies unchanged: the provider binding, action lease, authority members, custody and route hash. `routeKind` is present only on review routes, so legacy routes keep their exact key set and old campaigns re-parse unchanged.
3. **Executor.** A sibling predicate `isExactFencedCccCampaignReviewNode` (`toolMode: "readonly"`, `commitPolicy: "none"`, review prompt schema, `reviewOfTaskId`) selects `runCccCampaignReviewNode`, which:
   - materializes `R`'s worktree from `T`'s accepted tree (the existing predecessor-tree path);
   - builds the review packet: task contract, requirement ids, the diff of `T`'s accepted tree against `T`'s base, and `T`'s proof-gate observations (exit codes plus bounded output digests and excerpts). Critics judge observations; the controller executes commands (PRD line 247). The reviewer receives no previous verdicts;
   - opens a `critic` session (Q1 tool policy) with route M3;
   - requires `ccc_submit_verdict`.

   The node's output tree equals its input tree, so no commit is made.
4. **Verdict handling.** `accept` with zero blocking findings → success. `reject` → node failure `CCC_G7_REVIEW_REJECTED` → the existing global repair path, with the findings in the repair-feedback envelope (proven live in V14). Text without the verdict tool → `CCC_MODEL_DEGENERATE_OUTPUT` (Q5).
5. **Budget phase.** Review-task provider attempts must be charged to the review/proof allocation, not implementation (ADR D lines 572-576). The review route carries `phase: "review-proof"` for ADR A's bridge to count. The campaign `maxRequests` compare-and-set must cover implementation plus the compiled review floor, or ADR A must split the count by phase. **This is an open dependency on ADR A.**

### G6 rejected-identity admission (request-to-code imports only)

- A pure function in core is called at the request-to-code G6 freeze/import, and again at Build dispatch start after any restart. It is **not** called inside `parseProductRoute`, because historical combo campaigns (`canonical.ts:189-260`) must keep re-parsing on restart.
- Admission is by **allowlist**: the exact pin registry. The denylist only names the reason, so diagnostics are useful.
- ADR D's receipt check (D lines 357 and 403) should call this same function, so there is one implementation.
- Rules:
  - The role decides the model: writer → `glm/glm-5.3-flash` (GLM 5.3 writer escalation is I3 and refused in I2); review → `minimax/MiniMax-M3`.
  - `transport === "pi"`.
  - `receiptAdapterId === "terminal-route-sse-comments.v1"`.
  - No `terminalRouteMembers`.
  - `providerId` resolves to a loopback custom provider (`validateCccLoopbackHttpUrl`) whose settings entry declares exactly that one model and matches the pinned entry digest (Q5).
  - `family(review.modelId) !== family(reviewed.modelId)`, with `glm/*` as one family (PRD line 100).

```ts
// packages/core/src/ccc-campaign/route-admission.ts — new
export type CccModelFamily = "glm" | "minimax";
export type CccQualifiedPin = Readonly<{
  modelId: "glm/glm-5.3" | "glm/glm-5.3-flash" | "minimax/MiniMax-M3";
  family: CccModelFamily;
  providerId: string;
  settingsEntrySha256: string;
}>;
export type CccRouteRole = "writer" | "g7-review";
export type CccRouteAdmissionReason =
  | "excluded-model"            // glm/glm-5.2, bare glm-5.2, any */glm-5.2
  | "floating-alias"            // *-latest, :latest, @latest
  | "combo-route"               // combo/* or terminalRouteMembers present
  | "unqualified-id"            // no "<provider>/" prefix
  | "not-in-pin-registry"       // look-alikes: opencode-go/glm-5.3, glm/glm-5.3-flashx, glm/GLM-5.3
  | "role-model-mismatch"
  | "provider-not-pinned"       // providerId absent, non-loopback, extra models, or digest drift
  | "receipt-adapter-required"
  | "same-family-review";
export type CccRouteAdmissionRefusal = Readonly<{
  code: "CCC_ROUTE_IDENTITY_REJECTED";
  reason: CccRouteAdmissionReason;
  taskId: string;
  observedModelId: string;
}>;
export function admitCccRequestToCodeRoutes(input: Readonly<{
  routes: readonly (CccCampaignProductRoute | CccCampaignReviewRoute)[];
  roleOf: (taskId: string) => CccRouteRole;
  reviewedTaskOf: (reviewTaskId: string) => string;
  pins: readonly CccQualifiedPin[];
}>): readonly CccRouteAdmissionRefusal[];       // empty array = admitted
```

```ts
// packages/core/src/ccc-campaign/types.ts — additive
export type CccCampaignReviewRoute = Readonly<{
  taskId: string;
  routeKind: "g7-review";
  reviewOfTaskId: string;
  phase: "review-proof";
  providerId: string;
  modelId: string;
  transport: "pi";
  receiptAdapterId: "terminal-route-sse-comments.v1";
  toolMode: "readonly";
  commitPolicy: "none";
}>;

// packages/engine/src/ccc-confinement/verdict-tool.ts — new (shared by all critics)
export type CccReviewVerdict = Readonly<{
  verdict: "accept" | "reject";
  findings: readonly Readonly<{
    requirementId: string;              // must exist in the packet's requirement list
    severity: "blocking" | "advisory";
    path?: string; line?: number;       // path must be inside the reviewed diff
    summary: string;                    // <= 600 chars
  }>[];
}>;
// tool refuses: accept with any blocking finding; unknown requirementId; path outside diff; second call
```

No SQL. Routes persist inside the existing frozen execution policy JSON, and only new rows gain the new keys.

### Files that change

- `packages/core/src/ccc-campaign/canonical.ts` (parse a `routeKind: "g7-review"` key set beside `parseProductRoute`; plan builder accepts review routes)
- `packages/core/src/ccc-campaign/types.ts` (review route type)
- new `packages/core/src/ccc-campaign/route-admission.ts`
- `packages/core/src/ccc-prd/importer.ts` (`nativeWorkflowIr`: review nodes and edge rewiring)
- `packages/engine/src/executor.ts` (new predicate beside `:2043` and new `runCccCampaignReviewNode`, dispatched beside `:9756`)
- new `packages/engine/src/ccc-confinement/verdict-tool.ts`
- The request-to-code G6 call site is in ADR B's `product-import-preflight.ts`. This ADR adds one call there, coordinated with B.

### RED tests

| Test | Assertion | Non-vacuous because |
|---|---|---|
| Q2-T1 rejected identities | Each of `glm/glm-5.2`, `glm-5.2`, `combo/glm`, `glm/glm-5.3-latest`, `opencode-go/glm-5.3`, `glm/glm-5.3-flashx`, a route with `terminalRouteMembers`, and a writer route on `minimax/MiniMax-M3` is refused with its named reason, and the fake transport is called 0 times. | Positive control: the identical fixture with `glm/glm-5.3-flash` admits and the fake transport is called exactly once. A refuse-everything implementation fails the control. |
| Q2-T2 same-family review | A review route `glm/glm-5.3` for a Flash writer → `same-family-review`. | Control: M3 review of the same writer admits. |
| Q2-T3 historical re-parse | A persisted combo campaign policy fixture from before this change re-parses through `parseProductRoute` unchanged (byte-equal canonical output). | It fails if the admission check is put in the generic parser. |
| Q2-T4 graph shape | Compiling a 4-task diamond yields `T→R(T)`, every successor edge comes from `R(T)`, and no edge comes from `T` to a successor. | The fixture's original edges come from `T`, so an unchanged compiler fails. |
| Q2-T5 reject drives repair | The fake M3 calls `ccc_submit_verdict({verdict:"reject", findings:[blocking]})`. The successor never dispatches, and one global-repair request carries the finding ids. | Control: an `accept` verdict dispatches the successor. |
| Q2-T6 verdict tool integrity | `accept` with a blocking finding, an unknown requirement id, or a path outside the diff are each refused by the tool. | Control: a well-formed `accept` is admitted. |
| Q2-T7 binding unchanged for writers | Writer task binding hashes for a fixture campaign are byte-equal before and after adding review tasks. | It fails if review routes are folded into the writer task's route. |

### Rejected alternatives

- **A second "stage route" inside the writer task.** The binding hash, leases, approvals and custody are keyed to one route per task across core and engine, and a second route breaks every one of them.
- **Reuse the generic workflow-step reviewer.** It is documented to have failed on campaign nodes (`executor.ts:9748-9754`), has no route binding, and runs on the default model.
- **A hold node released by the planning controller.** That is a second execution authority.
- **Self-review inside the writer session.** It is the same family and not fresh.
- **Review only at joins.** It delays rejection and widens the repair scope. PRD G7 is per task and per join.
- **Put the identity denylist in `parseProductRoute`.** It breaks re-parsing of historical campaigns on restart.

### Risks

- **`commitPolicy: "none"` pass-through is new to the campaign executor.** Join and integration code may assume every campaign task yields a commit. Q2-T4 and a join test on a pass-through tree must run before I2.
- One extra M3 call series per task. ADR D's I2 fit (4 G7 reviews in review/proof) assumes this.
- **The budget phase split depends on ADR A.** Without it, review calls spend the implementation allocation.
- Persisted review routes are unreadable by older code. A rollback must not resume a campaign that contains review routes. The refusal is loud, by exact keys.

---

## Q3. Confinement of model-originated shell

### Finding: the Build writer path spawns raw host shell today

- The campaign writer session is `createResolvedAgentSession({ cwd: worktreePath, tools: toolMode, taskEnv: stepEnv, mcpServers: await this.resolveMcpServers(undefined), ... })` (`executor.ts:19228-19253`).
- In `pi.ts:3698-3709` the only bash option is a `spawnHook` that merges `taskEnv` into Pi's env. `createBashTool(options.cwd, bashToolOptions)` (`pi.ts:3719`) therefore uses Pi's default `createLocalBashOperations` (`bash.d.ts:41`). That spawns the host shell detached, with the full host environment and no default timeout.
- What sits in front of it is heuristics only: `wrapToolsWithBoundary` path checks (`pi.ts:2738`) and `cccCampaignUnsafeBashProcessReason` and the phase policy (`pi.ts:2797-3106`).
- The writer also receives resolved MCP servers and host extensions (`pi.ts:3847`, which skips extensions only for readonly and merger).
- **Answer: yes, raw.**

### Decision

Every model-originated shell command runs through a Pi `BashOperations` implementation (`bash.d.ts:18-34`, the official seam) that launches:

```
superviseSpawn("/usr/bin/sandbox-exec", ["-p", profile, sealedNode, "-e", REAPER_SOURCE, "--", sealedBash, "-c", wrapped])
```

`wrapped` is `ulimit -H -t <cpu>; ulimit -H -f <blocks>; exec <sealedBash> -c <command>`, with the command passed as an argument, never interpolated.

**Profile `ccc-writer-shell.v1`.** It is built by a new builder that reuses the proof sandbox helpers: `darwinLinkedRuntimeFiles` (`packages/engine/src/ccc-campaign-proof-sandbox.ts:239`), the `pathAncestors` metadata pattern (`:187`, `:469-472`) and the literal/subpath escaping.

- `(version 1)`, import `dyld-support.sb`, `(deny default)`, `(allow process-fork)`.
- `(allow process-exec ...)` for **real-path literals only**:
  - `/bin/bash` and `/bin/sh` (SIP-protected platform binaries) and `/private/var/select/sh`'s target;
  - the Cellar node;
  - the Cellar git, plus `(subpath <git --exec-path>)`;
  - an explicit list of platform utilities: `cat ls head tail wc sed awk grep find diff mkdir cp mv rm touch sort uniq tr cut xargs env basename dirname`, all from `/bin` or `/usr/bin` and each digest-recorded.
  
  Never `/opt/homebrew/bin/*` shims, and never `/usr/bin/git` (an xcrun shim). **Operator note:** inside the sandbox, the kernel exec allowlist replaces the advisory SafeExec shims by design.
- `(allow file-read-metadata ...)` limited to the ancestors of admitted roots.
- `(allow file-read* ...)` for:
  - system runtime roots (`/System/Library`, `/usr/lib`, `/private/var/db/dyld`, `/usr/share/zoneinfo`, `/private/var/db/timezone`);
  - the linked dylib closure;
  - the toolchain;
  - the worktree;
  - the worktree's gitdir and common gitdir (read-only);
  - invocation scratch;
  - `/dev/null` and `/dev/urandom`.
- `(allow file-write* ...)` for the route's `allowedWriteRoots` (realpaths inside the worktree), invocation scratch (which holds `HOME` and `TMPDIR`), and `/dev/null`. Nothing else: no gitdir writes, because writers do not commit (`executor.ts:18812`).
- **Then** `(deny file-read* file-write* ...)` for denied names inside allowed roots (`.env`, `.env.*`, `.agentsecrets`, `_secrets`, `.npmrc`) and the verifier bundle directory. Per P9 these must be emitted after the allows.
- **No** `mach*`, `ipc-posix-shm*` or `system-socket`. P1 and P2 show node (including child IPC and worker threads), git read-only and bash work without them. The proof sandbox grants all three (`:494-496`). The writer profile is tighter, and a qualification probe proves it each time the toolchain digest changes.
- `(deny network*)`. A single loopback port is allowed only when the task contract declares an owned endpoint, using the proof sandbox's `localhost:<port>` form (`:497-503`).
- `(allow signal (target same-sandbox))`, needed for job control and the reaper (P6).
- `(allow sysctl-read)`.

**Sealed environment.** The env is exactly:

```
PATH=<sealed bin dirs>
HOME=<scratch>/home
TMPDIR=<scratch>/tmp
USER=LOGNAME=ccc
LANG=C
TERM=dumb
NO_COLOR=1
CI=1
GIT_OPTIONAL_LOCKS=0
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_GLOBAL=/dev/null
GIT_CEILING_DIRECTORIES=<worktree parent>
GIT_TERMINAL_PROMPT=0
npm_config_offline=true
```

plus `taskEnv` keys only from an allowlist declared in the task contract (non-secret names). The `env` argument Pi passes to `exec` is ignored, and nothing is inherited from `process.env`.

**Descendant closure (the reaper).**

- `sandbox-exec` execs node, which runs `REAPER_SOURCE`. The reaper is the supervised process group leader and spawns bash `detached` with pipes.
- When bash exits, or on timeout or abort, the controller writes `reap` to the reaper's stdin. The reaper then:
  1. stops relaying and destroys its read ends of bash's pipes, so escapers holding those pipes cannot block the controller-facing pipe;
  2. sends `SIGKILL` to bash's process group;
  3. sweeps pid 2..99999 with `kill(pid, 0)`. Under the profile, success means same sandbox instance or a zombie (P6, P7), and EPERM means unowned. It sends `SIGKILL` to every success and repeats until two consecutive passes find only pids already killed (at most 20 passes, about 220 ms each per P8);
  4. writes one framed closure record `{passes, killed:[...], persistent:[...]}` and exits.
- The controller then runs `ps -o pid=,stat= -p <persistent>` **outside** the sandbox. Every persistent pid must be a zombie (`Z`). A non-zombie persistent pid, a missing closure record, or a reaper killed early (same-sandbox processes can signal it) → `CCC_CONFINEMENT_CLOSURE_UNCONFIRMED`:
  - the node fails closed;
  - the worktree is quarantined (never admitted; any later attempt uses a fresh worktree);
  - an operator finding is raised.
  
  Leaked processes stay sandboxed, without network or writes outside the write roots, and capped by the inherited CPU rlimit.
- Released only after confirmation. `kill(-1, …)` is never used (P7). Controller-side `superviseSpawn` waits on the reaper's pipe (`packages/core/src/process-supervisor.ts:264-302`), and only the reaper holds that pipe, which removes the escaper-holds-stdout hang.

**Bounds.**

- Wall time is `min(model-requested timeout, ceiling)`, with ceiling 600 s per command, enforced by the controller (reap on expiry).
- CPU and file size use hard rlimits (`ulimit -H -t`, `-f`).
- Output is capped at 1 MiB at the reaper relay and again at the controller, with a truncation marker.
- `ulimit -u` cannot be used, because it is per-user and shared with the host. Fork pressure is bounded by `kern.maxprocperuid` (10,666 here) and the CPU rlimit. This is stated as a residual risk.

**File tools for writers.** `read`, `ls`, `find`, `write` and `edit` use Pi's `operations` seams with in-controller realpath containment:

- writes resolve the parent's realpath, refuse a symlink leaf (`lstat`), and open with `O_NOFOLLOW`;
- the target must be inside `writeRoots` and must not match a denied name;
- `grep` is the controller implementation (Q1).

These run in the controller process, not the sandbox. They are not shell, and they never spawn.

**Refusal, no fallback.** `createCccConfinedBashOperations` throws `CccConfinementRefusedError` in any of these cases:
- the host is not Darwin;
- `/usr/bin/sandbox-exec` is missing;
- a toolchain digest has drifted;
- write roots and denied roots overlap in the wrong direction;
- the qualification receipt for `(profileTemplateSha256, toolchainSha256, os build)` is missing.

With a request-to-code binding present, `pi.ts` has no code path to `createLocalBashOperations`. A bash tool without confined operations is a refusal, not a downgrade. RTK is forced off.

**Readiness is qualification, not presence.** The RED suite below, run against the exact profile template and toolchain, produces the qualification receipt (stored in ADR D's qualification certificate). Presence of `sandbox-exec` alone never admits.

### TypeScript (new)

```ts
// packages/engine/src/ccc-confinement/confined-shell.ts — new
export type CccSealedExecutable = Readonly<{ path: string; sha256: string }>;
export type CccSealedToolchain = Readonly<{
  bash: CccSealedExecutable;
  sh: CccSealedExecutable;
  node: CccSealedExecutable;
  git: CccSealedExecutable & Readonly<{ execPath: string }>;
  utilities: readonly CccSealedExecutable[];
  toolchainSha256: string;
}>;
export type CccConfinementLimits = Readonly<{
  wallMsCeiling: number;      // 600_000
  cpuSeconds: number;         // 600
  fileSizeBlocks: number;     // 512-byte blocks
  maxOutputBytes: number;     // 1_048_576
  maxReapPasses: number;      // 20
}>;
export type CccConfinedShellInput = Readonly<{
  profileId: "ccc-writer-shell.v1";
  worktreeRoot: string;
  gitDirs: readonly string[];
  writeRoots: readonly string[];
  deniedNames: readonly string[];
  deniedRoots: readonly string[];         // e.g. verifier bundle dir
  scratchRoot: string;                    // controller-owned, per invocation
  toolchain: CccSealedToolchain;
  taskEnv: Readonly<Record<string, string>>; // already allowlisted
  loopbackPort?: number;
  limits: CccConfinementLimits;
  qualification: Readonly<{ receiptSha256: string; profileTemplateSha256: string; osBuild: string }>;
}>;
export function buildCccWriterShellDarwinProfile(input: CccConfinedShellInput): Promise<Readonly<{ profile: string; profileSha256: string }>>;
export function createCccConfinedBashOperations(input: CccConfinedShellInput): BashOperations;
export type CccClosureRecord = Readonly<{ passes: number; killed: readonly number[]; persistent: readonly number[] }>;
export class CccConfinementRefusedError extends Error {
  readonly code: "CCC_CONFINEMENT_REFUSED";
  readonly reason: "platform-unsupported" | "sandbox-exec-missing" | "toolchain-digest-drift"
    | "root-overlap" | "qualification-missing" | "taskenv-not-allowlisted";
}
export class CccConfinementClosureError extends Error {
  readonly code: "CCC_CONFINEMENT_CLOSURE_UNCONFIRMED";
  readonly record: CccClosureRecord | null;
}

// packages/engine/src/agent-runtime.ts / pi.ts AgentOptions — new optional field
cccConfinement?: Readonly<{ bash: BashOperations; fs: CccConfinedFsOperations }>;
// pi.ts: when cccProviderAttemptBinding.toolPolicy includes "bash", cccConfinement is required (else refuse)
```

No SQL.

### Files that change

- new `packages/engine/src/ccc-confinement/confined-shell.ts`, including `REAPER_SOURCE` as a digest-pinned string constant. This avoids a build asset-copy step.
- `packages/engine/src/ccc-campaign-proof-sandbox.ts`: export the existing helpers only (`darwinLinkedRuntimeFiles`, the literal/subpath escaping, `pathAncestors`), with no behaviour change.
- `packages/engine/src/pi.ts` region (b), via card C2: wire `cccConfinement` into builtins.
- `packages/engine/src/executor.ts:19228-19253`: the writer session passes `cccConfinement`, the writer `toolPolicy`, and **no** `mcpServers`.
- `scripts/lib/ccc-planning-proof-inventory/confinement.mjs` (ADR D's area module): the test names below.
- tests: `packages/engine/src/__tests__/ccc-confined-shell.darwin.test.ts`, with exactly one `skipIf(process.platform !== "darwin")` per ADR D lines 70-73.

### RED tests (Darwin, real `sandbox-exec`, run through `createCccConfinedBashOperations`)

| Test | Assertion | Non-vacuous because |
|---|---|---|
| Q3-T1 private read | `cat <canary>` (a file under a test-owned dir outside the roots) fails, and stdout lacks the canary token. | Positive control: the same command run unsandboxed prints the token. |
| Q3-T2 symlink escape | A worktree symlink to the canary: `cat link` fails. | Same control; P4 shows the kernel resolves the link. |
| Q3-T3 denied name inside the root | `cat .env` in the worktree fails, while `cat README` in the same dir succeeds. | The paired success proves the root is readable, so the deny (emitted after the allows) is what refuses. |
| Q3-T4 write roots | Writing `src/x` (a write root) succeeds; writing `docs/x` (in the worktree but not a write root), the gitdir and `$TMPDIR/../x` fail. | The success case proves writes work at all. |
| Q3-T5 network | Connecting to a test-owned listener on 127.0.0.1:<port> fails, connecting to 192.0.2.1:9 fails, and the listener sees zero connections. | Control: an unsandboxed connect to the same listener is accepted. |
| Q3-T6 env sealed | The parent seeds `SECRET_CANARY`, `OMNIROUTE_API_KEY`, `GH_TOKEN` and `PORT=4040`; `env` output inside contains none of them, and `HOME` equals scratch home. | The canaries are present in the parent's env and in Pi's `getShellEnv()` (asserted). |
| Q3-T7 exec allowlist | `/opt/homebrew/bin/git status` fails, while the sealed git `status` succeeds; a copied binary in scratch fails to exec. | The paired success proves git itself is usable. |
| Q3-T8 unowned signal | `kill -0 <pid>` and `kill -CONT <pid>` against a test-spawned unsandboxed `sleep` fail, and the sleeper stays alive. | Control: the same kill run unsandboxed succeeds. |
| Q3-T9 setsid escaper closure | The command starts `node -e 'spawn("/bin/sleep",["300"],{detached:true}).unref()'` and prints the pid. After return, `kill(pid,0)` from the test (outside) gives ESRCH, and the closure record lists the pid as killed. | Control: with the reaper disabled (test-only switch), the pid is alive after return. P6 shows escapers survive group kill. |
| Q3-T10 reaper killed | The command kills its reaper's pid. The result is `CCC_CONFINEMENT_CLOSURE_UNCONFIRMED`, and the worktree is marked quarantined. | It proves the fail-closed path exists; a happy-path-only implementation returns success. |
| Q3-T11 bounds | `yes` output stops at 1 MiB with the truncation marker; `sleep 900` with a 2 s ceiling returns within 4 s and is reaped; a CPU loop under a `cpuSeconds: 1` rlimit dies with SIGXCPU. | Each limit is set below the command's natural behaviour. |
| Q3-T12 no fallback | Platform mocked as `linux`, or `sandbox-exec` missing: the session refuses, and `child_process.spawn` is never called (spy). | Control: the default Pi bash under the same mock spawns. |
| Q3-T13 profile tightening | `node -e` with a worker thread, child IPC and `git status` all succeed under the profile **without** mach, shm or system-socket. | It proves the tighter profile is usable, so a test suite cannot pass by refusing everything. |

### Rejected alternatives

- **The generic `packages/engine/src/sandbox/sandbox-exec-backend.ts` and its templates.** They use unrestricted `(allow process-exec)`, allow launchservicesd mach, broad reads of `/Library` and `/private/var/folders`, fall back to native, and `runStreaming` runs unsandboxed.
- **`run-verification-tool.ts` strict profile.** It uses `(allow process*)` and allows writes to cwd, HOME and TMP. It is fine for its job, but too broad for model shell.
- **A `spawnHook` command-prefix wrapper.** Pi still owns the spawn and env, and a hook can be skipped by a caller.
- **Nested sandbox for the reaper.** macOS refuses nested `sandbox_apply` (also noted by ADR D).
- **Controller-side ps/lsof process-tree closure.** argv[0] is forgeable (`exec -a`), reparented escapers lose ancestry, and it has no kernel ownership proof.
- **`kill(-1)`.** It is not sandbox-scoped (P7).
- **A per-run Unix user.** It needs root and admin setup on the operator machine.
- **Container or VM.** The PRD forbids installing a replacement automatically (PRD line 239).
- **Copying platform binaries into scratch.** It breaks code signatures and SIP guarantees. Real paths plus digests are used instead.

### Risks

- `sandbox-exec` is deprecated on macOS. This is maintenance risk, not a reproduced escape (PRD line 239).
- The kernel profile replaces the SafeExec shims inside the sandbox. The operator should know that `rm` there is `/bin/rm` (limited by write roots), not the guarded wrapper.
- No package installs with network. I2 targets must be dependency-free, or dependencies must be installed by the controller before writers run.
- Fork pressure has a per-user limit only.
- `file-read-metadata` on ancestors reveals the existence of ancestor directories. This is accepted.
- Pi's `OutputAccumulator` writes truncated model output to a host temp file (prefix `pi-bash`). It is data, not execution, but it lives outside scratch.
- The tests are Darwin-only. Linux shards report NOT RUN (ADR D).
- The git common dir is readable. G0 must refuse remotes with embedded credentials (ADR D receipt).

---

## Q4. Researcher public web

### Finding

- The existing `fetchWebContent` (`packages/engine/src/web-fetch.ts:89-178`):
  - checks private hosts once before `fetch` (`:69-84`), so DNS rebinding passes;
  - follows redirects without re-checking hops (`redirect: "follow"`, `:105`);
  - reads the whole body before truncating (`response.text()`, `:118`);
  - counts characters after extraction, not raw bytes (`:137`);
  - has no allowlist, digest or retrieval time;
  - misses 198.18/15, 224/4, 240/4, the TEST-NETs, IPv6 `::`, `ff00::/8`, `64:ff9b::/96`, `2002::/16`, and hex-form IPv4-mapped IPv6 (`:204-248`).
- `fn_web_fetch` (`packages/engine/src/agent-tools.ts:3422`) exposes it to models.
- The `builtin` search backend spawns a nested `createFnAgent` with `WebSearch` and `WebFetch` on the default model (`packages/engine/src/research/providers/web-search-provider.ts:36-55, 99-102`). That is an unbound, unaccounted second model call.

### Decision

1. **`ccc_research_fetch` is a controller tool.** It is a `ToolDefinition` whose `execute` runs in the controller process, outside any command sandbox (PRD line 235). It is offered only to `researcher`-class sessions (Q1). It:
   - accepts only `https:` URLs whose host is **exactly** an allowlisted host and whose path starts with an allowlisted prefix from the G0 source policy (no wildcards in I2);
   - resolves with `dns.lookup({all:true})` and refuses if **any** answer is blocked. The extended blocklist uses `net.BlockList` with explicit IPv4-mapped normalization. It then pins the first allowed address via the `lookup` option of `https.request`, with `servername` set for SNI. There is no undici dependency, since Node ≥22.5 is already required;
   - follows redirects manually, at most 3, with every hop re-checked against the allowlist and re-resolved;
   - sends fixed headers only (`User-Agent`, `Accept`, `Accept-Encoding: identity`), with `agent: false`, no cookies, no `Authorization`, no proxy env, and default CA verification;
   - checks content type **before** reading the body: only `text/html`, `text/plain`, `text/markdown`, `application/json`;
   - enforces a streaming raw-byte cap (destroy on overflow, `truncated: true`) and a timeout;
   - stores raw bytes as a task artifact (ADR B) keyed by `rawSha256`, and returns bounded extracted text (≤ 64 KiB) plus a `citationId`.
2. **Accounting.** Each call reserves against the run's research grant before any network I/O, through ADR A's ledger, counted at reservation like a provider dispatch. It settles with raw bytes and outcome. Run-audit rows hold ids, counts and outcomes only (PRD line 60).
3. **`ccc_citation_read(citationId)`** serves stored bytes to the source verifier. Verification reads the same bytes the researcher saw, and no refetch is needed.
4. **Search.** In I2 the researcher has fetch-only access to the allowlist (for example the npm registry JSON and a few documentation hosts named in the G0 policy). A search tool is deferred to I3:
   - a `ccc_research_search` using a loopback SearXNG or a Brave/Tavily backend whose key the controller holds and the model never sees;
   - each result URL still passes the fetch allowlist.

   The `builtin` backend is rejected outright.

### TypeScript (new)

```ts
// packages/engine/src/ccc-research/research-fetch.ts — new
export type CccResearchSourcePolicy = Readonly<{
  policyId: string;
  policySha256: string;
  allow: readonly Readonly<{ host: string; pathPrefix: string }>[];   // https only
  maxFetchesPerNode: number;
  maxRawBytesPerFetch: number;
  maxRawBytesPerRun: number;
  timeoutMs: number;
  maxRedirects: 0 | 1 | 2 | 3;
  mimeTypes: readonly ("text/html" | "text/plain" | "text/markdown" | "application/json")[];
}>;
export type CccResearchCitation = Readonly<{
  citationId: string;               // sha256(canonical({requestedUrl, finalUrl, rawSha256, retrievedAt})).slice(0, 32)
  requestedUrl: string;
  finalUrl: string;
  redirectChain: readonly string[];
  resolvedAddress: string;
  status: number;
  contentType: string;
  rawBytes: number;
  rawSha256: string;
  truncated: boolean;
  retrievedAt: string;              // controller clock, ISO
  policySha256: string;
}>;
export interface CccResearchGrantPort {          // implemented by ADR A
  reserve(input: Readonly<{ runId: string; nodeId: string; nodeAttempt: number; maxRawBytes: number }>): Promise<Readonly<{ grantKey: string }>>;
  settle(input: Readonly<{ grantKey: string; rawBytes: number; outcome: "fetched" | "refused" | "failed" }>): Promise<void>;
}
export class CccResearchFetchRefusedError extends Error {
  readonly code: "CCC_RESEARCH_FETCH_REFUSED";
  readonly reason: "scheme" | "host-not-allowlisted" | "path-not-allowlisted" | "blocked-address"
    | "redirect-not-allowlisted" | "too-many-redirects" | "mime" | "grant-exhausted" | "timeout";
}
export async function fetchCccResearchSource(
  url: string,
  policy: CccResearchSourcePolicy,
  deps: Readonly<{ lookup: typeof import("node:dns").promises.lookup; now: () => Date; signal: AbortSignal }>,
): Promise<Readonly<{ citation: CccResearchCitation; raw: Uint8Array; text: string }>>;
export function createCccResearchFetchTool(input: Readonly<{
  policy: CccResearchSourcePolicy;
  grant: CccResearchGrantPort;
  storeCitation: (citation: CccResearchCitation, raw: Uint8Array) => Promise<void>;
  runId: string; nodeId: string; nodeAttempt: number;
}>): ToolDefinition;
export function createCccCitationReadTool(input: Readonly<{ load: (citationId: string) => Promise<Readonly<{ citation: CccResearchCitation; raw: Uint8Array }>> }>): ToolDefinition;
```

No SQL. Citations are artifacts (ADR B), and grants are ADR A's ledger.

### Files that change

- new `packages/engine/src/ccc-research/research-fetch.ts`
- new `packages/engine/src/ccc-research/address-blocklist.ts` (a `net.BlockList` builder; `web-fetch.ts` may adopt it later, but is not changed now)
- tests: `packages/engine/src/__tests__/ccc-research-fetch.test.ts`

### RED tests

| Test | Assertion | Non-vacuous because |
|---|---|---|
| Q4-T1 DNS rebinding | An injected `lookup` returns a public address on first call and `127.0.0.1` on second. The connection goes to the pinned first address only, and a test-owned loopback listener sees 0 connections. | Control: the existing `fetchWebContent` with the same lookup reaches the listener. |
| Q4-T2 redirect hop | An allowlisted local TLS test server (self-signed CA injected for the test) answers 302 to a non-allowlisted host → `redirect-not-allowlisted`, and the second server sees 0 requests. | Control: a 302 to an allowlisted path is followed. |
| Q4-T3 blocklist | `198.18.0.1`, `224.0.0.1`, `240.0.0.1`, `::`, `ff02::1`, `64:ff9b::7f00:1` and `::ffff:7f00:1` are each refused. | Each address is accepted by the current `isIpBlocked` (asserted in the same test). |
| Q4-T4 byte cap streams | The server sends 10 MiB with cap 64 KiB. Bytes received by the client are ≤ cap + one chunk, and `truncated` is true. | The server counts bytes written before the socket closes; a read-all implementation drains 10 MiB. |
| Q4-T5 no credentials | With `HTTPS_PROXY`, a cookie jar file and `Authorization` in `process.env`, the server observes exactly the fixed header set. | The env values are present, and a naive fetch with env-proxy enabled would route through the proxy (asserted). |
| Q4-T6 grant before I/O | With an exhausted grant, the server sees 0 requests. | Control: with an open grant, it sees 1. |
| Q4-T7 citation digest | `rawSha256` equals the sha256 of the server's exact bytes, and `ccc_citation_read` returns identical bytes. | The server body contains bytes that HTML extraction alters, so hashing the extracted text fails. |

### Rejected alternatives

- **Reuse `fn_web_fetch` / `fetchWebContent`.** It has the rebinding, redirect, whole-body and accounting gaps above.
- **The builtin search backend.** It is a nested, unbound, unaccounted model call on the default model.
- **Model-side network in the sandbox.** It breaks "default-denied network" and credential isolation.
- **An MCP fetch server.** The PRD forbids broad MCP control for models, and it gives no binding to the grant.
- **Wildcard host allowlists in I2.** Subdomain takeover and open redirectors widen the surface.

### Risks

- An allowlisted host that itself redirects to a CDN on another host needs that CDN host listed explicitly.
- The TLS pin is by address, not certificate. A compromised allowlisted origin can still serve false content. The source verifier and the falsification plans (G2) are the guard.
- I2 researcher capability is narrow without search.

---

## Q5. Model quirks

### 5.1 M3 degenerate output guard

**Decision.** Add a pure detector plus a streaming observer in the controlled stream, for every request-to-code binding.

- **Within a stream.** The observer watches text and thinking deltas. It aborts the request when either is crossed:
  - the placeholder `(prior reasoning summary unavailable)`, or its degraded tail `unavailable)`, appears ≥ 3 times;
  - in any 4 KiB window, zero-width characters (U+200B-U+200F, U+2060, U+FEFF) exceed 50%, or the deflate ratio is below 0.05 (heavy repetition).

  This is the KB-014 pattern: 42,758 placeholders, 33,838 degraded tails, U+200E padding.
- **Per message, after settlement.** It checks for:
  - an empty visible output (after trimming whitespace and zero-width characters) with no tool call;
  - tool-shaped text (for example `<tool_call>` or `{"name":` with an `arguments` object) with no structured call.
- **Across turns, in the session driver.** It counts K = 2 consecutive assistant messages without any tool call for roles that must end with a tool (`ccc_submit_artifact`, `ccc_submit_verdict`, or writer edits). This covers the 1,362-row text-only streak.
- **On trigger.** The attempt settles `proved_failed` once, with the detector record in the evidence digest (the Q1 mechanism; an abort initiated by the controller is a terminal observation). The node fails with `CCC_MODEL_DEGENERATE_OUTPUT`.
- **Classification.** This is a provider/model fault, not behavioural RED. It still counts against the dispatch cap and budget, and routes through the PRD failure ladder (shrink the task, then a recorded GLM 5.3 attempt). The 10-iteration cap (ADR A) remains the primary bound.
- Prose "sufficiency" signals are not used, because they are worthless per the KB-014 analysis.

```ts
// packages/engine/src/ccc-confinement/degenerate-output.ts — new
export type CccDegenerateOutputLimits = Readonly<{
  placeholderMax: number;          // 3
  zeroWidthRatioMax: number;       // 0.5 per 4 KiB window
  deflateRatioMin: number;         // 0.05 per 16 KiB window
  textOnlyStreakMax: number;       // 2
}>;
export type CccDegenerateOutputReason =
  | "placeholder-runaway" | "zero-width-padding" | "repetition"
  | "empty-visible-output" | "tool-shaped-text" | "text-only-streak";
export type CccDegenerateOutputVerdict =
  | Readonly<{ degenerate: false }>
  | Readonly<{ degenerate: true; reason: CccDegenerateOutputReason; metrics: Readonly<{
      visibleChars: number; reasoningChars: number; placeholderCount: number;
      zeroWidthRatio: number; deflateRatio: number; textOnlyStreak: number }> }>;
export class CccDegenerateOutputObserver {
  constructor(limits: CccDegenerateOutputLimits);
  observeDelta(kind: "text" | "thinking", chunk: string): CccDegenerateOutputVerdict;
}
export function detectCccDegenerateMessage(input: Readonly<{
  message: Readonly<{ text: string; reasoning: string; toolCallCount: number }>;
  priorTextOnlyStreak: number;
  requiresToolCall: boolean;
  limits: CccDegenerateOutputLimits;
}>): CccDegenerateOutputVerdict;
export class CccDegenerateOutputError extends Error { readonly code: "CCC_MODEL_DEGENERATE_OUTPUT"; readonly reason: CccDegenerateOutputReason; }
```

### 5.2 Flash tool-fidelity preflight

**Decision.** This runs once per run at G0, after authority is consumed and **before any planning node**. It is charged to the planning allocation as 3 calls. This closes ADR D's risk (D line 642) that a Flash tool failure would surface only at the writers, after planning has been spent. Each probe uses the exact production construction: the Flash binding, the writer `toolPolicy` and toolset digest, confined operations, and the pinned provider. The probes are:

1. **Identity.** A one-line prompt. The terminal route receipt must be `glm/glm-5.3-flash` (Q1 rules).
2. **Strict-schema echo.** A custom tool `ccc_probe_echo({nonce: string, items: {k: string, v: integer}[]})`, with a 32-hex nonce and a 3-item list in the prompt. It requires exactly one structured call, arguments deep-equal to the expected value, no extra keys, and no tool-shaped text.
3. **Exact edit.** A disposable fixture file in scratch. The prompt asks to replace the line containing nonce A with nonce B using the real `edit` tool. It requires the file's sha256 to equal the expected sha256, and exactly one `edit` call.

Any failure → `BLOCKED_PROVIDER`, plus a qualification receipt `{probeIds, providerId, modelId, toolsetDigest, settingsEntrySha256, piVersion, attemptKeys, results}`. A pass is reusable for later runs only while `(route, toolsetDigest, settingsEntrySha256, piVersion)` is unchanged. The same three probes run against M3 for the critic and researcher toolsets.

```ts
// packages/engine/src/ccc-planning/tool-fidelity-preflight.ts — new
export type CccToolFidelityProbeId = "identity" | "strict-echo" | "exact-edit";
export type CccToolFidelityReceipt = Readonly<{
  schema: "ccc-tool-fidelity.v1";
  providerId: string; modelId: string; toolsetDigest: string;
  settingsEntrySha256: string; piVersion: "0.81.1";
  results: readonly Readonly<{ probeId: CccToolFidelityProbeId; passed: boolean; attemptKey: string; failure?: string }>[];
}>;
export async function runCccToolFidelityPreflight(input: Readonly<{
  bindingFor: (probeId: CccToolFidelityProbeId) => CccProviderAttemptBinding;
  scratchRoot: string;
  createSession: typeof createFnAgent;
}>): Promise<CccToolFidelityReceipt>;   // throws CCC_BLOCKED_PROVIDER with the receipt on any failure
```

### 5.3 Exact-pin registration in the isolated HOME

**Decision.** ADR D's isolated `HOME/.fusion/settings.json` contains three custom providers, one model each, following the existing `omniroute-minimax-m3-pinned` precedent. Each provider:
- has `apiType: "openai-compatible"`;
- has a `baseUrl` on the loopback OmniRoute (port verified live at G0 and checked with `validateCccLoopbackHttpUrl`);
- has `headers: {"X-OmniRoute-No-Cache": "true"}`;
- has **no** `apiKey` (the loopback keyless sentinel applies);
- has **no** `modelProvenance`;
- declares `models: [{id, name, reasoning: true, maxTokens, contextWindow}]`, with real limits declared so the 16384/128000 defaults (`packages/engine/src/custom-provider-registry.ts:110-119`) do not truncate.

The file also sets `openrouterModelSync: false` and `opencodeGoModelSync: false`.

G0 records `settingsEntrySha256` = sha256 of the canonical JSON of each pinned provider entry. Every request-to-code session creation already re-reads the file (`readCustomProviders()` at `pi.ts:3543`, implemented in `packages/engine/src/custom-providers.ts:6-17`). The new check, beside `assertCccCustomProviderEgress` (`pi.ts:3544`), refuses with `CCC_PROVIDER_PIN_DRIFT` unless the bound `providerId`'s entry has exactly one model, equal to the bound `modelId`, and the same digest.

### 5.4 The serve-startup refresh trap

**Finding.** `fn serve` runs `refreshAllCustomProviderModels` in the background after listen (`packages/cli/src/commands/serve.ts:1118`). For each provider it:
- probes `/v1/models`;
- merges via `mergeConfiguredProviderModels` (`packages/dashboard/src/routes/register-custom-provider-routes.ts:550-569`), which keeps authored entries **unless their id is in `modelProvenance.discoveredModelIds`**, and replaces any such entry by a bare `{id, name}` that drops `reasoning`, `maxTokens` and `contextWindow`;
- appends the **entire** catalog (including `glm/glm-5.2` and combos);
- writes `modelProvenance` (`:620-627`).

There is no per-provider opt-out. The loop reports `skipped: 0` unconditionally (`:638-663`). Every I2 serve start would therefore turn a one-model pin into a catalog. The pin check (5.3) would then refuse every session, or without that check the pin would silently widen.

**Decision.**
- Add an optional `modelSync?: "disabled"` field to `CustomProvider` (`packages/core/src/types/workflow-steps.ts:176-250`).
- `refreshAllCustomProviderModels` skips such providers and counts them in `skipped`.
- The manual single-provider refresh returns 409 for them.
- `parseUpdateBody` and the create parser carry the field. Otherwise the dashboard field allowlist would silently drop it, which is the same failure class as `headers` before it was typed.
- G0 requires `modelSync: "disabled"` on all three pinned providers.

```ts
// packages/core/src/types/workflow-steps.ts — CustomProvider gains:
modelSync?: "disabled";
// packages/engine/src/ccc-planning/provider-pins.ts — new
export function cccProviderPinEntrySha256(provider: CustomProvider): string;
export function assertCccProviderPinned(input: Readonly<{
  providers: readonly CustomProvider[]; providerId: string; modelId: string; settingsEntrySha256: string;
}>): void; // throws CCC_PROVIDER_PIN_DRIFT: missing | not-loopback | api-key-present | model-count | model-id | provenance-present | sync-enabled | digest
```

No SQL. The qualification receipt is stored in ADR D's certificate.

### Files that change (Q5)

- new `packages/engine/src/ccc-confinement/degenerate-output.ts` (C6)
- `packages/engine/src/pi.ts` region (a): observer hook in the controlled stream (C1 owns the region; C6 supplies the observer)
- new `packages/engine/src/ccc-planning/tool-fidelity-preflight.ts` (C6)
- new `packages/engine/src/ccc-planning/provider-pins.ts` (C6), with its call site in `pi.ts:3544` (C1)
- `packages/core/src/types/workflow-steps.ts` (one field)
- `packages/dashboard/src/routes/register-custom-provider-routes.ts` (skip in refresh-all, 409 in single refresh, parser field) (C6b)

### RED tests

| Test | Assertion | Non-vacuous because |
|---|---|---|
| Q5-T1 placeholder runaway | Replaying a recorded KB-014 M3 stream excerpt aborts within the first 3 placeholders, and the provider stream's iterator is closed early (events consumed < total). | Negative control: a recorded normal M3 transcript (with long reasoning) runs to completion. A detector that always fires fails it. |
| Q5-T2 zero-width padding | A stream of U+200E-padded text triggers `zero-width-padding`. | Control: the same text without padding passes. |
| Q5-T3 text-only streak | Two consecutive messages without tools in a critic session → `text-only-streak`. | Control: a message that calls `ccc_submit_verdict` after one text message passes. |
| Q5-T4 tool-shaped text | Flash fake returns `<tool_call>{"name":"ccc_probe_echo",...}</tool_call>` as text → strict-echo probe fails, giving `BLOCKED_PROVIDER`, and zero planning nodes dispatch. | Control: a fake that emits a structured call passes all three probes. |
| Q5-T5 exact-edit fidelity | A fake calling `edit` with whitespace-altered `oldText` → probe 3 fails on the file digest. | Control: an exact `oldText` passes. |
| Q5-T6 refresh skip | Isolated settings with a `modelSync: "disabled"` pin and a fake `/v1/models` listing 40 models: after `refreshAllCustomProviderModels`, the provider entry is byte-equal, `skipped === 1`, and the fake saw 0 requests. | Control: the same provider without the field gains 40 models (this proves the trap). |
| Q5-T7 provenance wipe | A pinned entry whose id is listed in `modelProvenance.discoveredModelIds` is refused by `assertCccProviderPinned` (`provenance-present`). | Control: replaying refresh on it shows `maxTokens` and `reasoning` dropped, which is the trap reproduced. |
| Q5-T8 pin drift at session | Edit the settings file between G0 and session creation, adding a model → `CCC_PROVIDER_PIN_DRIFT`, and 0 provider calls. | Control: the unedited file creates the session. |

### Rejected alternatives

- **Rely on `openrouterModelSync` / `opencodeGoModelSync`.** They gate other sync paths, not the custom-provider refresh.
- **Avoid `fn serve` in I2.** The engine runs in-process in serve. The CLI-driven Build needs it.
- **Make the refresh preserve authored fields globally.** It changes behaviour for every user's providers. The opt-out is narrower.
- **Detect M3 trouble with prose heuristics.** These are proven worthless on KB-014.
- **Skip the Flash preflight and let writers fail.** That spends the whole planning allocation first (ADR D line 642).

### Risks

- Detector thresholds are calibrated on one bad run (KB-014) and a few good transcripts, so both false positives and misses are possible. The thresholds are policy-versioned, and each change requires re-running Q5-T1 and its negative control.
- An abort initiated by the controller does not stop provider-side billing at once. Cost for that attempt is unknown (`cost.kind: "unknown"`).
- The preflight proves tool fidelity on 3 probes, not on real tasks.
- The `modelSync` field is a dashboard and core change outside the request-to-code area.

---

## Card ownership (disjoint files)

| Card | Owns | Depends on |
|---|---|---|
| C1 binding and settlement | `pi.ts` region (a) (`744-1149`, plus the pin-check call at `3544`), `agent-runtime.ts`, `core/ccc-campaign/types.ts` (planning scope), `core/ccc-campaign/provider-controller.ts`, new `engine/ccc-planning/provider-binding.ts`, `pi.test.ts:1872-1909` | ADR A port shape |
| C2 tool policy and confined file tools | `pi.ts` region (b) (`3698-3730`, `3847`, `4043-4160`), new `engine/ccc-confinement/session-tool-policy.ts`, `confined-fs-tools.ts`, `verdict-tool.ts` | C1 types |
| C3 confined shell | new `engine/ccc-confinement/confined-shell.ts`, helper exports in `ccc-campaign-proof-sandbox.ts`, `executor.ts:19228-19253` writer call site, `scripts/lib/ccc-planning-proof-inventory/confinement.mjs` | C2 option field |
| C4 G7 review and route admission | `core/ccc-campaign/canonical.ts`, `core/ccc-campaign/types.ts` (review route; coordinate with C1), new `core/ccc-campaign/route-admission.ts`, `core/ccc-prd/importer.ts`, `executor.ts` review predicate and node (beside `2043` and `9756`) | C2 critic policy, ADR A phase split, ADR B G6 call site |
| C5 research fetch | new `engine/ccc-research/research-fetch.ts`, `address-blocklist.ts` | ADR A grant port, ADR B artifact store |
| C6 model quirks | new `degenerate-output.ts`, `tool-fidelity-preflight.ts`, `provider-pins.ts` | C1 observer hook |
| C6b refresh opt-out | `core/types/workflow-steps.ts` (`modelSync`), `dashboard/.../register-custom-provider-routes.ts` | none |

`types.ts` is touched by C1 and C4 in separate appended blocks. Land C1 first. `executor.ts` is touched by C3 (writer call site) and C4 (new review functions) in disjoint regions.

## Order for I2

C1, then C2 and C6b in parallel, then C3 and C6 in parallel, then C4. C5 runs in parallel throughout. Everything except C4's budget phase split is independent of I3 to I6. Nothing here adds a scheduler, table or second authority.
