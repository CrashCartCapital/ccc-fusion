# CCC-Fusion Golden Campaign and Product-Readiness Execution Handoff

You are a fresh Codex instance taking ownership of the next evidence-driven CCC-Fusion work cycle. Work autonomously through safe, local, reversible steps. Use the repository, its instructions, available skills, code-intelligence MCPs, direct AGY Bridge consultation, bounded Luna subagents, and `oc-fanout` where each adds real value. Do not use tools ceremonially. Every important claim must be tied to current evidence.

Your job is not to produce another broad architecture review. Your job is to determine why the current system is alive but not completing useful work, repair the smallest necessary repo-local defects in an isolated clean worktree, and prove one boring, real, end-to-end “golden campaign.” Then leave a precise, evidence-backed account of what is ready, what remains incomplete, and the shortest path to a genuinely usable product.

## Plain-language mission

CCC-Fusion already has a substantial safety and orchestration foundation: PRD intake, task compilation, Postgres state, leases, proofs, isolated worktrees, approvals, recovery logic, route policy, and extensive tests. It is not yet a ready-to-use product. The current live engine is healthy but its tasks are repeatedly reclaimed without producing edits, commits, proofs, or completed work. The central question is therefore not “Can we add more platform machinery?” It is:

> Can CCC-Fusion give one small, well-defined coding task to the requested model, have that model make the intended edit, preserve exactly one attributable commit, admit the required proof, and expose an honest terminal result to the operator?

Make that true once, cleanly and repeatably. Do not widen the scope until it is true.

That single-task proof is **Gate 1: worker-loop proof**. It is necessary, but it is not the definition of a ready product. **Gate 2: whole-product acceptance** must separately prove the full clean-candidate lifecycle, including pause/resume/stop, restart and uncertain-effect recovery, execution and merge holds, chained worktree custody, integrated proofs, controlled landing, terminal recovery, and operator-readable status. Never report Gate 1 as product readiness.

## Recovered evidence packet

This handoff was reconstructed and adversarially checked after a context compaction. If a detail appears ambiguous, use these local sources before inventing an answer:

- Visible-session transcript: `/Users/ryanpappal/.codex/sessions/2026/08/29/rollout-2026-08-29T20-22-15-01a050b0-7166-7b30-bda6-2a1a60ec98f5.jsonl`
- Original user-facing synthesis and all direct tool calls: contained in that transcript.
- Three completed Luna reports: Git/custody, product/models/readiness, and tests/quality/risk, also contained in the transcript.
- Two earlier AGY consultations: a readiness delegate report and a factual adversarial review, contained in the transcript.
- This handoff received a second post-compaction AGY review on 2026-08-29; its recommendations were verified against source rather than accepted blindly.

The transcript is historical evidence, not live truth. Re-probe Git refs, GitHub runs, worktrees, processes, routes, and task state before acting.

## Starting truth from the 2026-08-29 audit

Treat the following as a handoff snapshot, not eternal truth. Re-probe every drift-prone fact before relying on it. Label your conclusions `OBSERVED`, `INFERRED`, or `UNKNOWN`.

### Git and custody

- Repository: `/Users/ryanpappal/03_CODE/ccc-fusion`
- Primary checkout branch at audit: `main`
- Primary checkout `HEAD`: `3c30fafaf0736327975dad90f56a9b24af98e977`
- `origin/main`: `9b371ec28e186cd637c67799164feceaac456a03`
- Audit comparison: `origin/main...HEAD = 0 behind, 4 ahead`
- The four local commits were:
  - `d66591707` — July 24 installed instruction roots
  - `a2b655b69` — August 24 installed instruction roots
  - `b7c5979be` — merge of `origin/main`
  - `3c30fafaf` — current installed instruction roots
