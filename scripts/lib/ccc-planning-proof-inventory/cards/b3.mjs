// Proof inventory for card B3 (shared fn prd import preflight).
//
// FNXC:CccPlanningProof 2026-10-14-18:55: Shape: ClosedSuiteCommand from
// scripts/lib/ccc-closed-vitest-results.mjs (card P0). TARGETED is file-closed;
// OFFLINE is name-closed. The engine commands run the engine-default project so
// the engine-core build-on-setup never fires. The CLI command runs the
// @runfusion/fusion package's single project.
//
// Measured on the M5 Max at load average 10 to 11: the engine file took 8.1 to
// 8.3 s wall (5 tests); the CLI prd.test.ts took 24.5 to 26.3 s wall (72 tests).
// The 120 s and 300 s command timeouts are those measurements with wide headroom
// for a slower or busier host; no test timeout is raised anywhere.
//
// Two prerequisites the runner does not create: prd.test.ts needs the CLI
// proof-admission build (FUSION_CLI_TSUP_CONFIG=proof-admission tsup in
// packages/cli), and both files need the engine barrel to export
// ./ccc-prd/product-import-preflight.js, which the parent adds at integration (D34).

export const TARGETED = Object.freeze([
  Object.freeze({
    id: "b3-engine-import-preflight",
    packageFilter: "@fusion/engine",
    project: "engine-default",
    config: null,
    files: Object.freeze(["src/__tests__/ccc-prd-product-import-preflight.test.ts"]),
    closure: "files",
    expectedNames: Object.freeze([]),
    platform: "any",
    needsPostgres: false,
    timeoutMs: 120_000,
  }),
  Object.freeze({
    id: "b3-cli-prd",
    packageFilter: "@runfusion/fusion",
    project: null,
    config: null,
    files: Object.freeze(["src/commands/__tests__/prd.test.ts"]),
    closure: "files",
    expectedNames: Object.freeze([]),
    platform: "any",
    needsPostgres: false,
    timeoutMs: 300_000,
  }),
]);

export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "b3-engine-import-preflight-names",
    packageFilter: "@fusion/engine",
    project: "engine-default",
    config: null,
    files: Object.freeze(["src/__tests__/ccc-prd-product-import-preflight.test.ts"]),
    closure: "names",
    expectedNames: Object.freeze([
      "shared CCC PRD product import preflight (card B3) > fn prd preview --json and preflightCccPrdProductTarget give one confirmation digest for one packet, plan and project, equal to the digest of an independently derived identity",
      "shared CCC PRD product import preflight (card B3) > an injected verifier-conformance failure refuses before identity in the shared preflight and in fn prd preview and import; a conforming verifier admits the same packet",
      "shared CCC PRD product import preflight (card B3) > a target HEAD that is not the frozen base refuses CCC_PRD_TARGET_HEAD_DRIFT before custody or conformance runs",
      "shared CCC PRD product import preflight (card B3) > without the semantic-proof sandbox the conformance check is skipped and reported, import carries the sandbox blocker, and the digest is unchanged",
      "shared CCC PRD product import preflight (card B3) > a v1 bundle in preview mode refuses CCC_PRD_PRODUCT_SEMANTIC_V2_REQUIRED before the execution plan is read or the toolchain is resolved",
    ]),
    platform: "any",
    needsPostgres: false,
    timeoutMs: 120_000,
  }),
]);
