/*
FNXC:CccPlanningProofInventory 2026-10-14-09:25:
Loader and validator for the closed planning-proof inventory (card P0; CONTRACT-v2 section 2.20, rule 10). Every card that owns planning tests ships one module under `cards/` exporting two frozen lists, `TARGETED` and `OFFLINE`, of ClosedSuiteCommand objects. This index loads every `cards/*.mjs` in sorted filename order (so the digest does not depend on directory order), checks each command against the same closed shape the runner enforces, and refuses the whole inventory on the first problem: a card that lacks either export, a non-array export, a malformed command, a duplicate command id across cards, or a files-closed command in `OFFLINE`.

Which closure applies where (documented here because two readings of the contract exist):
- "names" (exact-name-closed) is for suites a card OWNS. Any rename, deletion, extra test or quiet skip fails the run. Required for every `OFFLINE` entry, because offline mode proves the whole name list under the Darwin sandbox.
- "files" (file-closed) is for large pre-existing suites whose test names the card does not own. Every listed file must run at least one test and pass, and no unlisted file may appear. Allowed only in `TARGETED`.
A card that wants both for one file lists it twice under two ids (card B2 does: `b2-graph-admission` is files-closed in TARGETED, `b2-graph-admission-names` is names-closed in OFFLINE).

The digest is the sha256 of a canonical JSON form (sorted keys) of the card file names plus every command in load order. It is recorded in each run report, so a report names exactly which inventory it proved. The module also exports the loaded lists at top level; a broken card therefore fails every importer, which is the intended fail-closed behaviour. The runner loads through `loadCccPlanningInventory()` so it can turn the failure into a coded refusal instead of a stack trace.
*/
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CCC_PLANNING_INVENTORY_INVALID, CccPlanningProofError, assertMachineResultInventory } from "../ccc-closed-vitest-results.mjs";

const defaultCardsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "cards");

function invalid(message) {
  return new CccPlanningProofError(CCC_PLANNING_INVENTORY_INVALID, message);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateList(file, exportName, list, seenIds, { requireNamesClosure }) {
  if (!Array.isArray(list)) throw invalid(`${file}: ${exportName} must be an array`);
  for (const command of list) {
    try {
      assertMachineResultInventory(command);
    } catch (error) {
      if (error instanceof CccPlanningProofError) throw invalid(`${file}: ${exportName}: ${error.message}`);
      throw error;
    }
    if (requireNamesClosure && command.closure !== "names") {
      throw invalid(`${file}: OFFLINE command ${command.id} must be names-closed; a files-closed command is only allowed in TARGETED`);
    }
    if (seenIds.has(command.id)) throw invalid(`${file}: duplicate command id ${command.id} (first declared in ${seenIds.get(command.id)})`);
    seenIds.set(command.id, file);
  }
}

/**
 * @param {{ cardsDir?: string }} [options]
 * @returns {Promise<{ cards: string[], targeted: readonly object[], offline: readonly object[], sha256: string }>}
 */
export async function loadCccPlanningInventory(options = {}) {
  const cardsDir = options.cardsDir ?? defaultCardsDir;
  let files;
  try {
    files = readdirSync(cardsDir)
      .filter((name) => name.endsWith(".mjs"))
      .sort();
  } catch (error) {
    throw invalid(`cannot read the inventory cards directory ${cardsDir}: ${error.message}`);
  }
  const targeted = [];
  const offline = [];
  const seenIds = new Map();
  for (const file of files) {
    let module;
    try {
      module = await import(pathToFileURL(path.join(cardsDir, file)).href);
    } catch (error) {
      throw invalid(`${file}: card module failed to load: ${error.message}`);
    }
    if (!("TARGETED" in module) || !("OFFLINE" in module)) throw invalid(`${file}: a card module must export both TARGETED and OFFLINE`);
    validateList(file, "TARGETED", module.TARGETED, seenIds, { requireNamesClosure: false });
    validateList(file, "OFFLINE", module.OFFLINE, seenIds, { requireNamesClosure: true });
    targeted.push(...module.TARGETED);
    offline.push(...module.OFFLINE);
  }
  const sha256 = createHash("sha256").update(canonicalJson({ cards: files, targeted, offline })).digest("hex");
  return { cards: files, targeted: Object.freeze(targeted), offline: Object.freeze(offline), sha256 };
}

const loaded = await loadCccPlanningInventory();

export const CCC_PLANNING_TARGETED_COMMANDS = loaded.targeted;
export const CCC_PLANNING_OFFLINE_COMMANDS = loaded.offline;

export function cccPlanningInventorySha256() {
  return loaded.sha256;
}
