// FNXC:CccPlanningProofInventory 2026-10-14-09:30:
// Card B4 (packet writer extraction) owns exactly this module. The inventory
// index loads every cards/*.mjs in sorted order; each card exports the closed
// ClosedSuiteCommand lists the proof runner (card P0) executes. The writer
// suite is name-closed, so a renamed, skipped or missing test fails the run.
// The existing intake suite is file-closed: it proves freeze still behaves
// after its tail moved into writeCccPrdPacketFiles.

const WRITER_SUITE = "CCC PRD packet writer";

export const TARGETED = Object.freeze([
  Object.freeze({
    id: "b4-packet-writer",
    packageFilter: "@fusion/engine",
    project: "engine-default",
    config: null,
    files: Object.freeze(["src/__tests__/ccc-prd-packet-writer.test.ts"]),
    closure: "names",
    expectedNames: Object.freeze([
      `${WRITER_SUITE} > reproduces the recorded freeze manifest hash and packet hash from the same sources and receipt`,
      `${WRITER_SUITE} > keeps freeze output equal to the recorded pre-extraction output and to a writer replay of its sources and receipt`,
      `${WRITER_SUITE} > writes a planning-shaped packet that custody reads back with identical hashes regardless of source order`,
      `${WRITER_SUITE} > changes both hashes when any single source byte or role changes`,
      `${WRITER_SUITE} > refuses an existing output directory without touching it`,
      `${WRITER_SUITE} > refuses unsafe source paths and extra-file names before any filesystem effect`,
      `${WRITER_SUITE} > removes its stage directory and created parents when a write fails midway`,
    ]),
    platform: "any",
    needsPostgres: false,
    timeoutMs: 120_000,
  }),
  Object.freeze({
    id: "b4-intake-regression",
    packageFilter: "@fusion/engine",
    project: "engine-default",
    config: null,
    files: Object.freeze(["src/__tests__/ccc-prd-intake.test.ts"]),
    closure: "files",
    expectedNames: Object.freeze([]),
    platform: "any",
    needsPostgres: false,
    timeoutMs: 120_000,
  }),
]);

export const OFFLINE = Object.freeze([]);
