import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { packAndInstallFusionCli, runCheckedCommand } from "./ccc-installed-cli.mjs";

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export async function runGate2InstalledPrdCommand(input) {
  if (!path.isAbsolute(input.executablePath)) {
    throw new Error("installed Gate 2 fn executable path must be absolute");
  }
  const args = ["prd", ...input.args, "--json"];
  const childEnv = {
    ...process.env,
    ...input.env,
    HOME: input.home,
    FUSION_HOME: input.env?.FUSION_HOME ?? path.join(input.home, ".fusion"),
    NO_COLOR: "1",
  };
  for (const key of Object.keys(childEnv)) {
    if (/^VITEST(?:_|$)/u.test(key)) delete childEnv[key];
  }
  const child = spawn(input.executablePath, args, {
    cwd: input.cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new Error(`installed Gate 2 fn terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
  const stdoutText = stdout.join("");
  const values = stdoutText.split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`installed Gate 2 fn emitted non-JSON stdout: ${line}`, { cause: error });
    }
  });
  return { exitCode, values, stderr: stderr.join("") };
}

export async function runGate2InstalledPrdController(input) {
  if (!path.isAbsolute(input.controllerModulePath)) {
    throw new Error("installed Gate 2 controller module path must be absolute");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.controllerModuleSha256)) {
    throw new Error("installed Gate 2 controller module digest must be 64 lowercase hex characters");
  }
  const observedSha256 = await sha256File(input.controllerModulePath);
  if (observedSha256 !== input.controllerModuleSha256) {
    throw new Error(
      `installed Gate 2 controller module digest mismatch: expected ${input.controllerModuleSha256}, observed ${observedSha256}`,
    );
  }
  const scopedEnvironment = {
    ...(input.env ?? {}),
    ...(input.home ? {
      HOME: input.home,
      FUSION_HOME: input.env?.FUSION_HOME ?? path.join(input.home, ".fusion"),
    } : {}),
    NO_COLOR: "1",
  };
  const previousEnvironment = new Map();
  for (const [key, value] of Object.entries(scopedEnvironment)) {
    previousEnvironment.set(key, process.env[key]);
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = String(value);
  }
  const vitestKeys = Object.keys(process.env).filter((key) => /^VITEST(?:_|$)/u.test(key));
  for (const key of vitestKeys) {
    if (!previousEnvironment.has(key)) previousEnvironment.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    const controller = await import(
      `${pathToFileURL(input.controllerModulePath).href}?sha256=${observedSha256}`
    );
    if (typeof controller.runPrdCommand !== "function") {
      throw new Error("installed Gate 2 PRD controller does not export runPrdCommand");
    }
    const values = [];
    const exitCode = await controller.runPrdCommand(
      [...input.args, "--json"],
      {
        write(line) {
          try {
            values.push(JSON.parse(line));
          } catch (error) {
            throw new Error(`installed Gate 2 controller emitted non-JSON output: ${line}`, { cause: error });
          }
        },
        readStdin: async () => "",
      },
      input.dependencies,
    );
    return { exitCode, values, stderr: "" };
  } finally {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const REQUIRED_GATE2_RUNTIME_EXPORTS = Object.freeze([
  "CentralCore",
  "TaskStore",
  "InProcessRuntime",
  "__resetWorkflowExtensionRegistryForTests",
  "bootstrapCccCampaignProofAdmissionHost",
  "readCustomProviders",
  "computeCccCampaignOperatorControlConfirmation",
  "resolveCccPrdSemanticProofToolchainPaths",
]);

export async function loadGate2InstalledRuntimeModule(input) {
  if (!path.isAbsolute(input.runtimeModulePath)) {
    throw new Error("installed Gate 2 runtime module path must be absolute");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.runtimeModuleSha256)) {
    throw new Error("installed Gate 2 runtime module digest must be 64 lowercase hex characters");
  }
  const observedSha256 = await sha256File(input.runtimeModulePath);
  if (observedSha256 !== input.runtimeModuleSha256) {
    throw new Error(
      `installed Gate 2 runtime module digest mismatch: expected ${input.runtimeModuleSha256}, observed ${observedSha256}`,
    );
  }
  const runtime = await import(
    `${pathToFileURL(input.runtimeModulePath).href}?sha256=${observedSha256}`
  );
  for (const name of REQUIRED_GATE2_RUNTIME_EXPORTS) {
    if (typeof runtime[name] !== "function") {
      throw new Error(`installed Gate 2 runtime module does not export ${name}`);
    }
  }
  return runtime;
}

export async function captureGate2InstalledRuntimeReceipt(input) {
  await mkdir(input.home, { recursive: true });
  const packageJson = JSON.parse(await readFile(path.join(input.installedRoot, "package.json"), "utf8"));
  if (packageJson.name !== "@runfusion/fusion" || typeof packageJson.version !== "string") {
    throw new Error("installed Gate 2 package identity is invalid");
  }
  const versionOutput = runCheckedCommand(input.executablePath, ["--version"], {
    cwd: input.home,
    env: { ...process.env, HOME: input.home, NO_COLOR: "1" },
    label: "installed fn --version",
  });
  const controllerModulePath = path.join(input.installedRoot, "dist", "ccc-prd-controller.js");
  const controllerModuleSha256 = await sha256File(controllerModulePath);
  const controllerModule = await import(`${pathToFileURL(controllerModulePath).href}?sha256=${controllerModuleSha256}`);
  if (typeof controllerModule.runPrdCommand !== "function") {
    throw new Error("installed Gate 2 PRD controller does not export runPrdCommand");
  }
  const runtimeModulePath = path.join(input.installedRoot, "dist", "ccc-gate2-runtime-host.js");
  const runtimeModuleSha256 = await sha256File(runtimeModulePath);
  await loadGate2InstalledRuntimeModule({ runtimeModulePath, runtimeModuleSha256 });
  return {
    schema: "ccc-gate2.installed-runtime.v1",
    artifactScope: {
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
    },
    tarballPath: input.tarballPath,
    tarballSha256: await sha256File(input.tarballPath),
    installedRoot: input.installedRoot,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    executablePath: input.executablePath,
    executableSha256: await sha256File(input.executablePath),
    controllerModulePath,
    controllerModuleSha256,
    runtimeModulePath,
    runtimeModuleSha256,
    versionOutput,
    versionOutputSha256: createHash("sha256").update(versionOutput, "utf8").digest("hex"),
  };
}

/**
 * FNXC:CccPlanningInstalledRuntime 2026-10-14-18:55: the build, pack, manifest-restore and install sequence moved to
 * `packAndInstallFusionCli` (card IP); Gate 2 keeps its receipt, its schema and the default arguments of that sequence.
 */
export async function prepareGate2InstalledRuntime(input) {
  const { tarballPath, installedRoot, executablePath, home } = await packAndInstallFusionCli({
    root: input.root,
    cliRoot: input.cliRoot,
    env: process.env,
    installProjectName: "ccc-gate2-installed-runtime",
  });
  return captureGate2InstalledRuntimeReceipt({
    tarballPath, installedRoot, executablePath, home,
  });
}
