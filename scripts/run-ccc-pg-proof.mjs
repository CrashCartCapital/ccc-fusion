#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const resultRoot = join(dataRoot, "machine-results");
const reportPath = join(proofRoot, "report.json");
const manifestPath = join(proofRoot, "manifest.json");

const expectedRestartNames = [
  "CCC Wave 4 PostgreSQL branch persistence > Wave 4 control: PostgreSQL persists uninterrupted A → {B,C} → D",
  "CCC Wave 4 PostgreSQL branch persistence > Wave 4 RED: ccc branch admission failure stops before the first branch effect",
  "CCC Wave 4 PostgreSQL branch persistence > Wave 4 RED: ccc terminal branch checkpoint failure blocks the join successor",
  "CCC Wave 4 PostgreSQL branch persistence > Wave 4 RED: PostgreSQL death during B and C resumes only unfinished branch work",
  "CCC Wave 4 PostgreSQL branch persistence > Wave 4 preservation: PostgreSQL restart after durable A resumes at the split without replaying A",
  "CCC Wave 4 PostgreSQL branch persistence > Wave 4 RED: failed PostgreSQL fixture teardown preserves a redacted diagnostic packet",
];
const expectedRetryNames = [
  "CCC Wave 4 PostgreSQL retry classification > Wave 4 RED: transient failure consumes exactly the configured total attempt count",
  "CCC Wave 4 PostgreSQL retry classification > Wave 4 RED: permanent failure is attempted once and parks manual-required",
  "CCC Wave 4 PostgreSQL retry classification > Wave 4 RED: transient exhaustion consumes three calls and parks exhausted",
  "CCC Wave 4 PostgreSQL retry classification > Wave 4 RED: consumed retrying cap fails closed without another handler call",
];

function assertionName(assertion) {
  return [...(assertion.ancestorTitles ?? []), assertion.title].join(" > ");
}

function assertClosedNamedResults(expectedNames, assertions, label) {
  const expected = new Set(expectedNames);
  if (expected.size !== expectedNames.length) throw new Error(`${label}: expected-name list contains duplicates`);
  const seen = new Map();
  for (const assertion of assertions) {
    const name = assertionName(assertion);
    if (!expected.has(name)) throw new Error(`${label}: unexpected named test: ${name}`);
    seen.set(name, (seen.get(name) ?? 0) + 1);
    if (assertion.status !== "passed") throw new Error(`${label}: ${name} is ${assertion.status}`);
  }
  for (const name of expectedNames) {
    const count = seen.get(name) ?? 0;
    if (count === 0) throw new Error(`${label}: missing named test: ${name}`);
    if (count !== 1) throw new Error(`${label}: duplicate named test: ${name}`);
  }
}

/*
FNXC:CccWave4Proof 2026-07-24-12:12:
The proof runner's policy is itself a correctness boundary. Exercise the
closed-list checker against synthetic machine results so missing, extra,
duplicate, skipped, pending, and failed outcomes are rejected without parsing
human vitest output.
*/
function selfTestClosedNamePolicy() {
  const expected = ["suite > required"];
  const good = [{ ancestorTitles: ["suite"], title: "required", status: "passed" }];
  assertClosedNamedResults(expected, good, "policy-self-test");
  for (const [label, assertions] of [
    ["missing", []],
    ["extra", [...good, { ancestorTitles: ["suite"], title: "extra", status: "passed" }]],
    ["duplicate", [...good, ...good]],
    ["skipped", [{ ...good[0], status: "skipped" }]],
    ["pending", [{ ...good[0], status: "pending" }]],
    ["failed", [{ ...good[0], status: "failed" }]],
  ]) {
    let rejected = false;
    try {
      assertClosedNamedResults(expected, assertions, `policy-self-test:${label}`);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`policy-self-test:${label} was accepted`);
  }
}
selfTestClosedNamePolicy();

function assertSupervisorResult(result, commands) {
  if (result.stopError) throw new Error(`embedded PostgreSQL stop failed: ${result.stopError}`);
  if (result.interrupted) throw new Error(`supervisor interrupted by ${result.interrupted}`);
  for (const command of commands) {
    const outcome = result.results.find((entry) => entry.id === command.id);
    if (!outcome) throw new Error(`missing command result: ${command.id}`);
    if (outcome.timedOut) throw new Error(`${command.id} exceeded its bounded timeout`);
    if (outcome.spawnError) throw new Error(`${command.id} spawn rejected: ${outcome.spawnError}`);
    if (outcome.code !== 0) throw new Error(`${command.id} exited ${outcome.code}`);
  }
}

