/*
FNXC:CccPlanningProofInventory 2026-10-15-05:40:
AU2's real PostgreSQL release proof (CONTRACT-v3.5 section 2.18, D36, challenge 33; E18 clarifies that native issuance
may create pending rows on refusal, but no authority is approved or claimed). The native importer and IM1 build the
linked campaign; the tests read authorization parents, child approvals, leases, artifacts and state events back from
PostgreSQL. The exact path has one sealed parent and two child approvals, one per compiled provider member. Every
refusal includes an exact-envelope positive control. No provider request is dispatched.

The canonical-path full-file behavioral RED ran all seven names, failed all seven on the missing release behavior,
and skipped none (27.83 s wall, 25.58 s test time on the M5 Max). The command timeout is a hang bound; no test timeout is widened.
TARGETED closes the file; OFFLINE closes the exact ancestor/title names below. The project is explicitly engine-default,
so the engine-slow project's separate alias/configuration cannot duplicate or hide this card's seven cases.
*/
const FILE = "src/__tests__/ccc-planning-live-execution-release.real-pg.test.ts";
const SUITE = "ccc planning live-execution release (card AU2, PostgreSQL)";
const command = {
  packageFilter: "@fusion/engine", project: "engine-default", config: null, files: Object.freeze([FILE]),
  platform: "any", needsPostgres: true, timeoutMs: 120_000,
};

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({ ...command, id: "au2-live-execution-release", closure: "files", expectedNames: Object.freeze([]) }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({ ...command, id: "au2-live-execution-release-names", closure: "names", expectedNames: Object.freeze([
    `${SUITE} > releases an exact controller envelope with a system actor and one durable release, then replays unchanged`,
    `${SUITE} > refuses a MiniMax member without a claimed approval or release; an exact Flash member releases`,
    `${SUITE} > requires the operator when the receipt release is absent`,
    `${SUITE} > requires the operator when the receipt release is operator_confirm_after_import`,
    `${SUITE} > replays a crash after issued to one sealed approval, one artifact and one state transition`,
    `${SUITE} > replays a crash after approved to one sealed approval, one artifact and one state transition`,
    `${SUITE} > replays a crash after published to one sealed approval, one artifact and one state transition`,
  ]) }),
]);