- The primary checkout had no tracked modifications, but had 23 top-level untracked entries.
- There were 69 registered worktrees; 19 were dirty.
- There were 86 local branches; 44 had no configured upstream, so their remote status was unknown rather than proven unpublished.
- `chore/canonical-task-gate` was 3 commits ahead of its configured upstream. `agent/verifier-task-bwrap` was 1 ahead and 78 behind `origin/main`.
- Local branches `codex/model-admission-platform` at `de5f7d574...` and `codex/oss-base-admission` at `c903fd4b9...` were adjacent to, but not hash-identical with, the open PR branches `codex/pr-model-admission-platform` at `10e5e4764...` and `codex/pr-oss-base-admission` at `4c76f8bc9...`. Do not confuse the local research branches with the GitHub PR heads.
- `origin` was `CrashCartCapital/ccc-fusion` for fetch and push.
- `upstream` was `Runfusion/Fusion`, with push explicitly disabled.
- The audit found `upstream/main...origin/main = 1928 304`. This is heavy divergence, not a simple “we are behind upstream” situation.

Preserve custody. Never reset, clean, stash, delete, detach, or rewrite shared worktrees just to obtain a clean status. The existing untracked and dirty material belongs to ongoing work unless proven otherwise.

The audit saw significant dirty source work in `pr18-a612-reproduction`, `scaleup-w0-w3t2-w1`, `wave-5-integration`, an `oc-fanout` `cf18r5-r` worktree, and `task2-plan-repair`. The merged `r1-qe-runner` worktree also retained `.opencode/` and `.scratch/` residue. Refresh these facts, but treat every listed tree as occupied until its owner/custody is proven otherwise.

The following paths have special boundaries:

- Never access the revoked path `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/wave-3`.
- Treat `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/wave-3-retry` as read-only unless the operator grants exact write authority.

### GitHub and recent work

Recheck GitHub with `gh`, but the audit saw:

- Draft PR `#49`, branch `codex/pr-oss-base-admission`: roughly 2,252 additions across 9 files; blocked, with no checks reported.
- Draft PR `#50`, branch `codex/pr-model-admission-platform`: roughly 3,287 additions across 10 files; blocked, with no checks reported.
- Merged PR `#51`, branch `agent/r1-qe-runner`: merged to `origin/main` at `9b371ec28`; roughly 18,468 additions across 160 files.
- The required PR checks on `#51` passed before merge, while a broader post-merge full-suite workflow later failed.

Recent implementation themes included request floors and campaign clocks, structured repair feedback, route-receipt adapters, fast-mode refusal, typed proof-admission mismatch handling, worktree and proof-host custody hardening, and phase-machine behavior. Do not assume those features are fully integrated merely because the code or commits exist.

### Live runtime

At the audit, a source-worktree server—not a normal globally installed product—was running:

```text
node .../ccc-fusion-worktrees/r1-qe-runner/packages/cli/dist/bin.js serve \
  --project r1-evidence-envelope \
  --no-auto-register \
  --host 127.0.0.1 \
  --port 4040
```

It had been up for about five days. `GET http://127.0.0.1:4040/api/health` reported:

- status `ok`
- version `0.73.0-beta.4`
- engine available
- database healthy
- task-integrity healthy

The global `fn` command was not found at audit time. A live development server is not proof that an ordinary user can install and operate the product.

The live project `r1-evidence-envelope` contained 17 tasks, `KB-001` through `KB-017`. All were still `Todo`; none were completed or failed. They were configured for:

```text
omniroute-minimax-m3-pinned / minimax/MiniMax-M3
```

The live API showed recurring messages approximately every five minutes resembling:

```text
[recovery] reclaim-self-owned ... (0 commits preserved, tip d1314bbb2770)
```

This is the most important live symptom. The engine appears alive, but it is not producing useful progress.

The roughly five-minute cadence matches the configured periodic-maintenance interval, and the log string comes from self-healing branch-conflict reclamation. It does **not** by itself prove that a 300-second lease reaper is the root cause. Trace the exact live task state, acquisition, worker exit, maintenance sweep, and state transition before naming the mechanism. The observed fact is repeated zero-commit reclamation; the causal chain remains `UNKNOWN` until traced.

A separate historical harness report recorded `AUTHORITY_ROOT_ESCAPE` whenever shell commands used `>/dev/null` or `2>/dev/null`: the authority layer treated `/dev/null` as a write outside the allowed root. See `orchestration/evidence/w3t2-harness-hygiene-report.md`. This was proven in that earlier lane, not re-proven in the 2026-08-29 live campaign. Test whether the current Pi worker tool path still has this behavior. Until falsified, avoid `/dev/null` redirects in diagnostic probes and use an explicitly owned in-worktree temporary file when redirection is necessary.

