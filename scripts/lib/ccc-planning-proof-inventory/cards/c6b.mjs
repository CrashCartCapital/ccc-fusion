/*
FNXC:CccPlanningProof 2026-10-14-07:05:
Proof inventory for request-to-code v3 card C6b (custom provider `modelSync` opt-out, PRD §8, D27). One module per card keeps the inventory files disjoint, so no parent-owned registry edit is needed (contract 0.18); `index.mjs` (owned by P0) loads `cards/*.mjs` in sorted order and rejects duplicate command ids.

The list is name-closed: the nine names below are exactly the tests in the file, built the way `assertionName` in `scripts/run-ccc-pg-proof.mjs` builds them (ancestor titles and the title joined by " > "). A skipped, pending, todo, renamed, missing or extra test therefore fails the command instead of passing quietly.

Contract gap (reported to the parent, not patched here): `ClosedSuiteCommand.packageFilter` is declared as "@fusion/core" | "@fusion/engine" | "@runfusion/fusion" | "node-test", and `project` as "engine-default" | "engine-slow" | null. Neither can name the dashboard package or its `dashboard-api-quality-backfill` Vitest project, which is where this card's contract check runs (`DASH`). This module uses the two literal values the check command needs; P0 widens the union and the runner's package-to-argv mapping.
*/

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({
    id: "c6b-custom-provider-model-sync",
    packageFilter: "@fusion/dashboard",
    project: "dashboard-api-quality-backfill",
    config: null,
    files: Object.freeze(["src/routes/__tests__/custom-provider-model-sync.test.ts"]),
    closure: "names",
    expectedNames: Object.freeze([
      'custom provider modelSync opt-out > refresh-all (serve-start and Settings refresh) > leaves an opt-out provider byte-identical, counts it as skipped, and never probes its endpoint',
      'custom provider modelSync opt-out > refresh-all (serve-start and Settings refresh) > writes nothing and invalidates no cache when every provider opts out',
      'custom provider modelSync opt-out > refresh-all (serve-start and Settings refresh) > does not treat any value other than the literal "disabled" as an opt-out',
      'custom provider modelSync opt-out > single-provider refresh route > returns 409 for an opt-out provider without probing or writing, while the control refreshes',
      'custom provider modelSync opt-out > single-provider refresh route > refuses to persist a catalog when the provider opts out while the probe is in flight',
      'custom provider modelSync opt-out > create and update parsers carry the field > POST persists and echoes modelSync: "disabled"; a body without it stays without it',
      'custom provider modelSync opt-out > create and update parsers carry the field > PUT keeps modelSync from the body and an unrelated edit does not erase a stored one',
      'custom provider modelSync opt-out > create and update parsers carry the field > POST rejects a modelSync value other than "disabled"',
      'custom provider modelSync opt-out > create and update parsers carry the field > PUT rejects a modelSync value other than "disabled"',
    ]),
    platform: "any",
    needsPostgres: false,
    // Measured on the M5 Max: about 6.2 s wall for the file including transform and import. This is a hang bound, not a test timeout.
    timeoutMs: 120_000,
  }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([]);
