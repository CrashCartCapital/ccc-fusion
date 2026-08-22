import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CCC_PRD_SEMANTIC_PROOF_HOST_ID,
  assertCccPrdSemanticProofV2Custody,
  computeCccPrdProofDefinitionSha256,
  computeCccPrdProofV2AdmissionDigests,
  hydrateCccPrdSemanticProofV2Custody,
  type CccPrdProofV2,
  type CccPrdSemanticProofToolchainPaths,
} from "../ccc-prd/index.js";

const execFile = promisify(execFileCallback);
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(overrides: {
  taskCommand?: string;
  additionalTaskfileLines?: string[];
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "ccc-semantic-custody-"));
  roots.push(root);
  const taskPath = join(root, "task-fixture");
  const proofHostPath = join(root, "proof-host.mjs");
  const taskCommand = overrides.taskCommand
    ?? "node verify/slugify.acceptance.test.js src/slugify.js test/slugify.test.js";
  await writeFile(taskPath, "#!/bin/sh\nprintf 'Task version: v-test\\n'\n", { mode: 0o755 });
  await chmod(taskPath, 0o755);
  await writeFile(
    proofHostPath,
    "#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('proof-host-test');\n",
    { mode: 0o755 },
  );
  await chmod(proofHostPath, 0o755);
  await writeFile(join(root, "Taskfile.yml"), [
    "version: '3'",
    "tasks:",
    "  verify:slugify:",
    "    cmds:",
    `      - ${taskCommand}`,
    ...(overrides.additionalTaskfileLines ?? []),
    "",
  ].join("\n"));
  await execFile("mkdir", ["-p", join(root, "verify")]);
  await writeFile(
    join(root, "verify/slugify.acceptance.test.js"),
    "console.log(process.argv.slice(2).join(','));\n",
  );
  await execFile("git", ["init", "--initial-branch=main", root]);
  await execFile("git", ["-C", root, "add", "Taskfile.yml", "verify/slugify.acceptance.test.js"]);
  await execFile("git", [
    "-C", root,
    "-c", "user.name=Fusion Test",
    "-c", "user.email=fusion-test@example.invalid",
    "commit", "-m", "proof baseline",
  ]);
  const { stdout } = await execFile("git", ["-C", root, "rev-parse", "HEAD"]);
  const baseCommit = stdout.trim();
  const proof: CccPrdProofV2 = {
    schema: "ccc-prd.proof.v2",
    id: "PROOF-slugify",
    requirementIds: ["REQ-slugify"],
    clauseIds: ["AC-REQ-slugify-001"],
    phases: ["task", "final_integrated"],
    command: "task verify:slugify",
    positiveOracle: "all declared semantic cases pass",
    positiveCases: [{ id: "CASE-basic", description: "ordinary words become a slug" }],
    negativeControls: [{ id: "CONTROL-punctuation", description: "punctuation defect fails" }],
    verifierClosure: [
      {
        role: "task_runner",
        path: "Taskfile.yml",
        baseGitBlobOid: "1".repeat(40),
        sha256: "1".repeat(64),
      },
      {
        role: "harness",
        path: "verify/slugify.acceptance.test.js",
        baseGitBlobOid: "2".repeat(40),
        sha256: "2".repeat(64),
      },
    ],
    candidateInputs: ["src/slugify.js", "test/slugify.test.js"],
    executionToolchain: {
      task: {
        executablePath: "/model/invented/task",
        executableSha256: "3".repeat(64),
        version: "invented",
        versionOutputSha256: "3".repeat(64),
      },
      node: {
        executablePath: "/model/invented/node",
        executableSha256: "4".repeat(64),
        version: "invented",
        versionOutputSha256: "4".repeat(64),
      },
      proofHost: {
        id: "model-invented-host",
        executablePath: "/model/invented/host",
        executableSha256: "5".repeat(64),
        version: "invented",
        versionOutputSha256: "5".repeat(64),
      },
      linkedRuntime: [],
    },
    spans: [],
    confidence: "high",
  };
  return {
    root,
    baseCommit,
    proof,
    toolchainPaths: {
      taskExecutablePath: taskPath,
      nodeExecutablePath: process.execPath,
      proofHost: {
        id: CCC_PRD_SEMANTIC_PROOF_HOST_ID,
        executablePath: proofHostPath,
      },
    },
  };
}

