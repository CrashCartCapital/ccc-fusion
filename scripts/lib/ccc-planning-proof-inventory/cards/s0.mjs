/*
FNXC:CccPlanningProof 2026-10-14-09:00:
Proof inventory for request-to-code v3 card S0 (migrations 0042 and 0043, applier registration, Drizzle mirror, run-audit `eventId`, D4/D6/D7/D39). One module per card keeps the inventory files disjoint (contract 0.18); `index.mjs` (owned by P0) loads `cards/*.mjs` in sorted order and rejects duplicate command ids.

TARGETED is file-closed over the six files of the card's check command: the five of the contract plus `ccc-prd-import-migration.pg.test.ts`, which errata E1-16 hands to S0 because it drops `project.ccc_prd_imports` and replays the migrations after it. The check includes the three existing registry files whose ceiling pins S0 moves to 0043. OFFLINE is name-closed over the two new files: the names below are exactly their tests, built the way `assertionName` in `scripts/run-ccc-pg-proof.mjs` builds them (ancestor titles and the title joined by " > "), so a skipped, renamed, missing or extra test fails the command.

Every entry needs PostgreSQL: each file declares `pgDescribe` blocks, and the pure registration and literal tests ride in the same files. The field is `needsPostgres` (errata E1-1 replaces the contract's `needsPg` everywhere).

Measured on the M5 Max under a load average near 15 (parallel agents), FNXC:CccPlanningProof 2026-10-14-13:56 (final repair, errata E2-60 to E2-65): 41 s wall for the six files (130 tests) and 12 s for the two new files (40 tests). The repair before it measured 39 s and 5 s for 116 and 26 tests, and the first build 70.8 s and 11 s under a load average near 20. The command timeouts are hang bounds over those measurements; no test timeout is raised anywhere.
*/

const CHECK_FILES = Object.freeze([
  "src/__tests__/postgres/ccc-planning-migration.pg.test.ts",
  "src/__tests__/postgres/run-audit-event-id.pg.test.ts",
  "src/__tests__/postgres/schema-applier.test.ts",
  "src/__tests__/postgres/ccc-campaign-semantic-proof-v2-migration.pg.test.ts",
  "src/__tests__/postgres/ccc-campaign-execution-authorization-migration.pg.test.ts",
  "src/__tests__/postgres/ccc-prd-import-migration.pg.test.ts",
]);

