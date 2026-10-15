/*
FNXC:CccPlanningProof 2026-10-14-18:58:
Proof inventory for request-to-code v3 card GG (deterministic planning gates: G3 objections, G4 graph gate, source fidelity, schedule simulation and the proof-command policy; D19, D47, challenges 14, 23 and 29, verify-v2 item 41). One module per card keeps the inventory files disjoint (contract 0.18); `index.mjs` (owned by P0) loads `cards/*.mjs` in sorted order and rejects duplicate command ids.

All four check files are engine tests the card owns, run under the `engine-default` project, whose aliases point @fusion/core at source, so no build runs and nothing reaches PostgreSQL (the gates are pure). TARGETED is file-closed over the four files in one command. OFFLINE is name-closed over the same files: the names below are exactly their tests, built the way `assertionName` in `scripts/run-ccc-pg-proof.mjs` builds them (ancestor titles and the title joined by " > "), so a skipped, renamed, missing or extra test fails the command instead of passing quietly.

Measured on the M5 Max under a load average near 10 to 12 (parallel agents running heavy suites): the four files take about 2.5 to 3.1 s of vitest duration for 46 tests, including transform and import (the tests themselves take under 0.1 s). The 120 s command timeout is a hang bound over that measurement; no test timeout is raised anywhere.
FNXC:CccPlanningProof 2026-10-14-21:13:
Repair 1 (errata E9 GG items 1 to 3) adds seven names: the write-root-canonical rule (non-canonical spelling, surrounding whitespace, a duplicate write root, and the same refusal through G4), the two-merges-on-the-terminal case, the G7 lineage collision through G4, and the derivation of the planning fixed lineage set from K1. Re-measured on the M5 Max at a load average near 13: 53 tests in 1.96 s of vitest duration (about 2 s wall; the tests themselves take 50 ms), so the 120 s command timeout keeps its wide margin as a hang bound.
*/

const SOURCE_FIDELITY_FILE = "src/__tests__/ccc-planning-source-fidelity.test.ts";
const GRAPH_GATE_FILE = "src/__tests__/ccc-planning-graph-gate.test.ts";
const OBJECTIONS_FILE = "src/__tests__/ccc-planning-objections.test.ts";
const SCHEDULE_AND_COMMANDS_FILE = "src/__tests__/ccc-planning-schedule-and-commands.test.ts";

