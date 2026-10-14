/*
FNXC:CccPlanningProof 2026-10-14-13:58:
Proof inventory for request-to-code v3 card G1 (store-level planning-task guards, D22, critic 1, challenges 11 and 24). One module per card keeps the inventory files disjoint (contract 0.18); `index.mjs` (owned by P0) loads `cards/*.mjs` in sorted order and rejects duplicate command ids.

TARGETED is file-closed over the card's three check files, one command per package because each runs under its own package filter: the core PostgreSQL file (needs PostgreSQL, `vitest.pg.config.ts`), the engine file (pinned to `engine-default`, whose aliases point @fusion/core at source, so no build runs) and the dashboard file (`dashboard-api-quality-backfill`, the project the card's DASH check names). OFFLINE is name-closed over the same files: the names below are exactly their tests, built the way `assertionName` in `scripts/run-ccc-pg-proof.mjs` builds them (ancestor titles and the title joined by " > "), so a skipped, renamed, missing or extra test fails the command instead of passing quietly. The field is `needsPostgres` (errata E1-1).

Measured on the M5 Max under a load average near 17 (parallel agents): core 8.5 s wall (8 tests), engine 6.5 s (5 tests), dashboard 11.3 s (5 tests), each including transform and import. The command timeouts are hang bounds over those measurements; no test timeout is raised anywhere.
*/

const CORE_FILE = "src/__tests__/postgres/ccc-planning-task-guard.pg.test.ts";
const ENGINE_FILE = "src/__tests__/ccc-planning-triage-guard.test.ts";
const DASH_FILE = "src/routes/__tests__/ccc-planning-task-guard.test.ts";

const CORE = "ccc planning task custody guards (PostgreSQL)";
const PREDICATES = "ccc planning custody predicates";
const TRIAGE = "triage excludes ccc planning tasks";
const DASH = "ccc planning task mutation guard";

const CORE_COMMAND = Object.freeze({
  packageFilter: "@fusion/core",
  project: null,
  config: "vitest.pg.config.ts",
  files: Object.freeze([CORE_FILE]),
  platform: "any",
  needsPostgres: true,
  timeoutMs: 180_000,
});

const ENGINE_COMMAND = Object.freeze({
  packageFilter: "@fusion/engine",
  project: "engine-default",
  config: null,
  files: Object.freeze([ENGINE_FILE]),
  platform: "any",
  needsPostgres: false,
  timeoutMs: 120_000,
});

const DASH_COMMAND = Object.freeze({
  packageFilter: "@fusion/dashboard",
  project: "dashboard-api-quality-backfill",
  config: null,
  files: Object.freeze([DASH_FILE]),
  platform: "any",
  needsPostgres: false,
  timeoutMs: 120_000,
});

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({ id: "g1-core-custody-guards", ...CORE_COMMAND, closure: "files", expectedNames: Object.freeze([]) }),
  Object.freeze({ id: "g1-engine-triage-guard", ...ENGINE_COMMAND, closure: "files", expectedNames: Object.freeze([]) }),
  Object.freeze({ id: "g1-dashboard-mutation-guard", ...DASH_COMMAND, closure: "files", expectedNames: Object.freeze([]) }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "g1-core-custody-guards-names",
    ...CORE_COMMAND,
    closure: "names",
    expectedNames: Object.freeze([
      `${CORE} > moveTask to todo refuses a held planning task with CccPlanningTaskCustodyError and leaves the row unchanged; the twin without an anchor moves`,
      `${CORE} > pauseTask(false) refuses to unpause a held planning task; the twin unpauses`,
      `${CORE} > updateTask writes a summary on a held planning task but refuses paused:false; the twin unpauses`,
      `${CORE} > updateTaskAtomic refuses paused:false on a held planning task through the path that skips updateTaskImpl; the twin unpauses`,
      `${CORE} > updateTask refuses reassigning the agent that paused a held planning task and adding a dependency while it sits in todo; the twin takes both`,
      `${CORE} > a direct updateTaskColumns write of paused is refused for a held planning task; the twin's write lands`,
      `${CORE} > archiveTask refuses a held planning task; the twin archives`,
      `${CORE} > deleteTask refuses a held planning task; the twin deletes`,
    ]),
  }),
  Object.freeze({
    id: "g1-engine-triage-guard-names",
    ...ENGINE_COMMAND,
    closure: "names",
    expectedNames: Object.freeze([
      `${PREDICATES} > isCccCampaignTask(planningTask) stays false while isCccCustodyGuardedTask(planningTask) is true`,
      `${PREDICATES} > treats an absent userPaused as unpaused and leaves a user-paused or unpaused planning lineage unguarded`,
      `${PREDICATES} > keeps guarding imported and profile campaign tasks and leaves an ordinary task unguarded`,
      `${TRIAGE} > discoverReadyPlanningTasks excludes a triage planning task even with paused cleared; the twin without the lineage is included`,
      `${TRIAGE} > discoverReadyPlanningTasks excludes a needs-replan todo planning task with paused cleared; the twin is included`,
    ]),
  }),
  Object.freeze({
    id: "g1-dashboard-mutation-guard-names",
    ...DASH_COMMAND,
    closure: "names",
    expectedNames: Object.freeze([
      `${DASH} > refuses move, unpause, PATCH and delete of a held planning task with 409 naming fn plan; the twin moves`,
      `${DASH} > refuses a mutation when the custody lookup throws (fail-closed); the same request with a working lookup moves`,
      `${DASH} > lets a not-found lookup through, so collection routes under /tasks keep working`,
      `${DASH} > lets a store with no task read through, as the partial stores of route tests are`,
      `${DASH} > lets an ENOENT-coded not-found lookup through, so the route still answers its own 404 for a missing task`,
    ]),
  }),
]);
