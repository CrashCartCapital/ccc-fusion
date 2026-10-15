#!/usr/bin/env node
/*
FNXC:CccPlanningInstalledRuntime 2026-10-14-21:13:
Entry for the planning installed-runtime proof (card IP, ADR D Q2; E9 IP item 1). Section 4.2 step 1 runs `node scripts/ccc-planning-install-runtime.mjs "$ROOT/install"`, so the argument is the INSTALL directory and the runtime root `$ROOT` is its parent. It builds the CLI package from the committed tree, packs it into `$ROOT/evidence/pack`, installs the tarball with `--ignore-scripts` into `<install-dir>` (fn lands at `<install-dir>/node_modules/.bin/fn`) with `HOME=$ROOT/home`, and writes and re-verifies `$ROOT/evidence/installed-runtime.json` (`ccc-planning.installed-runtime.v1`). `<install-dir>` must be missing or empty and the receipt file must not exist yet; either one is refused before any git, pnpm or npm step runs, and so is a tracked-dirty source tree.

The npm install reads the local cache first (`--offline`) and goes to the public registry only after ENOTCACHED; `CCC_PLANNING_INSTALLED_NPM_MODE=offline` forbids that fallback. Nothing is installed globally and no lifecycle script runs.
*/
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  prepareCccPlanningInstalledRuntime,
  resolveCccPlanningInstalledRuntimePaths,
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
  try {
    const paths = resolveCccPlanningInstalledRuntimePaths(args[0]);
    const receipt = await prepareCccPlanningInstalledRuntime({
      installDir: paths.installDir,
      cliRoot: path.join(repoRoot, "packages", "cli"),
      repoRoot,
      npmMode: process.env.CCC_PLANNING_INSTALLED_NPM_MODE === "offline" ? "offline" : "offline-first",
      toolCaches: toolCaches(),
    });
    const receiptPath = paths.receiptPath;
    await mkdir(paths.evidenceDir, { recursive: true });
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