Do not kill, restart, reconfigure, or mutate this server, its project, port `4040`, Postgres data, task state, routes, or credentials during diagnosis. Read-only inspection comes first. Any live mutation requires an explicit operator gate described below.

### Existing `oc-fanout` residue

At audit time, `oc-fanout doctor --json` reported ready, but recent batches were not active successes:

- `kb017-vertical-slice-authoring-v2-20260827-r2` — stalled with `LAUNCH_ERROR:CandidateInspectionError`; recovery recommendation was `recover`.
- Its predecessor — paused by `EVIDENCE_LIMIT`; recommendation was to start the same manifest.
- `ccc-fusion-model-admission-research-20260824-side2` — paused by evidence limit, with three ready but unrun tasks.
- `ccc-fusion-r1-minimax-diagnostics-20260824-b` — `partial_start`.
- No batch was actively running or waiting for review.

Treat these as evidence and unfinished residue. Do not blindly resume them. An open-ended repository audit is a poor `oc-fanout` task. Use `oc-fanout` only after the parent has defined independent, exact-file or exact-question tasks, proof-source roots, bounded budgets, and parent review criteria.

### Model and harness truth

The intended routine product routes include:

```text
openai-compatible-omniroute/minimax-m3-fanout
openai-compatible-omniroute/glm52-fanout
```

The current live tasks requested the pinned MiniMax M3 route. The current Fusion worker harness is Pi/custom-provider based. A first-class OpenCode harness is an intended target, but the repository requires a same-task Pi-versus-OpenCode benchmark before adopting it as the default.

The broader escalation policy discusses MiniMax M3 and GLM for routine tasks, OpenCode Go with Kimi or Qwen, AGY Gemini Pro or limited Opus consultation, and Codex Terra or Sol at higher reasoning levels. These are policy candidates, not proof that every route is wired, effective, healthy, or used by the live campaign.

Always distinguish four different facts:

1. the route a task requested;
2. the route configuration that was selected;
3. the effective provider/model that actually answered;
4. whether that answer successfully produced the required work.

No silent substitutions. If an effective route cannot be proven, label it `ROUTE_UNAVAILABLE` or `UNKNOWN`.

An older documented M3 campaign is summarized in:

`/Users/ryanpappal/03_CODE/ccc-fusion/docs/plans/2026-08-24-r1-minimax-m3-codex-handoff.md`

That campaign reportedly completed seven worker runs without invoking edit/write tools and produced zero diffs and zero commits. Re-read the source evidence before using it. The working hypothesis is a worker/harness/task-contract problem, but do not promote that hypothesis to fact until traced.

### Test truth

The audit ran fresh local checks:

- `task ci` exited `0`.
- After build artifacts existed, a quiet `task gate` rerun exited `0`.
- The curated gate result was `540 passed, 2 skipped`:
  - engine core: 300 passed
  - PostgreSQL canaries: 10 passed
  - core safety: 8 passed
  - engine safety: 71 passed, 2 skipped
  - CLI PRD safety: 51 passed
  - core PostgreSQL product status: 15 passed
  - CI shape: 85 passed

However, the first standalone `task gate` attempt failed 11 CLI tests because required built files were absent, including `packages/cli/dist/bin.js`, `extension.js`, `proof-admission.js`, and a native manifest. This is not automatically a product defect: `task gate` is a granular test-only runner and does not declare a build dependency, while canonical fresh-checkout `task ci` explicitly builds before invoking it. Use `task ci` or `task build && task gate` from a fresh tree. If the intended contract is that `task gate` itself must be fresh-checkout-safe, establish that requirement before changing Taskfile behavior.

One Luna audit lane accidentally began a duplicate `task ci` while the parent’s authoritative run was active. It was interrupted after about 227 seconds during plugin build, competed for CPU, and wrote ignored `dist` artifacts. That overlapping run is invalid evidence. The later quiet `task gate` replay is the curated-gate evidence, but the primary checkout was no longer a pristine no-artifact tree afterward.

