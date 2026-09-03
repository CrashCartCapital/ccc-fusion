import { spawnSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

import { createGate2TelemetryBaseline } from "./ccc-gate2-telemetry-baseline.mjs";
import { buildGate2TelemetryPacketDefinition } from "./ccc-gate2-telemetry-packet.mjs";
import { writeEvidenceLedgerPacketSources } from "./ccc-golden-packet-files.mjs";

const cliPath = fileURLToPath(new URL("../../packages/cli/bin.mjs", import.meta.url));
const childEnvironmentKeys = ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL"];

function buildChildEnvironment(source, home) {
  const environment = { HOME: home, NO_COLOR: "1" };
  for (const key of childEnvironmentKeys) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    input: options.input,
  });
}

export function buildGate2LifecycleCliInvocation(installedExecutablePath, args) {
  if (installedExecutablePath !== undefined) {
    if (!path.isAbsolute(installedExecutablePath)) {
      throw new Error("installed Gate 2 CLI executable path must be absolute");
    }
    return { command: installedExecutablePath, args };
  }
  return { command: process.execPath, args: [cliPath, ...args] };
}

function requireJsonSuccess(result, label) {
  if (result.status !== 0 || result.stderr !== "") {
    throw new Error(`${label} failed (exit ${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function runGit(root, args, label, env) {
  const result = run("git", args, { cwd: root, env });
  if (result.status !== 0 || result.stderr !== "") {
    throw new Error(`${label} failed (exit ${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

export async function prepareGate2TelemetryPacketLifecycle(input) {
  const root = path.resolve(input.root);
  if ((await readdir(root)).length > 0) throw new Error("lifecycle root is not empty");
  const lifecycleHome = path.join(root, ".home");
  await mkdir(lifecycleHome);
  const childEnvironment = buildChildEnvironment(process.env, lifecycleHome);
  const runCli = (args, options = {}) => {
    const invocation = buildGate2LifecycleCliInvocation(input.cliExecutablePath, args);
    return run(invocation.command, invocation.args, {
      cwd: root,
      env: childEnvironment,
      ...options,
    });
  };
  const targetRoot = path.join(root, "target");
  await createGate2TelemetryBaseline(targetRoot);
  await mkdir(path.join(targetRoot, ".fusion"));
  await writeFile(path.join(targetRoot, ".fusion", "project.json"), `${JSON.stringify({
    id: "proj_6a74653274656c65",
    createdAt: "2026-09-01T00:00:00.000Z",
  }, null, 2)}\n`);
  runGit(targetRoot, ["init", "-b", "main"], "git init", childEnvironment);
  runGit(targetRoot, ["config", "user.name", "CCC Gate 2 Test"], "git config name", childEnvironment);
  runGit(targetRoot, ["config", "user.email", "ccc-gate2@example.invalid"], "git config email", childEnvironment);
  runGit(targetRoot, ["add", "."], "git add", childEnvironment);
  runGit(targetRoot, ["commit", "-m", "chore: freeze Gate 2 baseline"], "git commit", childEnvironment);
  const baseCommit = runGit(targetRoot, ["rev-parse", "HEAD"], "git rev-parse", childEnvironment);
  if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw new Error("git base commit is not a 40-hex object id");

  const definition = buildGate2TelemetryPacketDefinition({
    targetRoot,
    targetBase: baseCommit,
    routes: input.routes,
    maxRequests: input.maxRequests,
    maxDurationMs: input.maxDurationMs,
    maxConcurrency: input.maxConcurrency,
  });
  const activeRoot = path.join(root, "active");
  const frozenRoot = path.join(root, "frozen");
  const sourceReceipt = await writeEvidenceLedgerPacketSources(activeRoot, definition);
  const freeze = requireJsonSuccess(runCli([
    "prd", "freeze", activeRoot, sourceReceipt.prdPath, frozenRoot, "--context-stdin", "--json",
  ], { input: JSON.stringify(definition.operatorContext) }), "prd freeze");
  const manifestPath = path.join(frozenRoot, "manifest.json");
  if (freeze.manifestPath !== manifestPath) throw new Error("freeze manifest path drifted");

  const proposalPath = path.join(frozenRoot, "authoring-proposal.json");
  const routesPath = path.join(frozenRoot, "routes.json");
  const sidecarPath = path.join(frozenRoot, "candidate.sidecar.json");
  const executionPlanPath = path.join(frozenRoot, "execution-plan.json");
  await writeFile(proposalPath, `${JSON.stringify(definition.proposal, null, 2)}\n`);
  await writeFile(routesPath, `${JSON.stringify(definition.routes, null, 2)}\n`);
  const author = requireJsonSuccess(runCli([
    "prd", "author", frozenRoot, manifestPath, proposalPath, sidecarPath, "--json",
  ]), "prd author");
  const validate = requireJsonSuccess(runCli([
    "prd", "validate", frozenRoot, manifestPath, sidecarPath, targetRoot, baseCommit, "--json",
  ]), "prd validate");
  const compile = requireJsonSuccess(runCli([
    "prd", "compile", frozenRoot, manifestPath, sidecarPath, targetRoot, baseCommit, "--json",
  ]), "prd compile");
  const policy = requireJsonSuccess(runCli([
    "prd", "policy", frozenRoot, manifestPath, sidecarPath, targetRoot, baseCommit,
    executionPlanPath, "--routes-file", routesPath, "--json",
  ]), "prd policy");

  return {
    root, targetRoot, baseCommit, activeRoot, frozenRoot, manifestPath, proposalPath,
    routesPath, sidecarPath, executionPlanPath, definition,
    receipts: { source: sourceReceipt, freeze, author, validate, compile, policy },
  };
}
