/*
FNXC:CccPlanningProofInventory 2026-10-14-22:53:
Proof inventory for request-to-code v3 card IM1 (the import intent and the import link, CONTRACT-v3.5 section 2.11, D16, D17). One module per card keeps the inventory files disjoint (contract 0.18); `index.mjs` (owned by P0) loads `cards/*.mjs` in sorted order and rejects duplicate command ids.

TARGETED is file-closed over the card's single test file. OFFLINE is name-closed over the same file: the names below are exactly its tests, built the way `assertionName` in `scripts/run-ccc-pg-proof.mjs` builds them (ancestor titles and the title joined by " > "), so a skipped, renamed, missing or extra test fails the command instead of passing quietly. The card's REDs are the 2nd (a failing `beforeArtifact` hook leaves no intent digest, and while it runs the anchor CAS is the one uncommitted write), the 3rd (a refused import_intent publication rolls the CAS back whatever the hook order), the 4th (a second digest is IMPORT_LINK_WRITE_ONCE), the 5th (maxDurationMs 1 ms off the bundle bounds is IMPORT_IDENTITY_DRIFT while admission_facts agrees), the 12th (a link whose import row holds another bundle hash is refused) and the 14th (intent-only is reported), ordinals as renumbered by repair 2. The 1st is the positive control (records once, replays with replayed: true); the 6th, 10th and 11th cover the admission_facts half of D16, the importing-state precondition and the link's own positive path.

FNXC:CccPlanningProofInventory 2026-10-14-23:20 (repair 1): the 3rd name is new and the 2nd test now probes the in-flight transaction, because a hook-only atomicity test passed an implementation that commits the CAS and the artifact in two transactions.

FNXC:CccPlanningProofInventory 2026-10-14-23:48 (repair 2, errata E13): four names are new, so the list holds 14. The 7th (an intent naming another bundle than the published one is IMPORT_IDENTITY_DRIFT, the adversary's X1 first half) and the 8th (another packet or sidecar, or a bundle with no bundleHash) are E13 item 1(a); the 9th (a bundle or admission_facts artifact that is not `complete` is never the bounds source) is item 2; the 13th (a link whose import row's canonical bundle bounds differ from the intent's limits is refused although the bundle hash matches, X1's second half) is item 1(b). Each failed on eab1819f7 with "expected a CCC_PLANNING_IMPORT_IDENTITY_DRIFT refusal but the call resolved", and each passes with the control in the same test.

The file needs PostgreSQL: its single describe is the harness `pgDescribe`, and the operations run as the application role (`fusion_runtime`) bound to one project, so row-level security, the anchor trigger (0042) and the artifact guard (0043) are live. The field is `needsPostgres` (errata E1-1). Core has no Vitest projects, so `project` is null, and the PostgreSQL config is `vitest.pg.config.ts`.

Measured on the M5 Max at a load average near 10 (1 min, parallel agents), FNXC:CccPlanningProofInventory 2026-10-14-22:53: about 3 s wall for the file (9 tests, about 1 s of Vitest test time), and the same order across the RED, GREEN and mutant runs. Re-measured after repair 1 (FNXC:CccPlanningProofInventory 2026-10-14-23:20): 10 tests, about 2.3 s Vitest duration and under 1 s of test time, over five repeats. Re-measured after repair 2 (FNXC:CccPlanningProofInventory 2026-10-14-23:48): 14 tests, about 3.4 s Vitest duration and about 1.2 s of test time. The 120 s command timeouts are hang bounds over that measurement; no test timeout is raised anywhere.
*/

const FILE = "src/__tests__/postgres/ccc-planning-import-link.pg.test.ts";

const SUITE = "ccc planning import intent and link (card IM1, PostgreSQL)";

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({
    id: "im1-import-link",
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
    id: "im1-import-link-names",
    packageFilter: "@fusion/core",
    project: null,
    config: "vitest.pg.config.ts",
    files: Object.freeze([FILE]),
    closure: "names",
    expectedNames: Object.freeze([
      `${SUITE} > records an intent whose limits equal the bundle bounds once, with the import key, the artifact and one event, and replays it with replayed: true`,
      `${SUITE} > a failing beforeArtifact hook rolls back the anchor CAS with the artifact, so the anchor has no intent digest; the same intent then records`,
      `${SUITE} > a refused import_intent publication (its slot already holds other bytes) rolls back the anchor CAS with it, whatever the hook order`,
      `${SUITE} > refuses a second intent with another digest with IMPORT_LINK_WRITE_ONCE and writes nothing; the first intent still replays`,
      `${SUITE} > refuses an intent whose maxDurationMs is 1 ms off the published bundle bounds with IMPORT_IDENTITY_DRIFT although admission_facts holds exactly those limits; a twin whose bundle agrees records`,
      `${SUITE} > refuses an intent whose limits are 1 ms off admission_facts with IMPORT_IDENTITY_DRIFT although the bundle agrees; a twin whose facts agree records`,
      `${SUITE} > refuses an intent that names another bundle than the published bundle artifact's own bundleHash with IMPORT_IDENTITY_DRIFT although its limits equal that bundle's bounds; the same run records the intent that names it`,
      `${SUITE} > refuses an intent whose packetHash or sidecarHash differs from the published bundle's sourceHash or sidecarHash, or whose bundle carries no bundleHash, with IMPORT_IDENTITY_DRIFT; the same run records the intent that agrees`,
      `${SUITE} > refuses an intent whose bundle or admission_facts artifact has an envelope status other than complete with IMPORT_IDENTITY_DRIFT; the same bundle with status complete records`,
      `${SUITE} > refuses an intent on a run that has not reached importing with STATE_TRANSITION_REFUSED; the same run records once it is importing`,
      `${SUITE} > links the import row whose bundle hash equals the intent once: import_id, implementation_transferred, import_receipt and one event, and replays with replayed: true`,
      `${SUITE} > refuses a link whose ccc_prd_imports bundle hash differs from the intent with IMPORT_IDENTITY_DRIFT and writes nothing; a twin whose row matches links`,
      `${SUITE} > refuses a link whose ccc_prd_imports canonical bundle bounds differ from the intent's limits with IMPORT_IDENTITY_DRIFT and writes nothing although its bundle hash matches; the same row with the intent's bounds links`,
      `${SUITE} > reports none before the intent, intent-only with the stored intent after it, and linked with the receipt after the link`,
    ]),
    platform: "any",
    needsPostgres: true,
    timeoutMs: 120_000,
  }),
]);