The latest fork full-suite workflow after PR `#51`—run `33140148676`, SHA `9b371...`—failed three of four deterministic shards. Its product-route and slow-lane product route reported seven failures and one pass. Reported failure areas included native CLI session persistence/restart and the Go Task semantic-proof toolchain path.

A second red snapshot recovered from the Luna report is **not the fork run**: run `33288668115`, SHA `ba24b5d0...`, belongs to upstream `Runfusion/Fusion`, not `CrashCartCapital/ccc-fusion`. It failed pipeline smoke (`WorktreePool is not a constructor`), engine slow, dashboard, i18n, and additional shards. Treat it as upstream divergence/integration context, not as evidence about the exact fork candidate. Re-probe both repositories and never combine these runs into one failure claim.

The dedicated product-acceptance workflow is nonblocking and has historically been red. A fresh local attempt to run:

```bash
pnpm verify:ccc-prd-product
```

refused immediately with `CCC_PRODUCT_REPOSITORY_DIRTY` because the primary checkout contained untracked material. That fail-closed refusal is correct, but it also means the shared primary checkout is not an acceptance candidate.

One quarantine entry is expired and still excluded:

```text
scripts/lib/test-quarantine.json
executor-task-done-invariant.test.ts
quarantined 2026-07-20; expired 2026-08-03
```

Repository policy is a deletion ratchet, not an indefinite “re-adjudicate someday” list. Whoever touches the suite and finds this expired entry must either rescue it with evidence that it catches real regressions plus a root-cause flake fix, or delete the test file, ledger entry, and Vitest exclusion. Retries, longer timeouts, and loosened assertions are not rescue.

The repository’s own testing documentation describes the curated gate as a blind spot and the full suite as nonblocking. A green curated gate is valuable evidence, but it is not whole-product proof.

### Product and operator truth

The source contains meaningful machinery for PRD intake/compilation/import, PostgreSQL-backed state, leases, worktree isolation, proofs, approvals, recovery, and safety controls. The product contract also names unfinished goals: full PRD-to-campaign acceptance, high parallelism, domain orchestrators, empirical model/chunk learning, a first-class OpenCode harness, terminal delivery, and installed/runtime proof.

The current dashboard is not yet the promised CCC control surface. Its task mutation and approval paths deliberately refuse and direct operators toward CLI digest commands. Dashboard reads intentionally remain available, so the present contract is **read-only telemetry in the dashboard; custody-sensitive mutations and approvals through `fn prd` CLI digest commands**. Inspect at least:

- `packages/dashboard/src/routes/ccc-campaign-task-guard.ts`
- `packages/dashboard/src/routes/register-approval-routes.ts`

The current plan/runtime path appears to use a basic or v2 route shape, while a richer v3 contract exists but is not emitted and consumed end-to-end. Verify this before deciding whether to freeze v2 or finish v3.

The product-acceptance route uses fake/OpenAI-shaped CLI routes with Sol/Terra and explicitly defers Pi. Therefore even a green acceptance workflow would not, by itself, prove the actual live Pi/custom-provider behavior that is currently stuck.

PRD chunked understanding currently executes chunks serially by design. Do not parallelize that lane merely because campaign-level DAG work can fan out; order-independent assembly, zero-residue failure handling, restart/resume behavior, and acceptance tests are prerequisites for any parallel chunk path.

## Readiness estimate to challenge with evidence

The audit’s plain-language estimate was:

- safety/orchestration foundation: about 80% built;
- operator-facing usability: about 35% built;
- whole ready-to-use product: roughly 50–60% complete.

These are orientation estimates, not metrics. Confirm, revise, or reject them based on the product contract and fresh proof. Do not manufacture a precise percentage from subjective evidence.

## Required operating method

### 1. Load instructions and skills before acting

Read the applicable `AGENTS.md`/instruction hierarchy for every path you touch. Use skills because they constrain how work is done, not because their names look impressive. At minimum, evaluate and load the current versions of:

- `using-superpowers`
- `systematic-debugging` for the reclaim/no-progress loop
- `dispatching-parallel-agents` for independent evidence lanes
- `code-auditor`
- `plain-language`
- `opencode-fanout`
- `consult-dispatcher`
- `codex-model-router`
- `test-driven-development` before any behavior-changing implementation
- `verification-before-completion` before any readiness or success claim

