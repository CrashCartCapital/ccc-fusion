/*
FNXC:CccPlanningProofInventory 2026-10-14-13:50:
Proof inventory for request-to-code v3 card A1 (planning artifact ops, CONTRACT-v3 section 2.6, decision D6, and the `cleanupArchivedTasksImpl` hunk). One module per card keeps the inventory files disjoint (contract 0.18); `index.mjs` (owned by P0) loads `cards/*.mjs` in sorted order and rejects duplicate command ids.

TARGETED is file-closed over the card's single test file. OFFLINE is name-closed over the same file: the 17 names below are exactly its tests, built the way `assertionName` in `scripts/run-ccc-pg-proof.mjs` builds them (ancestor titles and the title joined by " > "), so a skipped, renamed, missing or extra test fails the command instead of passing quietly. The five REDs of the contract card are the 1st, 2nd, 5th, 9th and 17th names; the other twelve cover the publisher steps the contract orders (validation, task and lease locks, input verification, the savepointed insert, the audit event), the read, list and closure functions, the three fence kinds the trigger knows, and project scoping.

The file needs PostgreSQL: its single describe is the harness `pgDescribe`, and it runs as the application role (`fusion_runtime`) bound to one project so row-level security and the 0043 trigger are live. The field is `needsPostgres` (errata E1-1). Core has no Vitest projects, so `project` is null, and the PostgreSQL config is `vitest.pg.config.ts`.

The existing archive-cleanup regression test (`store-sqlite-residue-fixes.pg.test.ts`) is not listed here: it is an outside regression check, not a file this card owns.

Measured on the M5 Max under a load average near 25 (parallel agents), FNXC:CccPlanningProofInventory 2026-10-14-13:50: about 7 to 8 s wall for the file (17 tests, about 3 to 4 s of Vitest time). The 120 s command timeouts are hang bounds over that measurement; no test timeout is raised anywhere.
*/

const FILE = "src/__tests__/postgres/ccc-planning-artifacts.pg.test.ts";

const SUITE = "ccc planning artifact ops (PostgreSQL)";
const PUBLISH = `${SUITE} > publish and replay`;
const READ = `${SUITE} > read, list and closure`;
const STEPS = `${SUITE} > publication steps`;
const CLEANUP = `${SUITE} > archive cleanup`;

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({
    id: "a1-artifact-ops",
    packageFilter: "@fusion/core",
    project: null,
    config: "vitest.pg.config.ts",
    files: Object.freeze([FILE]),
    closure: "files",
    expectedNames: Object.freeze([]),
    platform: "any",
    needsPostgres: true,
    timeoutMs: 120_000,
  }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "a1-artifact-ops-names",
    packageFilter: "@fusion/core",
    project: null,
    config: "vitest.pg.config.ts",
    files: Object.freeze([FILE]),
    closure: "names",
    expectedNames: Object.freeze([
      `${PUBLISH} > republishing the same identity returns replayed: true, leaves one row and one audit event; a first publish of a new key reads back with the same digest`,
      `${PUBLISH} > gives SLOT_CONFLICT for the same key with a different identity and keeps the first row; the next version slot is admitted`,
      `${PUBLISH} > serialises concurrent publishes of one key: equal identities give one insert and one replay, different identities one winner and a SLOT_CONFLICT`,
      `${PUBLISH} > sorts and de-duplicates inputs before hashing, so input order never changes the identity; one key with two digests is refused`,
      `${READ} > gives DIGEST_MISMATCH when expectedDigest differs on read; the stored digest reads back, a missing key is null and a non-planning key is refused`,
      `${READ} > gives DIGEST_MISMATCH when the stored text no longer hashes to its envelope digest, even without an expectedDigest`,
      `${READ} > lists only the task's planning artifacts, in key order, with their envelopes`,
      `${READ} > resolves the transitive input closure of its roots, roots included, sorted and unique; an unpublished or wrong-digest root is refused`,
      `${STEPS} > resets the publisher GUC after a publish inside a shared transaction, so a raw reserved-key insert in the same transaction is refused with PUBLISHER_REQUIRED`,
      `${STEPS} > maps a trigger refusal to its typed refusal, writes nothing for it, and leaves the shared transaction usable`,
      `${STEPS} > refuses a stale, expired or reclaimed work item lease with FENCE_REFUSED, replays included; the live lease is admitted`,
      `${STEPS} > validates the envelope before touching the database: stage and kind, model producer receipt, input digests; the valid input is admitted`,
      `${STEPS} > gives SLOT_CONFLICT when a concurrent publication took the key after this snapshot, and the shared transaction stays usable; a different slot is admitted`,
      `${STEPS} > publishes under the operator fence at the current controlSeq and refuses a stale one with FENCE_REFUSED`,
      `${STEPS} > publishes a g7 review under the campaign item's lease, and refuses a lease on another import's run or a fence that names the planning run`,
      `${STEPS} > keeps the layer's project: another project's layer neither reads, lists nor publishes this task's artifacts; the owning layer does`,
      `${CLEANUP} > archive cleanup of an archived planning task does not throw and keeps its artifacts; an archived ordinary task is still cleaned up`,
    ]),
    platform: "any",
    needsPostgres: true,
    timeoutMs: 120_000,
  }),
]);
