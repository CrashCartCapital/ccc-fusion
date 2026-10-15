import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function loadInstalledRuntime() {
  try {
    return await import("../lib/ccc-gate2-installed-runtime.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  }
}

test("PRD:GATE2-05 installed runtime receipt binds the CLI, controller, and scheduler host", async () => {
  const { captureGate2InstalledRuntimeReceipt } = await loadInstalledRuntime();
  assert.equal(typeof captureGate2InstalledRuntimeReceipt, "function");
  const root = await mkdtemp(path.join(tmpdir(), "ccc-gate2-installed-red-"));
  try {
    const tarballPath = path.join(root, "runfusion-fusion.tgz");
    const installedRoot = path.join(root, "node_modules/@runfusion/fusion");
    const executablePath = path.join(root, "node_modules/.bin/fn");
    const controllerModulePath = path.join(installedRoot, "dist/ccc-prd-controller.js");
    const runtimeModulePath = path.join(installedRoot, "dist/ccc-gate2-runtime-host.js");
    await mkdir(installedRoot, { recursive: true });
    await mkdir(path.dirname(controllerModulePath), { recursive: true });
    await mkdir(path.dirname(executablePath), { recursive: true });
    await writeFile(tarballPath, "sealed-tarball\n");
    await writeFile(path.join(installedRoot, "package.json"), JSON.stringify({
      name: "@runfusion/fusion",
      version: "9.8.7",
    }));
    await writeFile(executablePath, "#!/bin/sh\necho 9.8.7\n");
    await writeFile(controllerModulePath, "export async function runPrdCommand() { return 0; }\n");
    await writeFile(runtimeModulePath, [
      "export class CentralCore {}",
      "export class TaskStore {}",
      "export class InProcessRuntime {}",
      "export const __resetWorkflowExtensionRegistryForTests = () => undefined;",
      "export const bootstrapCccCampaignProofAdmissionHost = async () => undefined;",
      "export const readCustomProviders = () => [];",
      "export const computeCccCampaignOperatorControlConfirmation = () => 'confirmation';",
      "export const resolveCccPrdSemanticProofToolchainPaths = () => ({});",
      "",
    ].join("\n"));
    await chmod(executablePath, 0o755);

    const receipt = await captureGate2InstalledRuntimeReceipt({
      tarballPath,
      installedRoot,
      executablePath,
      home: path.join(root, "home"),
    });
    assert.deepEqual(Object.keys(receipt).sort(), [
      "artifactScope",
      "controllerModulePath",
      "controllerModuleSha256",
      "executablePath",
      "executableSha256",
      "installedRoot",
      "packageName",
      "packageVersion",
      "runtimeModulePath",
      "runtimeModuleSha256",
      "schema",
      "tarballPath",
      "tarballSha256",
      "versionOutput",
      "versionOutputSha256",
    ]);
    assert.equal(receipt.schema, "ccc-gate2.installed-runtime.v1");
    assert.deepEqual(receipt.artifactScope, {
      installedRuntime: [
        "fn-cli",
        "prd-controller",
        "semantic-proof-toolchain",
        "central-core",
        "task-store",
        "in-process-runtime",
        "proof-admission-host",
        "provider-config",
      ],
      sourceInProcessScheduler: "not_used",
      fullInstalledRuntime: "not_claimed_daemon_process",
      installedInProcessRuntime: "receipt_bound",
    });
    assert.equal(receipt.packageName, "@runfusion/fusion");
    assert.equal(receipt.packageVersion, "9.8.7");
    assert.equal(receipt.versionOutput, "9.8.7");
    assert.equal(receipt.controllerModulePath, controllerModulePath);
    for (const digest of [
      receipt.tarballSha256,
      receipt.executableSha256,
      receipt.versionOutputSha256,
      receipt.controllerModuleSha256,
      receipt.runtimeModuleSha256,
    ]) {
      assert.match(digest, /^[a-f0-9]{64}$/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GATE2-07 installed PRD controls execute through the receipt-bound fn executable", async () => {
  const { runGate2InstalledPrdCommand } = await loadInstalledRuntime();
  assert.equal(typeof runGate2InstalledPrdCommand, "function");
  const root = await mkdtemp(path.join(tmpdir(), "ccc-gate2-installed-command-red-"));
  try {
    const executablePath = path.join(root, "fn");
    const invocationPath = path.join(root, "invocation.txt");
    const vitestPath = path.join(root, "vitest.txt");
    const home = path.join(root, "home");
    await mkdir(home);
    await writeFile(executablePath, [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${JSON.stringify(invocationPath)}`,
      `printf '%s\\n' "\${VITEST-unset}" > ${JSON.stringify(vitestPath)}`,
      "printf '%s\\n' '{\"kind\":\"product-status\",\"found\":true}'",
      "",
    ].join("\n"));
    await chmod(executablePath, 0o755);

    const result = await runGate2InstalledPrdCommand({
      executablePath,
      cwd: root,
      home,
      args: ["status", "gate2-command-test"],
      env: { CCC_GATE2_TEST_MARKER: "present", VITEST: "true" },
    });

    assert.deepEqual(result, {
      exitCode: 0,
      values: [{ kind: "product-status", found: true }],
      stderr: "",
    });
    assert.equal(await readFile(invocationPath, "utf8"), [
      "prd",
      "status",
      "gate2-command-test",
      "--json",
      "",
    ].join("\n"));
    assert.equal(await readFile(vitestPath, "utf8"), "unset\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GATE2-08 installed PRD controls execute through the exact receipt-bound controller module", async () => {
  const { runGate2InstalledPrdController } = await loadInstalledRuntime();
  assert.equal(typeof runGate2InstalledPrdController, "function");
  const root = await mkdtemp(path.join(tmpdir(), "ccc-gate2-installed-controller-red-"));
  try {
    const controllerModulePath = path.join(root, "ccc-prd-controller.mjs");
    const source = [
      "export async function runPrdCommand(args, io, dependencies) {",
      "  io.write(JSON.stringify({ kind: 'controller-proof', args, marker: dependencies.marker }));",
      "  return 0;",
      "}",
      "",
    ].join("\n");
    await writeFile(controllerModulePath, source);
    const controllerModuleSha256 = createHash("sha256").update(source).digest("hex");

    const result = await runGate2InstalledPrdController({
      controllerModulePath,
      controllerModuleSha256,
      args: ["status", "gate2-controller-test"],
      dependencies: { marker: "receipt-bound" },
    });

    assert.deepEqual(result, {
      exitCode: 0,
      values: [{
        kind: "controller-proof",
        args: ["status", "gate2-controller-test", "--json"],
        marker: "receipt-bound",
      }],
      stderr: "",
    });
    await assert.rejects(
      runGate2InstalledPrdController({
        controllerModulePath,
        controllerModuleSha256: "0".repeat(64),
        args: ["status", "gate2-controller-test"],
        dependencies: {},
      }),
      /controller module digest mismatch/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GATE2-08 installed PRD controller runs with isolated installed-runtime environment", async () => {
  const { runGate2InstalledPrdController } = await loadInstalledRuntime();
  assert.equal(typeof runGate2InstalledPrdController, "function");
  const root = await mkdtemp(path.join(tmpdir(), "ccc-gate2-installed-controller-env-red-"));
  const originalHome = process.env.HOME;
  const originalFusionHome = process.env.FUSION_HOME;
  try {
    const controllerModulePath = path.join(root, "ccc-prd-controller.mjs");
    const home = path.join(root, "home");
    const fusionHome = path.join(home, ".fusion");
    await mkdir(fusionHome, { recursive: true });
    const source = [
      "export async function runPrdCommand(args, io, dependencies) {",
      "  io.write(JSON.stringify({",
      "    kind: 'controller-env-proof',",
      "    args,",
      "    home: process.env.HOME,",
      "    fusionHome: process.env.FUSION_HOME,",
      "    marker: process.env.CCC_GATE2_CONTROLLER_ENV_MARKER,",
      "    dependencyMarker: dependencies.marker,",
      "  }));",
      "  return 0;",
      "}",
      "",
    ].join("\n");
    await writeFile(controllerModulePath, source);
    const controllerModuleSha256 = createHash("sha256").update(source).digest("hex");

    const result = await runGate2InstalledPrdController({
      controllerModulePath,
      controllerModuleSha256,
      home,
      env: {
        FUSION_HOME: fusionHome,
        CCC_GATE2_CONTROLLER_ENV_MARKER: "isolated",
      },
      args: ["preview", "gate2-controller-env-test"],
      dependencies: { marker: "receipt-bound" },
    });

    assert.deepEqual(result, {
      exitCode: 0,
      values: [{
        kind: "controller-env-proof",
        args: ["preview", "gate2-controller-env-test", "--json"],
        home,
        fusionHome,
        marker: "isolated",
        dependencyMarker: "receipt-bound",
      }],
      stderr: "",
    });
    assert.equal(process.env.HOME, originalHome);
    assert.equal(process.env.FUSION_HOME, originalFusionHome);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalFusionHome === undefined) delete process.env.FUSION_HOME;
    else process.env.FUSION_HOME = originalFusionHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GATE2-09 loads only the exact receipt-bound installed scheduler host", async () => {
  const { loadGate2InstalledRuntimeModule } = await loadInstalledRuntime();
  assert.equal(typeof loadGate2InstalledRuntimeModule, "function");
  const root = await mkdtemp(path.join(tmpdir(), "ccc-gate2-installed-runtime-host-red-"));
  try {
    const runtimeModulePath = path.join(root, "ccc-gate2-runtime-host.mjs");
    const source = [
      "export class CentralCore {}",
      "export class TaskStore {}",
      "export class InProcessRuntime {}",
      "export const __resetWorkflowExtensionRegistryForTests = () => undefined;",
      "export const bootstrapCccCampaignProofAdmissionHost = async () => undefined;",
      "export const readCustomProviders = () => [];",
      "export const computeCccCampaignOperatorControlConfirmation = () => 'confirmation';",
      "export const resolveCccPrdSemanticProofToolchainPaths = () => ({});",
      "",
    ].join("\n");
    await writeFile(runtimeModulePath, source);
    const runtimeModuleSha256 = createHash("sha256").update(source).digest("hex");

    const runtime = await loadGate2InstalledRuntimeModule({
      runtimeModulePath,
      runtimeModuleSha256,
    });
    for (const name of [
      "CentralCore",
      "TaskStore",
      "InProcessRuntime",
      "__resetWorkflowExtensionRegistryForTests",
      "bootstrapCccCampaignProofAdmissionHost",
      "readCustomProviders",
      "computeCccCampaignOperatorControlConfirmation",
      "resolveCccPrdSemanticProofToolchainPaths",
    ]) {
      assert.equal(typeof runtime[name], "function", name);
    }
    await assert.rejects(
      loadGate2InstalledRuntimeModule({
        runtimeModulePath,
        runtimeModuleSha256: "0".repeat(64),
      }),
      /runtime module digest mismatch/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GATE2-09 package build owns the Gate 2 runtime host in CLI source", async () => {
  const repoRoot = process.cwd();
  const tsupConfig = await readFile(path.join(repoRoot, "packages/cli/tsup.config.ts"), "utf8");
  assert.match(
    tsupConfig,
    /"ccc-gate2-runtime-host":\s*"src\/ccc-gate2-runtime-host\.ts"/u,
  );
  assert.doesNotMatch(
    tsupConfig,
    /"ccc-gate2-runtime-host":\s*"\.\.\/engine\/src\/ccc-gate2-runtime-host\.ts"/u,
  );

  const runtimeHostSource = await readFile(path.join(repoRoot, "packages/cli/src/ccc-gate2-runtime-host.ts"), "utf8");
  for (const expectedExport of [
    "CentralCore",
    "TaskStore",
    "InProcessRuntime",
    "__resetWorkflowExtensionRegistryForTests",
    "bootstrapCccCampaignProofAdmissionHost",
    "readCustomProviders",
    "computeCccCampaignOperatorControlConfirmation",
    "resolveCccPrdSemanticProofToolchainPaths",
  ]) {
    assert.match(runtimeHostSource, new RegExp(`\\b${expectedExport}\\b`, "u"), expectedExport);
  }
});

test("PRD:GATE2-09 failed installed-runtime pack restores the CLI package manifest", async () => {
  const { prepareGate2InstalledRuntime } = await loadInstalledRuntime();
  assert.equal(typeof prepareGate2InstalledRuntime, "function");
  const root = await mkdtemp(path.join(tmpdir(), "ccc-gate2-pack-restore-red-"));
  const installRoot = path.join(root, "installed");
  const cliRoot = path.join(root, "cli");
  const fakeBin = path.join(root, "bin");
  const originalPath = process.env.PATH;
  const packageJsonPath = path.join(cliRoot, "package.json");
  const backupPath = path.join(cliRoot, "package.json.pack-backup");
  const originalPackageJson = `${JSON.stringify({
    name: "@runfusion/fusion",
    version: "0.0.0",
    type: "module",
    devDependencies: {
      "@fusion/core": "workspace:*",
      "@types/node": "^22.0.0",
    },
  }, null, 2)}\n`;
  try {
    await mkdir(installRoot);
    await mkdir(path.join(cliRoot, "scripts"), { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await writeFile(packageJsonPath, originalPackageJson);
    await writeFile(path.join(cliRoot, "scripts/prepare-publish-manifest.mjs"), [
      "import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';",
      "const packageJsonPath = new URL('../package.json', import.meta.url);",
      "const backupPath = new URL('../package.json.pack-backup', import.meta.url);",
      "if (process.argv[2] === 'prepack') {",
      "  const original = readFileSync(packageJsonPath, 'utf8');",
      "  writeFileSync(backupPath, original, 'utf8');",
      "  const pkg = JSON.parse(original);",
      "  delete pkg.devDependencies['@fusion/core'];",
      "  pkg.exports = { './dist/*': './dist/*' };",
      "  writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\\n');",
      "  process.exit(0);",
      "}",
      "if (process.argv[2] === 'postpack') {",
      "  if (existsSync(backupPath)) {",
      "    writeFileSync(packageJsonPath, readFileSync(backupPath, 'utf8'), 'utf8');",
      "    unlinkSync(backupPath);",
      "  }",
      "  process.exit(0);",
      "}",
      "process.exit(2);",
      "",
    ].join("\n"));
    const fakeCorepack = path.join(fakeBin, "corepack");
    await writeFile(fakeCorepack, [
      "#!/usr/bin/env node",
      "import { spawnSync } from 'node:child_process';",
      "if (process.argv[2] === 'pnpm' && process.argv[3] === 'run' && process.argv[4] === 'build:package') process.exit(0);",
      "if (process.argv[2] === 'pnpm' && process.argv[3] === 'pack') {",
      "  spawnSync(process.execPath, ['./scripts/prepare-publish-manifest.mjs', 'prepack'], { cwd: process.cwd(), stdio: 'inherit' });",
      "  process.stderr.write('fake pack failed after prepack\\n');",
      "  process.exit(254);",
      "}",
      "process.exit(2);",
      "",
    ].join("\n"));
    await chmod(fakeCorepack, 0o755);
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;

    await assert.rejects(
      prepareGate2InstalledRuntime({ root: installRoot, cliRoot }),
      /pnpm pack failed/u,
    );
    assert.equal(await readFile(packageJsonPath, "utf8"), originalPackageJson);
    await assert.rejects(readFile(backupPath, "utf8"), /ENOENT/u);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

const gate2RepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/*
FNXC:CccPlanningInstalledRuntime 2026-10-14-18:48:
Card IP extracts the build, pack, manifest-restore and install sequence of `prepareGate2InstalledRuntime` into scripts/lib/ccc-installed-cli.mjs (`packAndInstallFusionCli`). The two tests below are the regression guard the card names: the first pins where the sequence lives (it fails on the pre-extraction bytes), the second drives the whole successful path through fake `corepack` and `npm` executables and pins the exact step order and arguments Gate 2 has always used, so the extraction cannot quietly add an offline flag, a cache override or a different HOME. The failing-pack path is the existing GATE2-09 test above, unchanged.
*/
test("PRD:GATE2-10 the pack, restore and install sequence lives in the shared installed-cli module", async () => {
  const gate2 = await readFile(path.join(gate2RepoRoot, "scripts/lib/ccc-gate2-installed-runtime.mjs"), "utf8");
  const shared = await readFile(path.join(gate2RepoRoot, "scripts/lib/ccc-installed-cli.mjs"), "utf8");
  assert.match(gate2, /from "\.\/ccc-installed-cli\.mjs"/u);
  assert.match(gate2, /packAndInstallFusionCli\(/u);
  for (const step of ["clean npm install", "fresh CLI package build", "restore CLI package manifest after pack", "pnpm pack"]) {
    assert.ok(!gate2.includes(step), `${step} no longer lives in the Gate 2 module`);
    assert.ok(shared.includes(step), `${step} lives in the shared module`);
  }
});

test("PRD:GATE2-10 a successful prepare returns the Gate 2 receipt through the shared sequence with the unchanged npm arguments", async () => {
  const { prepareGate2InstalledRuntime } = await loadInstalledRuntime();
  assert.equal(typeof prepareGate2InstalledRuntime, "function");
  const root = await mkdtemp(path.join(tmpdir(), "ccc-gate2-prepare-success-"));
  const installRoot = path.join(root, "installed");
  const cliRoot = path.join(root, "cli");
  const fakeBin = path.join(root, "bin");
  const logPath = path.join(root, "calls.jsonl");
  const originalPath = process.env.PATH;
  const originalLog = process.env.FAKE_GATE2_LOG;
  const controllerSource = "export async function runPrdCommand() { return 0; }\n";
  const runtimeSource = [
    "export class CentralCore {}",
    "export class TaskStore {}",
    "export class InProcessRuntime {}",
    "export const __resetWorkflowExtensionRegistryForTests = () => undefined;",
    "export const bootstrapCccCampaignProofAdmissionHost = async () => undefined;",
    "export const readCustomProviders = () => [];",
    "export const computeCccCampaignOperatorControlConfirmation = () => 'confirmation';",
    "export const resolveCccPrdSemanticProofToolchainPaths = () => ({});",
    "",
  ].join("\n");
  try {
    await mkdir(installRoot);
    await mkdir(path.join(cliRoot, "scripts"), { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await writeFile(logPath, "");
    await writeFile(path.join(cliRoot, "scripts/prepare-publish-manifest.mjs"), [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.env.FAKE_GATE2_LOG, JSON.stringify({ tool: 'postpack', args: process.argv.slice(2) }) + '\\n');",
      "",
    ].join("\n"));
    await writeFile(path.join(fakeBin, "corepack"), [
      "#!/usr/bin/env node",
      "const fs = require('fs'); const path = require('path');",
      "const a = process.argv.slice(2);",
      "fs.appendFileSync(process.env.FAKE_GATE2_LOG, JSON.stringify({ tool: 'corepack', args: a, cwd: process.cwd(), home: process.env.HOME }) + '\\n');",
      "if (a[0] === 'pnpm' && a[1] === 'run' && a[2] === 'build:package') process.exit(0);",
      "if (a[0] === 'pnpm' && a[1] === 'pack') { fs.writeFileSync(path.join(a[a.indexOf('--pack-destination') + 1], 'runfusion-fusion-1.2.3.tgz'), 'sealed-tarball\\n'); process.exit(0); }",
      "process.exit(2);",
      "",
    ].join("\n"));
    await writeFile(path.join(fakeBin, "npm"), [
      "#!/usr/bin/env node",
      "const fs = require('fs'); const path = require('path');",
      "const a = process.argv.slice(2);",
      "fs.appendFileSync(process.env.FAKE_GATE2_LOG, JSON.stringify({ tool: 'npm', args: a, cwd: process.cwd(), home: process.env.HOME }) + '\\n');",
      "const modules = path.join(process.cwd(), 'node_modules'); const pkg = path.join(modules, '@runfusion', 'fusion');",
      "fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true }); fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });",
      "fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@runfusion/fusion', version: '1.2.3' }));",
      `fs.writeFileSync(path.join(pkg, 'dist', 'ccc-prd-controller.js'), ${JSON.stringify(controllerSource)});`,
      `fs.writeFileSync(path.join(pkg, 'dist', 'ccc-gate2-runtime-host.js'), ${JSON.stringify(runtimeSource)});`,
      "fs.writeFileSync(path.join(modules, '.bin', 'fn'), '#!/bin/sh\\necho 1.2.3\\n', { mode: 0o755 });",
      "",
    ].join("\n"));
    await chmod(path.join(fakeBin, "corepack"), 0o755);
    await chmod(path.join(fakeBin, "npm"), 0o755);
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
    process.env.FAKE_GATE2_LOG = logPath;

    const receipt = await prepareGate2InstalledRuntime({ root: installRoot, cliRoot });

    assert.equal(receipt.schema, "ccc-gate2.installed-runtime.v1");
    assert.equal(receipt.packageName, "@runfusion/fusion");
    assert.equal(receipt.packageVersion, "1.2.3");
    assert.equal(receipt.versionOutput, "1.2.3");
    assert.equal(receipt.tarballPath, path.join(installRoot, "pack", "runfusion-fusion-1.2.3.tgz"));
    assert.equal(receipt.installedRoot, path.join(installRoot, "install", "node_modules/@runfusion/fusion"));
    assert.equal(receipt.executablePath, path.join(installRoot, "install", "node_modules/.bin/fn"));
    assert.equal(receipt.tarballSha256, createHash("sha256").update("sealed-tarball\n").digest("hex"));
    assert.equal(receipt.controllerModuleSha256, createHash("sha256").update(controllerSource).digest("hex"));
    assert.equal(receipt.runtimeModuleSha256, createHash("sha256").update(runtimeSource).digest("hex"));
    const calls = (await readFile(logPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((call) => `${call.tool}:${call.args.join(" ")}`), [
      "corepack:pnpm run build:package",
      `corepack:pnpm pack --pack-destination ${path.join(installRoot, "pack")}`,
      "postpack:postpack",
      `npm:install --no-audit --no-fund --ignore-scripts ${receipt.tarballPath}`,
    ]);
    for (const call of calls.filter((entry) => entry.tool === "corepack" || entry.tool === "npm")) {
      assert.equal(call.home, path.join(installRoot, "home"), `${call.tool} runs under the isolated home`);
    }
    assert.equal(calls.find((call) => call.tool === "npm").cwd, await realpath(path.join(installRoot, "install")));
    assert.equal(JSON.parse(await readFile(path.join(installRoot, "install", "package.json"), "utf8")).name, "ccc-gate2-installed-runtime");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.FAKE_GATE2_LOG;
    else process.env.FAKE_GATE2_LOG = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});
