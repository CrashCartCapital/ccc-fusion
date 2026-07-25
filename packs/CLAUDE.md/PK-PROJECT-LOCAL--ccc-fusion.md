# ccc-fusion local guidance

Pack ID: `PK-PROJECT-LOCAL`.

Read this generated pack only after the compact root catalog identifies a strong trigger.

### Repo Identity

- Canonical repo slug and display name: `ccc-fusion`.
- Canonical primary checkout: `/Users/ryanpappal/03_CODE/ccc-fusion`.
- Repository role: Ryan's acceptance-hardening fork of Runfusion/Fusion for compiling immutable PRD packets into recoverable, proof-gated PostgreSQL workflows without creating a second orchestrator.
- The primary checkout stays on `main`. Branch-scoped conversion work belongs in dedicated worktrees under `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/`.
- Verify remotes, branch, HEAD, worktree path, cleanliness, and the current campaign checkpoint before relying on any remembered identity. The intended repository relationship is the private `CrashCartCapital/ccc-fusion` fork with `Runfusion/Fusion` as read-only upstream and upstream push disabled; live Git configuration is the proof.
- This is a pnpm 10.33 TypeScript monorepo. The root package is `fusion-workspace`; major packages include `@fusion/core`, `@fusion/engine`, `@fusion/dashboard`, `@runfusion/fusion`, desktop/mobile shells, the plugin SDK, and runtime plugins.

### Project Context

- Begin conversion work with the live campaign sources in `/Users/ryanpappal/01_VAULT/KnR-Vault/00_MAIN/01_ActiveProjects/ccc-fusion/`: `PRJ-AI-ccc-fusion-PRD-v0.1.md`, `PRJ-AI-ccc-fusion-ConversionPlan-v0.1.md`, `REF-AI-ccc-fusion-Phase5-OrchestrationCheckpoint.md`, and `REF-AI-ccc-fusion-ParallelForwardFillExecutionApproach-2026-07-24.md`. Then read this repo's `docs/testing.md` and the relevant implementation docs. The checkpoint is re-entry state, not a substitute for fresh Git and runtime probes.
- Preserve one authoritative accepted-wave spine. A speculative branch, child result, historical test pass, or compiler-front-half pass is development evidence only until it is replayed from the accepted predecessor and passes fresh integrated acceptance.
- Fusion's PostgreSQL task/workflow state remains the sole execution truth. ccc-fusion may add immutable campaign receipts and requirement/proof records, but must not create a parallel JSONL, SQLite, scheduler, merger, or second control plane.
- PRD compilation is deterministic and side-effect-free. Transactional import is a separate explicit step that revalidates the bundle and target, creates all task, dependency, workflow, document, artifact, and source records atomically, and rolls back the whole import on failure.
- Preserve exact requested provider/model identity, native MCP/tool traffic, cancellation ownership, durable effect identity, and truthful terminal state. Never flatten structured tools into prompt text or use `packages/engine/src/cli-agent/adapters/generic.ts` for the OmniRoute transport.
- Keep branding shallow unless a later accepted migration proves otherwise: preserve internal `@fusion/*`, `@runfusion/fusion`, `FUSION_*`, database, storage, and task-branch identifiers while exposing `ccc-fusion` at the operator-facing boundary.
- The CCC embedding corpus invariant is BGE-M3 at 1024 dimensions. An embedding-model change requires a complete corpus wipe and rebuild; partial migration is invalid.
- Optimize for Ryan as one technical operator: reliable recovery, visible proof, bounded cost, exact authority, and pragmatic maintenance outrank enterprise abstractions, generic platforms, or speculative extensibility.

### Tool And Routing Overrides

- Use `pnpm` from the repository root and respect the pinned `packageManager` version. Do not run dependency installation, rebuild, or lifecycle scripts unless the current campaign authority explicitly permits them.
- Prefer `rg`, repo docs, tests, Git plumbing, and direct loopback probes before external research or broad code-intelligence tools.
- Use `pnpm verify:fast` for test-free changed-package verification. It performs artifact bootstrap, scoped typecheck/build, the CLI build required by boot smoke, and boot smoke without running tests.
- The normal merge gate is `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test:gate`. `pnpm test` is the bounded gate-plus-changed-only lane. `pnpm test:full` and `pnpm verify:workspace` are explicit opt-in full sweeps, not routine per-task checks.
- Prefer exact file-scoped Vitest commands such as `pnpm --filter @fusion/<package> exec vitest run path/to/test.ts --silent=passed-only --reporter=dot`. Do not pass `allowFullSuite: true` unless the change truly has no targetable test set, and record why.
- Use `scripts/run-ccc-pg-proof.mjs` only with the exact accepted wave mapping. It owns disposable PostgreSQL startup, zero-skip proof reporting, cleanup on pass, and preserved redacted evidence on failure. Never broaden a frozen mapping merely to make review convenient.
- Provider, model, MCP, OmniRoute, and credential facts are live-state questions. Use the current capability ledger, project SSOT, relevant skills, and the narrowest safe health or inventory probe; never embed remembered model IDs, ports, tokens, or provider state as truth.
- Port `4040` is reserved. Never kill its owner or start a test server there. Use port `0` or another verified-free loopback port.

