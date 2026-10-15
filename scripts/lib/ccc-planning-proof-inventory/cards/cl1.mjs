/*
FNXC:CccPlanningProof 2026-10-14-22:58:
Proof inventory for request-to-code v3 card CL1 (`fn plan` CLI: CONTRACT-v3.5 section 2.19, D35, D49, errata E2-4/E4-6). One module per card keeps the inventory files disjoint; `index.mjs` loads `cards/*.mjs` in sorted order and rejects duplicate command ids.

TARGETED is file-closed over the card's two check files and OFFLINE is name-closed over the same two files: the names below are exactly their tests, built the way `assertionName` in `scripts/lib/ccc-closed-vitest-results.mjs` builds them (ancestor titles and the title joined by " > "), so a skipped, renamed, missing or extra test fails the command instead of passing quietly. Both run in the @runfusion/fusion package's single Vitest project, which aliases @fusion/core and @fusion/engine to source, so no build runs. Neither file reaches PostgreSQL (the L1 store operations are injected spies, and bin.ts is driven through its `plan` route with the default deps factory swapped for a fail-closed tripwire fake whose store-facing deps trip a flag and reject, so a parser regression fails an assertion instead of starting the operator's embedded PostgreSQL; the route's close of the global settings revision layers is counted through a partial mock of @fusion/core), so `needsPostgres` is false and the runner sets the PostgreSQL skip flag for the command; the files do not name the flag.

Measured on the M5 Max under parallel-agent load (load average 11.5 on the 1 minute figure): about 3 s wall for the two files (27 tests), from a cold transform cache about 8 s. The 120 s command timeout is a hang bound over that measurement; no test timeout is raised anywhere.

FNXC:CccPlanningProof 2026-10-14-23:17:
Repair 1 (CL1 review findings) adds two bin tests for the plan route's close of the global settings revision layers, so the card now has 29 tests: 22 in plan.test.ts and 7 in bin-plan-routing.test.ts. The 29 names below are exactly the passing names of a JSON reporter run of the card command (re-measured at repair 1 under a load average of 8.3: about 2 s wall, 29 passed; the cold-cache figure above is the original measurement). The five existing bin test names are unchanged.
*/

const CHECK_FILES = Object.freeze([
  "src/commands/__tests__/plan.test.ts",
  "src/__tests__/bin-plan-routing.test.ts",
]);

const PLAN = "fn plan CLI (card CL1)";
const BIN = "bin routes fn plan before the bin-level --project parse (card CL1, D35)";

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({
    id: "cl1-cli-plan",
    packageFilter: "@runfusion/fusion",
    project: null,
    config: null,
    files: CHECK_FILES,
    closure: "files",
    expectedNames: Object.freeze([]),
    platform: "any",
    needsPostgres: false,
    timeoutMs: 120_000,
  }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "cl1-cli-plan-names",
    packageFilter: "@runfusion/fusion",
    project: null,
    config: null,
    files: CHECK_FILES,
    closure: "names",
    expectedNames: Object.freeze([
      `${PLAN} > exports the frozen schema and exit codes`,
      `${PLAN} > status with no --project resolves the project from the run row and prints one status line; the twin with --project forwards it`,
      `${PLAN} > a run id held by two projects exits 1 with CCC_PLANNING_RUN_AMBIGUOUS; the twin held by one project exits 0`,
      `${PLAN} > --project naming another project exits 1 with CCC_PLANNING_RUN_PROJECT_MISMATCH; the twin naming the run's project exits 0`,
      `${PLAN} > opens the resolution layer on the --project given, reuses it when it already is the run's project, and opens the run's project otherwise`,
      `${PLAN} > a missing positional RUN_ID exits 2 with one usage_error line for every run subcommand and deps are never called; the twin with the id passes`,
      `${PLAN} > a --run flag grammar is not accepted: the run id is positional only`,
      `${PLAN} > every other grammar fault exits 2 with one usage_error line and no dep call, and each twin without the fault is not a usage error`,
      `${PLAN} > an actor over 200 characters, or blank after trimming, exits 2 before any dep call; 200 characters pass unchanged and a padded actor is trimmed`,
      `${PLAN} > the actor defaults to the OS user name, and an OS user name that is not 1 to 200 characters is a usage error before any read`,
      `${PLAN} > build and budget exit 1 with CCC_PLANNING_COMMAND_NOT_SUPPORTED and touch nothing; the same grammar with a bad value is still a usage error`,
      `${PLAN} > pause, cancel and resume on a run without import_id go to L1 and print control_accepted with route planning; deps.applyBuildControl is not called`,
      `${PLAN} > a run whose import intent is recorded but not linked yet still goes to L1`,
      `${PLAN} > pause, cancel and resume on a linked run call deps.applyBuildControl with the resolved project and never L1; the CL1 refusal exits 1 with COMMAND_NOT_SUPPORTED`,
      `${PLAN} > a bridge result is printed as control_accepted on the campaign-bridge route: applied is direct, pending-in-lease is not`,
      `${PLAN} > answer reads --value or --value-file, calls L1 with the actor and prints answer_accepted; an unreadable file is a usage error before any store call`,
      `${PLAN} > an answer value that starts with a dash is taken verbatim, but a value that is another flag is a missing value`,
      `${PLAN} > an L1 refusal keeps its own code and field; a code outside the CCC families is an internal error`,
      `${PLAN} > a thrown internal error exits 1 with CCC_PLANNING_INTERNAL_ERROR and never FUSION_NON_RETRYABLE_EXIT_CODE, even for a unique-violation shape`,
      `${PLAN} > a long diagnostic is bounded and a failing close does not change the outcome`,
      `${PLAN} > --json keeps stdout to exactly one JSON line and stderr to free text; human mode prints text with the same exit codes`,
      `${PLAN} > the status path hands the linked-outcome port to L1, and the control routing read does not`,
      `${BIN} > a duplicate --project on fn plan exits 2 with one usage_error JSON line, while the same flags on another command still hit the bin-level duplicate-project error`,
      `${BIN} > a missing RUN_ID and an unknown subcommand through bin exit 2 with a JSON usage_error line; the twin with the id does not`,
      `${BIN} > fn plan status with no --project resolves the project from the run row through bin and exits 0 with kind status`,
      `${BIN} > the --project given to fn plan reaches plan.ts untouched: bin does not strip it`,
      `${BIN} > an unexpected error inside fn plan exits 1 with CCC_PLANNING_INTERNAL_ERROR, never the non-retryable exit bin gives a unique violation`,
      `${BIN} > bin closes the global revision layers exactly once after every fn plan outcome: a usage error, a success, an unexpected error and a throwing deps factory`,
      `${BIN} > a failing close of the global revision layers never changes the fn plan exit code or its one JSON line`,
    ]),
    platform: "any",
    needsPostgres: false,
    timeoutMs: 120_000,
  }),
]);
