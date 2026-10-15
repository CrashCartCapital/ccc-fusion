/*
FNXC:CccPlanningProof 2026-10-14-22:31:
Proof inventory for request-to-code v3 card H1 (native host: planning custody in the work processor and the task runtime,
the stage controller, engine-start recovery and the running-runtime digest; CONTRACT-v3.4 sections 2.3, 2.10, 2.11, 2.12,
2.16, D1-D3, D40, D44, D45, errata E8-W3). One module per card keeps the inventory files disjoint; `index.mjs` loads
`cards/*.mjs` in sorted order and rejects duplicate command ids.

TARGETED is file-closed over the card's check files, split by PostgreSQL need so the runner's skip flag reaches only the
offline files: the unit host file with the pre-existing `workflow-work-processor.test.ts` (no PostgreSQL), and the
real-pg host file (needs PostgreSQL). Both are pinned to `engine-default`, whose aliases point @fusion/core at source,
so no build runs. OFFLINE is name-closed over the two files H1 owns: the names below are exactly their tests, built the
way `assertionName` in `scripts/run-ccc-pg-proof.mjs` builds them (ancestor titles and the title joined by " > "), so a
skipped, renamed, missing or extra test fails the command. `workflow-work-processor.test.ts` is not H1's suite, so it is
file-closed only.

Measured on the M5 Max at load average about 8.7 (1 min, parallel agents): unit command 6 s wall (2 files, 54 tests),
PostgreSQL command 4 s wall (6 tests), each including transform and import. The 180 s command timeouts are hang bounds
over those measurements; no test timeout is raised anywhere.

FNXC:CccPlanningProof 2026-10-14-23:24:
W3 repair 1 adds the unit names 12b-12e, 18b, 8c, 8d and the in-process runtime wiring names 13 and 14, and the
PostgreSQL names 16, 16b, 17, 17b, 18, 19 and 15 (15 runs last in its file because the file shares one database).
Re-measured at load average about 7.6 (1 min, parallel agents): unit command 5 s wall (2 files, 63 tests), PostgreSQL
command 7 s wall (13 tests). The 180 s hang bounds stay.
*/

const UNIT_FILE = "src/__tests__/ccc-planning-host.test.ts";
const PG_FILE = "src/__tests__/ccc-planning-host.real-pg.test.ts";
const PROCESSOR_FILE = "src/__tests__/workflow-work-processor.test.ts";

const UNREGISTERED = "ccc planning host before a runtime is registered (D44)";
const REGISTERED = "ccc planning host with a registered runtime";
const WATCHDOG = `${REGISTERED} > session watchdog (D40)`;
const ROUTE = `${REGISTERED} > provider route refusal (verify-v2 item 42, E8-W3)`;
const DIGEST = `${REGISTERED} > runtime dist manifest digest (D44, ADR D algorithm)`;
const WIRING = `${REGISTERED} > in-process runtime wiring`;
const PG = "ccc planning host (card H1, PostgreSQL)";

