# Errata E9: rulings on the early I2 cards (repair 1 of RP, IP, IB1, GG)

Date: 2026-10-14. Precedence: E9 over E8 over E7 over CONTRACT-v3.3 for these four cards only.

## Verdicts after the first review

- **B3: ACCEPTED** (critical lane, review and adversary both ACCEPT). Integrates at INT-3.
- **RP, IP, IB1, GG: REPAIR.** Each gets repair 1 of 2 in its own worktree (base INT-2c 115ab8d7f), then a fresh review in its lane: RP cheap (Sonnet), IP and IB1 normal (Opus), GG critical (Opus reviewer plus Opus adversary).

## Rulings

### RP
- Both review findings are adopted as written. The planner gives each task "normally one to three source files". Writers own only `src/` and `bin/` paths and never a test, fixture or `Taskfile.yml` path. Writer item 3 says they own no test, fixture or Taskfile path. Writer item 6 says the `proofIds` checks were written by someone else: read and run them, never edit them.
- DATA_RULE takes an optional task-input name. The implementation-writer uses `taskContract`, the extraction-leaf uses `extractionTask`, and every other role keeps today's text. Pin tests are added and `cards/rp.mjs` is updated.

### IP
1. **Install directory.** argv[0] is the install directory: it must be missing or empty, and the runtime root is its parent. fn goes to `<installDir>/node_modules/.bin/fn`. The pack goes to `<root>/evidence/pack`. The receipt goes to `<root>/evidence/installed-runtime.json`, and the run refuses before any build if that file already exists. This matches the frozen section 4.2 step 1 command literally, so step 1 is not amended.
2. **RULING: the installed keepalive lane leaves the runner inventory.** `scripts/__tests__/ccc-planning-installed-keepalive.test.mjs` is removed from TARGETED and OFFLINE in `cards/ip.mjs`. It is parent-run, directly, at section 4.2 step 0 and in card LV. This replaces the card text `inventory platform: "darwin"` for this one lane.
   - Why: the D50 offline guard wraps every runner mode, so a lane that builds, packs and npm-installs the CLI cannot run under it without a warm npm cache. It would also rewrite `packages/cli/package.json` in the integration checkout on every `pnpm test:ccc-planning` run.
   - The card header lists the lane's four test names for the parent run, with the false premise corrected.
3. **extraEnv** becomes an allowlist of exactly `DATABASE_URL`, `FUSION_HOME` and `TMPDIR` (ADR D Q2). Every other name is refused.
4. **RULING: arm A is described truthfully.** It drives a sibling bundle (`dist/ccc-route-receipt-adapter.js`), not the `bin.js` that fn runs, because tsup inlines with `splitting: false`. The fn-path arm, which runs a session with custom provider equal to defaultProvider and receipt adapter `terminal-route-sse-comments.v1` through the installed fn, is deferred to card LV (wave W9). The header, the test name or description, and the build report must not claim RED (A) is satisfied by arm A.
5. Four tests, each with a passing twin, kill mutants S25, S26, I9b and I27. I27 was fail-open: a non-literal `noExternal` used to parse as `[]`, and must now refuse with `CCC_PLANNING_INSTALLED_RUNTIME_INVALID`.

### IB1
All four findings are adopted as written:
- `assertAuthoringProducers` refuses non-authoring kinds, duplicate kinds and any status other than complete.
- A sorted-label pin is added.
- The vacuous requirement-id test is fixed: it now also edits `controls[0].requirementId`, and the twin renders `REQ-TOKENS`.
- Appended-unreviewed-line refusals are added for `finalPrd`, `technicalAnnex` and `admissionFacts`.

### GG
1. **New rule `write-root-canonical`** in `checkCccPlanningProofCommands` (listed in `CCC_PLANNING_PROOF_COMMAND_RULES`). This merges the review and adversary findings.
   - The rule runs `canonicalPathProblem` on every entry of every task's `ownedPaths` and `allowedWriteRoots`. It also refuses leading or trailing whitespace and duplicate write roots within a task, matching `exactTargetRelativePaths` in canonical.ts.
   - Each offending path gets one `CCC_PLANNING_GRAPH_INADMISSIBLE` diagnostic naming the task, the path and the custody rule.
   - Overlap comparison still goes through the K1 comparison key (E2-13).
2. **The vacuous merge-landing test is fixed.** It now also pushes `A-MERGE` into the proposal's T2, and asserts exactly one diagnostic, which contains "single terminal task" and "A-MERGE". Mutant M36 must now fail.
3. **N-3 (from E8) is added here.** G4 refuses a plan with a semantic task id whose G7 lineage id `review:<id>` equals a planning fixed lineage id.
   - The refusal is `CCC_PLANNING_GRAPH_INADMISSIBLE`, with a detail naming the task and the colliding lineage id.
   - The fixed set is derived from K1 exports, never hard-coded: `${stageId}:${roleId}` for every fixed or once-if-leaves role of every role policy K1 exports, every `CCC_PLANNING_PREFLIGHT_LINEAGES` id, and `judge:final`.
   - Today the colliding ids are `review:product-adversary` and `review:technical-critic`.
   - RED: a task with semantic id `product-adversary` is refused. Control: `product-adversary-2` is admitted.
4. **Deviation recorded, no action:** `CCC_PLANNING_G4_SOURCE_PATHS` is duplicated locally in GG. The parent dedups it at integration.
