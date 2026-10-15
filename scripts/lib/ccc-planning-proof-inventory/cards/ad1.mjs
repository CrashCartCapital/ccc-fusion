/*
FNXC:CccPlanningProofInventory 2026-10-14-21:02:
Proof inventory for request-to-code v3 card AD1 (the admission transaction, CONTRACT-v3 section 2.11 `admitCccPlanningRun`, errata E8-W3). One module per card keeps the inventory files disjoint (contract 0.18); `index.mjs` (owned by P0) loads `cards/*.mjs` in sorted order and rejects duplicate command ids.

TARGETED is file-closed over the card's single test file. OFFLINE is name-closed over the same file: the 14 names below are exactly its tests, built the way `assertionName` in `scripts/run-ccc-pg-proof.mjs` builds them (ancestor titles and the title joined by " > "), so a skipped, renamed, missing or extra test fails the command instead of passing quietly. The card's REDs are the 2nd to 6th names (one rollback per `afterStep` value), the 1st (receipt reuse, with the clean-admission control), the 8th (the held task and G1's guard) and the 9th and 10th (work item run id and IR hash, stored IR, per mode). The 12th is the v1-order foreign-key check; the others cover a failed admission consuming nothing, the run-id derivation, input agreement and the concurrent receipt race.

The file needs PostgreSQL: its single describe is the harness `pgDescribe`, and admission runs as the application role (`fusion_runtime`) bound to one project, so row-level security and the 0042 and 0043 triggers are live. The field is `needsPostgres` (errata E1-1). Core has no Vitest projects, so `project` is null, and the PostgreSQL config is `vitest.pg.config.ts`.

Measured on the M5 Max under a load average near 9 (parallel agents), FNXC:CccPlanningProofInventory 2026-10-14-21:02: about 6 s wall for the file (14 tests, about 3 s of Vitest time). The 120 s command timeouts are hang bounds over that measurement; no test timeout is raised anywhere.
*/

const FILE = "src/__tests__/postgres/ccc-planning-admission.pg.test.ts";

const SUITE = "ccc planning admission (card AD1, PostgreSQL)";
const ROLLBACK = "the hook runs while that step's inserts are in flight, and its failure rolls back every row of the run";
const IR = "the work item carries the run id and the hash of the K1 IR, and the stored workflow IR deep-equals the K1 IR";

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({
    id: "ad1-admission",
    packageFilter: "@fusion/core",
    project: null,
    config: "vitest.pg.config.ts",
    files: Object.freeze([FILE]),
    closure: "files",
    expectedNames: Object.freeze([]),
    platform: "any",
    needsPostgres: true,
    timeoutMs: 120_000,
  }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "ad1-admission-names",
    packageFilter: "@fusion/core",
    project: null,
    config: "vitest.pg.config.ts",
    files: Object.freeze([FILE]),
    closure: "names",
    expectedNames: Object.freeze([
      `${SUITE} > a clean admission writes one task, anchor, workflow, selection and work item, the three admission artifacts and four audit rows; replaying the receipt refuses RECEIPT_CONSUMED and adds nothing`,
      `${SUITE} > afterStep task: ${ROLLBACK}`,
      `${SUITE} > afterStep anchor: ${ROLLBACK}`,
      `${SUITE} > afterStep workflow: ${ROLLBACK}`,
      `${SUITE} > afterStep work-item: ${ROLLBACK}`,
      `${SUITE} > afterStep artifacts: ${ROLLBACK}`,
      `${SUITE} > a receipt whose admission failed at every step admits once afterwards, so a failed admission consumes nothing`,
      `${SUITE} > the planning task is held (triage, paused, not user-paused, lineage = run id, anchored) and the G1 guard refuses moving it; an ordinary task in the same store moves`,
      `${SUITE} > build mode: ${IR}`,
      `${SUITE} > spec mode: ${IR}`,
      `${SUITE} > the run id is cccPlanningRunId over the receipt's project, request digest and receipt sha256, the K2 envelope binding`,
      `${SUITE} > the v1 order, the anchor before its task, fails the composite task foreign key at the anchor insert; the task first is admitted`,
      `${SUITE} > refuses CCC_PLANNING_INTERNAL_ERROR naming the field when the input's parts disagree, before any write; the agreeing input is admitted`,
      `${SUITE} > two concurrent admissions of one receipt commit one run, and the other refuses RECEIPT_CONSUMED through the unique key`,
    ]),
    platform: "any",
    needsPostgres: true,
    timeoutMs: 120_000,
  }),
]);
