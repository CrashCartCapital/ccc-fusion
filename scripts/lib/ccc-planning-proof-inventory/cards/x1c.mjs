/*
FNXC:CccPlanningProofInventory 2026-10-14-15:35:
Proof inventory for request-to-code v3 card X1c (errata E4, item 10; errata
E2-81). One module per card keeps the inventory files disjoint (contract 0.18);
`index.mjs` (owned by P0) loads `cards/*.mjs` in sorted order.

`ccc-confined-denied-names.test.ts` is the consistency check INT-1 promised:
every name in K1's `CCC_PLANNING_DENIED_NAMES` is matched by the confined
shell's effective denied names with no caller names, and the shared write
predicate refuses each of them. It needs no sandbox and no PostgreSQL, so it is
tagged `platform: "any"` and also runs in the ci-linux lane. Both lists are
name-closed: the names below are exactly the tests in the file, joined the way
`assertionName` in `scripts/run-ccc-pg-proof.mjs` joins them (ancestor titles
and the title with " > "), so a skipped, renamed, missing or extra test fails.
The file runs in about 2 s on the M5 Max; the 120 s command timeout is a hang
bound for vitest start-up on a loaded host, not a test timeout.
*/

const SUITE = "CCC confined-shell denied names cover K1's planning denied names (E2-81)";

const NAMES = Object.freeze([
  `${SUITE} > matches every K1 CCC_PLANNING_DENIED_NAMES entry, .envrc included, in cccConfinedEffectiveDeniedNames with no caller names`,
  `${SUITE} > refuses a write through any K1 denied name as the basename or a directory segment with no caller names, while a near-miss name is admitted`,
]);

function deniedNamesCommand(id) {
  return Object.freeze({
    id,
    packageFilter: "@fusion/engine",
    project: "engine-default",
    config: null,
    files: Object.freeze(["src/__tests__/ccc-confined-denied-names.test.ts"]),
    closure: "names",
    expectedNames: NAMES,
    platform: "any",
    needsPostgres: false,
    timeoutMs: 120_000,
  });
}

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([deniedNamesCommand("x1c-denied-names")]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([deniedNamesCommand("x1c-denied-names-offline")]);
