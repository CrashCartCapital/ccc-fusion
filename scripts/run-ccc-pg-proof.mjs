#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

if (process.argv.length !== 4 || process.argv[2] !== "--wave" || process.argv[3] !== "4") {
  throw new Error("usage: node scripts/run-ccc-pg-proof.mjs --wave 4");
}
if (process.env.FUSION_PG_TEST_SKIP === "1") {
  throw new Error("FUSION_PG_TEST_SKIP=1 disables the required Wave 4 PostgreSQL proof before test execution");
}

const repoRoot = process.cwd();
const proofRoot = await mkdtemp(join(tmpdir(), "ccc-wave-4-proof-"));
const dataRoot = join(proofRoot, "postgres-data");
const reportPath = join(proofRoot, "report.json");
const manifestPath = join(proofRoot, "manifest.json");
const commands = [
  ["pnpm", ["--filter", "@fusion/core", "test:pg-gate"]],
  ["pnpm", ["--filter", "@fusion/engine", "exec", "vitest", "run", "src/__tests__/restart.integration.test.ts", "--project=engine-default", "--silent=passed-only", "--reporter=dot"]],
  ["pnpm", ["--filter", "@fusion/engine", "exec", "vitest", "run", "src/__tests__/ccc-workflow-restart.real-pg.test.ts", "--project=engine-default", "--silent=passed-only", "--reporter=dot"]],
  ["pnpm", ["--filter", "@fusion/engine", "exec", "vitest", "run", "src/__tests__/ccc-retry-classification.real-pg.test.ts", "--project=engine-default", "--silent=passed-only", "--reporter=dot"]],
];

const supervisor = `
  import { EmbeddedPostgresLifecycle } from ${JSON.stringify(join(repoRoot, "packages/core/src/postgres/embedded-lifecycle.ts"))};
  import { spawn } from "node:child_process";
  const lifecycle = new EmbeddedPostgresLifecycle({ dataDir: process.env.CCC_W4_DATA_ROOT, database: "ccc_wave4_proof" });
  const commands = JSON.parse(process.env.CCC_W4_COMMANDS);
  const results = [];
  const run = (cmd, args, env) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: process.env.CCC_W4_REPO_ROOT, env, stdio: "ignore" });
    child.once("error", reject); child.once("exit", (code) => resolve(Number(code ?? 1)));
  });
  try {
    await lifecycle.start();
    const url = new URL(lifecycle.getConnectionUrl()); url.pathname = "/";
    for (const [cmd, args] of commands) {
      const code = await run(cmd, args, { ...process.env, FUSION_PG_TEST_URL_BASE: url.href.slice(0, -1) });
      results.push({ command: [cmd, ...args], code });
      if (code !== 0) break;
    }
  } finally { await lifecycle.stop().catch(() => {}); }
  process.stdout.write(JSON.stringify(results));
  if (results.some((result) => result.code !== 0) || results.length !== commands.length) process.exitCode = 1;
`;

const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", supervisor], {
  cwd: repoRoot,
  env: { ...process.env, CCC_W4_DATA_ROOT: dataRoot, CCC_W4_REPO_ROOT: repoRoot, CCC_W4_COMMANDS: JSON.stringify(commands) },
  stdio: ["ignore", "pipe", "inherit"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += String(chunk); });
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
const results = JSON.parse(output || "[]");
await writeFile(reportPath, JSON.stringify({ wave: 4, results }, null, 2));
await writeFile(manifestPath, JSON.stringify({ wave: 4, reportPath, passed: code === 0 }, null, 2));
if (code === 0) {
  await rm(dataRoot, { recursive: true, force: true });
  console.log(`Wave 4 PostgreSQL proof passed; redacted report: ${reportPath}`);
} else {
  console.error(`Wave 4 PostgreSQL proof failed; preserved diagnosis: ${proofRoot}`);
  process.exitCode = 1;
}
