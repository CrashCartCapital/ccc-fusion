#!/usr/bin/env node
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { prepareGate2InstalledRuntime } from "./lib/ccc-gate2-installed-runtime.mjs";

const root = process.argv[2];
if (!root || process.argv.length !== 3) {
  console.error("usage: node scripts/ccc-gate2-install-runtime.mjs <empty-output-root>");
  process.exit(2);
}
const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/cli");
const receipt = await prepareGate2InstalledRuntime({ root, cliRoot });
await writeFile(
  path.join(path.resolve(root), "installed-runtime-receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
