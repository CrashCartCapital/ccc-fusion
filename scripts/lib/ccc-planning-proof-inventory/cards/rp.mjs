/*
FNXC:CccPlanningProofInventory 2026-10-14-18:53:
Proof inventory for request-to-code v3 card RP (versioned role prompts for every FULL-v2 role and the three preflight probe roles, PRD section 4, D47). Card RP owns exactly this module; the inventory index (card P0) loads every cards/*.mjs in sorted order and rejects duplicate command ids.

TARGETED is file-closed over the card's one check file. OFFLINE is name-closed over the same file: the names below are exactly its tests, built the way `assertionName` in `scripts/run-ccc-pg-proof.mjs` builds them (ancestor titles and the title joined by " > "), so a skipped, renamed, missing or extra test fails the command instead of passing quietly. The engine command is pinned to `engine-default`, whose aliases point @fusion/core at source, so no build runs. The file is pure: no PostgreSQL, no network, no process spawn; `needsPostgres` is false and `platform` is any. The names stay ASCII so they compare byte for byte.

Measured on the M5 Max with other agents running heavy suites (load average about 10): 3 s wall for the whole Vitest command and 2.1 s of Vitest time, 23 tests, 0 failed, 0 skipped. The 60 s command timeout is a hang bound at 20 times that; no test timeout is raised anywhere.
*/

const FILE = "src/__tests__/ccc-planning-prompts.test.ts";
const SUITE = "ccc planning role prompts";

const COMMAND = Object.freeze({
  packageFilter: "@fusion/engine",
  project: "engine-default",
  config: null,
  files: Object.freeze([FILE]),
  platform: "any",
  needsPostgres: false,
  timeoutMs: 60_000,
});

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({ id: "rp-role-prompts", ...COMMAND, closure: "files", expectedNames: Object.freeze([]) }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "rp-role-prompts-names",
    ...COMMAND,
    closure: "names",
    expectedNames: Object.freeze([
      `${SUITE} > covers every FULL-v2 role and probe role with a versioned prompt and a 64-hex digest`,
      `${SUITE} > gives each probe role one prompt per preflight probe and every other role a single main prompt`,
      `${SUITE} > derives each digest from the version, role id, inputs and template with a documented sha256 form`,
      `${SUITE} > keeps a role digest equal across two builds of the table and reports it through the identity lookup`,
      `${SUITE} > changes a role digest when one byte of any of its templates changes and leaves every other digest alone`,
      `${SUITE} > changes a role digest when its version or a declared input changes`,
      `${SUITE} > names only ccc_submit_verdict in critic prompts, except the probe critic that also exercises the probe tool`,
      `${SUITE} > names a tool in backticks only when the role's closed toolset allows it`,
      `${SUITE} > tells author and researcher roles to submit only artifact kinds their stage publishes`,
      `${SUITE} > requires one decision_record per objection input in the spec author prompt and in no other prompt`,
      `${SUITE} > embeds content examples that pass the core schema validators, and the validators refuse a corrupted copy`,
      `${SUITE} > declares every template placeholder as an input, uses each input once, and has no stray braces`,
      `${SUITE} > refuses at build time an undeclared placeholder, an unused input, a stray brace pair and a JavaScript placeholder`,
      `${SUITE} > refuses at build time duplicate or unknown roles and a version that does not name its role`,
      `${SUITE} > renders each prompt as its template with only the declared inputs filled in`,
      `${SUITE} > renders byte-identical output under another clock, environment and random source`,
      `${SUITE} > refuses a packet with an undeclared key, a missing key or a malformed value, and an unknown role or variant`,
      `${SUITE} > inserts a packet value that looks like a placeholder literally instead of expanding it`,
      `${SUITE} > gives the prompt set digest a documented form that ignores source order and moves with one byte`,
      `${SUITE} > keeps the two designers blind to each other and gives each design reviewer exactly one design input`,
      `${SUITE} > makes each probe prompt exercise exactly one tool and end after one call`,
      `${SUITE} > sizes planner tasks to the call cap and names fn_complete_phase only in the implementation writer prompt`,
      `${SUITE} > keeps every template ASCII with LF line ends and shows critics no earlier verdict`,
    ]),
  }),
]);