async function controllerPython312Path(): Promise<string> {
  const uvPythonRoot = join(userInfo().homedir, ".local/share/uv/python");
  const uvPythonDirectories = await readdir(uvPythonRoot).catch(() => [] as string[]);
  const isolated = uvPythonDirectories
    .filter((name) => /^cpython-3\.12(?:[.-]|$)/u.test(name))
    .sort()
    .map((name) => join(uvPythonRoot, name, "bin/python3.12"))
    .find((path) => existsSync(path));
  return isolated ?? (await execFile("which", ["python3"])).stdout.trim();
}

describe("CCC PRD semantic-proof controller custody", () => {
  it("RED-S5-controller-hydration: replaces model-fabricated Git and toolchain identities with controller observations", async () => {
    const f = await fixture();
    const [hydrated] = await hydrateCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: [f.proof],
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    });

    expect(hydrated!.verifierClosure).toEqual([
      expect.objectContaining({
        role: "task_runner",
        path: "Taskfile.yml",
        baseGitBlobOid: expect.stringMatching(/^[0-9a-f]{40}$/u),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
      expect.objectContaining({
        role: "harness",
        path: "verify/slugify.acceptance.test.js",
        baseGitBlobOid: expect.stringMatching(/^[0-9a-f]{40}$/u),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    ]);
    expect(hydrated!.verifierClosure[0]!.baseGitBlobOid).not.toBe("1".repeat(40));
    expect(hydrated!.executionToolchain).toMatchObject({
      task: { executablePath: await realpath(f.toolchainPaths.taskExecutablePath) },
      node: { executablePath: await realpath(process.execPath) },
      proofHost: {
        id: CCC_PRD_SEMANTIC_PROOF_HOST_ID,
        executablePath: await realpath(f.toolchainPaths.proofHost.executablePath),
        version: "proof-host-test",
      },
    });
    expect(hydrated!.executionToolchain.proofHost.executableSha256).toBe(
      (await import("node:crypto")).createHash("sha256")
        .update(await readFile(f.toolchainPaths.proofHost.executablePath))
        .digest("hex"),
    );
  });

  it("RED-S5-product-preflight: rejects fabricated custody and accepts only the exact hydrated proof", async () => {
    const f = await fixture();
    await expect(assertCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: [f.proof],
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    })).rejects.toMatchObject({ code: "CCC_PRD_SEMANTIC_PROOF_CUSTODY_REFUSED" });

    const hydratedWithoutAdmission = await hydrateCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: [f.proof],
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    });
    const hydrated = hydratedWithoutAdmission.map((proof) => ({
      ...proof,
      admission: {
        schema: "ccc-prd.proof-admission.v2" as const,
        pluginId: "fusion-native",
        pluginVersion: "1.0.0",
        extensionId: "ccc-proof-admission",
        proofVersion: "ccc-proof-admission.v1",
        extensionRootRelativeSource: "ccc-campaign-proof-admission.js",
        extensionSourceSha256: "a".repeat(64),
        extensionManifestSha256: "b".repeat(64),
        definitionSha256: computeCccPrdProofDefinitionSha256(proof),
        ...computeCccPrdProofV2AdmissionDigests(proof),
      },
    }));
    await expect(assertCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: hydrated,
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    })).resolves.toBeUndefined();
  });

  it("RED-S5-linked-runtime-set-custody: accepts identical linked runtime entries in semantic order", async () => {
    const f = await fixture();
    const [hydratedWithoutAdmission] = await hydrateCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: [f.proof],
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    });
    if (process.platform !== "darwin") {
      expect(hydratedWithoutAdmission!.executionToolchain.linkedRuntime).toEqual([]);
      return;
    }
    expect(hydratedWithoutAdmission!.executionToolchain.linkedRuntime.length).toBeGreaterThan(1);
    const reordered = {
      ...hydratedWithoutAdmission!,
      executionToolchain: {
        ...hydratedWithoutAdmission!.executionToolchain,
        linkedRuntime: [...hydratedWithoutAdmission!.executionToolchain.linkedRuntime].reverse(),
      },
    };
    const admitted = {
      ...reordered,
      admission: {
        schema: "ccc-prd.proof-admission.v2" as const,
        pluginId: "fusion-native",
        pluginVersion: "1.0.0",
        extensionId: "ccc-proof-admission",
        proofVersion: "ccc-proof-admission.v1",
        extensionRootRelativeSource: "ccc-campaign-proof-admission.js",
        extensionSourceSha256: "a".repeat(64),
        extensionManifestSha256: "b".repeat(64),
        definitionSha256: computeCccPrdProofDefinitionSha256(reordered),
        ...computeCccPrdProofV2AdmissionDigests(reordered),
      },
    };

    await expect(assertCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: [admitted],
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    })).resolves.toBeUndefined();
  });

  it("RED-R1-python-semantic-v2-controller-custody: observes and persists a complete Python runtime manifest", async () => {
    const state = await fixture({
      taskCommand: "python3 verify/python_adapter.py --target fixtures/python-target",
    });
    await mkdir(join(state.root, "verify"), { recursive: true });
    await mkdir(join(state.root, "fixtures/python-target"), { recursive: true });
    await mkdir(join(state.root, "src"), { recursive: true });
    await mkdir(join(state.root, "test"), { recursive: true });
    await writeFile(join(state.root, "src/slugify.js"), "export const slugify = () => 'candidate';\n");
    await writeFile(join(state.root, "test/slugify.test.js"), "export const proof = true;\n");
    await writeFile(join(state.root, "verify/python_adapter.py"), "print('adapter')\n");
    await writeFile(join(state.root, "fixtures/python-target/target.py"), "print('target')\n");
    await execFile("git", ["-C", state.root, "add", "Taskfile.yml", "verify/python_adapter.py", "fixtures/python-target/target.py", "src/slugify.js", "test/slugify.test.js"]);
    await execFile("git", [
      "-C", state.root,
      "-c", "user.name=Fusion Test",
      "-c", "user.email=fusion-test@example.invalid",
      "commit", "-m", "python semantic proof baseline",
    ]);
    const baseCommit = (await execFile("git", ["-C", state.root, "rev-parse", "HEAD"])).stdout.trim();
    const pythonRoot = await mkdtemp(join(tmpdir(), "ccc-python-runtime-"));
    roots.push(pythonRoot);
    const requestedPythonPath = (await execFile("which", ["python3"])).stdout.trim();
    const resolvedPythonProbe = await execFile(
      requestedPythonPath,
      ["-c", "import os,sys; print(os.path.realpath(sys.executable))"],
    );
    const resolvedPythonPath = await realpath(resolvedPythonProbe.stdout.trim());
    const frameworkPythonPath = resolve(
      dirname(resolvedPythonPath),
      "../Resources/Python.app/Contents/MacOS/Python",
    );
    const pythonPath = await realpath(existsSync(frameworkPythonPath) ? frameworkPythonPath : resolvedPythonPath);
    const versionProbe = await execFile(pythonPath, ["--version"], { encoding: "buffer" });
    const versionOutput = Buffer.concat([versionProbe.stdout, versionProbe.stderr]);
    const dylibRequestedPaths = new Map<string, Set<string>>();
    const dylibPaths = new Set<string>();
    const dylibLoaders = process.platform === "darwin" ? [pythonPath] : [];
    while (dylibLoaders.length > 0) {
      const loader = dylibLoaders.shift()!;
      const otool = await execFile("/usr/bin/otool", ["-L", loader]);
      for (const line of otool.stdout.split("\n").slice(1)) {
        const requested = line.trim().split(/\s+/u)[0];
        if (!requested || !requested.startsWith("/") || requested.startsWith("/usr/lib/") || requested.startsWith("/System/Library/") || !existsSync(requested)) continue;
        const canonical = await realpath(requested);
        const requestedSet = dylibRequestedPaths.get(canonical) ?? new Set<string>();
        requestedSet.add(requested);
        dylibRequestedPaths.set(canonical, requestedSet);
        if (!dylibPaths.has(canonical)) {
          dylibPaths.add(canonical);
          dylibLoaders.push(canonical);
        }
      }
    }
    const dylibClosure = await Promise.all([...dylibPaths].sort().map(async (path) => ({
      path,
      sha256: sha256(await readFile(path)),
      requestedPaths: [...(dylibRequestedPaths.get(path) ?? [])].sort(),
    })));
    const runtimeSupport = [];
    const runtimePaths = {
      stdlib: join(pythonRoot, "lib/python3.12/os.py"),
      sitePackages: join(pythonRoot, "lib/python3.12/site-packages/fixture.py"),
      extensionModules: join(pythonRoot, "lib/python3.12/lib-dynload/fixture.so"),
    } as const;
    await Promise.all(Object.values(runtimePaths).map(async (path) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `runtime:${path}\n`);
    }));
    const entry = async (path: string) => ({ path: await realpath(path), sha256: sha256(await readFile(path)) });
    const pythonIdentity = {
      executablePath: pythonPath,
      executableSha256: sha256(await readFile(pythonPath)),
      version: versionOutput.toString("utf8").trim(),
      versionOutputSha256: sha256(versionOutput),
      runtimeManifest: {
        schema: "ccc-prd.python-runtime-manifest.v1",
        interpreter: await entry(pythonPath),
        stdlibRoot: await realpath(dirname(runtimePaths.stdlib)),
        pythonHomeRoot: await realpath(pythonRoot),
        sitePackagesRoots: [await realpath(dirname(runtimePaths.sitePackages))],
        extensionModuleRoots: [await realpath(dirname(runtimePaths.extensionModules))],
        runtimeSupport,
        stdlib: [await entry(runtimePaths.stdlib)],
        sitePackages: [await entry(runtimePaths.sitePackages)],
        extensionModules: [await entry(runtimePaths.extensionModules)],
        dylibClosure,
      },
    };
    const adapterOid = (await execFile("git", ["-C", state.root, "rev-parse", `${baseCommit}:verify/python_adapter.py`])).stdout.trim();
    const targetOid = (await execFile("git", ["-C", state.root, "rev-parse", `${baseCommit}:fixtures/python-target/target.py`])).stdout.trim();
    const taskOid = (await execFile("git", ["-C", state.root, "rev-parse", `${baseCommit}:Taskfile.yml`])).stdout.trim();
    const proof = {
      ...state.proof,
      command: "task verify:slugify",
      verifierProfile: {
        schema: "ccc-prd.verifier.python-adapter.v1",
        adapterPath: "verify/python_adapter.py",
        targetPath: "fixtures/python-target",
      },
      verifierClosure: [
        { role: "task_runner", path: "Taskfile.yml", baseGitBlobOid: taskOid, sha256: sha256(await readFile(join(state.root, "Taskfile.yml"))) },
        { role: "harness", path: "verify/python_adapter.py", baseGitBlobOid: adapterOid, sha256: sha256(await readFile(join(state.root, "verify/python_adapter.py"))) },
        { role: "fixture", path: "fixtures/python-target/target.py", baseGitBlobOid: targetOid, sha256: sha256(await readFile(join(state.root, "fixtures/python-target/target.py"))) },
      ],
      executionToolchain: {
        ...state.proof.executionToolchain,
        python: pythonIdentity,
      },
    } as unknown as CccPrdProofV2;
    const hydrated = await hydrateCccPrdSemanticProofV2Custody({
      repositoryRoot: state.root,
      baseCommit,
      proofs: [proof],
      modelWriteRoots: ["src", "test"],
      toolchainPaths: {
        ...state.toolchainPaths,
        pythonExecutablePath: requestedPythonPath,
      },
    });

    expect(hydrated[0]!.executionToolchain.python?.runtimeManifest.stdlib).toEqual([
      await entry(runtimePaths.stdlib),
    ]);
  });

  it("RED-R1-python-discovery-controller-pythonpath: admits an existing absolute site-packages root from sanitized controller sys.path", async () => {
    const state = await fixture({
      taskCommand: "python3 verify/python_adapter.py --target fixtures/python-target",
    });
    await mkdir(join(state.root, "fixtures/python-target"), { recursive: true });
    await mkdir(join(state.root, "src"), { recursive: true });
    await mkdir(join(state.root, "test"), { recursive: true });
    await writeFile(join(state.root, "src/slugify.js"), "export const slugify = () => 'candidate';\n");
    await writeFile(join(state.root, "test/slugify.test.js"), "export const proof = true;\n");
    await writeFile(join(state.root, "verify/python_adapter.py"), "print('adapter')\n");
    await writeFile(join(state.root, "fixtures/python-target/target.py"), "print('target')\n");
    await execFile("git", [
      "-C", state.root,
      "add", "Taskfile.yml", "verify/python_adapter.py", "fixtures/python-target/target.py", "src/slugify.js", "test/slugify.test.js",
    ]);
    await execFile("git", [
      "-C", state.root,
      "-c", "user.name=Fusion Test",
      "-c", "user.email=fusion-test@example.invalid",
      "commit", "-m", "python explicit path baseline",
    ]);
    const baseCommit = (await execFile("git", ["-C", state.root, "rev-parse", "HEAD"])).stdout.trim();
    const sitePackagesParent = await mkdtemp(join(tmpdir(), "ccc-python-explicit-path-"));
    roots.push(sitePackagesParent);
    const sitePackagesRoot = join(sitePackagesParent, ".venv", "lib", "python3.12", "site-packages");
    await mkdir(sitePackagesRoot, { recursive: true });
    const canonicalSitePackagesRoot = await realpath(sitePackagesRoot);
    const sitePackagesFile = join(sitePackagesRoot, "controller_fixture.py");
    const extensionModuleFile = join(sitePackagesRoot, "controller_extension.so");
    const sitecustomizeMarker = join(sitePackagesParent, "sitecustomize-ran");
    await writeFile(sitePackagesFile, "CONTROLLER_EXPLICIT = True\n");
    await writeFile(extensionModuleFile, "not-a-real-extension\n");
    await writeFile(
      join(sitePackagesRoot, "sitecustomize.py"),
      `from pathlib import Path\nPath(${JSON.stringify(sitecustomizeMarker)}).write_text("executed")\n`,
    );

    const requestedPythonPath = await controllerPython312Path();
    const proof = {
      ...state.proof,
      verifierProfile: {
        schema: "ccc-prd.verifier.python-adapter.v1" as const,
        adapterPath: "verify/python_adapter.py",
        targetPath: "fixtures/python-target",
      },
      verifierClosure: [
        {
          role: "task_runner" as const,
          path: "Taskfile.yml",
          baseGitBlobOid: (await execFile("git", ["-C", state.root, "rev-parse", `${baseCommit}:Taskfile.yml`])).stdout.trim(),
          sha256: sha256(await readFile(join(state.root, "Taskfile.yml"))),
        },
        {
          role: "harness" as const,
          path: "verify/python_adapter.py",
          baseGitBlobOid: (await execFile("git", ["-C", state.root, "rev-parse", `${baseCommit}:verify/python_adapter.py`])).stdout.trim(),
          sha256: sha256(await readFile(join(state.root, "verify/python_adapter.py"))),
        },
        {
          role: "fixture" as const,
          path: "fixtures/python-target/target.py",
          baseGitBlobOid: (await execFile("git", ["-C", state.root, "rev-parse", `${baseCommit}:fixtures/python-target/target.py`])).stdout.trim(),
          sha256: sha256(await readFile(join(state.root, "fixtures/python-target/target.py"))),
        },
      ],
      executionToolchain: {
        ...state.proof.executionToolchain,
        python: {
          executablePath: "",
          executableSha256: "",
          version: "",
          versionOutputSha256: "",
          runtimeManifest: {
            schema: "ccc-prd.python-runtime-manifest.v1" as const,
            interpreter: { path: "", sha256: "" },
            stdlibRoot: "",
            pythonHomeRoot: "",
            sitePackagesRoots: [],
            extensionModuleRoots: [],
            runtimeSupport: [],
            stdlib: [],
            sitePackages: [],
            extensionModules: [],
            dylibClosure: [],
          },
        },
      },
    } as unknown as CccPrdProofV2;

    const toolchainPaths = {
      ...state.toolchainPaths,
      pythonExecutablePath: requestedPythonPath,
      pythonPathRoots: [canonicalSitePackagesRoot],
    } as CccPrdSemanticProofToolchainPaths;
    const hydrated = await hydrateCccPrdSemanticProofV2Custody({
      repositoryRoot: state.root,
      baseCommit,
      proofs: [proof],
      modelWriteRoots: ["src", "test"],
      toolchainPaths,
    });
    const manifest = hydrated[0]!.executionToolchain.python!.runtimeManifest;

    expect(manifest.sitePackagesRoots).toContain(await realpath(sitePackagesRoot));
    expect(manifest.sitePackages).toContainEqual({
      path: await realpath(sitePackagesFile),
      sha256: sha256(await readFile(sitePackagesFile)),
    });
    expect(manifest.extensionModules).toContainEqual({
      path: await realpath(extensionModuleFile),
      sha256: sha256(await readFile(extensionModuleFile)),
    });
    expect(existsSync(sitecustomizeMarker)).toBe(false);
    for (const pythonPathRoots of [
      [".venv/lib/python3.12/site-packages"],
      [join(sitePackagesParent, "missing-site-packages")],
    ]) {
      await expect(hydrateCccPrdSemanticProofV2Custody({
        repositoryRoot: state.root,
        baseCommit,
        proofs: [proof],
        modelWriteRoots: ["src", "test"],
        toolchainPaths: { ...toolchainPaths, pythonPathRoots },
      })).rejects.toThrow(/controller PYTHONPATH|root/u);
    }
  });

  it("RED-S5-preflight-no-probe-before-hash: rejects a replaced executable before its version command can run", async () => {
    const f = await fixture();
    const hydratedWithoutAdmission = await hydrateCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: [f.proof],
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    });
    const admitted = hydratedWithoutAdmission.map((proof) => ({
      ...proof,
      admission: {
        schema: "ccc-prd.proof-admission.v2" as const,
        pluginId: "fusion-native",
        pluginVersion: "1.0.0",
        extensionId: "ccc-proof-admission",
        proofVersion: "ccc-proof-admission.v1",
        extensionRootRelativeSource: "ccc-campaign-proof-admission.js",
        extensionSourceSha256: "a".repeat(64),
        extensionManifestSha256: "b".repeat(64),
        definitionSha256: computeCccPrdProofDefinitionSha256(proof),
        ...computeCccPrdProofV2AdmissionDigests(proof),
      },
    }));
    const markerPath = join(f.root, "swapped-task-ran.marker");
    await writeFile(
      f.toolchainPaths.taskExecutablePath,
      `#!/bin/sh\nprintf swapped > ${markerPath}\nprintf 'Task swapped 2.0.0\\n'\n`,
      { mode: 0o755 },
    );
    await chmod(f.toolchainPaths.taskExecutablePath, 0o755);

    await expect(assertCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: admitted,
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    })).rejects.toThrow(/(?:custody|identity) drifted/u);
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("RED-S5-authoring-sealed-probe: launches controller-read sealed bytes instead of the mutable original path", async () => {
    const f = await fixture();
    const replacementPath = join(f.root, "task-replacement");
    const markerPath = join(f.root, "authoring-swapped-task-ran.marker");
    const originalTask = [
      "#!/bin/sh",
      "case \"$0\" in",
      "  *ccc-semantic-proof-authoring-toolchain-*)",
      `    mv \"${replacementPath}\" \"${f.toolchainPaths.taskExecutablePath}\"`,
      "    printf 'Task version: sealed-original\\n'",
      "    ;;",
      "  *)",
      "    printf 'Task version: mutable-original-path\\n'",
      "    ;;",
      "esac",
      "",
    ].join("\n");
    await writeFile(f.toolchainPaths.taskExecutablePath, originalTask, { mode: 0o755 });
    await writeFile(replacementPath, [
      "#!/bin/sh",
      `printf swapped > ${markerPath}`,
      "printf 'Task version: swapped\\n'",
      "",
    ].join("\n"), { mode: 0o755 });
    await Promise.all([
      chmod(f.toolchainPaths.taskExecutablePath, 0o755),
      chmod(replacementPath, 0o755),
    ]);

    const [hydrated] = await hydrateCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: [f.proof],
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    });
    expect(hydrated!.executionToolchain.task.version).toBe("Task version: sealed-original");
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(f.toolchainPaths.taskExecutablePath, "utf8"))
      .resolves.toContain("authoring-swapped-task-ran.marker");
  });

  it("RED-S5-authoring-shared-sealed-node: proof-host probe uses the sealed Node after original Node is swapped", async () => {
    const f = await fixture();
    const nodePath = join(f.root, "node-fixture");
    f.toolchainPaths.nodeExecutablePath = nodePath;
    const originalNode = [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then printf 'Node version: sealed-original\\n'; exit 0; fi",
      "exec \"$@\"",
      `# ${"x".repeat(16 * 1024 * 1024)}`,
      "",
    ].join("\n");
    const replacementPath = join(f.root, "node-replacement");
    const markerPath = join(f.root, "authoring-swapped-node-ran.marker");
    await writeFile(nodePath, originalNode, { mode: 0o755 });
    const originalNodeWithSwap = [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then",
      `  mv ${replacementPath} ${nodePath}`,
      "  printf 'Node version: sealed-original\\n'",
      "  exit 0",
      "fi",
      "exec \"$@\"",
      "",
    ].join("\n");
    await writeFile(nodePath, originalNodeWithSwap, { mode: 0o755 });
    await writeFile(
      f.toolchainPaths.proofHost.executablePath,
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'proof-host-test\\n'; fi\n",
      { mode: 0o755 },
    );
    await writeFile(replacementPath, [
      "#!/bin/sh",
      `printf swapped-node > ${markerPath}`,
      "exit 42",
      "",
    ].join("\n"), { mode: 0o755 });
    await Promise.all([
      chmod(nodePath, 0o755),
      chmod(f.toolchainPaths.proofHost.executablePath, 0o755),
      chmod(replacementPath, 0o755),
    ]);

    const hydration = hydrateCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: [f.proof],
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    });

    const [hydrated] = await hydration;
    expect(hydrated!.executionToolchain.proofHost.version).toBe("proof-host-test");
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("RED-S5-task-grammar: refuses Task indirection before any proof becomes executable", async () => {
    const f = await fixture({
      taskCommand: "node verify/slugify.acceptance.test.js $CCC_CANDIDATES",
    });
    await expect(hydrateCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: [f.proof],
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    })).rejects.toThrow(/literal and substitution-free/u);
  });

  it("RED-R1-multi-target-taskfile: admits a selected proof target when another verify target exists", async () => {
    const f = await fixture({
      additionalTaskfileLines: [
        "  verify:integrated:",
        "    cmds:",
        "      - node verify/slugify.acceptance.test.js src/slugify.js test/slugify.test.js",
      ],
    });

    await expect(hydrateCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: [f.proof],
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    })).resolves.toHaveLength(1);
  });

  it("RED-R1-taskfile-selected-target: admits a strict selected verify target alongside ordinary tasks", async () => {
    const f = await fixture({
      additionalTaskfileLines: [
        "  setup:",
        "    desc: Install project dependencies",
        "    deps:",
        "      - bootstrap",
        "    vars:",
        "      ENV: development",
        "    cmds:",
        "      - pnpm install --filter '{{.ENV}}'",
      ],
    });

    await expect(hydrateCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: [f.proof],
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    })).resolves.toHaveLength(1);
  });

  it("RED-S5-candidate-set-order: admits the exact candidate set independent of Task argv order", async () => {
    const f = await fixture();
    const proof = {
      ...f.proof,
      candidateInputs: [...f.proof.candidateInputs].reverse(),
    };

    await expect(hydrateCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: [proof],
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    })).resolves.toHaveLength(1);
  });

  it("RED-R1-taskfile-unselected-target: ignores dependencies hidden in an unselected target", async () => {
    const f = await fixture({
      additionalTaskfileLines: [
        "  verify:hidden:",
        "    deps:",
        "      - verify:slugify",
        "    cmds:",
        "      - node verify/slugify.acceptance.test.js src/slugify.js test/slugify.test.js",
      ],
    });

    await expect(hydrateCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: [f.proof],
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    })).resolves.toHaveLength(1);
  });

  it("RED-R1-taskfile-unselected-target-path: ignores a noncanonical path hidden in an unselected target", async () => {
    const f = await fixture({
      additionalTaskfileLines: [
        "  verify:hidden:",
        "    cmds:",
        "      - node verify/../hidden.js src/slugify.js test/slugify.test.js",
      ],
    });

    await expect(hydrateCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: [f.proof],
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    })).resolves.toHaveLength(1);
  });

  it("RED-S5-selected-target-grammar: refuses dependencies on the selected target", async () => {
    const f = await fixture({
      additionalTaskfileLines: [
        "    deps:",
        "      - bootstrap",
      ],
    });

    await expect(hydrateCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: [f.proof],
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    })).rejects.toThrow(/dependencies behavior is forbidden/u);
  });

  it("RED-S5-taskfile-root-grammar: refuses unknown top-level behavior", async () => {
    const f = await fixture({ additionalTaskfileLines: ["metadata: unsafe"] });

    await expect(hydrateCccPrdSemanticProofV2Custody({
      repositoryRoot: f.root,
      baseCommit: f.baseCommit,
      proofs: [f.proof],
      modelWriteRoots: ["src", "test"],
      toolchainPaths: f.toolchainPaths,
    })).rejects.toThrow(/Taskfile metadata behavior is forbidden/u);
  });
});
