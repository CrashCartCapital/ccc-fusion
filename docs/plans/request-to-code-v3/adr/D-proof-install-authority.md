# ADR D: proof commands, installed path, live authority, I2 target and budget, quarantine route

Status: proposed design (read-only investigation). Nothing here is implemented, tested, installed or demonstrated.
Code base read: worktree `/Users/ryanpappal/03_CODE/ccc-fusion/.worktrees/request-to-code-v3`, branch `agent/request-to-code-v3`, HEAD `589c293c7` = `origin/main` `d5fd9e87d` plus the PRD v3 document commit. All `path:line` references below are in that worktree unless marked otherwise. The I0 digest was read against the stale primary checkout; every fact used here was re-checked in the worktree.

## Decisions at a glance

| Q | Decision |
|---|---|
| Q1 | One new closed-result runner (`scripts/run-ccc-planning-proof.mjs`) serves `test:ccc-planning` (file-closed, zero-skip, any host) and `verify:ccc-planning-offline` (name-closed, zero-skip, Darwin only, owns its PostgreSQL and Git scratch). `verify:ccc-planning-live` and `verify:ccc-planning-installed` are separate scripts that drive the installed CLI. `run-ccc-pg-proof.mjs` and `ci-darwin-proof-lane.mjs` stay byte-unchanged. |
| Q2 | Extract the pack-and-install sequence from the Gate 2 helper into a shared module; Gate 2 keeps its behavior. A new planning receipt binds digests and records that the packed install does **not** carry the pi-ai workspace patch. I2 runs the real `fn serve` daemon (not Gate 2's in-process host) under a lane-scoped Pueue group with a scrubbed environment; the CLI talks to it only through the shared PostgreSQL. |
| Q3 | New `ccc-planning.live-authority-receipt.v1`, consumed once at G0. For live execution after import, the receipt carries an explicit `release` field. Recommended for Build (and for I2): `controller_within_receipt`, which reuses the existing issue/claim functions unchanged after an exact envelope check; the default when the field is absent is today's one operator `fn prd approve-execution`. No qualification certificate exists before I6; until then G0 admits only owned disposable targets named by a receipt. No new table. |
| Q4 | Owned disposable repo with no remote, a sealed "text statistics" request whose natural graph is a 4-task diamond. Build Standard fits FULL-v2 only with **zero** Flash extraction leaves under a strict cross-family count (planning N=14, floor 1,440 ≤ 1,536). One leaf makes N=16, floor 1,560: G0 or leaf admission must refuse with "short 24 calls; amend or authorize Large". Implementation and review/proof fit easily. |
| Q5 | Cherry-pick only PR #103's test-only rescue commit `1a8002f6d` (with `-x`) onto our branch, re-prove the six rescued files under owned PostgreSQL with a closed name list, then run the strict ledger check. Do not merge #103 or main; do not delete tests. |

---

## Q1. The four new commands

### Decision

Add four root scripts. None replaces or edits an existing script.

```json
"test:ccc-planning": "node scripts/run-ccc-planning-proof.mjs --mode targeted",
"verify:ccc-planning-offline": "node scripts/run-ccc-planning-proof.mjs --mode offline",
"verify:ccc-planning-live": "node scripts/ccc-planning-live-proof.mjs",
"verify:ccc-planning-installed": "node scripts/ccc-planning-installed-proof.mjs"
```

`pnpm verify:ccc-planning-live --profile full --candidate PATH --approval-receipt PATH` forwards the flags to the script. Every script parser must drop one leading literal `--` (the same defensive rule `scripts/run-script-tests.mjs:15` applies).

Exit codes for all four: `2` usage error, `1` refusal or any failed, missing, skipped or partial proof, `0` only for complete proof of that command's contract.

#### `test:ccc-planning` (targeted, bounded named suites)

- What it runs: an explicit, frozen list of planning test files per package (core, engine, CLI) plus the planning script tests under `scripts/__tests__/` (which no workflow runs today; `run-script-tests.mjs` is wired to no workflow, confirmed by `rg test:scripts .github` returning nothing).
- Closure: file-level. Every listed file must exist, must execute at least one test, must report zero skipped, pending or todo tests and zero failures, and the child must exit 0. Unlisted files cannot run because the runner passes explicit paths.
- Bounded: each command has a timeout taken from measured durations in the inventory; on timeout the runner sends SIGTERM then SIGKILL and counts the command as failed. Test timeouts are never raised (the `check-no-test-timeout-appeasement` guard stays in force).
- PostgreSQL: if any listed command needs it, the runner owns a disposable embedded PostgreSQL through a supervisor child (the same architecture as `scripts/run-ccc-pg-proof.mjs:1307-1371`) and sets `FUSION_PG_TEST_URL_BASE` for the children.
- Platform: platform-neutral by construction. Darwin-only confinement suites are not in the targeted list.
- Where it runs: Darwin local (M5 Max) as the routine pre-commit proof; on Linux it is valid too. The new test files are also discovered by the default package lanes, so after a merge to main they run in the Linux Full Suite shards.

#### `verify:ccc-planning-offline`

- What it runs: an exact name-closed mapping (expected test names per command, frozen arrays) covering planning contracts, real-PostgreSQL publication/reservation/restart, real-Git verifier preparation, the offline end-to-end run with injected fake loopback models, and the Darwin-only confinement suites.
- Closure: the same semantics as `assertClosedNamedResults` and `assertMachineResultJson` in `scripts/run-ccc-pg-proof.mjs:840-867`: no missing, extra, duplicate, skipped, pending, todo or failed name; `numPassedTests` must equal the mapping size. A test that skips itself is therefore a failure, not a pass.
- Owns: a disposable embedded PostgreSQL in a supervisor child; a scratch root (mkdtemp) passed to tests as `CCC_PLANNING_PROOF_SCRATCH` and as `TMPDIR`, so every test Git repository is created under it. Before and after the run it snapshots the repository's own `git status --porcelain` and `git worktree list --porcelain`; any difference fails the run (`CCC_PLANNING_PROOF_FOREIGN_GIT_MUTATION`).
- Refuses before spawning anything: `FUSION_PG_TEST_SKIP=1` (mirrors `run-ccc-pg-proof.mjs:18-19` and `pg-gate-global-setup.ts:100`), a non-Darwin host (`CCC_PLANNING_OFFLINE_PLATFORM_UNSUPPORTED`), and a Darwin host where `inspectCccSemanticProofSandboxReadiness()` (`packages/engine/src/ccc-campaign-proof-sandbox.ts:87`) is not ready (`CCC_PLANNING_OFFLINE_SANDBOX_UNAVAILABLE`). It never produces a partial pass on Linux.
- No external network: enforced where it can be enforced and stated honestly where it cannot. Enforced: every configured model endpoint is an in-process fake on 127.0.0.1 that the runner starts; the controller's provider allowlist refuses any other endpoint; model-originated shell commands run under the planning confinement profile with network denied. Not enforced at the operating-system level for the Vitest processes themselves, because wrapping Vitest in `sandbox-exec` would break the confinement tests that must start `sandbox-exec` themselves (nested sandbox application is refused by macOS). The report states this boundary.
- Provenance: Git head, tree and tracked-dirty state captured before the run with a scrubbed environment (the `FNXC:CccWave7GitProvenance` rule, `run-ccc-pg-proof.mjs:1395-1426`), manifest hashes, Node version, platform, and the SHA-256 of the inventory module.
- Where it runs: Darwin local (M5 Max) is the authoritative pre-merge evidence. The native macOS runner (`ccc-fusion-darwin-proof-v1`, `.github/workflows/full-suite.yml:555-557`) can run it as one added step in the `darwin-proof-lane` job; on our branch that requires dispatching `full-suite.yml` with `--ref agent/request-to-code-v3` (the workflow has `workflow_dispatch`, `full-suite.yml:18`). That `gh workflow run` is an unlisted GitHub outcome under the repo rules, so it is consult-gated. Linux CI never runs it; if it is invoked there it exits 1 with the named Linux-backend gap.

#### `verify:ccc-planning-live --profile full|adaptive|lean --candidate PATH --approval-receipt PATH`

- `--candidate` is a `ccc-planning.installed-runtime.v1` receipt (Q2). The script recomputes every digest and refuses drift.
- `--approval-receipt` is a `ccc-planning.live-authority-receipt.v1` (Q3). The script never creates or confirms one.
- In I2 only `--profile full` is implemented. `adaptive` and `lean` exit 1 with `CCC_PLANNING_PROFILE_NOT_IMPLEMENTED` until I6 adds isolated comparison jobs.
- It drives the installed `fn` binary end to end on the owned disposable target (Q4), with actual pinned models through loopback OmniRoute, and writes `ccc-planning.live-proof-report.v1`.
- Where it runs: Darwin local only (operator workstation with loopback OmniRoute, `sandbox-exec` and the operator's receipt). Never CI: CI holds no receipt and must not reach model routes.

#### `verify:ccc-planning-installed --candidate PATH --approval-receipt PATH`

- PRD contract: neutral-directory dashboard and CLI journeys plus the complete release matrix. That is I5/I6 work.
- In I2 the command exists, runs the CLI journeys that already exist from a neutral empty directory (not the target, not the repo), and then exits 1 listing every NOT RUN item (dashboard journeys, twelve-criterion matrix, held-out results). It must never exit 0 before I6, because the PRD says partial proof fails.
- Where it runs: Darwin local.

### How Darwin-only confinement suites fail on an individually skipped test

`decideDarwinProofLaneOutcome` counts per package, not per test (`scripts/ci-darwin-proof-lane.mjs:106-163`, empty-suite rule at `:123`). It cannot be made zero-skip without breaking existing suites that legitimately skip on Darwin, for example the Linux-refusal test `it.skipIf(process.platform === "darwin")` at `packages/engine/src/__tests__/ccc-campaign-proof-sandbox.test.ts:35`. So:

1. Planning confinement files are **not** added to `DARWIN_PROOF_LANE_SUITES`. They live in the offline name-closed mapping, where any skipped name fails.
2. Planning confinement files may contain exactly one skip form: `skipIf(process.platform !== "darwin")`, so the Linux Full Suite shards report the existing named NOT RUN state (`docs/testing.md:391-396`) instead of going red. The offline runner refuses non-Darwin hosts, so on the only host where the mapping is evaluated that skip cannot fire without failing the run.
3. Tests of "refuse on a non-Darwin host" take the platform as an injected dependency, so they run (and must pass) on Darwin too. No platform-inverse `skipIf(process.platform === "darwin")` is allowed in planning files.
4. A static policy check (in the runner's own script test) scans every inventory file and refuses any other skip form: `.skip(`, `.todo(`, `describe.skip`, any `skipIf`/`runIf` other than the Darwin form in Darwin-tagged files, and `pgDescribe` in files not tagged `needsPostgres`.

### How silent PostgreSQL skips are prevented

Today `pgDescribe` collapses to `describe.skip` when no server answers (`packages/core/src/__test-utils__/pg-test-harness.ts:92,112`), and real-PG engine tests use it (`packages/engine/src/__tests__/ccc-campaign-runtime-bootstrap.real-pg.test.ts:36,122`). Default lanes therefore go green with zero PG coverage. The planning proof closes this three ways: the runner owns the PostgreSQL and sets `FUSION_PG_TEST_URL_BASE` for every child; it refuses `FUSION_PG_TEST_SKIP=1`; and the closed mapping (offline) or zero-skip file rule (targeted) turns any skipped PG test into a failure. Engine suites always pin `--project=engine-default` (or `engine-slow`) so the `engine-core` project's build-on-setup never fires (`ci-darwin-proof-lane.mjs:37-41` explains the trap).

### Existing guards that pin `package.json` scripts

None pins the full script set, so the four new keys are additive. These pins must not be disturbed:

- `packages/cli/src/__tests__/ci-workflow.test.ts:514-532` pins `test:gate` and `test:ccc-prd-safety` composition (substring checks); `:186` pins the PR job set to exactly `build, gate, lint, typecheck`; `:233-235` forbids `test:ci:shard` and `verify:workspace` in PR checks; `:1185-1206` and `:1290-1320` pin the `darwin-proof-lane` job shape (one dist build, no cache, no `needs`).
- `scripts/__tests__/engine-vitest-gate-policy.test.mjs:84-210` pins `test:gate`, `test`, `test:full`, `test:fast`, engine `test:core` and `test:product-route`, the exact two-file core `test:pg-gate` canary list, an unnarrowed core `test` lane and an empty core quarantine list.
- `packages/cli/src/__tests__/package-config.test.ts:470-593` pins `typecheck`, `test`, `test:ci:shard`, `test:full`, `verify:workspace` order, `build`, `build:all`, `build:desktop`, `mobile:build`.
- `scripts/__tests__/build-workspace.test.mjs:311` pins `build`; `scripts/__tests__/verify-fast.test.mjs:127` pins the canonical `pretest` validators; `packages/dashboard/src/__tests__/dashboard-test-config-guard.test.ts:64` pins the dashboard `pretest`.

Rule for cards: do not add planning suites to `test:gate`, `test:ccc-prd-safety`, `pretest` or `test:pg-gate`.

### Signatures (new)

`scripts/lib/ccc-closed-vitest-results.mjs` (pure; re-implements the policy of `run-ccc-pg-proof.mjs:840-1029`, which cannot be imported because that file runs top-level side effects on import, `:1082-1083`):

```ts
export type VitestAssertion = { ancestorTitles?: string[]; title: string; status: "passed" | "failed" | "pending" | "skipped" | "todo" };
export type VitestJsonReport = { numTotalTests: number; numPassedTests: number; numFailedTests: number; numPendingTests: number; numTodoTests: number; testResults: { name: string; assertionResults?: VitestAssertion[] }[] };
export type ClosedSuiteCommand = Readonly<{
  id: string;                                   // /^[a-z0-9-]+$/, unique
  packageFilter: "@fusion/core" | "@fusion/engine" | "@runfusion/fusion" | "node-test";
  project: "engine-default" | "engine-slow" | null;
  config: string | null;                        // e.g. "vitest.pg.config.ts"
  files: readonly string[];                     // package-relative
  closure: "names" | "files";
  expectedNames: readonly string[];             // closure "names": non-empty, unique; closure "files": []
  platform: "any" | "darwin";
  needsPostgres: boolean;
  timeoutMs: number;
}>;
export function assertClosedNamedResults(expectedNames: readonly string[], assertions: readonly VitestAssertion[], label: string): void;
export function assertFileClosedResults(command: ClosedSuiteCommand, report: VitestJsonReport): { files: number; executed: number };
export function assertMachineResultInventory(command: ClosedSuiteCommand): void;
export function assertCccPlanningSuiteSkipPolicy(fileText: string, input: { file: string; platform: "any" | "darwin"; needsPostgres: boolean }): void;
```

`scripts/lib/ccc-planning-proof-inventory/index.mjs` re-exports one frozen array per area module (`contracts.mjs`, `store.mjs`, `confinement.mjs`, `dispatch.mjs`, `controller.mjs`, `import.mjs`, `cli.mjs`, `scripts.mjs`), so each implementation card owns only its own area module:

```ts
export const CCC_PLANNING_TARGETED_COMMANDS: readonly ClosedSuiteCommand[];
export const CCC_PLANNING_OFFLINE_COMMANDS: readonly ClosedSuiteCommand[];
export function cccPlanningInventorySha256(): string;
```

`scripts/run-ccc-planning-proof.mjs`:

```ts
export type CccPlanningProofMode = "targeted" | "offline";
export type CccPlanningProofRefusalCode =
  | "CCC_PLANNING_PROOF_USAGE" | "CCC_PLANNING_PROOF_PG_SKIP_REFUSED"
  | "CCC_PLANNING_OFFLINE_PLATFORM_UNSUPPORTED" | "CCC_PLANNING_OFFLINE_SANDBOX_UNAVAILABLE"
  | "CCC_PLANNING_PROOF_INVENTORY_INVALID" | "CCC_PLANNING_PROOF_RESULTS_NOT_CLOSED"
  | "CCC_PLANNING_PROOF_SUPERVISOR_FAILED" | "CCC_PLANNING_PROOF_FOREIGN_GIT_MUTATION";
export type CccPlanningProofReport = {
  schema: "ccc-planning.proof-report.v1"; mode: CccPlanningProofMode; passed: boolean;
  refusal: null | { code: CccPlanningProofRefusalCode; detail: string };
  gitHead: string | null; gitTree: string | null; workingTreeDirty: boolean | null;
  platform: string; nodeVersion: string; inventorySha256: string;
  manifestHashes: Record<"package.json" | "pnpm-workspace.yaml" | "pnpm-lock.yaml", string | null>;
  perCommand: { id: string; passed: number; expected: number | null; skipped: number; failed: number; files: number; timedOut: boolean }[];
  postgres: { owned: true; database: string; stopError: string | null } | { owned: false };
  scratch: { root: string; cleanup: "removed-on-pass" | "preserved-on-failure" };
};
export function parseCccPlanningProofArgs(argv: readonly string[]): { mode: CccPlanningProofMode } | { usageError: string };
export async function runCccPlanningProof(input: {
  mode: CccPlanningProofMode; repoRoot: string; env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  inspectSandboxReadiness: () => Promise<{ ready: boolean; detail: string }>;
  runSupervised: (commands: readonly ClosedSuiteCommand[], options: { needsPostgres: boolean; scratchRoot: string }) => Promise<{ results: { id: string; code: number; signal: string | null; timedOut: boolean; outputFile: string | null }[]; stopError: string | null }>;
}): Promise<{ exitCode: 0 | 1 | 2; report: CccPlanningProofReport }>;
```

### Files (disjoint card ownership)

- Card P1 (proof runner): `scripts/lib/ccc-closed-vitest-results.mjs` (new), `scripts/lib/ccc-planning-proof-inventory/index.mjs` and `scripts.mjs` (new), `scripts/run-ccc-planning-proof.mjs` (new), `scripts/__tests__/run-ccc-planning-proof.test.mjs` (new), `package.json` (the four keys), and two stub entry files `scripts/ccc-planning-live-proof.mjs` and `scripts/ccc-planning-installed-proof.mjs` that exit 1 `CCC_PLANNING_PROOF_NOT_IMPLEMENTED` until card P4 takes them over.
- Each later implementation card owns one area file under `scripts/lib/ccc-planning-proof-inventory/`.
- Optional, consult-gated card P1b: one step in `.github/workflows/full-suite.yml` `darwin-proof-lane` job (`node scripts/run-ccc-planning-proof.mjs --mode offline`) plus its pin in `packages/cli/src/__tests__/ci-workflow.test.ts`.
- Unchanged: `scripts/run-ccc-pg-proof.mjs`, `scripts/ci-darwin-proof-lane.mjs`, every vitest config.

### Behavioral RED tests (and what makes each non-vacuous)

1. Offline refuses a skipped expected name. Feed a vitest JSON whose one expected name has `status: "skipped"`; expect `CCC_PLANNING_PROOF_RESULTS_NOT_CLOSED`. Non-vacuous: the same fixture with `status: "passed"` must pass in the same test.
2. Offline refuses a non-Darwin host before spawning. Inject `platform: "linux"` and a spy `runSupervised`; expect exit 1, the platform code, and zero spy calls. Non-vacuous: with `platform: "darwin"` and ready readiness, the spy is called once.
3. Offline refuses `FUSION_PG_TEST_SKIP=1` before PostgreSQL starts. Non-vacuous: without the variable the PG start spy is called.
4. Targeted refuses a listed file that executed zero tests, and refuses a listed file with one skipped test. Non-vacuous: a report where every listed file has one passed test passes.
5. Skip policy. `assertCccPlanningSuiteSkipPolicy` refuses a fixture text containing `it.skipIf(process.platform === "darwin")` and `describe.skip(`; accepts `it.skipIf(process.platform !== "darwin")` only for a Darwin-tagged file; refuses it for an `any` file. Then the test runs the policy over every real inventory file. Non-vacuous: the planted fixtures must be refused.
6. Foreign Git mutation. A fake command that adds a worktree to the repo root must produce `CCC_PLANNING_PROOF_FOREIGN_GIT_MUTATION`. Non-vacuous: a fake command that only writes under the scratch root passes.
7. Frozen-wave guard. SHA-256 of `scripts/run-ccc-pg-proof.mjs` equals its value at `d5fd9e87d`. Non-vacuous because any edit changes the hash; the test names the frozen-mapping rule in its failure text.

### Rejected alternatives

- Add `--wave planning` to `run-ccc-pg-proof.mjs`: its wave mappings are frozen and the project pack forbids broadening them (`packs/CLAUDE.md/PK-PROJECT-LOCAL--ccc-fusion.md:40`).
- Refactor `run-ccc-pg-proof.mjs` to share a policy library: edits a frozen, evidence-bearing file for code reuse alone; the duplicated policy is about 100 lines and is covered by its own tests.
- Add planning files to `DARWIN_PROOF_LANE_SUITES`: its package-level rule passes individually skipped tests.
- Change `decideDarwinProofLaneOutcome` to zero-skip: turns the existing lane red on its legitimate platform-inverse tests.
- Add `test:ccc-planning` to `test:gate` or a fifth PR job: breaks the thin-gate pins (`ci-workflow.test.ts:186`) and the merge-gate time budget.
- New dispatch-only workflow file: GitHub only dispatches workflows that exist on the default branch, and we may not merge main, so it could not run on our branch.

### Risks

- The inventory is a second list to maintain; drift is caught only because a missing or extra name fails the closed run.
- The offline network boundary is enforced at the controller, not at the OS, for the Vitest process.
- The macOS runner path depends on a consult-gated `gh workflow run`; until then Darwin evidence is local only.
- `scripts/__tests__` still run in no workflow; the planning script tests run only through `test:ccc-planning`.

---

## Q2. Installed path

### Decision

1. Extract the build, pack, manifest-restore and install sequence from `prepareGate2InstalledRuntime` (`scripts/lib/ccc-gate2-installed-runtime.mjs:221-274`) into `scripts/lib/ccc-installed-cli.mjs` as `packAndInstallFusionCli`. Gate 2's function delegates to it and keeps its exports, receipt schema and behavior; its seven existing tests (`scripts/__tests__/ccc-gate2-installed-runtime.test.mjs:17-336`, including GATE2-09 "failed pack restores the manifest") are the regression guard.
2. Add `scripts/lib/ccc-planning-installed-runtime.mjs` and the entry `scripts/ccc-planning-install-runtime.mjs <empty-root>`. It refuses a tracked-dirty source tree (an exact candidate must be a committed tree), captures source provenance before building, builds with `build:package`, packs, runs `npm install --ignore-scripts` into `<root>/install` with `HOME=<root>/home`, and writes `ccc-planning.installed-runtime.v1`.
3. The packed install does **not** carry the pi-ai workspace patch. Evidence: the patch is applied only through pnpm `patchedDependencies` (root `package.json` `pnpm.patchedDependencies`, file `patches/@earendil-works__pi-ai@0.81.1.patch`); the CLI declares `@earendil-works/pi-ai: 0.81.1` as an ordinary runtime dependency (`packages/cli/package.json` dependencies); tsup bundles only `@fusion/*` (`packages/cli/tsup.config.ts:412,689,731` `noExternal`), so pi-ai stays external; `npm install` fetches the unpatched registry copy and ignores pnpm patches. The patch only changes how `responseModel` is captured from keepalive chunks.
   Consequence: in the installed CLI, any identity check that reads pi-ai's `responseModel` can see a placeholder. That covers the non-OmniRoute branch of the response identity check (`packages/engine/src/pi.ts:690-701`) and the native PRD authoring adapter (`packages/engine/src/ccc-prd/native-authoring-adapter.ts:363`). The OmniRoute terminal-route receipt path (`pi.ts:677-689`, selected when the binding's `receiptAdapterId` is `terminal-route-sse-comments.v1`, `pi.ts:4186-4196`) reads identity from OmniRoute's own route comments and is unaffected.
   Rule for I2: every live model call (planning roles, writers, reviews, judge) must carry `receiptAdapterId: "terminal-route-sse-comments.v1"`; the controller refuses a live call without it. The receipt records the installed `openai-completions.js` digest and `workspacePatch: "not_carried"`; the proof report must not claim the patch.
4. The serve lane. The I2 harness starts an owned PostgreSQL cluster (the Darwin-lane recipe, `full-suite.yml` "Start a disposable PostgreSQL": `initdb` under the scratch root, TCP-only, kernel-chosen port, refuse 5432), registers the target with `fn project add`, then launches the installed `fn serve` under a dedicated Pueue group:

   ```text
   pueue group add ccc-planning-<tag>          (if absent; the default group is paused)
   pueue parallel 1 --group ccc-planning-<tag>
   pueue add --group ccc-planning-<tag> --label ccc-planning-serve-<tag> --working-directory <root>/target -- \
     sh -c 'cd <root>/target && exec /usr/bin/env -i PATH=<sanitized> HOME=<root>/home \
       FUSION_HOME=<root>/home/.fusion DATABASE_URL=postgresql://postgres@127.0.0.1:<pgport>/fusion \
       NO_COLOR=1 LANG=en_US.UTF-8 TMPDIR=<root>/tmp \
       <root>/install/node_modules/.bin/fn serve --port 0 --host 127.0.0.1 --no-auto-register --project <projectId>'
   ```

   Why each part: `env -i` stops credential inheritance (PRD §8) and removes `PORT`, which `serve` would otherwise substitute for `--port 0` (`packages/cli/src/commands/serve.ts:255-259`); `--no-auto-register` plus the target working directory prevents the cwd auto-registration that let self-healing sweep `.worktrees/` (`serve.ts:401-406`); the bind host defaults to 127.0.0.1 (`serve.ts:273`) and is stated explicitly for the evidence. Liveness: the Pueue log must contain exactly one `[serve] HTTP layer bound to project <name> (<projectId>)` line (`serve.ts:583`), zero `Auto-registered` lines (`ensure-project-registered.ts:82`), and the bound port must not be 4040; the listener must belong to the Pueue task's process (checked with `lsof -a -p <pid>`), and no other listener is touched. Teardown: `pueue kill` for that task id only, confirm no descendant of its process group remains, then stop PostgreSQL with `pg_ctl -D <root>/pg -m fast stop`.
   The isolated `settings.json` sets `openrouterModelSync: false` and `opencodeGoModelSync: false` (`packages/cli/src/commands/startup-model-sync.ts:324,333`) and defines the three exact-pin custom providers on the loopback OmniRoute URL with no API key.
5. How the CLI talks to serve: only through the shared PostgreSQL named by `DATABASE_URL`. `fn plan start` performs the G0 checks and the admission transaction; `fn plan status` reads the projection; `pause`, `cancel`, `resume` write durable fenced requests. The serve process is the only executor. This is how `fn prd` already works: `approve-execution` claims the authorization and moves the work item from `manual-required` to `runnable` in PostgreSQL (`packages/cli/src/commands/prd.ts:2625-2656`), and the serve-hosted runtime then passes its gate (`packages/engine/src/runtimes/in-process-runtime.ts:2102-2108`). The CLI never hosts the planning driver, so there is no second execution authority and no HTTP dependency (the dashboard in I5 reads the same projection).

### Rejected alternatives

- Reuse Gate 2's in-process controller and runtime host (`runGate2InstalledPrdController`, `loadGate2InstalledRuntimeModule`, `ccc-gate2-installed-runtime.mjs:70-166`): Gate 2 itself records `fullInstalledRuntime: "not_claimed_daemon_process"` (`:202`), so it would not prove an installed-CLI run.
- Run the planning driver inside the `fn plan start` process: creates a second executor beside `fn serve`.
- Bundle pi-ai into the CLI (`noExternal`) so the patch ships: changes how a core dependency is packaged, close to an incidental Pi change, for a defect the receipt adapter already covers.
- Apply the patch at install time with a postinstall script: `--ignore-scripts` is required for a safe install.
- Embedded PostgreSQL under the isolated HOME: supported (attach through `postmaster.pid`, `packages/core/src/postgres/embedded-lifecycle.ts:1039-1100,1210`) but ties database lifetime to serve restarts, which the recovery proofs in I4 need to control independently.
- Reuse `runGate2InstalledPrdCommand` for planning: it inherits the whole parent environment (`ccc-gate2-installed-runtime.mjs:28-34`), so credentials would leak into the child.

### Signatures (new)

```ts
// scripts/lib/ccc-installed-cli.mjs
export async function packAndInstallFusionCli(input: { root: string; cliRoot: string; env: Readonly<Record<string, string>> }):
  Promise<{ tarballPath: string; installedRoot: string; executablePath: string; home: string }>;
export const CCC_INSTALLED_FN_ENV_ALLOWLIST: readonly ["PATH", "LANG", "LC_ALL", "TZ"];
export async function runInstalledFnJsonCommand(input: {
  executablePath: string; args: readonly string[]; cwd: string; home: string;
  extraEnv: Readonly<{ DATABASE_URL?: string; FUSION_HOME?: string; TMPDIR?: string }>;
  timeoutMs: number;
}): Promise<{ exitCode: number; values: unknown[]; stderr: string }>; // refuses non-JSON stdout lines

// scripts/lib/ccc-planning-installed-runtime.mjs
export type CccPlanningInstalledRuntimeReceiptV1 = {
  schema: "ccc-planning.installed-runtime.v1";
  source: { gitHead: string; gitTree: string; workingTreeDirty: false; capturedBeforeBuild: true };
  toolchain: { node: string; npm: string; pnpm: string };
  tarballPath: string; tarballSha256: string;
  installedRoot: string; packageName: "@runfusion/fusion"; packageVersion: string;
  executablePath: string; executableSha256: string;
  distManifestSha256: string;          // SHA-256 over sorted [relativePath, sha256] of installed dist/**/*.js
  versionOutput: string; versionOutputSha256: string;
  planCommand: { helpExitCode: 0; usageExitCode: 2 };
  piAi: { version: "0.81.1"; openaiCompletionsSha256: string; workspacePatch: "carried" | "not_carried" };
  runtimeBoundary: { fullInstalledRuntime: "daemon_process"; sourceInProcessScheduler: "not_used" };
};
export async function prepareCccPlanningInstalledRuntime(input: { root: string; cliRoot: string; repoRoot: string }): Promise<CccPlanningInstalledRuntimeReceiptV1>;
export async function verifyCccPlanningInstalledRuntimeReceipt(receiptPath: string): Promise<CccPlanningInstalledRuntimeReceiptV1>; // recomputes every digest

// scripts/lib/ccc-planning-serve-lane.mjs
export function buildCccPlanningServeLaunch(input: { executablePath: string; targetDir: string; home: string; databaseUrl: string; projectId: string; pathEnv: string; tmpDir: string; group: string; label: string }): { argv: readonly string[]; cwd: string };
export function parseCccPlanningServeLog(log: string, projectId: string):
  | { ok: true; port: number }
  | { ok: false; code: "CCC_PLANNING_SERVE_NOT_BOUND" | "CCC_PLANNING_SERVE_AUTO_REGISTERED" | "CCC_PLANNING_SERVE_MULTIPLE_BINDINGS" | "CCC_PLANNING_SERVE_PORT_FORBIDDEN" };
export async function startOwnedPostgres(input: { dataDir: string; pgBin: string; logPath: string }): Promise<{ port: number; databaseUrl: string; stop(): Promise<void> }>;
export async function startCccPlanningServeLane(input: Parameters<typeof buildCccPlanningServeLaunch>[0]): Promise<{ pueueTaskId: number; port: number; pid: number }>;
export async function stopCccPlanningServeLane(lane: { pueueTaskId: number; pid: number }): Promise<{ stopped: true; descendantsRemaining: 0 }>;
```

### Files

- Card P2 (installed runtime): `scripts/lib/ccc-installed-cli.mjs` (new), `scripts/lib/ccc-gate2-installed-runtime.mjs` (delegate only), `scripts/lib/ccc-planning-installed-runtime.mjs` (new), `scripts/ccc-planning-install-runtime.mjs` (new), `scripts/__tests__/ccc-planning-installed-runtime.test.mjs` (new).
- Card P3 (serve lane): `scripts/lib/ccc-planning-serve-lane.mjs` (new), `scripts/__tests__/ccc-planning-serve-lane.test.mjs` (new).
- Card P4 (live and installed proofs, after P1): `scripts/ccc-planning-live-proof.mjs`, `scripts/ccc-planning-installed-proof.mjs`, `scripts/lib/ccc-planning-disposable-target.mjs` (new), `scripts/__tests__/ccc-planning-live-proof.test.mjs` (new).

### Behavioral RED tests

1. Patch status is measured, not assumed. A fake installed tree whose `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js` lacks the patch's `identitySubstantive` marker yields `workspacePatch: "not_carried"`; a fixture containing it yields `"carried"`. Non-vacuous: both branches asserted.
2. No credential or `PORT` inheritance. The parent seeds canaries (`OMNIROUTE_API_KEY=canary-1`, `ANTHROPIC_API_KEY=canary-2`, `GH_TOKEN=canary-3`, `PORT=4040`); a fake `fn` (a Node script) prints its environment as JSON; assert none of the canaries appear and `HOME` is the isolated home. Non-vacuous because the canaries are present in the parent.
3. Serve launch shape. `buildCccPlanningServeLaunch` output contains `env -i`, `--port 0`, `--no-auto-register`, `--host 127.0.0.1`, the target as working directory, and no `PORT=`. A real-spawn variant with a fake `fn` records argv, cwd and environment. Non-vacuous: a deliberately broken builder (dropping `env -i`) fails the canary assertion.
4. Liveness parser. Fixture logs with zero bound lines, two bound lines, one `Auto-registered` line, and a 4040 binding each return their named code; a clean log returns the port.
5. Candidate drift. Flip one byte in the installed `fn` after receipt capture; `verifyCccPlanningInstalledRuntimeReceipt` refuses with the mismatched field named. Non-vacuous: the untouched install verifies.
6. Dirty source refused. A tracked modification in the source tree makes `prepareCccPlanningInstalledRuntime` refuse before building (build spy not called).
7. Gate 2 regression: the seven existing Gate 2 tests stay green after the extraction.

### Risks

- `build:package` and `npm install` need registry network access and run build tooling; the project pack forbids dependency installation and rebuilds without current campaign authority (`packs/CLAUDE.md/PK-PROJECT-LOCAL--ccc-fusion.md:31`). The operator must permit this step.
- `fn serve` may attempt other startup egress (update checks, integrations). Model sync is disabled; anything else is observed, not prevented.
- `pueue add` stores the client environment; `env -i` inside the command is what actually scrubs it.
- The serve-hosted planning controller is designed in another ADR. This harness assumes only that `fn serve` hosts execution and that the CLI writes and reads PostgreSQL.

---

## Q3. Live authority, the receipt, and qualification

### Facts that shape the decision

- No gate covers model calls before import. After import, every coding node passes `requireCccCampaignLiveExecutionApproval` (`packages/engine/src/workflow-task-runtime.ts:711-723`, wired at `in-process-runtime.ts:2102-2108`, defined at `packages/engine/src/ccc-campaign-product-control.ts:930-1010`). It issues or replays the sealed authorization and throws `CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED` until the exact child lease exists.
- The sealed authorization identity is derived from the imported campaign: import, campaign, bundle, manifest, workflow IR, execution-policy hashes, target, base, deadline, `maxRequests`, `maxConcurrency` and every member's provider, model, prompt and route hash (`packages/core/src/ccc-campaign/execution-authorization.ts:56-76,220-283`). It cannot exist at G0.
- The live-execution action is the packet's protected action of kind `live_execution` with `operatorDecision: "approve_live_execution"` (`execution-authorization.ts:291-295`; `packages/core/src/ccc-prd/types.ts:396-425` makes `requiresOperatorDecision: true` and requires source spans). The compiler refuses one action shared by several tasks (`packages/engine/src/ccc-prd/compiler.ts:1194-1212`).
- Claiming is `approveCccCampaignLiveExecution` (`ccc-campaign-product-control.ts:792-925`): exact confirmation digest, then `claimCccCampaignExecutionAuthorization` (`execution-authorization.ts:794-876`) creates every child lease in one transaction. The claimant actor type is not restricted (`packages/core/src/types/agents.ts:307-311`: `agent | user | system`). The digest is computable by any caller (`computeCccCampaignLiveExecutionApprovalConfirmation` is exported, `ccc-campaign-product-control.ts:698-756`). So "a human approved" is today a procedural fact about which surface called the function, not a cryptographic one. The same is true of any receipt file.

### Decision: `ccc-planning.live-authority-receipt.v1`

```ts
// packages/core/src/ccc-planning/authority.ts
export const CCC_PLANNING_LIVE_AUTHORITY_RECEIPT_SCHEMA = "ccc-planning.live-authority-receipt.v1" as const;
export type CccPlanningExactModelId = "glm/glm-5.3" | "glm/glm-5.3-flash" | "minimax/MiniMax-M3";
export type CccPlanningLiveExecutionRelease = "operator_confirm_after_import" | "controller_within_receipt";

export type CccPlanningLiveAuthorityReceiptV1 = Readonly<{
  schema: typeof CCC_PLANNING_LIVE_AUTHORITY_RECEIPT_SCHEMA;
  receiptId: string;                               // /^[a-z0-9][a-z0-9-]{7,63}$/
  issuedAt: string; notBefore: string; expiresAt: string;   // canonical UTC ISO-8601; expiresAt ≤ issuedAt + 7 days and ≥ deadlineAt
  operator: Readonly<{ actorId: string; actorName: string }>;
  project: Readonly<{ projectId: string }>;          // the project created for this target before issuance
  target: Readonly<{
    class: "owned_disposable";                     // the only value accepted before qualification
    scratchRoot: string;                           // realpath; the repository is a direct child
    repositoryRealpath: string;
    baseCommit: string; baseTree: string;          // 40- or 64-hex object ids
    ownershipMarker: Readonly<{ path: string; sha256: string }>;  // <scratchRoot>/owner.json, outside the repository
    remotes: readonly [];                          // literally empty
    admittedFusionPaths: readonly string[];        // e.g. ["proof/**", "Taskfile.yml"]: verifier-baseline paths outside the request's scope
  }>;
  request: Readonly<{ sha256: string; byteLength: number }>;
  mode: "spec" | "build";
  profile: "full-v2";
  budgetProfile: "standard" | "large";
  budgetPolicyVersion: string;                     // the versioned policy whose allocations G0 recomputes
  largeAuthorized: boolean;
  phaseCallCaps: Readonly<{ planning: number; implementation: number; reviewProof: number }>; // must equal the policy allocation
  deadlineAt: string;
  models: Readonly<{ glm53: "glm/glm-5.3"; glm53Flash: "glm/glm-5.3-flash"; minimaxM3: "minimax/MiniMax-M3" }>;
  omniRoute: Readonly<{
    baseUrl: string;                               // must pass validateCccLoopbackHttpUrl (packages/engine/src/ccc-loopback-policy.ts:10)
    receiptAdapterId: "terminal-route-sse-comments.v1";
    providerIds: Readonly<{ glm53: string; glm53Flash: string; minimaxM3: string }>;
  }>;
  quota: Readonly<{ accounting: "subscription_unknown"; meteredFallback: "forbidden" }>;
  escalation: "forbidden";                         // I2 uses no higher ladder
  permittedProtectedActions: readonly Readonly<{ kind: "live_execution"; release: CccPlanningLiveExecutionRelease }>[]; // at most one entry
  sourceToolPolicy: Readonly<{ policyId: string; sha256: string }>;
  runtime: Readonly<{ installedRuntimeReceiptSha256: string; packageVersion: string; distManifestSha256: string }>;
  operatorConfirmation: string;                    // SHA-256 of the canonical receipt without this field
}>;

export type CccPlanningAuthorityRefusalCode =
  | "CCC_PLANNING_AUTHORITY_RECEIPT_REQUIRED" | "CCC_PLANNING_AUTHORITY_RECEIPT_INVALID"
  | "CCC_PLANNING_AUTHORITY_RECEIPT_UNCONFIRMED" | "CCC_PLANNING_AUTHORITY_RECEIPT_EXPIRED"
  | "CCC_PLANNING_AUTHORITY_RECEIPT_CONSUMED" | "CCC_PLANNING_REJECTED_MODEL_IDENTITY"
  | "CCC_PLANNING_ENDPOINT_NOT_LOOPBACK" | "CCC_PLANNING_BUDGET_POLICY_MISMATCH"
  | "CCC_PLANNING_RUNTIME_NOT_PERMITTED" | "CCC_PLANNING_TARGET_NOT_DISPOSABLE"
  | "CCC_PLANNING_QUALIFICATION_REQUIRED";

export function computeCccPlanningAuthorityReceiptDigest(receipt: Omit<CccPlanningLiveAuthorityReceiptV1, "operatorConfirmation">): string; // canonicalCccPrdJson + SHA-256
export function parseCccPlanningLiveAuthorityReceipt(bytes: Uint8Array, input: { confirmDigest: string; now: string; budgetPolicy: CccPlanningBudgetPolicy }):
  | { ok: true; receipt: CccPlanningLiveAuthorityReceiptV1; receiptSha256: string }
  | { ok: false; code: CccPlanningAuthorityRefusalCode; field: string; detail: string };
```

Rules:

- Exact keys, canonical JSON, no extra fields. Any model id other than the three exact pins is refused, including `glm/glm-5.2`, bare `glm-5.2`, `combo/*` and `*-latest` floating aliases.
- `phaseCallCaps` must equal the versioned allocation for `budgetProfile`; a different size is an amendment, not a receipt.
- `runtime` binds the permitted runtime version (G0): the serve-hosted controller hashes its own installed `dist` files and must match `distManifestSha256`.
- `--confirm-authority <sha256>` on `fn plan start` must equal `operatorConfirmation`, and both must equal the recomputed digest.
- Consumed once. The admission transaction records the receipt SHA-256 and canonical bytes with the run. Preferred storage: a column on the planning-run admission record owned by the storage ADR, with this constraint inside that ADR's migration:

  ```sql
  ALTER TABLE project.<planning admission table>
    ADD COLUMN authority_receipt_sha256 text NOT NULL,
    ADD COLUMN authority_receipt_json text NOT NULL,
    ADD CONSTRAINT <t>_authority_receipt_sha256_check CHECK (authority_receipt_sha256 ~ '^[a-f0-9]{64}$'),
    ADD CONSTRAINT <t>_authority_receipt_unique UNIQUE (project_id, authority_receipt_sha256);
  ```

  If the storage ADR keeps runs inside existing native task and artifact rows instead of a run table, reuse `project.ccc_effect_receipts` (`packages/core/src/postgres/migrations/0034_ccc_effect_receipts.sql`, primary key `(project_id, effect_scope_id, logical_key)`) with `effect_scope_id = 'ccc-planning-authority-receipt'`, `logical_key = <receipt sha256>`, `arguments_digest = sha256(runId)`, driven through the existing reserve/commit functions (`packages/core/src/ccc-effect-receipts.ts:354-375`). Either way no new table. Because the receipt binds `projectId`, per-project uniqueness is global uniqueness for that receipt.
- The receipt bytes are copied into PostgreSQL at admission. Later edits to the file have no effect. Every phase reservation re-checks `expiresAt` and `deadlineAt` against the database clock.
- The import bridge (another ADR) adds the canonical receipt as an authoritative manifest source with role `operator-authority`, and each task's `live_execution` action takes its spans from the receipt's `permittedProtectedActions` bytes. The protected action is then traced to the operator's words, never to the user's request or to model output (PRD §3, "never attribute generated decisions to the user's words").

### Binding to the existing gate after import: (a) versus (b)

(a) The G0 receipt pre-authorizes live execution for the campaign this run imports. After the G6 import commits, the controller calls the existing `issueCccCampaignLiveExecutionApproval` (`ccc-campaign-product-control.ts:648-695`), checks the issued authorization against the receipt envelope, and if every field fits, calls the existing `approveCccCampaignLiveExecution` with the computed confirmation and actor `{ actorId: "ccc-planning-controller", actorType: "system", actorName: "CCC planning receipt <first 12 hex>" }`, then performs the same guarded `manual-required → runnable` transition the CLI performs (`prd.ts:2641-2655`). The runtime gate, the claim function, the leases and `execution-authorization.ts` are unchanged.

(b) After import the run waits in a distinct state `AWAITING_EXECUTION_AUTHORITY`; `fn plan status --json` shows the existing confirmation payload and the exact command `fn prd approve-execution <key> <authorization-id> --confirm <digest>`; the operator runs it once.

Comparison:

- Exactness. (b) binds the human to the exact compiled member set. (a) binds the human to the exact target, base, models, endpoint, caps, deadline, expiry and allowed action, and binds the compiled member set to that envelope by code. The member set's content (task prompts, routes) is what PRD §10 removes from human review ("without ritual plan approval") and assigns to G1–G6 and fresh reviews.
- Risk added by (a): one new code path that claims a protected action. It is bounded: single-use receipt, only for a campaign whose idempotency key is `ccc-plan:<runId>:<finalDigest>` for the run that consumed the receipt, owned disposable targets only before qualification, worst case spend inside caps the operator already granted, a distinct `system` actor in the audit, and automatic fallback to (b) on any mismatch.
- Consistency with the PRD. G0 includes "scope/action authority" and G6 includes "policy/budget/authority binding"; §10 says Build proceeds without ritual plan approval while protected actions keep exact authority. Under (b), every Build stops for a human after the plan is compiled, which is plan approval in practice. Under (a), live execution inside the granted scope is the exact authority the operator gave at G0, and every action the receipt does not list (merge, publication, upstream write, deletion, credential, billing, promotion) keeps today's exact operator approval.

Recommendation: implement both, selected only by the receipt's `release` field, defaulting to (b) when the field is absent. Recommend that the operator issue the I2 receipt with `controller_within_receipt`: it is the option that is safe enough and consistent with the PRD; (b) is safer in isolation but contradicts §10 for Build and would leave I2 unable to show "Build proceeds without ritual plan approval". Because (a) lets code release a protected action, it is an authority change: it happens only when Ryan's own receipt says so. No agent may author or confirm `operatorConfirmation`; the leader shows Ryan the draft and its digest, and only a digest Ryan states in his own message may be passed to `--confirm-authority`.

Merge and landing in I2: not permitted by the receipt. G8 judges the integrated candidate commit; landing on the target's `main` is either not run or done with today's exact `fn prd approve-merge`. G9 delivery is NOT RUN because the target has no remote.

Envelope check (pure, core):

```ts
export function assertCccPlanningExecutionAuthorizationWithinReceipt(input: {
  receipt: CccPlanningLiveAuthorityReceiptV1; receiptSha256: string;
  run: { runId: string; finalBundleSha256: string; deadlineAt: string; implementationCallsRemaining: number; compiledProviderTaskCount: number; writerProviderId: string };
  authorization: CccCampaignExecutionAuthorization;   // execution-authorization.ts:87-104
  baseline: { commit: string; firstParent: string; changedPaths: readonly string[] };
  now: string;
}): { ok: true } | { ok: false; code: "CCC_PLANNING_RECEIPT_ENVELOPE_MISMATCH"; field: string; detail: string };
```

It requires: `targetRepository === receipt.target.repositoryRealpath`; `targetBase === baseline.commit`, whose first parent is `receipt.target.baseCommit` and whose changed paths all match `admittedFusionPaths`; `idempotencyKey === "ccc-plan:" + runId + ":" + finalBundleSha256`; `members.length === compiledProviderTaskCount`; every member has `modelId === "glm/glm-5.3-flash"`, `providerId === writerProviderId === receipt.omniRoute.providerIds.glm53Flash`, `transport === "pi"`; `maxRequests ≤ implementationCallsRemaining`; `campaignDeadlineAt ≤ min(receipt.deadlineAt, run.deadlineAt)`; `expiresAt ≤ receipt.expiresAt`; `now < receipt.expiresAt`; and the receipt lists `{ kind: "live_execution", release: "controller_within_receipt" }`.

Engine bridge:

```ts
// packages/engine/src/ccc-planning/live-execution-release.ts
export type CccPlanningLiveExecutionReleaseResult =
  | { kind: "released"; authorizationId: string; authorizationDigest: string }
  | { kind: "awaiting_operator"; authorizationId: string; confirmation: string;
      reason: "receipt_requires_operator" | "envelope_mismatch"; mismatch?: { field: string; detail: string } };
export async function releaseCccPlanningLiveExecution(input: {
  store: TaskStore; rootDir: string; entryTaskId: string;
  receipt: CccPlanningLiveAuthorityReceiptV1; receiptSha256: string;
  run: Parameters<typeof assertCccPlanningExecutionAuthorizationWithinReceipt>[0]["run"];
  observeBaseline: (commit: string) => Promise<{ commit: string; firstParent: string; changedPaths: readonly string[] }>;
  deps?: { issue?: typeof issueCccCampaignLiveExecutionApproval; approve?: typeof approveCccCampaignLiveExecution; compute?: typeof computeCccCampaignLiveExecutionApprovalConfirmation };
}): Promise<CccPlanningLiveExecutionReleaseResult>;
```

It records one run audit event `ccc-planning:live-execution-released` (bounded fields: receipt SHA-256, authorization id and digest, member count) through the existing run-audit path.

### PostgreSQL qualification certificate (§7), minimal shape

```ts
// packages/core/src/ccc-planning/qualification.ts
export type CccPlanningQualificationDigestsV1 = Readonly<{
  controller: string;        // installed distManifestSha256
  policy: string;            // canonical SHA-256 of the versioned planning policy (roles, counters, budgets, ladder)
  prompts: string;           // SHA-256 over sorted (role, promptVersion, promptSha256)
  toolchain: string;         // semantic-proof toolchain identity (node, task, git, python paths and versions)
  runner: string;            // confinement profile set (SBPL digests) plus OS identity class
  corpus: string;            // sealed held-out case set
  proof: string;             // the zero-skip qualification proof report
  models: string;            // exact pinned route identities
}>;
export type CccPlanningQualificationCertificateV1 = Readonly<{
  schema: "ccc-planning.qualification-certificate.v1";
  certificateId: string;     // SHA-256 of the canonical body
  issuedAt: string;
  scope: Readonly<{ targetClasses: readonly ("owned_disposable" | "admitted_repository")[]; modes: readonly ("spec" | "build")[]; profiles: readonly ["full-v2"] }>;
  digests: CccPlanningQualificationDigestsV1;
  evidence: Readonly<{ reportSha256: string; heldOutResultsSha256: string; reviewDispositionsSha256: string }>;
}>;
export interface CccPlanningQualificationPort {
  findCertificate(current: CccPlanningQualificationDigestsV1): Promise<CccPlanningQualificationCertificateV1 | null>; // exact tuple match; any drift returns null
}
export const UNQUALIFIED_CCC_PLANNING_QUALIFICATION_PORT: CccPlanningQualificationPort; // always null until I6
export function decideCccPlanningTargetAdmission(input: {
  certificate: CccPlanningQualificationCertificateV1 | null;
  receipt: CccPlanningLiveAuthorityReceiptV1 | null;
  mode: "spec" | "build";
}): { admitted: true; basis: "qualification_certificate" | "owned_disposable_receipt" }
  | { admitted: false; code: "CCC_PLANNING_QUALIFICATION_REQUIRED" | "CCC_PLANNING_AUTHORITY_RECEIPT_REQUIRED" };
```

Storage is decided in I6 (an insert-only record, superseded by a later record, never updated). I1 to I5 ship only the port that returns null, so no table is added before there is a certificate to store.

Pre-qualification rule (enforced at G0 and re-checked on resume, for both Spec and Build): with no applicable certificate, admit only `target.class === "owned_disposable"` under a valid unconsumed receipt, and prove ownership:

```ts
// packages/engine/src/ccc-planning/disposable-target.ts
export async function assertCccPlanningOwnedDisposableTarget(input: {
  receipt: CccPlanningLiveAuthorityReceiptV1; registeredProjectPath: string;
  git: (args: readonly string[], cwd: string) => Promise<{ code: number; stdout: string }>;   // the existing supervised git runner, never execSync
  readFile: (path: string) => Promise<Uint8Array>; realpath: (path: string) => Promise<string>;
}): Promise<{ ok: true } | { ok: false; code: "CCC_PLANNING_TARGET_NOT_DISPOSABLE"; check: string }>;
```

Checks: realpath equals the receipt path and the registered project path; the parent directory equals `scratchRoot`; `owner.json` exists there with the receipt's SHA-256 and names the repository; `git remote` prints nothing and `git config --get-regexp '^remote\.'` finds nothing; `HEAD` and its tree equal the receipt; the working tree is clean; `git rev-parse --show-toplevel` from the scratch root fails (the repository is not nested inside another repository).

### Files

- Card A1 (pure contracts): `packages/core/src/ccc-planning/authority.ts`, `packages/core/src/ccc-planning/qualification.ts`, `packages/core/src/__tests__/ccc-planning-authority.test.ts`, `packages/core/src/__tests__/ccc-planning-qualification.test.ts` (all new). Kept out of `types.ts`, `schemas.ts` and `policy.ts`, which the contracts ADR owns.
- Card A2 (consumption, real PostgreSQL): `packages/core/src/task-store/ccc-planning-authority-ops.ts`, `packages/core/src/__tests__/postgres/ccc-planning-authority.pg.test.ts` (new). The SQL constraint lives in the storage ADR's migration.
- Card A3 (release bridge): `packages/engine/src/ccc-planning/live-execution-release.ts`, `packages/engine/src/__tests__/ccc-planning-live-execution-release.real-pg.test.ts` (new).
- Card A4 (disposable target): `packages/engine/src/ccc-planning/disposable-target.ts`, `packages/engine/src/__tests__/ccc-planning-disposable-target.real-git.test.ts` (new).
- Unchanged: `ccc-campaign-product-control.ts`, `execution-authorization.ts`, `in-process-runtime.ts`, `workflow-task-runtime.ts`, `prd.ts`.
- `fn plan start --authority-receipt PATH --confirm-authority SHA256` is specified here and implemented by the CLI card that owns `packages/cli/src/commands/plan.ts`.

### Behavioral RED tests

1. Receipt field table. One valid receipt passes; then one test case per field changes exactly that field (path, base, tree, marker digest, non-empty remotes, `glm/glm-5.2`, `combo/glm-latest`, non-loopback base URL, past `expiresAt`, wrong confirmation, caps ≠ policy, unknown extra key, wrong runtime digest) and must return its named code and field. Non-vacuous: the positive control passes and each case differs by one field.
2. Single use under concurrency (real PostgreSQL, offline closed mapping). Two transactions consume the same receipt for two run ids; exactly one succeeds, the other gets `CCC_PLANNING_AUTHORITY_RECEIPT_CONSUMED`; the same run id replays idempotently.
3. Disposable target (real Git). A target with `git remote add origin <path>`, one without `owner.json`, one nested inside another repository, and one with a dirty tree are each refused with the named check; a clean owned target passes.
4. Release with an exact envelope (real PostgreSQL plus the existing import fixture). Before release, `requireCccCampaignLiveExecutionApproval` throws `CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED`; after `releaseCccPlanningLiveExecution`, the authorization is `claimed`, every child lease exists, and the same gate returns. Non-vacuous: the gate result flips across the call.
5. Envelope mismatch never widens. Mutate one field at a time (a member on `glm/glm-5.3`, `maxRequests` above the remaining allocation, a deadline after the receipt's, a baseline whose first parent is not the receipt base, a baseline that changes `src/index.mjs`, another run's idempotency key); each returns `awaiting_operator` with the field, the authorization stays `issued`, and the gate still throws.
6. Default is operator. A receipt with `release: "operator_confirm_after_import"` leaves the authorization `issued` and the status payload carries the existing confirmation; the existing `approveCccCampaignLiveExecution` then claims it.
7. Race order. Run the release both before and after the runtime has moved the work item to `manual-required`; both end `runnable` with exactly one claim.
8. Audit actor. The automatic path records actor type `system` with the receipt digest; the operator path records `user`.
9. Expiry at dispatch. A planning reservation after `expiresAt` (row inserted with a past expiry) is refused by the database-clock check.
10. Pre-qualification. With the null qualification port, a receipt whose `target.class` is anything else, or no receipt, is refused (`CCC_PLANNING_QUALIFICATION_REQUIRED`, `CCC_PLANNING_AUTHORITY_RECEIPT_REQUIRED`); a stub port returning a certificate whose digests differ in one field also returns null and is refused.

### Rejected alternatives

- Pre-issue the sealed authorization at G0: its identity depends on post-import hashes.
- A new authority or approvals table: the existing sealed authorization, approval requests, leases and effect receipts already model exact, idempotent, single-use authority.
- Granting live execution through a global setting: not exact, not single-use, not expiring.
- Teaching `requireCccCampaignLiveExecutionApproval` to read receipts: widens a hardened runtime gate used by every campaign.
- A qualification-certificate table in I1: nothing would write it until I6.

### Risks

- (a) is only as good as the envelope check; the field-by-field RED table is the main defense.
- Receipt provenance is procedural on a single-user machine; the digest proves integrity, not who typed it. The same is true of today's operator confirmation.
- If the storage ADR's admission record does not exist when A2 starts, A2 must use the effect-receipt fallback and say so.

---

## Q4. I2 target, sealed request and budget fit

### Target

Owned scratch root `<scratch>/ccc-planning-i2-<tag>/` (short path; PostgreSQL TCP-only so the 103-byte socket limit never applies):

- `owner.json`: `{ "schema": "ccc-planning.disposable-target-owner.v1", "repositoryRealpath": ..., "nonce": <32 random hex>, "createdAt": ... }` (its SHA-256 goes into the receipt).
- `target/`: `git init -b main`; local `user.name`/`user.email`; no remote. Baseline commit contains only `package.json` (`{"name":"text-stats","version":"0.0.0","private":true,"type":"module","engines":{"node":">=20"},"scripts":{"test":"node --test"}}`), `README.md`, `.gitignore` (`node_modules/`), and `Taskfile.yml` with one `test` task (`node --test`). No dependencies.
- `home/` (isolated HOME and `.fusion/settings.json`), `install/`, `pg/`, `tmp/`, `request/request.md`, `authority/receipt.json`, `evidence/`. Fusion's task worktrees land in the sibling `target-worktrees/`, still inside the scratch root.

Sealed request (`request/request.md`, plain language, its SHA-256 goes into the receipt):

> Add a small text statistics library and command-line tool to this repository.
>
> 1. A shared tokenizer. `tokenize(text, options)` in `src/tokenize.mjs` returns the words of the text in order. A word is a run of Unicode letters or digits; an apostrophe between two letters stays inside the word, so "don't" is one word. Words are lower-cased unless `options.caseSensitive` is true. `options.minLength` (default 1) drops shorter words.
> 2. `wordFrequency(text, options)` in `src/word-frequency.mjs` returns a `Map` from each word to how many times it appears, using the tokenizer and the same options.
> 3. `readingTime(text, options)` in `src/reading-time.mjs` returns the whole number of minutes needed to read the text at `options.wordsPerMinute` (default 200), rounded up. Text with no words takes 0 minutes.
> 4. `bin/text-stats.mjs` takes one file path, reads the file, and prints one JSON object: `{"words": <word count>, "readingMinutes": <minutes>, "top": [[word, count], ...]}` with the five most frequent words, ties broken alphabetically. With no argument, or a file it cannot read, it prints a message to standard error and exits with code 2.
>
> Each part has tests that run with `node --test`. Put the code in `src/` and `bin/` and the tests in `test/`. Do not add npm dependencies, do not change `package.json`, and do not use the network.

Expected admissible graph: T1 tokenizer (entry) → {T2 word frequency, T3 reading time} → T4 command line (terminal). Ownership is disjoint: T1 `src/tokenize.mjs` and `test/tokenize.test.mjs`; T2 `src/word-frequency.mjs` and its test; T3 `src/reading-time.mjs` and its test; T4 `bin/text-stats.mjs` and `test/text-stats.test.mjs`. This fits the compiler's limits: exactly one workflow, one entry, one terminal, series-parallel shape, pairwise disjoint ownership, one live-execution action per task (`compiler.ts:1060-1308`). A chain or a single task is also admissible. The request is worded so T2 and T3 have no reason to depend on each other: a cross edge T2→T3 plus T1→T3 and T2→T4 would form the non-series-parallel "bridge" shape the compiler refuses. G4 must run the compiler's product admission deterministically before any model review, so an inadmissible graph costs no review calls.

### Budget fit, counted strictly

Rules used: `N` counts every planned model node of a phase, including every cross-family review the PRD requires (§4: every GLM/Flash-authored candidate gets a fresh M3 review; M3-authored research and design get a GLM 5.3 review). A reviewer role that already is that review counts once. Repair chunks are not planned nodes, so they are not in `N`, but they spend from the same allocation (the floor's doubling and +300 are the headroom). Floor: `2 × (30N + 300)`. An allocation `A` admits at most `N = floor((A/2 − 300)/30)`: 15 for 1,536, 41 for 3,072.

Planning phase (FULL-v2, Build Standard allocation 1,536):

| # | Node | Model | Why it is a node |
|---|---|---|---|
| 1 | Intent/acceptance assessor | GLM 5.3 | role |
| 2 | Fresh review of acceptance | M3 | GLM-authored candidate needs M3 review before G1 |
| 3 | Repository/public researcher | M3 | role |
| 4 | Source verifier | GLM 5.3 | role; is the GLM review of M3 research |
| 5 | Designer A | M3 | role |
| 6 | Designer B | GLM 5.3 | role |
| 7 | Fresh review of design A | GLM 5.3 | M3-authored design needs GLM review |
| 8 | Fresh review of design B | M3 | GLM-authored design needs M3 review |
| 9 | Decision synthesizer/spec author | GLM 5.3 | role |
| 10 | Execution planner/domain lead | GLM 5.3 | role |
| 11 | Product adversary | M3 | role; is the M3 review of the PRD |
| 12 | Technical/readiness critic | M3 | role; is the M3 review of the plan |
| 13 | Verifier author | GLM 5.3 | role |
| 14 | Verifier auditor | M3 | role; is the M3 review of the verifier bundle |
| +L | Flash extraction leaves | Flash | role, dynamic fan-out |
| +1 if L>0 | Fresh batched review of leaf outputs | M3 | Flash-authored candidates need M3 review (one batched instance; per-leaf reviews would add L) |

| Planning case | N | Floor | Allocation | Result |
|---|---:|---:|---:|---|
| No leaves | 14 | 1,440 | 1,536 | fits, 96 spare |
| 1 leaf | 16 | 1,560 | 1,536 | short 24 |
| 2 leaves | 17 | 1,620 | 1,536 | short 84 |
| 3 leaves | 18 | 1,680 | 1,536 | short 144 |

A looser count (synthesizer counts as the GLM review of design A, product adversary as the late review of acceptance) gives N=12 with no leaves and admits up to two leaves (N=15, floor 1,500). This ADR rejects the looser count: it lets G1 and the design decision pass on same-family judgment before any other-family review.

Build phases for the expected 4-task graph:

| Phase | Nodes | N | Floor | Allocation | Result |
|---|---|---:|---:|---:|---|
| Implementation | 4 Flash writers | 4 | 840 | 3,072 | fits (up to 41 writers) |
| Review/proof | 4 fresh M3 task reviews (G7), 1 fresh M3 final judge (G8), 1 fresh M3 auditor of observed acceptance runs | 6 | 960 | 1,536 | fits (up to 15 nodes, so at most about 13 tasks) |
| Total | | 24 | 3,240 | 6,144 | |

G7 reviews are counted in review/proof only (the draft also counted them in implementation, which double-counted). The campaign's `limits.maxRequests` should be the implementation floor for the compiled graph (840 here), not the whole 3,072, so writer spend is bounded even though the existing executor does not yet enforce the 10-iteration cap.

Time fit, using the PRD's default estimates (10 min planning/review node, 60 min writer, 20 min heavy check): planning critical path ≈ 100 min (acceptance and research in parallel, then designs, reviews, synthesizer, planner, verifier author, G5 control run, Pass 3); Build ≈ 300 min (three writer levels of 60 + 20 + 10, integration check, final judgment). Twice 400 min is about 13.3 hours, inside 48 hours. Spec Standard: twice 100 min, inside 12 hours. A long wait for an operator approval under release mode (b) eats this slack.

### Consequence when planning does not fit

The I2 G0 estimate uses no leaves, so G0 admits Build Standard (N=14). If the researcher later asks for a leaf, leaf admission recomputes N=16 and refuses with the exact numbers and the required amendment, without reserving or dispatching:

```ts
// packages/core/src/ccc-planning/budget-fit.ts (pure; moves into policy.ts if the contracts ADR prefers)
export type CccPlanningPhase = "planning" | "implementation" | "reviewProof";
export type CccPlanningNodeEstimate = Readonly<{
  id: string; phase: CccPlanningPhase; role: string;
  model: "glm/glm-5.3" | "glm/glm-5.3-flash" | "minimax/MiniMax-M3";
  reviewsNodeIds: readonly string[];           // empty for authors
}>;
export function cccPlanningCallFitFloor(n: number): number;                 // 2 * (30 * n + 300)
export function cccPlanningMaxAdmissibleNodes(allocation: number): number;  // floor((allocation / 2 - 300) / 30)
export function enumerateFullV2PlanningNodes(input: { extractionLeaves: number }): readonly CccPlanningNodeEstimate[];
export function enumerateFullV2BuildNodes(input: { providerTasks: number }): readonly CccPlanningNodeEstimate[];
export function assertCccPlanningCrossFamilyReviewCoverage(nodes: readonly CccPlanningNodeEstimate[]): void;
export type CccPlanningBudgetFitDecision =
  | { fits: true; selectedProfile: "standard" | "large"; phases: Record<CccPlanningPhase, { n: number; floor: number; allocation: number }>; criticalPathMinutes: number }
  | { fits: false; code: "CCC_PLANNING_BUDGET_FIT_INSUFFICIENT" | "CCC_PLANNING_TIME_FIT_INSUFFICIENT";
      phase: CccPlanningPhase; n: number; floor: number; allocation: number; shortfall: number;
      requiredAmendment: { kind: "large_profile"; authorized: false } | { kind: "phase_allocation"; phase: CccPlanningPhase; minimumCalls: number } };
export function decideCccPlanningBudgetFit(input: {
  mode: "spec" | "build"; requestedProfile: "standard" | "large"; largeAuthorized: boolean;
  nodes: readonly CccPlanningNodeEstimate[]; criticalPathMinutes: number;
}): CccPlanningBudgetFitDecision;
```

For one leaf the refusal reads: phase planning, N 16, floor 1,560, allocation 1,536, shortfall 24, amendment "planning allocation ≥ 1,560" or "Build Large (not authorized)". The researcher continues without the leaf. If it marks the leaf as necessary to resolve a material unknown, the run parks as `AWAITING_BUDGET` (PRD §6: "report exact insufficiency and the required amendment before exceeding the grant"). `fn plan budget --amendment` is I4 work, so in I2 that park is final for the run. Large is selected automatically only when the receipt says `largeAuthorized: true` and Large fits; nothing ever downgrades.

Honest I2 consequence: under Build Standard, FULL-v2's Flash extraction-leaf role cannot run. The I2 claim must read "FULL-v2 roles except Flash extraction leaves (refused for budget fit, evidence recorded)". Flash is still exercised by the four writers. To run every role, Ryan must either authorize Build Large in the receipt or approve a policy amendment raising the Standard planning allocation to at least 1,560 (one leaf) or 1,620 (two leaves).

### Calibration warning (affects I2 feasibility, not the fit arithmetic)

The 30-calls-per-node term assumes the PRD cap of 10 iterations per attempt and 3 attempts per lineage. Gate 2's installed live run used 12, 27, 35, 54, 130 and 127 model calls for its six tasks (`docs/plans/evidence/2026-09-02-ccc-gate2-installed-live-acceptance.md:96-105`), five of six above 30. If the cap is enforced honestly, I2's writer tasks must be small enough to finish in about 10 calls per attempt: one source file and one test file each, with exact signatures in the task contract so the writer needs no exploratory reads. The caps must not be widened to make I2 pass.

### Files

- Card B1: `packages/core/src/ccc-planning/budget-fit.ts`, `packages/core/src/__tests__/ccc-planning-budget-fit.test.ts` (new).
- Card P4 (with Q2): `scripts/lib/ccc-planning-disposable-target.mjs` builds the scratch root, target, owner marker and request; its test lives in `scripts/__tests__/ccc-planning-live-proof.test.mjs`.
- Card B2: `packages/engine/src/__tests__/ccc-planning-i2-graph-admission.test.ts` (new) runs the real compiler on hand-written packets.

### Behavioral RED tests

1. Boundary. `cccPlanningMaxAdmissibleNodes(1536) === 15`; N=15 fits (1,500) and N=16 refuses (1,560, shortfall 24). Both sides asserted.
2. Counting cannot silently loosen. `enumerateFullV2PlanningNodes({ extractionLeaves: 1 })` has 16 nodes and `assertCccPlanningCrossFamilyReviewCoverage` passes; removing the design-B review node makes coverage throw. Non-vacuous: the mutation must be caught.
3. Large selection. Insufficient Standard with `largeAuthorized: false` refuses with `{ kind: "large_profile", authorized: false }`; with `true` it selects Large; a request for Large with Large unauthorized refuses.
4. Leaf admission mid-run refuses without a reservation row (real PostgreSQL; the reservation count is unchanged and a positive control with spare capacity inserts one).
5. G0 refusal is atomic. Inject a failure after the first admission insert; afterwards no run, task or receipt-consumption row exists. Non-vacuous: the same admission without injection writes all of them.
6. Compiler fit of the expected graph. The real product admission accepts the diamond packet and the chain packet, and refuses the bridge packet (T1→T2, T1→T3, T2→T3, T2→T4, T3→T4) with `CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED`. Both outcomes asserted.
7. Target builder. The builder's repository has zero remotes, a 40-hex baseline, a clean tree and an owner marker whose digest it reports; `assertCccPlanningOwnedDisposableTarget` accepts it.

### Rejected alternatives

- Exclude cross-family reviews from N: makes Standard look roomy by under-counting required work.
- Count repair chunks in N: four chunks of author plus review make planning N at least 22 (floor 2,580) and Standard could never admit FULL-v2, contradicting the PRD's choice of Standard as default.
- A request that mentions `topWords` built on `wordFrequency`: invites the bridge shape the compiler refuses.
- A target cloned from a real project: before qualification only owned disposable targets are allowed.

### Risks

- The 10-iteration cap may make Flash writers and the M3 researcher fail on tool-heavy turns; Gate 2 data says real tasks often exceed it.
- `glm/glm-5.3` and `glm/glm-5.3-flash` are in the live catalog but have no recorded exact-pin tool runs. G0 performs only a free catalog read; identity is proved per call by the route receipt, so a Flash tool-call failure would surface only at the writers, after planning has been spent.
- The verifier-containing baseline changes files outside the request's code folders; the receipt's `admittedFusionPaths` makes that explicit so G3 does not mistake it for unauthorized scope.

---

## Q5. Expired quarantine entries and the final `task verify`

### Facts

- `scripts/lib/test-quarantine.json` on our base holds six `engine-slow` entries quarantined 2026-09-11, deadline 2026-09-25. `node scripts/check-quarantine-ledger.mjs --strict` exits 1 in the worktree today (re-run during this investigation: `strict rc=1`, report-only `rc=0`; also `baseline/quarantine-strict.log`). The strict check runs only in the daily `full-suite-health.yml` job (`.github/workflows/full-suite-health.yml:51-58`).
- `task verify` is `pnpm verify:workspace` = lint, `test:full`, `build:full` (`Taskfile.yml:67-70`, root `package.json`). It does not run the strict ledger check, and the six files are excluded in the engine `engine-slow` project, so `task verify` is not turned red by the ledger. But PRD §14 requires "Reconcile exclusions and quarantine ledger" and says missing or skipped required proof prevents a completion claim, so an unreconciled ledger blocks the final packet.
- PR #103 (open, mergeable, head `57e7dcdf3`) has four commits. Only `1a8002f6d` ("test(engine): rescue six expired round-11 quarantines") touches the ledger: the six test files, `packages/engine/vitest.config.ts` (removes the six excludes) and the ledger (empties `entries`). It is test-only. Its parent `87750bbc` is docs-only on top of our base `d5fd9e87d`. The other commits change unrelated things, including production `packages/core/src/task-store/lifecycle-ops.ts` (`57e7dcdf3`).
- The rescue is a root-cause fix, not appeasement: five files called now-async store methods (`createBranchGroup`, `getBranchGroup`, `getRunAuditEvents`) without `await`, which is exactly the recorded "`branch_groups.id` resolves to undefined" failure; the sixth changes an expected log type from `"text"` to `"status"`, which matches production (`packages/engine/src/merger-ai.ts:1151-1154` logs with `"status"`).
- `git show 1a8002f6d | git apply --check` passes cleanly on our HEAD, and none of the eight paths changed since the base. Stable patch-id `f396ca225259efa0f710a05cecf03d9c3fe56746`.

### Decision

1. Before the first I1 card, carry the rescue on our branch as its own commit: `git cherry-pick -x 1a8002f6dfa61966564e6b617ade6b96aa7d672f` on `agent/request-to-code-v3` (an ordinary commit on an agent branch; this is neither merging main nor merging #103). Do not carry the other three #103 commits.
2. Prove the rescue on our tree, because #103's CI never reached a verdict. The rescued files use `it.skipIf(!hasGit || !hasPg)`, so a run without PostgreSQL silently skips them. Run them with an owned PostgreSQL and a closed name list: `pnpm --filter @fusion/engine exec vitest run --project=engine-slow <the six files> --reporter=json --outputFile <path>` with `FUSION_PG_TEST_URL_BASE` pointing at the owned cluster, then require zero skipped and every expected name passed (about 24 tests by the files' own declarations: 6, 2, 3, 4, 3, 6; the closed list is taken from the first green run and frozen).
3. Final verification on our branch: start an owned PostgreSQL and export `FUSION_PG_TEST_URL_BASE` (otherwise `test:full`'s engine-slow PG tests skip silently), run `task verify`, run `pnpm check:quarantine-ledger --strict` (must exit 0), and record skipped counts from the engine-slow JSON output in the final packet.
4. If the rescue proof fails on our tree, do not delete tests (deletion of test files is approval-gated) and do not re-quarantine with a fresh date to dodge the clock. Record the exact failing names as a pre-existing red with the base commit, the command and the output, which keeps the completion claim blocked as the PRD requires, and ask the operator whether to merge #103 himself or approve deletion.
5. When #103 later lands on main, rebasing our branch drops the carried commit automatically (same patch-id). If #103 changes first, the conflict is limited to those eight files, which no planning card touches; take main's version.

No planning card may edit `packages/engine/vitest.config.ts` or the six rescued files until the carried commit lands on our branch.

### RED tests

1. Before the cherry-pick: `node scripts/check-quarantine-ledger.mjs --strict` exits 1 (observed). After: exits 0. Non-vacuous: the same command, same tree minus the commit, gives 1.
2. The six files run under owned PostgreSQL with zero skipped and the closed name list passing. Non-vacuous: the same command without `FUSION_PG_TEST_URL_BASE` reports skips, which the closed check refuses, proving the check can see a silent skip.

### Rejected alternatives

- Merge #103 or main: forbidden for the implementation leader (PRD §13:405).
- Delete the six expired test files under the 14-day rule: deletion is approval-gated, and the rescue shows the tests catch real behavior.
- Record a pre-existing red and stop: honest but leaves the PRD §14 reconciliation unmet and blocks the completion claim when a clean, attributable, test-only fix exists.
- Carry all four #103 commits: pulls unrelated production changes into this branch without review.

### Risks

- The rescue has had no CI verdict; step 2 is the first proof.
- Our branch diff includes an unrelated attributed commit until #103 lands; reviewers must see it as separate.
- Main's daily health job stays red until someone merges #103; that is outside this branch.

---

## Card ownership summary (disjoint files)

| Card | Owns |
|---|---|
| R0 rescue carry | the eight files of `1a8002f6d` (cherry-pick only) |
| P1 proof runner | `scripts/lib/ccc-closed-vitest-results.mjs`, `scripts/lib/ccc-planning-proof-inventory/index.mjs`, `.../scripts.mjs`, `scripts/run-ccc-planning-proof.mjs`, `scripts/__tests__/run-ccc-planning-proof.test.mjs`, `package.json` (four keys), stub `scripts/ccc-planning-live-proof.mjs` and `scripts/ccc-planning-installed-proof.mjs` |
| P1b (optional, consult-gated) | one step in `.github/workflows/full-suite.yml`, its pin in `packages/cli/src/__tests__/ci-workflow.test.ts` |
| P2 installed runtime | `scripts/lib/ccc-installed-cli.mjs`, `scripts/lib/ccc-gate2-installed-runtime.mjs` (delegate), `scripts/lib/ccc-planning-installed-runtime.mjs`, `scripts/ccc-planning-install-runtime.mjs`, `scripts/__tests__/ccc-planning-installed-runtime.test.mjs` |
| P3 serve lane | `scripts/lib/ccc-planning-serve-lane.mjs`, `scripts/__tests__/ccc-planning-serve-lane.test.mjs` |
| P4 live and installed proofs (after P1, P2, P3) | `scripts/ccc-planning-live-proof.mjs`, `scripts/ccc-planning-installed-proof.mjs`, `scripts/lib/ccc-planning-disposable-target.mjs`, `scripts/__tests__/ccc-planning-live-proof.test.mjs` |
| A1 authority contracts | `packages/core/src/ccc-planning/authority.ts`, `.../qualification.ts`, two core unit tests |
| A2 receipt consumption | `packages/core/src/task-store/ccc-planning-authority-ops.ts`, `packages/core/src/__tests__/postgres/ccc-planning-authority.pg.test.ts` |
| A3 release bridge | `packages/engine/src/ccc-planning/live-execution-release.ts`, its real-PG test |
| A4 disposable target | `packages/engine/src/ccc-planning/disposable-target.ts`, its real-Git test |
| B1 budget fit | `packages/core/src/ccc-planning/budget-fit.ts`, its unit test |
| B2 graph admission | `packages/engine/src/__tests__/ccc-planning-i2-graph-admission.test.ts` |
| Each card | its own area file under `scripts/lib/ccc-planning-proof-inventory/` |

## Decisions that need the operator (Ryan)

1. Issue the I2 live-authority receipt and choose `release`: `controller_within_receipt` (recommended) or `operator_confirm_after_import` (one `fn prd approve-execution` mid-run). Only a digest Ryan states in his own message may be passed to `--confirm-authority`.
2. Choose Build Standard with Flash extraction leaves NOT RUN (fits as-is), or authorize Build Large or a Standard planning amendment of at least 1,560 calls so leaves can run.
3. Permit the installed path's build, pack and `npm install --ignore-scripts` (registry network access) under the project pack's dependency-installation rule.
4. Consult-gated, not necessarily Ryan: dispatching `full-suite.yml` on the branch ref for native macOS runner evidence.