### Workflow And Skill Overrides

### Campaign execution

- Use one branch and one dedicated non-primary worktree per wave. One authoritative writer owns the accepted integration branch, and one writer owns each shared file or interface.
- Fan out only predecessor-independent, collision-free work with frozen consumed contracts. Pure new-file, fixture, research, documentation, and read-only review lanes may run ahead; persistence, scheduler, receipt, provider, session, migration, proof-runner, and live-action seams remain serial.
- Forward-fill speculative work only from the newly accepted predecessor. Re-derive changed interfaces, resolve the speculative commit as replay, repair, partial harvest, or rejection, and rerun fresh integrated proof before acceptance.
- Before every implementation wave, verify branch/worktree identity, remotes, protected paths, dependency state, manifest hashes when required by the plan, live listeners relevant to the proof, and the exact prior acceptance/operator gate.
- After every accepted wave, interface freeze, material repair, worktree change, or agent-session replacement, update the Phase 5 orchestration checkpoint with exact Git identity, proof commands/results, residual risk, and unissued actions.
- Product code remains paused whenever the canonical checkpoint says paused. Documentation setup or speculative preparation does not silently resume implementation authority.

### Test and proof discipline

- Behavior changes, fixes, and new execution logic use RED → GREEN → REFACTOR. RED must exercise the intended behavior and capture the failure signature; environment/setup failures are not behavioral RED. GREEN uses the smallest proof that closes the requirement, then the owning file/package and campaign gate appropriate to the risk.
- Regression tests prove the invariant across all known surfaces, not only the reported reproduction. Bug and UI-affordance work must enumerate affected providers, adapters, components, breakpoints, data states, and reused helpers; include the original symptom, exact reproduction, and assertion that it is gone.
- Do not add slow tests. Prefer narrow seams, in-memory fakes, shared harnesses, targeted assertions, and fake timers. Do not widen timeouts, retries, or worker counts to appease a flaky or slow test.
- A test observed failing without a corresponding product bug is quarantined on sight using `scripts/lib/test-quarantine.json` and the owning Vitest exclusion in the same commit. Never weaken assertions to make a flake pass. Quarantined tests follow the repository's 14-day rescue-or-delete ratchet in `docs/testing.md`.
- Acceptance requires exact commands, observed results, clean committed state, and fresh independent review of the final bytes. A child self-report, stale pass, skipped named test, or proof produced before the last repair is not acceptance.

### Repository conventions

- Direct work on `main` is allowed only when the operator intends the change to land on `main`. Feature, multi-commit, parallel, speculative, and PR-bound work uses a dedicated worktree; never switch the primary checkout away from `main`.
- Commit prefixes are `feat(FN-XXX):`, `fix(FN-XXX):`, and `test(FN-XXX):`. Fusion task-worktree commits carry a `Fusion-Task-Id: FN-NNNN` trailer. Keep one coherent commit per step boundary.
- Squash is the default merge strategy unless project/task configuration explicitly selects another supported strategy. Preserve file-scope invariants, do not force-add ignored task artifacts, drop duplicate commits, and treat empty cherry-picks as no-ops.
- `autoMerge: false` means `in-review` is terminal until a human merges, except for the documented shared-branch-group member-to-group integration seam. Never interpret it as authority to promote the shared branch to the default branch.
- A change affecting published `@runfusion/fusion` needs a correctly formatted changeset; internal docs, generated instruction files, CI configuration, and behavior-preserving refactors do not. Only `@runfusion/fusion` is published.
- Releases are operator-only and never run inside a Fusion task. Do not run `pnpm release`, `changeset publish`, `pnpm publish`, `npm publish`, or create release tags.

### Code and specification hygiene