If another skill clearly applies, read it too. Follow the skill’s current instructions; do not rely on remembered versions.

### 2. Use direct repository evidence first

Start with Git, `rg`, focused file reads, exact tests, live read-only API calls, and current owner documents. Use `rg`/`rg --files` before broad search tools. Do not scan huge trees indiscriminately when a narrow falsifier is available.

Then use code-intelligence MCPs to answer relationship questions that direct search cannot answer efficiently. Prefer MCPJungle Smart Tree search/read/code-intelligence surfaces when available. Discover exact tool names through the broker rather than guessing them. Do not use or recommend `mcp-run`; it is retired.

### 3. Create bounded Luna subagents

Use Luna subagents for independent read-only investigation. The parent owns synthesis, decisions, all overlapping edits, and the final proof. Give each agent an explicit isolation contract and exact requested output. A recommended initial fanout is:

1. **Live reclaim-loop investigator**
   - Read-only access to the live API, logs, relevant engine/recovery/worker code, and task records.
   - Trace one task from lease/acquisition through worker launch, model response, edit detection, commit preservation, proof admission, and reclaim.
   - Return a timestamped event sequence, leading root-cause hypotheses, evidence for/against each, and the cheapest falsifying probe.

2. **Tests and product-acceptance investigator**
   - Reproduce or inspect the standalone `task gate` build-order gap, the latest failed full-suite shards, product-acceptance preconditions, and the expired quarantine.
   - Return exact failing commands/tests, whether each failure is current or historical, and the narrowest repair sequence.

3. **Model-route and harness investigator**
   - Trace requested route → selected configuration → effective provider/model → worker tool calls → produced artifacts.
   - Compare the Pi/custom-provider path with the acceptance fake/OpenAI route and the intended OpenCode harness.
   - Identify how to run the same tiny task under pinned M3 and GLM without silent substitution.

4. **Git, worktree, PR, and custody investigator** if a fourth slot is useful
   - Refresh branch/remote/PR/worktree facts.
   - Identify a safe base and destination for an isolated clean implementation worktree.
   - Do not mutate, clean, switch, or delete anything.

Use the available Luna model explicitly when the platform requires a model choice. Keep each task bounded. Do not have multiple agents edit the same files. Continue useful parent work while they run, then adjudicate their evidence instead of concatenating their reports.

### 4. Consult AGY Bridge at decision points

Use direct `agy-bridge` tools when available. Every AGY request must begin with this exact boundary:

```text
Role: advisory MCP consultant to the main agent. Do not create, edit, or delete files or otherwise alter project state. Use only read-only tools for context. Return the requested answer/report for main-agent adjudication.
```

Use bounded `delegate` consultation to challenge the leading reclaim-loop diagnosis or route/harness explanation. Use `adversarial_review` before freezing the repair design and again after the final diff/evidence packet. AGY is an advisory consultant, not an implementation owner. If the direct route is unavailable, report `ROUTE_UNAVAILABLE`; do not substitute `mcp-run` or invent another path.

### 5. Use `oc-fanout` only after work is sharply sliced

Inspect `oc-fanout doctor`, batch status, manifests, and residue read-only. Do not resume existing batches automatically. If the diagnosis yields two or more substantial, non-overlapping implementation or verification tasks, `oc-fanout` may be used only when each task has:

- exact owned files or directories;
- a one-sentence objective;
- explicit forbidden surfaces;
- a small first-edit budget;
- proof-source roots;
- exact commands that define success;
- a parent review and integration step.

No vague “fix the repo,” “audit the system,” or “make the product ready” fanout tasks.

## Execution phases

### Phase 0 — Preflight and custody freeze

1. Read all applicable instructions.
2. Record current date/time, repository root, branch, `HEAD`, upstream refs, remotes, worktree list, and dirty/untracked state.
3. Refresh GitHub PR/check facts with authenticated, machine-readable `gh` commands.
4. Confirm whether port `4040` is listening, identify the exact owner process, and query health read-only.
5. Capture the live project/task summary and recent logs without changing task state.
6. Inspect current `oc-fanout` readiness and batch statuses without recovery/resume.
7. Choose an isolated clean worktree for any later implementation. Base it on a verified commit—probably current `origin/main`, unless evidence shows a different authoritative base. Do not create or switch it until custody and ownership are unambiguous.

