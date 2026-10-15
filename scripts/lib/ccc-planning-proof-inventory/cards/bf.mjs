/**
 * FNXC:CccPlanningProofInventory 2026-10-15-11:00: BF caps, D43 outcomes and E18's issued-policy digest handoff.
 * TARGETED includes the five unchanged campaign regressions named by the card. OFFLINE closes over all 38 BF names,
 * including real PostgreSQL rollback/savepoint evidence and unlinked positive controls; no skipped test can satisfy it.
 * The observed two-file run was about 13 seconds and the five regressions about 20 seconds; 120 seconds is a hang bound.
 */

const FILES = Object.freeze([
  "src/__tests__/postgres/ccc-planning-writer-caps.pg.test.ts",
  "src/__tests__/postgres/ccc-planning-campaign-outcome.pg.test.ts"
]);
const REGRESSIONS = Object.freeze([
  "src/__tests__/postgres/ccc-campaign-provider-controller.pg.test.ts",
  "src/__tests__/postgres/ccc-campaign-provider-attempt.pg.test.ts",
  "src/__tests__/postgres/ccc-provider-attempt-effective-route.pg.test.ts",
  "src/__tests__/postgres/workitem-transition-event.pg.test.ts",
  "src/__tests__/postgres/orphan-workitem-cancellation.pg.test.ts"
]);
const EXPECTED_NAMES = Object.freeze([
  "ccc planning linked writer caps (card BF, PostgreSQL) > iteration and dispatch caps > caps a linked writer turn at 11 calls, gives each node attempt its own turn and refuses a 4th distinct attempt",
  "ccc planning linked writer caps (card BF, PostgreSQL) > iteration and dispatch caps > returns the five admitted writer route values as exactly five string keys",
  "ccc planning linked writer caps (card BF, PostgreSQL) > iteration and dispatch caps > refuses a missing or invalid toolset digest before opening a transaction",
  "ccc planning linked writer caps (card BF, PostgreSQL) > run state, control, deadline and runtime > checks runtime, state and control before deadline, and unsettled calls before caps",
  "ccc planning linked writer caps (card BF, PostgreSQL) > run state, control, deadline and runtime > refuses control-pending while the run has a pending cancel",
  "ccc planning linked writer caps (card BF, PostgreSQL) > run state, control, deadline and runtime > rechecks linked control before a reserved replay or direct dispatch can issue a provider permit",
  "ccc planning linked writer caps (card BF, PostgreSQL) > run state, control, deadline and runtime > refuses deadline when the run deadline is 20 s away even though the campaign deadline is a day later",
  "ccc planning linked writer caps (card BF, PostgreSQL) > run state, control, deadline and runtime > refuses run-not-building with RUN_ENDED once the run is accepted and CONTROL_PENDING while it is paused",
  "ccc planning linked writer caps (card BF, PostgreSQL) > run state, control, deadline and runtime > refuses runtime-not-permitted when the registered runtime is not the run's",
  "ccc planning linked writer caps (card BF, PostgreSQL) > run state, control, deadline and runtime > moves the run awaiting_execution_authority to building in the first approved reservation transaction",
  "ccc planning linked writer caps (card BF, PostgreSQL) > refusal recording (item 48) > preserves the original linked refusal when its post-rollback audit transaction fails",
  "ccc planning linked writer caps (card BF, PostgreSQL) > refusal recording (item 48) > records exactly one writer-refused event after the reservation transaction rolls back, on a fresh transaction",
  "ccc planning linked writer caps (card BF, PostgreSQL) > unlinked positive control > keeps the unlinked reservation sequence byte-identical and writes no planning rows",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > D43 rows > operator pause moves building to paused",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > D43 rows > operator resume moves paused to building only when before.blockedReason was the pause reason",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > D43 rows > operator stop moves the current state to cancelled through cancelling and clears control_request",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > D43 rows > in-lease cancel moves the current state to cancelled and clears control_request",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > D43 rows > every item succeeded with an accepted final_judgment moves building to accepted",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > D43 rows > every item succeeded without a final_judgment moves building to failed FINAL_JUDGMENT_MISSING",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > D43 rows > a rejected task_review then item failed moves building to verification_failed",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > D43 rows > a dispatch-cap refusal then item failed moves building to budget_exhausted DISPATCH_CAP",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > D43 rows > a route refusal then item failed moves building to blocked_provider PIN_DRIFT",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > D43 rows > maps every remaining budget and provider refusal code with the same terminal-state rules",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > D43 rows > a dispatched_unknown linked attempt then item manual-required moves building to unknown_effect",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > D43 rows > a writer closure that is unconfirmed moves building to blocked_prerequisite",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > D43 rows > a pending cancel or a control-pending refusal ends the run cancelled, never CAMPAIGN_FAILED",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > D43 rows > any other failure moves building or awaiting_execution_authority to failed CAMPAIGN_FAILED",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > D43 rows > pins the pause reason the mapping reads to the engine operator constant",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > savepoint, rollback and L1-only writes > leaves cancellation pending while a linked provider effect is unsettled and completes it after settlement",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > savepoint, rollback and L1-only writes > a transition the anchor does not allow leaves it unchanged, writes campaign-unmapped and commits the item",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > savepoint, rollback and L1-only writes > an SQL error inside the mapping body is contained by its savepoint",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > savepoint, rollback and L1-only writes > an outer rollback after the mapping leaves no anchor change and no state event",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > savepoint, rollback and L1-only writes > reaches the anchor only through L1's two within functions",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > savepoint, rollback and L1-only writes > maps the success row to cancelling while a cancel is pending",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > reconcile > keeps a known route-refusal settlement when cancellation races its run-state mapping",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > reconcile > moves the run to blocked_provider in the reconcile transaction for an effective-route-drift refusal",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > reconcile > reconcileCccPlanningCampaignOutcome maps item states written outside the hook, idempotently",
  "ccc planning campaign outcome mapping (card BF, PostgreSQL) > unlinked positive control > gives an unlinked campaign the same work-item results and no planning rows"
]);

const BASE = Object.freeze({
  packageFilter: "@fusion/core", project: null, config: "vitest.pg.config.ts",
  platform: "any", needsPostgres: true, timeoutMs: 120_000,
});

export const TARGETED = Object.freeze([Object.freeze({
  ...BASE, id: "bf-linked-writer-and-outcomes", files: Object.freeze([...FILES, ...REGRESSIONS]),
  closure: "files", expectedNames: Object.freeze([]),
})]);

export const OFFLINE = Object.freeze([Object.freeze({
  ...BASE, id: "bf-linked-writer-and-outcomes-names", files: FILES,
  closure: "names", expectedNames: EXPECTED_NAMES,
})]);
