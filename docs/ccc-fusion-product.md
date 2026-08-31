# CCC-Fusion Product Contract

[Docs index](./README.md)

This document is the product-facing contract for **ccc-fusion**, CrashCartCapital's acceptance-hardening fork of Fusion. It records the intended CCC-Fusion behavior and operator rules. It does not by itself prove that every target is implemented, installed, running, or proven in real use.

## Proof Posture

Keep these states separate in docs, reviews, dashboards, and delivery notes:

- Written in a plan or product contract.
- Present in code.
- Passing tests on an exact tree.
- Committed locally.
- Ready to push.
- Pushed.
- Merged.
- Installed.
- Running.
- Proved in real use.

CCC-Fusion must not call a feature live-ready until the exact installed/runtime path has passed real-use proof.

## Product Purpose

CCC-Fusion exists to turn large, user-owned product direction into recoverable coding campaigns:

1. Ingest unchanged PRD packets and preserve their source text.
2. Compile deterministic packet sidecars and semantic indexes.
3. Import admitted work into PostgreSQL transactionally.
4. Decompose the work into a dependency graph. A dependency graph is a map of what can run now and what must wait.
5. Dispatch every dependency-ready task that is safe to run in parallel.
6. Keep each worker isolated by worktree and atomic ownership.
7. Verify, review, integrate, and deliver only after proof gates pass.

The practical goal is simple: Ryan should be able to feed CCC-Fusion a serious PRD and get a controlled multi-agent coding campaign that can pause, recover, explain itself, and avoid hidden partial work.

## Current Code Truth vs Target

CCC-Fusion should reuse Fusion's existing substrate rather than grow a second control plane. Current repo foundations include task lifecycle state, PostgreSQL stores, task dependencies, worktrees, scheduler gates, inter-agent messaging, run audit, approvals, model/provider settings, the Pi extension, dashboard surfaces, and CLI recovery paths.

The following are CCC-Fusion product targets and must stay labeled as targets until direct source, test, install, runtime, and real-use evidence proves them:

- Full PRD-to-campaign acceptance lane.
- High-parallel campaign orchestration across dependency-ready work.
- Domain/subsystem orchestrators coordinating leaf workers through durable mail.
- Empirical model and chunk-size learning.
- A first-class OpenCode worker harness.
- A dedicated terminal delivery agent.
- Installed/runtime proof beyond the existing source-level middle-chunk zero-residue regression.

## Worker Compute Policy

Normal CCC-Fusion leaf-worker execution must use Ryan's approved OmniRoute endpoints. Routine workers and ordinary orchestrators should draw mainly from:

- `openai-compatible-omniroute/minimax-m3-fanout`
- `openai-compatible-omniroute/glm52-fanout`

The system should learn which of MiniMax M3 and GLM 5.2 performs best by task type, task size, prompt shape, failure pattern, and verification result. That learning should stay useful and simple: receipts, labels, and comparison reports before complicated evaluation infrastructure.

Escalation should be explicit and evidence-backed:

1. Shrink or clarify the task and retry on MiniMax M3 or GLM 5.2 when the failure looks like task size or prompt shape.
2. Use OpenCode Go compute through OmniRoute for Kimi K3 or Qwen 3.8 when a stronger non-Codex worker is warranted.
3. Use Antigravity compute for Gemini Pro latest, or Gemini API free tier for Gemini Pro latest, when available and appropriate.
4. Use Antigravity compute for Opus 4.6 when that limited quota is worth spending.
5. Use Codex GPT-5.6 Terra at high or xhigh reasoning for hard chunks that still need more.
6. Raise Terra to max reasoning if needed.
7. Use Codex GPT-5.6 Sol at max reasoning only for the hardest remaining cases or parent-level judgment.

Codex and Claude Code are Ryan's general interactive compute pools. They are not CCC-Fusion's default worker compute. Direct Antigravity or Codex use is a logged step-up exception for a bounded hard task or review, not a routine worker route.

Model IDs, quotas, and provider health are runtime facts. CCC-Fusion should re-probe them rather than hard-code stale assumptions.

## Harness Policy

Route and harness are different things:

- Route means which model/provider receives the work.
- Harness means the program that runs the worker session, tools, prompts, and lifecycle.

Current CCC worker truth should be documented from live code before claims are made. The present expected default is the Pi/custom-provider path using OmniRoute. OpenCode is useful for model discovery and may become a worker harness, but that needs a small benchmark first:

- Same repo fixture.
- Same PRD packet or task.
- Same model route where possible.
- Pi worker result vs OpenCode worker result.
- Compare success rate, residue, tool behavior, prompt fit, cost, latency, and review burden.

Do not build a broad OpenCode adapter until that benchmark proves a clear benefit.

## Parallel Campaign Model

CCC-Fusion should not have an arbitrary product ceiling like "two workers" or "twenty workers." The product goal is maximal safe parallelism, constrained empirically by hardware, provider throughput, repository contention, and review/integration capacity.

