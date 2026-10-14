/*
FNXC:CccPlanningProofInventory 2026-10-14-15:20:
Proof inventory for request-to-code card P1 (Pi seam, planning route binding and planning-scope settlement). Card P1 owns exactly this module; the inventory index (card P0) loads every cards/*.mjs in sorted order and rejects duplicate command ids.

TARGETED is file-closed over the three P1 test files, plus a second file-closed command over the unchanged pi.test.ts, which is the card's positive control: campaign scope keeps today's settlement, including the drift case at pi.test.ts:1872-1909. OFFLINE is name-closed over the three P1 files: the 31 names below are exactly the tests in them, built as ancestor titles and the title joined by " > " (the `assertionName` rule of scripts/run-ccc-pg-proof.mjs), so a skipped, renamed, missing or extra test fails the command. The P1 tests use loops instead of it.each so that no name is truncated.

Every command pins the engine-default Vitest project, so a narrow run never triggers the engine-core build. None of these tests touches PostgreSQL or the network: the provider streams, controllers and custom provider settings are in-memory fakes, and the runner sets PI_OFFLINE=1. ccc-provider-seam.typecheck.test.ts runs the TypeScript compiler once over its own source and three snippets, with the engine's compiler options and @fusion/core pointed at core source, because the engine's typecheck script excludes tests.

Measured on the M5 Max under concurrent agent load: about 16 s wall for the three P1 files plus pi.test.ts (135 tests), of which the in-test compile is about 4 s. The 120 s command timeouts are that measurement with headroom for a slower host; no test timeout is raised anywhere.
*/

const SEAM_FILES = Object.freeze([
  "src/__tests__/ccc-planning-provider-settlement.test.ts",
  "src/__tests__/ccc-planning-provider-binding.test.ts",
  "src/__tests__/ccc-provider-seam.typecheck.test.ts",
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({
    id: "p1-pi-seam",
    packageFilter: "@fusion/engine",
    project: "engine-default",
    config: null,
    files: SEAM_FILES,
    closure: "files",
    expectedNames: Object.freeze([]),
    platform: "any",
    needsPostgres: false,
    timeoutMs: 120_000,
  }),
  Object.freeze({
    id: "p1-pi-campaign-regression",
    packageFilter: "@fusion/engine",
    project: "engine-default",
    config: null,
    files: Object.freeze(["src/__tests__/pi.test.ts"]),
    closure: "files",
    expectedNames: Object.freeze([]),
    platform: "any",
    needsPostgres: false,
    timeoutMs: 120_000,
  }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "p1-pi-seam-names",
    packageFilter: "@fusion/engine",
    project: "engine-default",
    config: null,
    files: SEAM_FILES,
    closure: "names",
    expectedNames: Object.freeze([
      "planning-scope route refusal settles once and leaves the slot loop (D10, item 42) > a mismatched terminal receipt in planning scope: one proved_failed reconcile, a CccProviderRouteReceiptError, and dispatch keys [pi-stream:1]",
      "planning-scope route refusal settles once and leaves the slot loop (D10, item 42) > a missing terminal receipt in planning scope: one proved_failed reconcile, a CccProviderRouteReceiptError, and dispatch keys [pi-stream:1]",
      "planning-scope route refusal settles once and leaves the slot loop (D10, item 42) > a mismatched terminal receipt in planning-linked-writer scope: one proved_failed reconcile, a CccProviderRouteReceiptError, and dispatch keys [pi-stream:1]",
      "planning-scope route refusal settles once and leaves the slot loop (D10, item 42) > settles a provider error event as proved_failed provider-error-event, and a retry takes the next slot (E2-1)",
      "planning-scope route refusal settles once and leaves the slot loop (D10, item 42) > positive control: an exact terminal receipt in planning scope commits with the requested Pi route and no refusal",
      "planning-scope route refusal settles once and leaves the slot loop (D10, item 42) > positive control: an abort with no terminal event stays dispatched_unknown in planning scope",
      "planning-scope route refusal settles once and leaves the slot loop (D10, item 42) > positive control: a proved_failed hold this session did not refuse still advances to the next slot (E2-1)",
      "planning-scope route refusal settles once and leaves the slot loop (D10, item 42) > control: campaign scope with the same mismatched receipt keeps today's refusal before reconcile",
      "createCccPlanningProviderAttemptBinding binds one exact route > refuses a dispatch with a different modelId as route-drift and never asks the inner controller",
      "createCccPlanningProviderAttemptBinding binds one exact route > refuses a dispatch with a different providerId as route-drift and never asks the inner controller",
      "createCccPlanningProviderAttemptBinding binds one exact route > refuses a dispatch with a different transport as route-drift and never asks the inner controller",
      "createCccPlanningProviderAttemptBinding binds one exact route > positive control: the exact route is forwarded to the inner controller unchanged",
      "createCccPlanningProviderAttemptBinding binds one exact route > returns a frozen planning binding whose frozen controller carries the bound route under a symbol key",
      "planning session creation enforces the bound route and the planning seams (D48) > refuses a planning binding whose provider is not the session's default provider, before any provider is registered",
      "planning session creation enforces the bound route and the planning seams (D48) > positive control: the bound provider as the default provider creates the session with the receipt adapter on that provider only",
      "planning session creation enforces the bound route and the planning seams (D48) > refuses scopeKind planning without a toolPolicy at session creation",
      "planning session creation enforces the bound route and the planning seams (D48) > propagates a provider pin check refusal before any provider is registered",
      "planning session creation enforces the bound route and the planning seams (D48) > refuses a planning binding without the receipt adapter at session creation",
      "planning session creation enforces the bound route and the planning seams (D48) > refuses a planning binding with terminal route members at session creation",
      "planning session creation enforces the bound route and the planning seams (D48) > refuses a planning binding whose controller carries no bound route at session creation",
      "planning session creation enforces the bound route and the planning seams (D48) > refuses a missing stream guard at session creation",
      "planning session creation enforces the bound route and the planning seams (D48) > refuses a missing provider pin check at session creation",
      "planning session creation enforces the bound route and the planning seams (D48) > refuses a missing confinement at session creation",
      "planning session creation enforces the bound route and the planning seams (D48) > refuses a linked writer whose policy allows bash without a confined bash at session creation",
      "planning session creation enforces the bound route and the planning seams (D48) > refuses an unknown scopeKind at session creation",
      "planning session creation enforces the bound route and the planning seams (D48) > refuses a tool policy that is not frozen at session creation",
      "planning session creation enforces the bound route and the planning seams (D48) > positive control: a linked writer with a confined bash and the linked writer policy creates its session",
      "Pi seam types carry the real campaign controller (type-only, compiled in-test) > the campaign controller still satisfies CccProviderAttemptController<CccProviderAttemptScope>",
      "Pi seam types carry the real campaign controller (type-only, compiled in-test) > assigns the real campaign controller to K1's CccProviderAttemptControllerView<CccProviderAttemptScope> (item 51)",
      "Pi seam types carry the real campaign controller (type-only, compiled in-test) > refuses the real campaign controller as a planning-scope K1 view with an assignability error",
      "Pi seam types carry the real campaign controller (type-only, compiled in-test) > the equality check is strict and the scope kind is a closed set",
    ]),
    platform: "any",
    needsPostgres: false,
    timeoutMs: 120_000,
  }),
]);