- Do not cite `.fusion/tasks/<id>/<file>` in a task specification unless the file exists, is explicitly created as a new artifact, or is an allowed sibling `PROMPT.md`, `task.json`, or `attachments/*`. Use task documents for planning scratch.
- Third-party integration specifications must name the canonical repository, documentation/homepage, release/download URL, exact binary/CLI name, and checksum or `upstream-pending-verification`. Never invent upstream evidence.
- Reuse existing modules, hooks, components, design primitives, and documented solutions before adding a parallel system.
- Dashboard work uses existing design tokens and component CSS. Do not hardcode pixels, hex colors, or `rgba()` in component CSS; use tokens and `color-mix(...)`. Put component styles beside the component, not in the global stylesheet.
- `@fusion/*` imports must remain statically analyzable. Use static imports by default; preserve the core-to-engine dependency-injection seam instead of dynamic `@fusion/engine` import tricks.
- User-configured commands run through bounded asynchronous execution, never `execSync`. Managed child processes use `superviseSpawn(...)`; raw detached `spawn`/`nohup` requires an explicit allowlist.
- Maintain requirement comments using `FNXC:<Area> YYYY-MM-dd-hh:mm:`. Comments record the user-facing requirement or technical decision that justified the behavior, stay concise, and are updated when the requirement changes. Prefer JSDoc or focused block comments; do not narrate obvious code.

### Runtime And Execution Overrides

- Provider, credential, billing, non-loopback network, publication, release, upstream write, automatic merge, and live/destructive action gates are action-specific. Earlier wave approval or local code proof never grants blanket future authority.
- Never re-authenticate providers, refresh or modify credential stores, expose secret values, or allow `OPENAI_API_KEY`, `OPENAI_BASE_URL`, Anthropic API-key, alternate-base, Bedrock, Vertex, or similar billing-route variables to influence subscription-only CCC sessions.
- Live provider checks are separate, tiny, serial, read-only, and require the exact current operator gate named by the plan. Record request counts, requested/resolved models, tool policy, ceilings, harness hash, target, and expiry without persisting credential or raw session values.
- Protected actions—promotion, live execution, deletion, merge, publication, credential, billing, and upstream write—require an immutable exact action/target/packet decision receipt. Missing, changed, expired, claimed, or consumed authority fails closed with zero side effects.
- Campaign cancellation owns only the registered task/provider process tree. It must await descendant termination, durable terminal-state flush, and ownership release before acknowledging completion; killed work must not become resume-eligible or duplicate an external effect.
- `moveTask(in-progress → todo)` is a hard user cancel: abort active sessions and subprocesses and park the task with user-paused semantics. Engine rebounds must not set `userPaused`.
- Run-audit metadata remains IDs, counts, timestamps, fixed outcomes, and bounded machine facts only. Never persist prompt text, reflection prose, secret values, arbitrary errors, or user content in run-audit events.
- Never run an unbounded recursive `find` against `/tmp`, `$TMPDIR`, `/var/folders`, or their canonical `/private` forms. Inspect only a known task prefix or one bounded directory level.
- Disposable PostgreSQL fixtures must use a fresh task-specific directory and verified-free loopback port, never reuse an unrelated live database, and stop only the exact process they created. Preserve redacted evidence on failure when the wave contract requires it.
- Compilation and validation perform zero task-store, workflow-store, artifact-store, provider, or action-adapter writes. Only the explicit transactional import path may mutate the disposable/project PostgreSQL target.
- Generated `CLAUDE.md`, `AGENTS.md`, `instruction-pack-manifest.json`, `packs/**`, and `.claude/_compiled/**` are instruction-system products. Change the canonical overlay or shared source and regenerate; never hand-edit generated output. Manifest, lockfile, dependency, native-build, remote-write, merge, publication, release, and broad-cleanup actions remain bound to the exact campaign authority.

### Optional Local Notes

### Primary references

- `README.md` — operator-facing product and development entry point.
- `docs/architecture.md` — lifecycle, persistence, self-healing, process, and run-audit architecture.
- `docs/testing.md` — authoritative verification lanes, quarantine rules, surface enumeration, and test-performance constraints.
- `docs/contributing.md` — dependency, build, and contribution rules.
- `docs/agents.md` — Pi extension, agent coordination, checkout leasing, and runtime configuration.
- `docs/workflow-steps.md` — graph-owned workflow and merge-blocking steps.
- `docs/secrets.md` — secret-handling behavior.
- `docs/storage.md` — PostgreSQL and task-artifact storage model.
- `docs/solutions/` — prior bug and architecture solutions; search it before repairing a known class.
- `CONCEPTS.md` — canonical domain vocabulary.

### Durable local invariants

- `createApiRoutes` is orchestration-only; dashboard route registrars and their mount order are a tested contract.
- Heavy dashboard views are intentionally lazy-loaded and guarded by `packages/dashboard/app/__tests__/lazy-loaded-views-docs.test.ts`; update the documented inventory and test together when the import surface changes.
- Graph workflow nodes are the sole plan/code/browser review authority. Do not restore deleted pre-graph cutover machinery, in-session duplicate review gates, or legacy fallback execution.
- PostgreSQL lease claims, terminal parks, effect identity, projection commits, and workflow retry attempts fail closed. Repair the shared invariant and prove every known path rather than adding reproduction-specific exceptions.
