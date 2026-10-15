/*
FNXC:CccPlanningProof 2026-10-14-18:58:
Proof inventory for request-to-code v3 card GG (deterministic planning gates: G3 objections, G4 graph gate, source fidelity, schedule simulation and the proof-command policy; D19, D47, challenges 14, 23 and 29, verify-v2 item 41). One module per card keeps the inventory files disjoint (contract 0.18); `index.mjs` (owned by P0) loads `cards/*.mjs` in sorted order and rejects duplicate command ids.

All four check files are engine tests the card owns, run under the `engine-default` project, whose aliases point @fusion/core at source, so no build runs and nothing reaches PostgreSQL (the gates are pure). TARGETED is file-closed over the four files in one command. OFFLINE is name-closed over the same files: the names below are exactly their tests, built the way `assertionName` in `scripts/run-ccc-pg-proof.mjs` builds them (ancestor titles and the title joined by " > "), so a skipped, renamed, missing or extra test fails the command instead of passing quietly.

Measured on the M5 Max under a load average near 10 to 12 (parallel agents running heavy suites): the four files take about 2.5 to 3.1 s of vitest duration for 46 tests, including transform and import (the tests themselves take under 0.1 s). The 120 s command timeout is a hang bound over that measurement; no test timeout is raised anywhere.
FNXC:CccPlanningProof 2026-10-14-21:13:
Repair 1 (errata E9 GG items 1 to 3) adds seven names: the write-root-canonical rule (non-canonical spelling, surrounding whitespace, a duplicate write root, and the same refusal through G4), the two-merges-on-the-terminal case, the G7 lineage collision through G4, and the derivation of the planning fixed lineage set from K1. Re-measured on the M5 Max at a load average near 13: 53 tests in 1.96 s of vitest duration (about 2 s wall; the tests themselves take 50 ms), so the 120 s command timeout keeps its wide margin as a hang bound.
FNXC:CccPlanningProof 2026-10-14-22:28:
Repair 2 (errata E11 GG items 1 to 3) adds seven names: the importer's two route rules through G4 (a write root outside the PRD-admitted write roots, a write root that matches its owned path only in another letter case, and the case-by-case agreement with the real execution-policy parse), write-root-canonical with the odd spelling in one field only, and the three exact-spelling pins (harness token, closure path in the bundle, candidate inside its write root). Re-measured on the M5 Max at a load average near 6 to 8: 60 tests in 2.00 s of vitest duration (the tests themselves take about 70 ms); the 120 s command timeout is unchanged.
FNXC:CccPlanningProof 2026-10-14-23:14:
Card GGz (errata E12, successor owner of this card) adds a fifth file, `ccc-planning-g4-importer-parity.test.ts`, and its 11 names, which judge each case by G4 and by the real importer or custody function it mirrors; four custody cases build and remove a throwaway git repository under the OS temp directory and run the real custody hydration, still with no network and no PostgreSQL. The schedule-and-commands file renames the candidate case for the rule that replaces `candidate-in-own-write-roots` and adds three names (a proof shared by two tasks, an owned directory as a candidate, a closure path that starts with a colon); the graph-gate names are unchanged. 74 names in all. Measured on the M5 Max at a load average near 10 to 11 (parallel agents running heavy suites): the five files take 6.7 to 7.7 s wall (6.2 to 7.3 s of vitest duration) over three runs, about 4 s of it the custody hydrations, each about 0.5 to 1.4 s. One earlier run stalled once inside a custody case for about 40 s and hit vitest's 30 s test timeout; it did not recur in more than 25 later runs of the file and was not explained, and no test timeout was raised for it. The 120 s command timeout stays a hang bound, about 15 times the measurement.
FNXC:CccPlanningProof 2026-10-15-00:02:
Card GGz repair 1 adds one parity name: a verifier closure path not in Unicode NFC, refused by G4 and pinned against the real custody hydration (refused on Darwin, where git precomposes the custody check's ls-tree argument; admitted elsewhere, the accepted fail-closed over-refusal), with its NFC control. 75 names in all. Measured on the M5 Max at a load average near 8.5 to 9.3 (parallel agents running heavy suites): the five files take 7.8 to 8.6 s wall (7.2 to 8.0 s of vitest duration) over three runs; the new case adds two custody hydrations. The 120 s command timeout is unchanged, about 14 times the measurement.
*/

