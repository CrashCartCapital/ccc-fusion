/*
FNXC:CccPlanningProofInventory 2026-10-14-14:10:
Proof inventory for request-to-code card K2 (live-authority receipt, envelope check, null qualification port and request-to-code route admission; D23, D24, critic 11). Card K2 owns exactly this module; the inventory index (card P0) loads every cards/*.mjs in sorted order and rejects duplicate command ids.

TARGETED is file-closed over the three K2 test files of the card's check command. OFFLINE is name-closed over the same files: the 35 names below are exactly the tests in them, built as ancestor titles and the title joined by " > ", so a skipped, renamed, missing or extra test fails the command instead of passing quietly. Core has no Vitest projects, so `project` is null. Every K2 module is pure: none of these tests touches PostgreSQL, the network or the clock.

Measured on the M5 Max under parallel agent load: about 5 s wall for the three files, 35 tests. The 60 s command timeout is that measurement with headroom for a slower host; no test timeout is raised anywhere.
*/

const FILES = Object.freeze([
  "src/__tests__/ccc-planning-authority.test.ts",
  "src/__tests__/ccc-planning-qualification.test.ts",
  "src/__tests__/ccc-campaign-route-admission.test.ts",
]);

const PARSE = "live-authority receipt parse";
const ENVELOPE = "receipt envelope check";
const PORT = "qualification port";
const ADMISSION = "pre-qualification target admission";
const ROUTES = "request-to-code route admission";

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({
    id: "k2-core-authority",
    packageFilter: "@fusion/core",
    project: null,
    config: null,
    files: FILES,
    closure: "files",
    expectedNames: Object.freeze([]),
    platform: "any",
    needsPostgres: false,
    timeoutMs: 60_000,
  }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "k2-core-authority-names",
    packageFilter: "@fusion/core",
    project: null,
    config: null,
    files: FILES,
    closure: "names",
    expectedNames: Object.freeze([
      `${PARSE} > admits the control receipt and returns the SHA-256 of its canonical bytes`,
      `${PARSE} > computes the confirmation digest over exactly the named fields without operatorConfirmation`,
      `${PARSE} > refuses a receipt naming glm/glm-5.2 as REJECTED_MODEL_IDENTITY, and admits the control glm/glm-5.3`,
      `${PARSE} > refuses aliases, combos, lookalikes and a pin in the wrong slot as REJECTED_MODEL_IDENTITY`,
      `${PARSE} > refuses phaseCallCaps.planning = 1535 as BUDGET_POLICY_MISMATCH, and admits the control 1536`,
      `${PARSE} > recomputes the caps from the profile and the policy version the receipt names`,
      `${PARSE} > refuses a wrong confirm digest as UNCONFIRMED, and a receipt edited after confirmation too`,
      `${PARSE} > refuses a missing confirm digest as AUTHORITY_CONFIRMATION_REQUIRED`,
      `${PARSE} > refuses an extra key, a missing key and an extra nested key as INVALID`,
      `${PARSE} > refuses bytes that are not the canonical JSON of the receipt, and accepts one trailing newline`,
      `${PARSE} > refuses an admitted_repository target as QUALIFICATION_REQUIRED and a target with remotes as TARGET_NOT_DISPOSABLE`,
      `${PARSE} > refuses a repository that is not a direct child of the scratch root, or a marker outside it`,
      `${PARSE} > refuses outside the validity window as EXPIRED and a window over 7 days or before the deadline as INVALID`,
      `${PARSE} > refuses more than one permitted protected action and any action other than live_execution`,
      `${ENVELOPE} > accepts the control authorization inside the receipt envelope`,
      `${ENVELOPE} > accepts the import key ccc-plan:<24hex>:r1 and refuses ccc-plan:<24hex>:<digest>`,
      `${ENVELOPE} > refuses a member on glm/glm-5.3, a member on another provider and a non-pi member`,
      `${ENVELOPE} > refuses maxRequests above the remaining allocation and a deadline or expiry after the receipt's`,
      `${ENVELOPE} > refuses a baseline whose first parent is not the receipt base or that changes a path outside the admitted Fusion paths`,
      `${ENVELOPE} > refuses when the receipt asks for the operator, or is not the receipt the run consumed`,
      `${PORT} > the unqualified port finds no certificate for any digest tuple`,
      `${ADMISSION} > refuses an admitted_repository class with the null certificate as QUALIFICATION_REQUIRED; the owned_disposable control is admitted`,
      `${ADMISSION} > refuses a missing receipt as AUTHORITY_RECEIPT_REQUIRED, with or without a certificate`,
      `${ADMISSION} > refuses a receipt issued for the other mode as AUTHORITY_RECEIPT_REQUIRED`,
      `${ADMISSION} > admits an admitted_repository through a certificate whose scope covers its class and mode`,
      `${ADMISSION} > ignores a certificate whose scope omits the class or mode, or whose id is not the digest of its body`,
      `${ROUTES} > admits the control: Flash writers, M3 task reviews and an M3 final judge on their pinned providers`,
      `${ROUTES} > refuses combo/x as combo-route, and admits the control glm/glm-5.3-flash`,
      `${ROUTES} > refuses a Flash writer reviewed by glm/glm-5.3 as same-family-review, and admits the M3 control`,
      `${ROUTES} > refuses a GLM final judge of GLM writers as same-family-review`,
      `${ROUTES} > names every identity reason in the frozen classification order`,
      `${ROUTES} > refuses a combo with terminal route members even under an exact model id`,
      `${ROUTES} > refuses a writer on GLM 5.3 or M3 as role-model-mismatch, and a review of its own family first as same-family-review`,
      `${ROUTES} > refuses a route whose kind disagrees with the graph role or whose reviewed task disagrees with the graph`,
      `${ROUTES} > refuses a non-pi transport, a missing receipt adapter and an unpinned provider`,
    ]),
    platform: "any",
    needsPostgres: false,
    timeoutMs: 60_000,
  }),
]);