const ENGINE_COMMAND = Object.freeze({
  packageFilter: "@fusion/engine",
  project: "engine-default",
  config: null,
  files: Object.freeze([SOURCE_FIDELITY_FILE, GRAPH_GATE_FILE, OBJECTIONS_FILE, SCHEDULE_AND_COMMANDS_FILE]),
  platform: "any",
  needsPostgres: false,
  timeoutMs: 120_000,
});

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({ id: "gg-deterministic-gates", ...ENGINE_COMMAND, closure: "files", expectedNames: Object.freeze([]) }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "gg-deterministic-gates-names",
    ...ENGINE_COMMAND,
    closure: "names",
    expectedNames: Object.freeze([
      // ccc-planning-source-fidelity.test.ts
      `checkCccPlanningSourceFidelity > positive control: a correctly attributed map yields zero diagnostics`,
      `checkCccPlanningSourceFidelity > one changed request byte gives an anchor mismatch`,
      `checkCccPlanningSourceFidelity > a quote that exists only in the final PRD gives REQUEST_QUOTE_UNRESOLVED`,
      `checkCccPlanningSourceFidelity > an uncovered line of a heading-free request gives REQUEST_UNIT_UNDISPOSITIONED, where compile alone sees zero items`,
      `checkCccPlanningSourceFidelity > a fenced block is one unit: one quote inside it covers the whole block`,
      `checkCccPlanningSourceFidelity > an annex clause citing the request gives ANNEX_ATTRIBUTED_TO_REQUEST`,
      `checkCccPlanningSourceFidelity > an annex clause carrying request quotes gives ANNEX_ATTRIBUTED_TO_REQUEST`,
      `checkCccPlanningSourceFidelity > an annex clause citing a decision the annex does not declare gives ANNEX_DECISION_UNKNOWN`,
      `checkCccPlanningSourceFidelity > a request quote that occurs twice gives REQUEST_QUOTE_AMBIGUOUS`,
      `checkCccPlanningSourceFidelity > a request-derived clause with no request quote gives REQUEST_DERIVATION_MISSING`,
      `checkCccPlanningSourceFidelity > an acceptance case no request-derived clause maps gives ACCEPTANCE_CASE_UNMAPPED`,
      `checkCccPlanningSourceFidelity > an exclusion with no non-goal citing its request quote gives EXCLUSION_UNMAPPED`,
      // ccc-planning-graph-gate.test.ts
      `runCccPlanningG4 > positive control: the section 4.1 diamond with its sources yields zero diagnostics`,
      `runCccPlanningG4 > a cyclic plan fails G4 with the compiler's graph diagnostic, and G4 stays pure`,
      `runCccPlanningG4 > an N-shaped plan fails G4 before any review: the compiler refuses its shape`,
      `runCccPlanningG4 > an annex decision realized by no task fails G4 with the material-coverage code`,
      `runCccPlanningG4 > a task path missing from its exact source evidence fails G4 with the custody provenance code`,
      `runCccPlanningG4 > a proposal whose task custody differs from the task plan fails G4`,
      `runCccPlanningG4 > a merge action on a non-terminal task fails G4 with the importer's landing rule`,
      `runCccPlanningG4 > two merge actions on the terminal task fail G4 with the importer's one-merge rule`,
      `runCccPlanningG4 > a non-canonical task path fails G4 before review: the custody check would refuse it as a model write root`,
      `runCccPlanningG4 > a semantic task id whose G7 lineage review:<id> is a planning fixed lineage fails G4`,
      `runCccPlanningG4 > admitted write roots without the target's .fusion fail G4`,
      `runCccPlanningG4 > G4 runs source fidelity: a changed request byte gives the anchor mismatch`,
      `runCccPlanningG4 > G4 runs the proof-command policy on the proposal's proofs`,
      `runCccPlanningG4 > a task plan that fails its schema stops G4 at the schema diagnostics`,
      `CCC_PLANNING_FIXED_LINEAGE_IDS > is derived from K1: each fixed or once-if-leaves role's stage:role, each preflight lineage and judge:final`,
      // ccc-planning-objections.test.ts
      `cccPlanningObjectionsFromVerdict > turns a reject verdict with a counterexample finding and an artifact finding into two objections with those refs`,
      `cccPlanningObjectionsFromVerdict > refuses a stage that may not publish objections`,
      `assessCccPlanningObjectionDispositions > positive control: a resolved objection set yields zero diagnostics`,
      `assessCccPlanningObjectionDispositions > a blocking objection with no decision_record gives OBJECTION_UNRESOLVED`,
      `assessCccPlanningObjectionDispositions > a deferred disposition on a blocking objection gives OBJECTION_UNRESOLVED`,
      `assessCccPlanningObjectionDispositions > a rejected disposition with no evidence ref gives OBJECTION_UNRESOLVED`,
      `assessCccPlanningObjectionDispositions > a decision record for another objection does not resolve a blocking objection`,
      `assessCccPlanningObjectionDispositions > an advisory objection needs no decision record`,
      // ccc-planning-schedule-and-commands.test.ts
      `simulateCccPlanningSchedule > schedules the diamond at concurrency 1 with campaignCriticalPathMs 4 x 5,400,000 + 1,200,000 + 600,000 = 23,400,000`,
      `simulateCccPlanningSchedule > follows the planned graph: a chain of two is 2 x 5,400,000 + 1,800,000`,
      `simulateCccPlanningSchedule > orders by dependency, not by declaration`,
      `simulateCccPlanningSchedule > reports tasks a cycle leaves unschedulable`,
      `checkCccPlanningProofCommands > positive control: the section 4.1 diamond yields zero diagnostics`,
      `checkCccPlanningProofCommands > refuses the proof command npm install && node --test`,
      `checkCccPlanningProofCommands > refuses node --test test/tokenizer.test.mjs because it is not task verify:<name>`,
      `checkCccPlanningProofCommands > refuses task verify:tokenizer when the bundle's Taskfile.yml does not declare that target`,
      `checkCccPlanningProofCommands > refuses a harness that is not in the verifier bundle`,
      `checkCccPlanningProofCommands > refuses v2's demo shape: the writer owns its harness, so the verifier closure overlaps a model write root`,
      `checkCccPlanningProofCommands > refuses a writer task that owns Taskfile.yml`,
      `checkCccPlanningProofCommands > refuses a writer task that owns a test/** path`,
      `checkCccPlanningProofCommands > refuses a candidate path outside the task's own write roots`,
      `checkCccPlanningProofCommands > compares paths on the comparison key: ./TASKFILE.yml is refused as a writer-owned Taskfile.yml`,
      `checkCccPlanningProofCommands > compares paths on the comparison key: another letter case of a harness overlaps it`,
      `checkCccPlanningProofCommands > refuses a task path that is not a canonical target-relative path, which the custody check refuses as a model write root`,
      `checkCccPlanningProofCommands > refuses a task path with leading or trailing whitespace, as the importer's execution policy does`,
      `checkCccPlanningProofCommands > refuses a write root listed twice in one task, as the importer's execution policy does`,
    ]),
  }),
]);
