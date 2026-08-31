import { spawnSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

import { createEvidenceLedgerBaseline } from "./ccc-golden-evidence-ledger.mjs";
import { writeEvidenceLedgerPacketSources } from "./ccc-golden-packet-files.mjs";
import { buildEvidenceLedgerPacketDefinition } from "./ccc-golden-packet.mjs";

const cliPath = fileURLToPath(new URL("../../packages/cli/bin.mjs", import.meta.url));

const childEnvironmentKeys = ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL"];

export function buildLifecycleChildEnvironment(source, home) {
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

function requireExitZero(result, label) {
  if (result.status !== 0 || result.stderr !== "") {
    throw new Error(`${label} failed (exit ${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function requireJsonSuccess(result, label) {
  if (result.status !== 0 || result.stderr !== "") {
    throw new Error(`${label} failed (exit ${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function runGit(root, args, label, env) {
  const result = run("git", args, { cwd: root, env });
  requireExitZero(result, label);
  return result.stdout.trim();
}

export async function prepareEvidenceLedgerPacketLifecycle(input) {
  const root = path.resolve(input.root);
  const warnings = [];
  if ((await readdir(root)).length > 0) throw new Error("lifecycle root is not empty");
  const lifecycleHome = path.join(root, ".home");
  await mkdir(lifecycleHome);
  const childEnvironment = buildLifecycleChildEnvironment(process.env, lifecycleHome);
  const targetRoot = path.join(root, "target");
  await createEvidenceLedgerBaseline(targetRoot);
  runGit(targetRoot, ["init", "-b", "main"], "git init", childEnvironment);
  runGit(targetRoot, ["config", "user.name", "CCC Golden Test"], "git config name", childEnvironment);
  runGit(targetRoot, ["config", "user.email", "ccc-golden@example.invalid"], "git config email", childEnvironment);
  runGit(targetRoot, ["add", "."], "git add", childEnvironment);
  runGit(targetRoot, ["commit", "-m", "chore: freeze golden baseline"], "git commit", childEnvironment);
  const baseCommit = runGit(targetRoot, ["rev-parse", "HEAD"], "git rev-parse", childEnvironment);
  if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw new Error("git base commit is not a 40-hex object id");

  const definition = buildEvidenceLedgerPacketDefinition({
    targetRoot,
    targetBase: baseCommit,
    route: input.route,
    maxRequests: input.maxRequests,
    maxDurationMs: input.maxDurationMs,
    taskCount: input.taskCount,
  });
  const activeRoot = path.join(root, "active");
  const frozenRoot = path.join(root, "frozen");
  const sourceReceipt = await writeEvidenceLedgerPacketSources(activeRoot, definition);
  const freeze = requireJsonSuccess(run(process.execPath, [
    cliPath, "prd", "freeze", activeRoot, sourceReceipt.prdPath, frozenRoot, "--context-stdin", "--json",
  ], { cwd: root, env: childEnvironment, input: JSON.stringify(definition.operatorContext) }), "prd freeze");
  const manifestPath = path.join(frozenRoot, "manifest.json");
  if (freeze.manifestPath !== manifestPath) throw new Error("freeze manifest path drifted");

  const proposalPath = path.join(frozenRoot, "authoring-proposal.json");
  const routesPath = path.join(frozenRoot, "routes.json");
  const sidecarPath = path.join(frozenRoot, "candidate.sidecar.json");
  const executionPlanPath = path.join(frozenRoot, "execution-plan.json");
  await writeFile(proposalPath, `${JSON.stringify(definition.proposal, null, 2)}\n`);
  await writeFile(routesPath, `${JSON.stringify(definition.routes, null, 2)}\n`);
  const author = requireJsonSuccess(run(process.execPath, [
    cliPath, "prd", "author", frozenRoot, manifestPath, proposalPath, sidecarPath, "--json",
  ], { cwd: root, env: childEnvironment }), "prd author");
  const validate = requireJsonSuccess(run(process.execPath, [
    cliPath, "prd", "validate", frozenRoot, manifestPath, sidecarPath, targetRoot, baseCommit, "--json",
  ], { cwd: root, env: childEnvironment }), "prd validate");
  const compile = requireJsonSuccess(run(process.execPath, [
    cliPath, "prd", "compile", frozenRoot, manifestPath, sidecarPath, targetRoot, baseCommit, "--json",
  ], { cwd: root, env: childEnvironment }), "prd compile");
  const policy = requireJsonSuccess(run(process.execPath, [
    cliPath, "prd", "policy", frozenRoot, manifestPath, sidecarPath, targetRoot, baseCommit,
    executionPlanPath, "--routes-file", routesPath, "--json",
  ], { cwd: root, env: childEnvironment }), "prd policy");

  return {
    root,
    targetRoot,
    baseCommit,
    activeRoot,
    frozenRoot,
    manifestPath,
    proposalPath,
    routesPath,
    sidecarPath,
    executionPlanPath,
    definition,
    warnings,
    receipts: { source: sourceReceipt, freeze, author, validate, compile, policy },
  };
}