function selfTestSupervisorFailurePolicy() {
  const commands = [{ id: "required" }];
  const passed = { results: [{ id: "required", code: 0, timedOut: false }], stopError: null, interrupted: null };
  assertSupervisorResult(passed, commands);
  for (const result of [
    { ...passed, results: [{ id: "required", code: 1, timedOut: true }] },
    { ...passed, results: [{ id: "required", code: 1, spawnError: "injected rejection" }] },
    { ...passed, stopError: "injected stop failure" },
    { ...passed, interrupted: "SIGTERM" },
  ]) {
    let rejected = false;
    try { assertSupervisorResult(result, commands); } catch { rejected = true; }
    if (!rejected) throw new Error("policy-self-test: supervisor failure was accepted");
  }
}
selfTestSupervisorFailurePolicy();

const commands = [
  {
    id: "core-pg-gate",
    command: ["pnpm", "--filter", "@fusion/core", "test:pg-gate"],
    expectedNames: null,
    machineResults: false,
  },
  {
    id: "engine-restart-integration",
    command: ["pnpm", "--filter", "@fusion/engine", "exec", "vitest", "run", "src/__tests__/restart.integration.test.ts", "--project=engine-default", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: null,
    machineResults: true,
  },
  {
    id: "ccc-workflow-restart-real-pg",
    command: ["pnpm", "--filter", "@fusion/engine", "exec", "vitest", "run", "src/__tests__/ccc-workflow-restart.real-pg.test.ts", "--project=engine-default", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedRestartNames,
    machineResults: true,
  },
  {
    id: "ccc-retry-classification-real-pg",
    command: ["pnpm", "--filter", "@fusion/engine", "exec", "vitest", "run", "src/__tests__/ccc-retry-classification.real-pg.test.ts", "--project=engine-default", "--silent=passed-only", "--reporter=dot"],
    vitestArgs: ["--reporter=json"],
    expectedNames: expectedRetryNames,
    machineResults: true,
  },
];

const supervisor = `
  import { EmbeddedPostgresLifecycle } from ${JSON.stringify(join(repoRoot, "packages/core/src/postgres/embedded-lifecycle.ts"))};
  import { spawn } from "node:child_process";
  import { mkdir } from "node:fs/promises";
  import { join } from "node:path";
  const lifecycle = new EmbeddedPostgresLifecycle({ dataDir: process.env.CCC_W4_DATA_ROOT, database: "ccc_wave4_proof" });
  const commands = JSON.parse(process.env.CCC_W4_COMMANDS);
  const results = [];
  const timeoutMs = Number(process.env.CCC_W4_CHILD_TIMEOUT_MS ?? 120000);
  const terminateGraceMs = Number(process.env.CCC_W4_CHILD_TERMINATE_GRACE_MS ?? 2000);
  let activeTerminate = null;
  let interrupted = null;
  const run = (cmd, args, env) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: process.env.CCC_W4_REPO_ROOT, env, stdio: ["ignore", "ignore", "ignore"] });
    let settled = false;
    let timedOut = false;
    let forcedKill = false;
    let forceTimer = null;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); activeTerminate = null; resolve(result); };
    const terminate = (signal = "SIGTERM") => {
      if (settled) return;
      child.kill(signal);
      if (signal === "SIGTERM") {
        forceTimer = setTimeout(() => { if (!settled) { forcedKill = true; child.kill("SIGKILL"); } }, terminateGraceMs);
      }
    };
    activeTerminate = terminate;
    const timer = setTimeout(() => { timedOut = true; terminate("SIGTERM"); }, timeoutMs);
    child.once("error", (error) => finish({ code: 1, signal: null, timedOut, forcedKill, spawnError: error instanceof Error ? error.message : String(error) }));
    child.once("exit", (code, signal) => finish({ code: Number(code ?? 1), signal: signal ?? null, timedOut, forcedKill }));
  });
  const onSignal = (signal) => { interrupted ??= signal; activeTerminate?.("SIGTERM"); };
  const onSigInt = () => onSignal("SIGINT");
  const onSigTerm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigInt);
  process.once("SIGTERM", onSigTerm);
  let stopError = null;
  try {
    await lifecycle.start();
    const url = new URL(lifecycle.getConnectionUrl()); url.pathname = "/";
    await mkdir(process.env.CCC_W4_RESULT_ROOT, { recursive: true });
    for (const entry of commands) {
      if (interrupted) break;
      const outputFile = entry.machineResults ? join(process.env.CCC_W4_RESULT_ROOT, entry.id + ".json") : null;
      const args = entry.machineResults
        ? [...entry.command.slice(1), ...entry.vitestArgs, "--outputFile", outputFile]
        : entry.command.slice(1);
      const outcome = await run(entry.command[0], args, { ...process.env, FUSION_PG_TEST_URL_BASE: url.href.slice(0, -1) });
      results.push({ id: entry.id, command: entry.command, ...outcome, outputFile });
      if (interrupted || outcome.code !== 0) break;
    }
  } finally {
    process.removeListener("SIGINT", onSigInt);
    process.removeListener("SIGTERM", onSigTerm);
    try { await lifecycle.stop(); } catch (error) { stopError = error instanceof Error ? error.message : String(error); }
  }
  process.stdout.write("CCC_W4_SUPERVISOR_RESULT=" + JSON.stringify({ results, database: "ccc_wave4_proof", stopError, interrupted }) + "\\n");
  if (stopError || interrupted || results.some((result) => result.code !== 0) || results.length !== commands.length) process.exitCode = 1;
`;

function redact(text) {
  return String(text)
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-postgresql-url]")
    .replace(/password=[^\s&]+/gi, "password=[redacted]");
}

const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", supervisor], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CCC_W4_DATA_ROOT: dataRoot,
    CCC_W4_RESULT_ROOT: resultRoot,
    CCC_W4_REPO_ROOT: repoRoot,
    CCC_W4_COMMANDS: JSON.stringify(commands),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += String(chunk); });