const ENGINE = Object.freeze({
  packageFilter: "@fusion/engine",
  project: "engine-default",
  config: null,
  platform: "any",
  timeoutMs: 180_000,
});

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({
    id: "h1-engine-host",
    ...ENGINE,
    files: Object.freeze([UNIT_FILE, PROCESSOR_FILE]),
    needsPostgres: false,
    closure: "files",
    expectedNames: Object.freeze([]),
  }),
  Object.freeze({
    id: "h1-engine-host-pg",
    ...ENGINE,
    files: Object.freeze([PG_FILE]),
    needsPostgres: true,
    closure: "files",
    expectedNames: Object.freeze([]),
  }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "h1-engine-host-names",
    ...ENGINE,
    files: Object.freeze([UNIT_FILE]),
    needsPostgres: false,
    closure: "names",
    expectedNames: Object.freeze([
      `${UNREGISTERED} > H1 RED 6b: an unregistered runtime digest parks an admitted run in blocked_prerequisite before any stage`,
      `${UNREGISTERED} > H1 runtime digest: a source run (distRoot null) registers nothing`,
      `${REGISTERED} > H1 RED 1: a planning item runs the twelve stages in order under one lease`,
      `${REGISTERED} > H1 control: the same planning fixture claimed under campaign custody still fails as campaign custody missing`,
      `${REGISTERED} > H1 RED 2: lease loss mid-stage aborts and settles in the order cancelAll, flush, release, completeCancellation`,
      `${REGISTERED} > H1 RED 4: a dispatched_unknown call moves the run to unknown_effect at the next stage start and is never re-dispatched`,
      `${REGISTERED} > H1 RED 5: a pending pause is applied at the next stage boundary`,
      `${REGISTERED} > H1 RED 5b: a pending cancel at a stage boundary settles the run and L1 completes the cancellation`,
      `${REGISTERED} > H1 RED 6a: a registered runtime digest different from the run's parks an admitted run before any stage`,
      `${REGISTERED} > H1 RED 7: a stored IR altered by one node config fails the run with WORKFLOW_IR_DRIFT`,
      `${REGISTERED} > H1 RED 7b: a work item irHash that is not the K1 digest fails the run with WORKFLOW_IR_DRIFT`,
      `${REGISTERED} > H1 RED 12: a planning node gets exactly one attempt (maxRetriesPerNode 1), never an executor retry`,
      `${REGISTERED} > H1 RED 12b: a runtime rejection moves the run to failed before the work item fails`,
      `${REGISTERED} > H1 RED 12c: a host failure while a pause is pending applies the pause and holds the item, never failed`,
      `${REGISTERED} > H1 RED 12d: a host failure while a cancel is pending settles the cancel and L1 completes it`,
      `${REGISTERED} > H1 RED 12e: when L1 cannot be reached to fail the run, the item is released to runnable, never failed or held`,
      `${REGISTERED} > H1 RED 18b: a park whose pair the host may not take from a startable state fails the run instead of holding it`,
      `${WATCHDOG} > H1 RED 8a: a stage that runs four 20-minute sessions is not killed`,
      `${WATCHDOG} > H1 RED 8b: a single 31-minute session attempt is killed at 30 minutes`,
      `${WATCHDOG} > H1 RED 8c: a session open that hangs past 30 minutes is killed at 30 minutes and its late session disposed`,
      `${WATCHDOG} > H1 RED 8d: control, a 20-minute session open is not killed and the stage runs`,
      `${ROUTE} > H1 RED 11: a session that throws CccProviderRouteReceiptError after settlement yields blocked with one state event`,
      `${ROUTE} > H1 RED 11b: a stage that swallows the route refusal still yields blocked with one state event`,
      `${DIGEST} > H1 runtime digest: sha256 of canonical sorted [relPath, sha256] over dist/**/*.js`,
      `${WIRING} > H1 RED 13: the drain dispatches a lease-expired planning item behind 25 older lease-expired running items under planning custody`,
      `${WIRING} > H1 RED 14: start() registers its own runtime digest and runs planning recovery with the wired linked-outcome ports`,
    ]),
  }),
  Object.freeze({
    id: "h1-engine-host-pg-names",
    ...ENGINE,
    files: Object.freeze([PG_FILE]),
    needsPostgres: true,
    closure: "names",
    expectedNames: Object.freeze([
      `${PG} > H1 RED 3: an expired lease is reclaimed by the existing acquire path and the next stage runs`,
      `${PG} > H1 control: a live lease held by another engine is not reclaimed and no stage runs`,
      `${PG} > H1 RED 3b: recovery.ts contains no requeue of planning work`,
      `${PG} > H1 RED 9: at engine start a cancelling run whose lease expired ends cancelled`,
      `${PG} > H1 recovery: a running run with a dispatched_unknown call and no live holder moves to unknown_effect`,
      `${PG} > H1 RED 10: recovery calls reconcileLinkedOutcome once per linked run, never for an unlinked one; without ports it reports none`,
      `${PG} > H1 RED 16: one transient ledger read failure moves the run to failed before the item fails`,
      `${PG} > H1 RED 16b: when L1 cannot be reached to fail the run, the item is released and a later operator cancel completes`,
      `${PG} > H1 RED 17: a stored workflow IR that no longer parses fails the run with WORKFLOW_IR_DRIFT`,
      `${PG} > H1 RED 17b: a deleted workflow definition fails the run with WORKFLOW_IR_DRIFT`,
      `${PG} > H1 RED 18: a refused awaiting-intent park fails the run instead of holding the item behind a running run`,
      `${PG} > H1 RED 19: an operator cancel landing between the park and the item release ends cancelled without a restart`,
      `${PG} > H1 RED 15: one run refused at engine start does not stop recovery of the runs after it`,
    ]),
  }),
]);