const MIGRATION = "ccc planning migrations 0042 and 0043 (PostgreSQL)";
const FRESH = "ccc planning migration 0042: fresh database ownership audit";
const REGISTRATION = "ccc planning migrations 0042 and 0043: registration";
const LITERALS = "run-audit planning literals";
const EVENT_ID = "run-audit deterministic planning event ids (PostgreSQL)";

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({
    id: "s0-planning-migrations",
    packageFilter: "@fusion/core",
    project: null,
    config: "vitest.pg.config.ts",
    files: CHECK_FILES,
    closure: "files",
    expectedNames: Object.freeze([]),
    platform: "any",
    needsPostgres: true,
    timeoutMs: 300_000,
  }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "s0-planning-migrations-names",
    packageFilter: "@fusion/core",
    project: null,
    config: "vitest.pg.config.ts",
    files: Object.freeze([CHECK_FILES[0], CHECK_FILES[1]]),
    closure: "names",
    expectedNames: Object.freeze([
      `${MIGRATION} > 0042 ownership > refuses an anchor naming a task that exists only in another project; the same-project anchor is admitted`,
      `${MIGRATION} > 0042 anchor guard > the transition function admits exactly the 65 frozen pairs plus identity over all 400 pairs`,
      `${MIGRATION} > 0042 anchor guard > refuses planning_spent 3 -> 2 with COUNTER_DECREASE; 3 -> 4 is admitted`,
      `${MIGRATION} > 0042 anchor guard > refuses a spend while control_request is 'pause' with SPEND_REFUSED; the same spend without a control request is admitted`,
      `${MIGRATION} > 0042 anchor guard > refuses cancelled -> running with RUN_TERMINAL; paused -> running is admitted`,
      `${MIGRATION} > 0042 anchor guard > refuses running -> importing with STATE_TRANSITION_REFUSED; admitted -> blocked_prerequisite and spec_ready -> importing -> budget_exhausted are admitted`,
      `${MIGRATION} > 0042 anchor guard > refuses stagnant_epochs +1 without review_epochs +1 with REVIEW_EPOCH_INVALID; both +1 is admitted`,
      `${MIGRATION} > 0042 anchor guard > refuses SET project_id = NULL that the assign trigger resolves to another project with ANCHOR_IMMUTABLE; the explicit project change is refused alike and NULL under the anchor's own project is admitted`,
      `${MIGRATION} > 0042 anchor guard > refuses a NULL project_id that reaches the guard with ANCHOR_IMMUTABLE even when no trigger fills it in; the unchanged project_id is admitted`,
      `${MIGRATION} > 0042 deadline check > refuses the relative or unbounded deadline_at 'tomorrow' on insert with the deadline check; an ISO toISOString() deadline is admitted`,
      `${MIGRATION} > 0042 deadline check > refuses the relative or unbounded deadline_at 'infinity' on insert with the deadline check; an ISO toISOString() deadline is admitted`,
      `${MIGRATION} > 0042 deadline check > refuses an enlarging amendment whose deadline_at is 'infinity' with the deadline check; the same amendment with an ISO deadline is admitted`,
      `${MIGRATION} > 0042 partition promotion > promotes a stand-in partition holding one ccc_prd_imports row and no planning run, with 0042 and 0043 present; the row moves to the registered id`,
      `${MIGRATION} > 0042 partition promotion > refuses to promote a stand-in partition holding a planning anchor with planning-rows-present and moves nothing; the same partition without the anchor is promoted`,
      `${MIGRATION} > 0042 partition promotion > refuses to promote a stand-in partition holding a cccplan- document and no anchor with planning-rows-present; the same partition without the document is promoted`,
      `${MIGRATION} > 0042 runtime privileges > refuses a delete-and-reinsert counter reset as fusion_runtime with SQLSTATE 42501; the same role's spend UPDATE on the same row is admitted`,
      `${MIGRATION} > 0042 runtime privileges > refuses DELETE and TRUNCATE of the anchor as fusion_runtime with SQLSTATE 42501; SELECT, INSERT and UPDATE by the same role are admitted`,
      `${MIGRATION} > 0043 artifact guard > refuses a reserved-key insert without the publisher GUC with PUBLISHER_REQUIRED; the same insert with it is admitted`,
      `${MIGRATION} > 0043 artifact guard > refuses a design_alternative whose closure holds another one with DESIGN_SEAL_BROKEN, directly and through a review; a closure without one is admitted`,
      `${MIGRATION} > 0043 artifact guard > refuses UPDATE and DELETE of a planning artifact with IMMUTABLE; the same writes on an ordinary document are admitted`,
      `${MIGRATION} > 0043 artifact guard > refuses an operator fence with a stale controlSeq with FENCE_REFUSED; the current controlSeq is admitted`,
      `${MIGRATION} > 0043 artifact guard > refuses a campaign fence whose runId is not ccc-prd:<import_id> with FENCE_REFUSED; the campaign's own lease is admitted`,
      `${FRESH} > a fresh database applies 0000-0043, boots a second time through the ownership audit, and the audit refuses the anchor once its policy or key scoping is broken`,
      `${REGISTRATION} > registers 0042 and 0043 in order after 0041 and advances the ceiling to 0043`,
      `${REGISTRATION} > lists ccc_planning_runs among the project-owned tables and mirrors the composite keys in Drizzle`,
      `${LITERALS} > RunAuditMutationType names exactly the 19 ccc-planning audit literals`,
      `${EVENT_ID} > replays one eventId at a later timestamp as one row and returns the first persisted event`,
      `${EVENT_ID} > throws RunAuditEventCollisionError when the same eventId carries a different metadata, and keeps the first row`,
      `${EVENT_ID} > throws RunAuditEventCollisionError when the same eventId carries a different agentId, and keeps the first row`,
      `${EVENT_ID} > throws RunAuditEventCollisionError when the same eventId carries a different target, and keeps the first row`,
      `${EVENT_ID} > replays inside one caller transaction under an explicit projectId and re-reads that project's row`,
      `${EVENT_ID} > refuses a malformed eventId before writing anything; the well-formed id is admitted`,
      `${EVENT_ID} > refuses an eventId combined with a campaign event key; the campaign path alone is unchanged and still compares timestamps`,
      `${EVENT_ID} > replays an exact event whose optional metadata fields are undefined as the persisted event, with those fields dropped as jsonb drops them`,
      `${EVENT_ID} > refuses a Date in metadata on the first write with no row written; the same event with JSON values is admitted`,
      `${EVENT_ID} > refuses a BigInt in metadata on the first write with no row written; the same event with JSON values is admitted`,
      `${EVENT_ID} > refuses a non-finite number in metadata on the first write with no row written; the same event with JSON values is admitted`,
      `${EVENT_ID} > refuses an undefined array element in metadata on the first write with no row written; the same event with JSON values is admitted`,
      `${EVENT_ID} > refuses a class instance in metadata on the first write with no row written; the same event with JSON values is admitted`,
      `${EVENT_ID} > without an eventId the legacy path is unchanged: each call writes its own random id`,
    ]),
    platform: "any",
    needsPostgres: true,
    timeoutMs: 180_000,
  }),
]);
