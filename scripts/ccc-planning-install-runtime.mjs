#!/usr/bin/env node
/*
FNXC:CccPlanningInstalledRuntime 2026-10-14-18:57:
Entry for the planning installed-runtime proof (card IP, ADR D Q2). It builds the CLI package from the committed tree, packs it, installs the tarball with `--ignore-scripts` under `<install-dir>/install` with `HOME=<install-dir>/home`, and writes and re-verifies `<install-dir>/evidence/installed-runtime.json` (`ccc-planning.installed-runtime.v1`). `<install-dir>` must be missing or empty; a non-empty directory is refused before any pnpm or npm step runs, and so is a tracked-dirty source tree.

The npm install reads the local cache first (`--offline`) and goes to the public registry only after ENOTCACHED; `CCC_PLANNING_INSTALLED_NPM_MODE=offline` forbids that fallback. Nothing is installed globally and no lifecycle script runs.
*/
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  prepareCccPlanningInstalledRuntime,
  verifyCccPlanningInstalledRuntimeReceipt,
} from "./lib/ccc-planning-installed-runtime.mjs";

const USAGE = "usage: node scripts/ccc-planning-install-runtime.mjs <install-dir>";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function toolCaches() {
  const corepackHome = process.env.COREPACK_HOME ?? path.join(homedir(), ".cache", "node", "corepack");
  return {
    npmCache: process.env.npm_config_cache ?? path.join(homedir(), ".npm"),
    ...(existsSync(corepackHome) ? { corepackHome } : {}),
  };
}

async function main(args) {
  if (args.length !== 1) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const root = path.resolve(args[0]);
  try {
    const receipt = await prepareCccPlanningInstalledRuntime({
      root,
      cliRoot: path.join(repoRoot, "packages", "cli"),
      repoRoot,
      npmMode: process.env.CCC_PLANNING_INSTALLED_NPM_MODE === "offline" ? "offline" : "offline-first",
      toolCaches: toolCaches(),
    });
    const receiptPath = path.join(root, "evidence", "installed-runtime.json");
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    await verifyCccPlanningInstalledRuntimeReceipt(receiptPath);
    process.stdout.write(`${JSON.stringify({ receiptPath, schema: receipt.schema, distManifestSha256: receipt.distManifestSha256, piAi: receipt.piAi })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