child.stderr.on("data", (chunk) => { stderr += String(chunk); });
let forwardedSignal = null;
const forwardSignal = (signal) => { forwardedSignal ??= signal; child.kill(signal); };
const forwardSigInt = () => forwardSignal("SIGINT");
const forwardSigTerm = () => forwardSignal("SIGTERM");
process.once("SIGINT", forwardSigInt);
process.once("SIGTERM", forwardSigTerm);
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
process.removeListener("SIGINT", forwardSigInt);
process.removeListener("SIGTERM", forwardSigTerm);
const supervisorLine = stdout.split("\n").find((line) => line.startsWith("CCC_W4_SUPERVISOR_RESULT="));
let supervisorResult = { results: [], database: "ccc_wave4_proof" };
let policyError;
try {
  if (!supervisorLine) throw new Error("supervisor did not emit machine result");
  supervisorResult = JSON.parse(supervisorLine.slice("CCC_W4_SUPERVISOR_RESULT=".length));
  if (forwardedSignal) throw new Error(`proof runner interrupted by ${forwardedSignal}`);
  assertSupervisorResult(supervisorResult, commands);
  for (const command of commands) {
    const result = supervisorResult.results.find((entry) => entry.id === command.id);
    if (!command.machineResults) continue;
    const json = JSON.parse(await readFile(result.outputFile, "utf8"));
    const assertions = json.testResults.flatMap((testResult) => testResult.assertionResults ?? []);
    if (json.numFailedTests !== 0 || json.numPendingTests !== 0 || json.numTodoTests !== 0 || json.numPassedTests === 0) {
      throw new Error(`${command.id}: failed, skipped, pending, todo, or empty machine result`);
    }
    if (command.expectedNames) assertClosedNamedResults(command.expectedNames, assertions, command.id);
  }
} catch (error) {
  policyError = error instanceof Error ? error.message : String(error);
}

const passed = exitCode === 0 && policyError === undefined;
const report = {
  wave: 4,
  passed,
  commands: supervisorResult.results.map(({ outputFile, ...result }) => result),
  policyError: policyError ?? null,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(manifestPath, `${JSON.stringify({ wave: 4, passed, reportPath, database: supervisorResult.database }, null, 2)}\n`);
if (passed) {
  await rm(dataRoot, { recursive: true, force: true });
  console.log(`Wave 4 PostgreSQL proof passed; redacted report: ${reportPath}`);
} else {
  await writeFile(join(proofRoot, "supervisor.log"), redact(`${stdout}\n${stderr}`));
  console.error(`Wave 4 PostgreSQL proof failed; preserved diagnosis: ${proofRoot}`);
  process.exitCode = 1;
}