const SOURCE_FIDELITY_FILE = "src/__tests__/ccc-planning-source-fidelity.test.ts";
const GRAPH_GATE_FILE = "src/__tests__/ccc-planning-graph-gate.test.ts";
const OBJECTIONS_FILE = "src/__tests__/ccc-planning-objections.test.ts";
const SCHEDULE_AND_COMMANDS_FILE = "src/__tests__/ccc-planning-schedule-and-commands.test.ts";
const IMPORTER_PARITY_FILE = "src/__tests__/ccc-planning-g4-importer-parity.test.ts";

const ENGINE_COMMAND = Object.freeze({
  packageFilter: "@fusion/engine",
  project: "engine-default",
  config: null,
  files: Object.freeze([SOURCE_FIDELITY_FILE, GRAPH_GATE_FILE, OBJECTIONS_FILE, SCHEDULE_AND_COMMANDS_FILE, IMPORTER_PARITY_FILE]),
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
      `runCccPlanningG4 > a task write root outside every PRD-admitted write root fails G4, as the importer's execution policy refuses it`,
      `runCccPlanningG4 > a write root that matches an owned path only in another letter case fails G4, as the importer refuses it as outside task ownership`,
      `runCccPlanningG4 > G4's write-root rules agree with the importer's execution-policy parse case by case`,
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
      `checkCccPlanningProofCommands > refuses a candidate path outside the owned paths and write roots of every task that runs the proof`,
      `checkCccPlanningProofCommands > admits a proof shared by two tasks whose candidates are the union of their owned paths, as IB1 builds it`,
      `checkCccPlanningProofCommands > admits an owned directory as a candidate although no write root contains it, as IB1 builds it`,
      `checkCccPlanningProofCommands > refuses a verifier closure path that starts with a colon, which git reads as pathspec magic`,
      `checkCccPlanningProofCommands > compares paths on the comparison key: ./TASKFILE.yml is refused as a writer-owned Taskfile.yml`,
      `checkCccPlanningProofCommands > compares paths on the comparison key: another letter case of a harness overlaps it`,
      `checkCccPlanningProofCommands > refuses a task path that is not a canonical target-relative path, which the custody check refuses as a model write root`,
      `checkCccPlanningProofCommands > refuses a task path with leading or trailing whitespace, as the importer's execution policy does`,
      `checkCccPlanningProofCommands > refuses a write root listed twice in one task, as the importer's execution policy does`,
      `checkCccPlanningProofCommands > refuses a non-canonical or padded path in one field only, naming that field`,
      `checkCccPlanningProofCommands > refuses a Taskfile target that names the declared harness in another letter case`,
      `checkCccPlanningProofCommands > refuses a closure harness that names the bundle file in another letter case`,
      `checkCccPlanningProofCommands > refuses a candidate that lies inside the task's write root only on the comparison key`,
      // ccc-planning-g4-importer-parity.test.ts
      `G4 importer and custody parity > positive control: the IB1-built diamond passes G4 and every importer and custody function G4 mirrors`,
      `G4 importer and custody parity > a verifier closure path that starts with a colon fails G4, as git pathspec magic makes the custody check miss it`,
      `G4 importer and custody parity > a verifier closure path that is not in Unicode NFC fails G4, as git's precomposeunicode on the Darwin host makes the custody check miss it`,
      `G4 importer and custody parity > a dependency edge id the importer's entity-id rule refuses fails G4, as the importer refuses it`,
      `G4 importer and custody parity > defence in depth: a task id the importer's entity-id rule refuses fails G4 even when IB1's packet is bypassed`,
      `G4 importer and custody parity > a stats proof shared by T2 and T3, each with its own proof as well, is admitted by G4 and by the importer`,
      `G4 importer and custody parity > a write root inside an owned directory, with IB1-built candidates, is admitted by G4 and by the importer`,
      `G4 importer and custody parity > a task whose only proof is shared fails G4 exactly, as the importer's proof plan requires a task-phase proof`,
      `G4 importer and custody parity > a single-owner proof whose requirements include another task's requirement fails G4, as the importer's proof plan refuses it`,
      `G4 importer and custody parity > G4's proof-graph rules agree with the importer's proof plan case by case`,
      `G4 importer and custody parity > a relative PRD-admitted write root fails G4, as the importer resolves it against its own working directory`,
      `G4 importer and custody parity > G4's source paths are IB1's packet source paths (errata E9-4, E12 item 7)`,
    ]),
  }),
]);