Suggested probes, adapted to current repository instructions:

```bash
pwd
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
git rev-list --left-right --count origin/main...HEAD
git remote -v
git worktree list --porcelain
git log --oneline --decorate -12
gh pr list --state open --json number,title,isDraft,headRefName,baseRefName,statusCheckRollup,updatedAt,url
gh run list --limit 20 --json databaseId,name,workflowName,headSha,status,conclusion,createdAt,url
lsof -nP -iTCP:4040 -sTCP:LISTEN
curl --fail --silent --show-error http://127.0.0.1:4040/api/health
oc-fanout doctor --json
oc-fanout status --json
```

Discover live project/task endpoints from the source and existing scripts rather than guessing mutating API calls.

### Phase 1 — Trace the failure, do not merely describe it

Build a single-task causal timeline for one recurring reclaim cycle:

```text
task eligible
→ lease/acquisition
→ worktree/custody selection
→ prompt/task contract construction
→ provider route selection
→ effective model response
→ tool-call permission and tool invocation
→ filesystem diff
→ commit detection/preservation
→ proof collection/admission
→ state transition
→ reclaim or terminal state
```

At every arrow, identify:

- the source function/module responsible;
- the persisted state or log evidence;
- the expected transition;
- the observed transition;
- the first point where observed behavior diverges;
- one probe that could falsify the current explanation.

Do not stop at “the model did nothing.” Determine whether the model was given an actionable task, whether edit tools were exposed and permitted, whether it called them, whether edits were visible in the expected worktree, whether a commit was required/created/detected, whether proof admission rejected otherwise useful work, or whether recovery logic discarded or misclassified progress.

Include one narrow shell-authority probe in the same worker execution surface. Determine whether a harmless read command containing `2>/dev/null` is refused with `AUTHORITY_ROOT_ESCAPE`, whether commands without that redirect succeed, and whether any generated worker/hook commands in the golden path contain `/dev/null`. Do not weaken the root boundary to make the probe pass; normalize commands or use an owned in-worktree redirect target if that is the confirmed contract.

Use historical M3 runs as supporting evidence, not as a substitute for tracing a current representative cycle.

### Phase 2 — Freeze the smallest repair design

Before editing, write a compact root-cause and design note in your working record:

- confirmed root cause(s);
- contributing factors;
- rejected hypotheses and their falsifiers;
- exact behavior that must change;
- exact behavior that must not change;
- files/modules to touch;
- tests that will fail before the repair and pass afterward;
- rollback/recovery path;
- risks to live state, shared worktrees, providers, credentials, and PostgreSQL.

Run an AGY adversarial review of this design. Adjudicate each critique against code and tests. Do not implement speculative platform breadth.

### Phase 3 — Implement in a clean isolated worktree

Only after the diagnosis is sufficiently evidenced:

1. Create or select an isolated clean worktree from the verified authoritative base.
2. Confirm it contains no unrelated changes.
3. Add the smallest failing regression test first.
4. Implement the narrow repair.
5. Keep model-route receipt changes separate from worker behavior changes where practical.
6. Do not modify the live project, restart the live server, rotate credentials, or change global OmniRoute/provider settings.
7. Preserve exact commits and a readable diff.

If the root problem is a contract mismatch rather than a code bug, repair the narrowest authoritative contract and its tests. Do not paper over it with retries, longer timeouts, fake proofs, silent route fallback, or relaxed custody checks.

### Phase 4 — Verify in layers

Run the narrow regression first, then expand:

1. touched-package unit/integration tests;
2. CLI and engine safety tests related to the changed path;
3. `task ci` from a clean state;
4. `task build && task gate` when independently replaying the curated gate; run bare `task gate` without artifacts only when explicitly testing the granular runner’s precondition;
5. the relevant formerly failing full-suite shards;
6. `pnpm verify:ccc-prd-product` in the clean acceptance candidate;
7. the expired quarantine resolved according to the deletion ratchet: verified root-cause rescue, or deletion of the test, ledger row, and Vitest exclusion.