CCC-Fusion should also provide generous finite execution limits by default. Size request and time envelopes from the useful job we expect the worker to finish, then retain explicit safety and cost ceilings. Prefer a session that runs long enough to produce a useful product over one cut off by an arbitrary micro-limit. The starting request recommendation is 384 requests per provider task; this is planning guidance, not a new admission gate, per-task reservation, completion guarantee, or permission to remove finite ceilings. Task evidence may justify a different envelope. Record actual requests by model and task so later defaults can reflect model-specific tool-use behavior rather than forcing every model into one low cap.

The scheduler should treat these as separate resource pools:

- Model/research sessions.
- Writing worktrees and ownership leases.
- Heavy verification jobs.
- Integration and delivery lanes.
- Human approval gates.

The important rule is one writer per atomic scope, not low global concurrency. An atomic scope can be a file, symbol, module, package boundary, or shared interface, depending on the task. Other independent work should continue while that scope is owned.

Capacity should be learned by ramping cautiously and recording evidence:

- dispatch count;
- host CPU, memory, disk, and process pressure;
- provider latency, failures, and quota pressure;
- merge conflict rate;
- review failure rate;
- residue after interruption, cancellation, or restart.

The operator should be able to choose a responsive preset that preserves machine usability or an aggressive preset that spends more available capacity. Neither preset imposes an arbitrary low worker count; both use measured pressure and backoff.

## Orchestrators and Mail

The target hierarchy is:

- Main orchestrator: owns the campaign, proof gates, and final judgment.
- Domain orchestrators: own bounded subsystems such as ingestion, verification, dashboard UX, provider harness, or logging.
- Leaf workers: own one small outcome and one non-overlapping scope.

Durable agent mail is the coordination channel. It helps agents ask for context, report blockers, and hand off findings. Mail is not proof by itself. Proof still comes from source, tests, logs, git state, database state, and runtime checks.

## Operator Experience

CCC-Fusion should be dashboard-first for Ryan:

- A clear campaign view.
- Simple status labels.
- Plain-language blockers.
- Visible dependencies.
- Worker receipts and model-route receipts.
- Easy pause, cancel, retry, and resume controls.
- Proof state labels that do not blur "tested" into "live."

The CLI remains important for recovery, exact inspection, scripted checks, and terminal delivery. The CLI should not be the only comfortable way to operate the product.

## Data and Authority Boundaries

Workers may receive declared repo context, the admitted PRD packet, task-scoped artifacts, and task-specific public documentation. They must not browse Ryan's private vault, secrets, credentials, clinical data, private financial-account or broker data, or unrelated local files unless an explicit approved mechanism allows a narrow read.

A future read-only advisor can answer narrow worker questions, such as "what package preference is already documented?" The advisor must decide whether the requested context is safe to expose. That advisor is a future target, not a v1 requirement.

CCC-Fusion v1 should focus on one primary repo per campaign. Cross-repo and multi-node campaigns can follow after the single-repo lane is proved.

## Delivery Boundary

Ordinary workers, reviewers, and orchestrators must not push, open pull requests, merge remote branches, force-push, or perform external landing.

The target delivery model is a special terminal delivery agent that runs only after exact-tree validation and review are complete. A frozen campaign may preauthorize exact push, pull-request creation or update, and merge actions for this agent. Before any remote Git action, it must recheck:

- target branch;
- remote head;
- required checks;
- stale approvals;
- protected-branch rules;
- the exact unconsumed campaign authority receipt.

If the scope, commit, tree, checks, target, remote head, or authority receipt changed, the agent must refuse and return control to campaign orchestration. If they are unchanged and every named gate passes, it may perform the preauthorized action without interrupting Ryan for a duplicate approval. Release publication, provider credentials, money, private data, and external live activation remain separate gates. Remote delivery never proves the product installed, running, or live-ready.

## Acceptance Criteria

The product contract is satisfied only when the exact candidate tree proves these behaviors:

- PRD packets import without source mutation and produce deterministic sidecars.
- Failed middle chunks leave no partial packet, hidden database residue, stale files, or misleading proof state.
- Resume options explicitly refuse until integrity work is implemented and proved.
- Dependency-ready tasks dispatch in parallel while overlapping atomic write scopes serialize.
- Capacity ramps are measured and produce actionable model/chunk-size receipts.
- MiniMax M3 and GLM 5.2 are the routine worker routes unless a logged escalation rule applies.
- Pi-vs-OpenCode worker harness benchmarking is complete before a first-class OpenCode adapter is treated as product direction.
- Interruption, restart, cancellation, stale approval, target drift, and duplicate-effect cases pass in a disposable local environment.
- Dashboard and CLI both expose enough state for Ryan to understand what happened without reading code.
- The dedicated delivery lane refuses remote mutation until final validation and authority are fresh.