Do not say “tests pass” without the exact command, exit code, counts, commit, and important skips. A nonblocking workflow that is red remains red.

### Phase 5 — Gate 1: prove one golden worker campaign

The golden campaign should be deliberately boring:

- one tiny disposable repository or fixture;
- one precise task;
- no ambiguous multi-file architecture work;
- preferably four or fewer relevant files;
- one deterministic requested edit;
- one expected commit;
- one required proof artifact;
- one human-readable terminal digest;
- one dashboard-visible read-only terminal status, if the current read surface supports it, with any missing view labeled honestly;
- no dependence on the existing 17-task live project.

Run the same task through the same Pi/custom-provider harness twice where authorized:

1. pinned MiniMax M3;
2. pinned GLM 5.2.

The comparison must retain:

- requested route;
- selected route configuration;
- effective provider/model receipt;
- prompt/task contract hash or stable identifier;
- worker tool calls;
- diff;
- commit SHA;
- proof-admission outcome;
- task terminal state;
- wall time and retry/reclaim count;
- any model substitution or route failure.

The point is not to crown a permanent winner from one task. The point is to prove that the harness can cause attributable useful work and that route receipts tell the truth. Passing this phase proves the worker loop only. It does not prove pause/resume/stop, crash recovery, multi-task custody, controlled landing, or whole-product readiness.

This phase is a **live-action gate**. Before making a billable provider call, changing a live route, creating live tasks, altering credentials, restarting services, or writing to shared Postgres state, present the operator with:

- the exact command/action;
- the exact disposable target;
- the requested model route;
- expected cost/risk if knowable;
- rollback/cleanup plan;
- why existing read-only or fake-route evidence is insufficient.

Proceed only with explicit authority for that live action. If authority is not granted, stop at a fully prepared, locally verified campaign packet and label live proof `PENDING_OPERATOR_GATE`.

### Phase 6 — Gate 2: close whole-product readiness in order

After the golden campaign is proven—or prepared up to the live gate—reassess these milestones:

1. **Clean authoritative candidate** — `task ci`, relevant full-suite routes, and product acceptance are green on an exact clean commit.
2. **Useful worker loop** — a real model performs an edit, preserves a commit, admits proof, and reaches an honest terminal state.
3. **Model comparison and receipts** — M3 and GLM run the same task through the same harness with requested/effective route proof.
4. **Full lifecycle acceptance** — the 39 checks in `scripts/ccc-prd-product-acceptance.mjs` pass on the exact candidate, including operator lifecycle controls, provider/proof/import restart handling, execution and merge human holds, chained worktree custody, integrated proof across commits, controlled landing, terminal restart recovery, and fanout/join proof.
5. **Route-contract decision** — either freeze and document v2 or finish v3 end-to-end; no half-integrated dual truth.
6. **Operator control surface** — preserve the current honest read-only dashboard/CLI-mutation contract or deliberately implement custody-safe dashboard controls; in either case, status, receipts, approvals, and terminal delivery must be understandable to the operator.
7. **PR and residue adjudication** — decide PRs `#49` and `#50`, expired quarantine, failed full-suite lanes, and old worktree/fanout residue only after the golden path is stable.
8. **Installability** — prove an ordinary user can install/launch the intended CLI/runtime rather than relying on a five-day source-worktree server.

Do not attempt all eight as one giant change. Gate 1 is the first milestone; Gate 2 is the product-readiness standard.

## Authority boundaries and stop gates

You are authorized to perform read-only inspection and safe repo-local implementation in a new isolated worktree. You are not authorized to perform materially different or externally consequential actions without an explicit operator decision.

### Forbidden without explicit approval

- `git reset --hard`, destructive checkout, broad clean, automatic stash, history rewrite, or deleting branches/worktrees;
- touching the revoked `wave-3` path;
- writing to `wave-3-retry`;
- killing or restarting the port `4040` owner;
- mutating `r1-evidence-envelope` tasks or its database;
- changing global/provider/OmniRoute routing, credentials, quotas, or secrets;
- silent model substitution;
- pushing branches, opening/updating/merging PRs, or changing GitHub settings;
- resuming/recovering existing `oc-fanout` batches;
- relaxing proof, custody, or fail-closed controls merely to make a test green.

### Required stop labels

- `CUSTODY_CONFLICT` — another worktree or uncommitted owner state overlaps the proposed work.
- `ROUTE_UNAVAILABLE` — the required AGY, provider, model, MCP, or receipt route cannot be called or proven.
- `LIVE_ACTION_REQUIRED` — progress now requires a provider call, service restart, task mutation, credential change, database write, or other live-state action.
- `DEPENDENCY_OPEN` — the clean baseline, build toolchain, or required service cannot be reproduced safely.
- `HONEST_RED` — a required test or acceptance route remains failing after bounded diagnosis.
- `PENDING_OPERATOR_GATE` — the implementation and dry-run packet are ready, but live authorization has not been granted.

Do not call the task blocked merely because it is difficult. Exhaust safe, local, read-only and isolated-worktree avenues first.

## Definition of done for this work cycle

The work cycle is complete only when one of the following honest outcomes is delivered.

### Outcome A — Gate 1 and Gate 2 proven

All of the following are evidenced:

- an exact clean implementation commit;
- the reclaim/no-progress root cause is traced and repaired or conclusively avoided by the corrected contract;
- targeted regression tests pass;
- `task ci` passes on the exact clean commit;
- relevant formerly failing broad tests are green, or remaining failures are precisely isolated and unrelated;
- product acceptance passes on the clean candidate;
- a tiny disposable real-model campaign reaches terminal success;
- requested and effective model identities are captured;
- the worker creates the expected diff and attributable commit;
- required proof is admitted;
- the golden result is visible through an honest operator digest and dashboard read surface, or the missing dashboard read is explicitly failed rather than waived;
- all 39 whole-product acceptance checks pass on the exact candidate, including lifecycle controls, restart/uncertain-effect handling, human execution and merge holds, chained worktree custody, multi-commit integrated proof, controlled landing, terminal recovery, and fanout/join proof;
- no live or worktree residue is silently left behind.

A Gate 1 success with Gate 2 still red is `PARTIAL`, never “product ready.”

### Outcome B — Everything locally ready at an operator gate

If a live provider/database/service action is the only missing proof, deliver:

- the clean tested repair commit;
- the complete disposable campaign fixture;
- exact commands for pinned M3 and GLM;
- expected receipts and assertions;
- cost/risk and cleanup plan;
- all local/fake-route tests passing;
- status `PENDING_OPERATOR_GATE`, with no claim that the product is live-proven.

### Outcome C — Honest bounded failure

If a required test, route, dependency, or custody boundary remains unresolved, deliver:

- the first failing boundary;
- exact reproduction command and output summary;
- confirmed facts versus hypotheses;
- attempted falsifiers;
- the smallest next action requiring new authority or external-state change;
- one of the required stop labels above.

## Final deliverable format

Keep commentary updates short and useful while working. The final report should be conversational and plain enough for a busy operator to grasp without rereading, while preserving technical nuance. Lead with the bottom line.

Use this structure:

1. **What changed in plain language** — two to four short paragraphs.
2. **What is actually proven** — exact commit, runtime, model, test, and campaign evidence.
3. **What remains unproven or red** — no euphemisms.
4. **Git and custody status** — local versus remote, worktree used, dirty state, PR impact.
5. **Tests** — commands, exit codes, pass/fail/skip counts, quarantine disposition.
6. **Models and routes** — requested, configured, effective, successful.
7. **Product readiness** — revise the starting readiness estimate and explain why without false precision.
8. **One next physical action** — the smallest concrete re-entry step, not a giant backlog.

State Gate 1 and Gate 2 separately. A reader must be able to see, in one glance, whether the worker loop works and whether the complete product lifecycle is accepted.

For every major conclusion, distinguish:

- `OBSERVED`: directly measured in this run;
- `INFERRED`: best explanation supported by multiple observations;
- `UNKNOWN`: not proven;
- `PENDING_OPERATOR_GATE`: ready but awaiting live authority.

Never claim “complete,” “production ready,” “tests pass,” “model X was used,” or “the dashboard works” from intent, configuration, generated files, historical logs, or one green narrow test. Completion requires fresh proof on the exact candidate being described.

Begin now with Phase 0. Do not restart the live server or resume existing fanout batches.
