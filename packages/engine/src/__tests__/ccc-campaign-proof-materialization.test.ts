import { createHash } from "node:crypto";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CCC_PRD_SEMANTIC_PROOF_HOST_ID,
  computeCccPrdCandidateInputsSha256,
  computeCccPrdVerifierClosureSha256,
  type CccPrdProofV2,
} from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitAndMaterializeCccSemanticProof,
  EXECUTABLE_PROBE_TIMEOUT_MS,
  inspectCccSemanticProofExecutable,
  inspectCccSemanticProofLinkedRuntime,
  verifyCccSemanticProofToolchainBeforeSpawn,
} from "../ccc-campaign-proof-materialization.js";
import { runCccSemanticProofSandboxedProcess } from "../ccc-campaign-proof-sandbox.js";

let runtimePathToSwap: string | undefined;
let replacementPathToSwap: string | undefined;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const [path] = args;
      if (runtimePathToSwap && replacementPathToSwap && typeof path === "string" && path === runtimePathToSwap) {
        await actual.rename(replacementPathToSwap, runtimePathToSwap);
        runtimePathToSwap = undefined;
        replacementPathToSwap = undefined;
      }
      return actual.realpath(...args);
    },
  };
});

const execFile = promisify(execFileCallback);
const actualExecFile = execFileCallback;
const roots: string[] = [];
// This copies, hashes, and executes the complete host Python runtime under
// sandbox-exec. Keep it out of the default parallel engine matrix; the
// dedicated qualification command opts in with FUSION_TEST_REAL_PYTHON_SEAL_SMOKE=1.
const runRealPythonSealSmoke = process.env.FUSION_TEST_REAL_PYTHON_SEAL_SMOKE === "1";
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

const EXECUTABLE_PATH_PREFIX = "@executable_path/";

type RelativeInstallNameCPython = {
  interpreterPath: string;
  dylibPath: string;
  requestedPath: string;
  installRoot: string;
  stdlibDirectoryName: string;
};

// python-build-standalone interpreters (what `uv python install` ships) name
// libpython through a short relative `@executable_path/../lib/libpython3.N.dylib`
// with only a few dozen spare bytes in the load command. Homebrew and framework
// interpreters use absolute install names and never exercise that headroom, so a
// real interpreter of this shape is the only binary that proves the seal works.
// Discovery is synchronous so `it.runIf` can gate at collection time.
function findRelativeInstallNameCPython(): RelativeInstallNameCPython | undefined {
  if (process.platform !== "darwin") return undefined;
  const installDir = process.env.UV_PYTHON_INSTALL_DIR
    ?? join(homedir(), ".local", "share", "uv", "python");
  let distributions: string[];
  try {
    distributions = readdirSync(installDir).filter((name) => !name.startsWith(".")).sort();
  } catch {
    return undefined;
  }
  for (const distribution of distributions) {
    const binDirectory = join(installDir, distribution, "bin");
    let launchers: string[];
    try {
      launchers = readdirSync(binDirectory).filter((name) => /^python3\.\d+$/u.test(name)).sort();
    } catch {
      continue;
    }
    for (const launcher of launchers) {
      const interpreterPath = join(binDirectory, launcher);
      let linked: string;
      try {
        linked = execFileSync("/usr/bin/otool", ["-L", interpreterPath], { encoding: "utf8" });
      } catch {
        continue;
      }
      for (const line of linked.split("\n").slice(1)) {
        const requestedPath = line.trim().split(/\s+/u)[0];
        if (!requestedPath?.startsWith(EXECUTABLE_PATH_PREFIX)) continue;
        const dylibPath = resolve(
          dirname(interpreterPath),
          requestedPath.slice(EXECUTABLE_PATH_PREFIX.length),
        );
        if (!existsSync(dylibPath)) continue;
        const installRoot = dirname(binDirectory);
        const stdlibDirectoryName = launcher;
        if (!existsSync(join(installRoot, "lib", stdlibDirectoryName))) continue;
        return { interpreterPath, dylibPath, requestedPath, installRoot, stdlibDirectoryName };
      }
    }
  }
  return undefined;
}

const relativeInstallNameCPython = findRelativeInstallNameCPython();

async function createGitFixture(): Promise<{
  repository: string;
  baseCommit: string;
  candidateCommit: string;
  taskOid: string;
  harnessOid: string;
}> {
  const repository = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-git-"));
  roots.push(repository);
  await execFile("git", ["init", "--initial-branch=main", repository]);
  await execFile("git", ["-C", repository, "config", "user.name", "CCC Proof Test"]);
  await execFile("git", ["-C", repository, "config", "user.email", "proof@example.invalid"]);
  await Promise.all([
    mkdir(join(repository, "verify")),
    mkdir(join(repository, "src")),
  ]);
  await writeFile(join(repository, "Taskfile.yml"), [
    "version: '3'",
    "tasks:",
    "  verify:slugify:",
    "    cmds:",
    "      - node verify/slugify.mjs src/slugify.js",
    "  verify:other:",
    "    cmds:",
    "      - node verify/other.mjs src/other.js",
    "",
  ].join("\n"));
  await writeFile(join(repository, "verify", "slugify.mjs"), "process.stdout.write('{}\\n');\n");
  await writeFile(join(repository, "verify", "other.mjs"), "process.stdout.write('{}\\n');\n");
  await writeFile(join(repository, "src", "slugify.js"), "export const slugify = () => 'base';\n");
  await writeFile(join(repository, "src", "other.js"), "export const other = () => 'base';\n");
  await execFile("git", ["-C", repository, "add", "Taskfile.yml", "verify/slugify.mjs", "verify/other.mjs", "src/slugify.js", "src/other.js"]);
  await execFile("git", ["-C", repository, "commit", "-m", "base verifier"]);
  const baseCommit = (await execFile("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  const taskOid = (await execFile("git", ["-C", repository, "rev-parse", `${baseCommit}:Taskfile.yml`])).stdout.trim();
  const harnessOid = (await execFile("git", ["-C", repository, "rev-parse", `${baseCommit}:verify/slugify.mjs`])).stdout.trim();
  await writeFile(join(repository, "src", "slugify.js"), "export const slugify = () => 'candidate';\n");
  await execFile("git", ["-C", repository, "add", "src/slugify.js"]);
  await execFile("git", ["-C", repository, "commit", "-m", "candidate"]);
  const candidateCommit = (await execFile("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  return { repository, baseCommit, candidateCommit, taskOid, harnessOid };
}

async function executableIdentity(path: string) {
  return inspectCccSemanticProofExecutable(path, ["--version"]);
}

function proof(input: {
  taskOid: string;
  harnessOid: string;
  taskIdentity: Awaited<ReturnType<typeof executableIdentity>>;
  nodeIdentity: Awaited<ReturnType<typeof executableIdentity>>;
  linkedRuntime?: CccPrdProofV2["executionToolchain"]["linkedRuntime"];
}): CccPrdProofV2 {
  return {
    schema: "ccc-prd.proof.v2",
    id: "PROOF-slugify",
    requirementIds: ["REQ-slugify"],
    clauseIds: ["AC-REQ-slugify-001"],
    phases: ["task", "final_integrated"],
    command: "task verify:slugify",
    positiveOracle: "declared evidence passes",
    positiveCases: [{ id: "CASE-slug", description: "candidate produces a slug" }],
    negativeControls: [{ id: "CONTROL-empty", description: "empty-string regression is caught" }],
    verifierClosure: [
      {
        role: "task_runner",
        path: "Taskfile.yml",
        baseGitBlobOid: input.taskOid,
        sha256: sha256(["version: '3'", "tasks:", "  verify:slugify:", "    cmds:", "      - node verify/slugify.mjs src/slugify.js", "  verify:other:", "    cmds:", "      - node verify/other.mjs src/other.js", ""].join("\n")),
      },
      {
        role: "harness",
        path: "verify/slugify.mjs",
        baseGitBlobOid: input.harnessOid,
        sha256: sha256("process.stdout.write('{}\\n');\n"),
      },
    ],
    candidateInputs: ["src/slugify.js"],
    executionToolchain: {
      task: input.taskIdentity,
      node: input.nodeIdentity,
      proofHost: {
        id: "fusion-native-semantic-proof-v2",
        ...input.nodeIdentity,
      },
      linkedRuntime: input.linkedRuntime ?? [],
    },
    spans: [],
    confidence: "high",
  };
}

async function createPythonMaterializationFixture(
  additionalTaskfileLines: readonly string[] = [],
): Promise<{
  fixture: Awaited<ReturnType<typeof createGitFixture>>;
  proofBaseCommit: string;
  outputRoot: string;
  toolRoot: string;
  definition: CccPrdProofV2;
  runtimeFiles: {
    stdlib: string;
    sitePackages: string;
    extensionModules: string;
    dylibClosure: string;
  };
}> {
  const fixture = await createGitFixture();
  const outputRoot = await mkdtemp(join(tmpdir(), "ccc-python-semantic-proof-output-"));
  const toolRootRaw = await mkdtemp(join(tmpdir(), "ccc-python-semantic-proof-runtime-"));
  const toolRoot = await realpath(toolRootRaw);
  roots.push(outputRoot, toolRootRaw);
  const adapterPath = "verify/python_adapter.py";
  const targetPath = "fixtures/python-target";
  await mkdir(join(fixture.repository, "fixtures/python-target"), { recursive: true });
  await writeFile(join(fixture.repository, adapterPath), "print('adapter')\n");
  await writeFile(join(fixture.repository, targetPath, "target.py"), "print('target')\n");
  await writeFile(join(fixture.repository, "Taskfile.yml"), [
    "version: '3'",
    "tasks:",
    "  verify:slugify:",
    "    cmds:",
    `      - python3 ${adapterPath} --target ${targetPath}`,
    ...additionalTaskfileLines,
    "",
  ].join("\n"));
  await execFile("git", ["-C", fixture.repository, "add", "Taskfile.yml", adapterPath, targetPath]);
  await execFile("git", ["-C", fixture.repository, "commit", "-m", "python semantic proof baseline"]);
  const baseCommit = (await execFile("git", ["-C", fixture.repository, "rev-parse", "HEAD"])).stdout.trim();
  const gitOid = async (path: string) => (
    await execFile("git", ["-C", fixture.repository, "rev-parse", `${baseCommit}:${path}`])
  ).stdout.trim();
  const taskIdentity = await executableIdentity("/opt/homebrew/bin/task");
  const nodeIdentity = await executableIdentity(process.execPath);
  const pythonPath = join(toolRoot, "python3");
  await writeFile(pythonPath, "#!/bin/sh\nprintf 'Python 3.12.10\\n'\n", { mode: 0o755 });
  await chmod(pythonPath, 0o755);
  const pythonIdentity = await executableIdentity(pythonPath);
  const runtimeFiles = {
    stdlib: join(toolRoot, "lib/python3.12/os.py"),
    sitePackages: join(toolRoot, "lib/python3.12/site-packages/fixture.py"),
    extensionModules: join(toolRoot, "lib/python3.12/lib-dynload/fixture.so"),
    dylibClosure: join(toolRoot, "lib/libpython3.12.dylib"),
  } as const;
  await Promise.all(Object.values(runtimeFiles).map(async (path) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `runtime:${path}\n`);
  }));
  const runtimeEntry = async (path: string) => ({
    path,
    sha256: sha256(await readFile(path)),
  });
  const definition = proof({
    ...fixture,
    taskOid: await gitOid("Taskfile.yml"),
    taskIdentity,
    nodeIdentity,
    linkedRuntime: [],
  });
  definition.verifierClosure[0] = {
    ...definition.verifierClosure[0],
    baseGitBlobOid: await gitOid("Taskfile.yml"),
    sha256: sha256(await readFile(join(fixture.repository, "Taskfile.yml"))),
  };
  definition.verifierClosure[1] = {
    role: "harness",
    path: adapterPath,
    baseGitBlobOid: await gitOid(adapterPath),
    sha256: sha256(await readFile(join(fixture.repository, adapterPath))),
  };
  definition.verifierClosure.push({
    role: "fixture",
    path: `${targetPath}/target.py`,
    baseGitBlobOid: await gitOid(`${targetPath}/target.py`),
    sha256: sha256(await readFile(join(fixture.repository, `${targetPath}/target.py`))),
  });
  definition.verifierProfile = {
    schema: "ccc-prd.verifier.python-adapter.v1",
    adapterPath,
    targetPath,
  };
  definition.executionToolchain.python = {
    ...pythonIdentity,
    runtimeManifest: {
      schema: "ccc-prd.python-runtime-manifest.v1",
      interpreter: await runtimeEntry(pythonPath),
      stdlibRoot: join(toolRoot, "lib/python3.12"),
      pythonHomeRoot: toolRoot,
      sitePackagesRoots: [join(toolRoot, "lib/python3.12/site-packages")],
      extensionModuleRoots: [join(toolRoot, "lib/python3.12/lib-dynload")],
      runtimeSupport: [await runtimeEntry(runtimeFiles.dylibClosure)],
      stdlib: [await runtimeEntry(runtimeFiles.stdlib)],
      sitePackages: [await runtimeEntry(runtimeFiles.sitePackages)],
      extensionModules: [await runtimeEntry(runtimeFiles.extensionModules)],
      dylibClosure: [],
    },
  };
  definition.executionToolchain.linkedRuntime = await inspectCccSemanticProofLinkedRuntime({
    task: taskIdentity,
    node: nodeIdentity,
    proofHost: { id: "fusion-native-semantic-proof-v2", ...nodeIdentity },
  });
  return {
    fixture,
    proofBaseCommit: baseCommit,
    outputRoot,
    toolRoot,
    definition,
    runtimeFiles,
  };
}

// maturin / Rust-built CPython extension modules ship as MH_DYLIB with an
// LC_ID_DYLIB of @rpath/<package>.<module>.so and no LC_RPATH, so the id never
// resolves on disk. otool -L prints that id as its own first dependency line.
const MACH_O_FIXTURE_SELF_ID = "@rpath/ccc_fixture.fixture.abi3.so";
const MACH_O_FIXTURE_MISSING_DEPENDENCY = "@rpath/ccc_fixture_missing.dylib";
const darwinMachOFixtureRunnable = process.platform === "darwin"
  && existsSync("/usr/bin/clang")
  && existsSync("/usr/bin/otool")
  && existsSync("/opt/homebrew/bin/task");

async function darwinInstallNameIds(machOPath: string): Promise<string[]> {
  const { stdout } = await execFile("/usr/bin/otool", ["-D", machOPath]);
  return stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("Architecture:"));
}

async function compileDarwinFixtureDylib(
  installName: string,
  missingDependencyInstallName?: string,
): Promise<Buffer> {
  const buildRoot = await mkdtemp(join(tmpdir(), "ccc-macho-fixture-"));
  roots.push(buildRoot);
  const sourcePath = join(buildRoot, "fixture.c");
  const outputPath = join(buildRoot, "fixture.so");
  const linkArgs: string[] = [];
  if (missingDependencyInstallName) {
    const stubSourcePath = join(buildRoot, "stub.c");
    await writeFile(stubSourcePath, "int ccc_fixture_stub_symbol(void) { return 7; }\n");
    await execFile("/usr/bin/clang", [
      "-dynamiclib",
      "-install_name",
      missingDependencyInstallName,
      "-o",
      join(buildRoot, "libcccfixturestub.dylib"),
      stubSourcePath,
    ]);
    await writeFile(sourcePath, [
      "extern int ccc_fixture_stub_symbol(void);",
      "int ccc_fixture_symbol(void) { return ccc_fixture_stub_symbol() + 1; }",
      "",
    ].join("\n"));
    // The stub is linked but never sealed, so its @rpath name stays a genuine
    // unresolvable LOAD dependency inside the sealed root.
    linkArgs.push(`-L${buildRoot}`, "-lcccfixturestub");
  } else {
    await writeFile(sourcePath, "int ccc_fixture_symbol(void) { return 1; }\n");
  }
  await execFile("/usr/bin/clang", [
    "-dynamiclib",
    "-install_name",
    installName,
    "-o",
    outputPath,
    sourcePath,
    ...linkArgs,
  ]);
  return readFile(outputPath);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    const makeWriteable = async (path: string): Promise<void> => {
      await chmod(path, 0o755).catch(() => undefined);
      const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
      await Promise.all(entries.map(async (entry) => {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await makeWriteable(child);
        else if (!entry.isSymbolicLink()) await chmod(child, 0o644).catch(() => undefined);
      }));
    };
    await makeWriteable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

describe("CCC semantic-proof admission and materialization", () => {
  it("RED-S5-controller-git-custody: refuses to spawn a fake git earlier on PATH", async () => {
    const fixture = await createGitFixture();
    const outputRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-output-"));
    const fakeBin = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-fake-git-"));
    roots.push(outputRoot, fakeBin);
    const marker = join(fakeBin, "fake-git-ran");
    await writeFile(join(fakeBin, "git"), [
      "#!/bin/sh",
      `printf hit > ${marker}`,
      "if [ \"$1\" = \"--version\" ]; then printf 'git version hostile\\n'; exit 0; fi",
      "exit 42",
      "",
    ].join("\n"));
    await chmod(join(fakeBin, "git"), 0o755);
    const taskIdentity = await executableIdentity("/opt/homebrew/bin/task");
    const nodeIdentity = await executableIdentity(process.execPath);
    const definition = proof({
      ...fixture,
      taskIdentity,
      nodeIdentity,
      linkedRuntime: await inspectCccSemanticProofLinkedRuntime({
        task: taskIdentity,
        node: nodeIdentity,
        proofHost: { id: "fusion-native-semantic-proof-v2", ...nodeIdentity },
      }),
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    try {
      await expect(admitAndMaterializeCccSemanticProof({
        repositoryRoot: fixture.repository,
        baseCommit: fixture.baseCommit,
        sourceCommit: fixture.candidateCommit,
        proof: definition,
        modelWriteRoots: ["src"],
        outputRoot,
      })).resolves.toMatchObject({
        taskTarget: "verify:slugify",
      });
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("RED-S5-closure-git-custody: materializes frozen verifier blobs and exact candidate commit bytes only", async () => {
    const fixture = await createGitFixture();
    const outputRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-output-"));
    roots.push(outputRoot);
    const taskIdentity = await executableIdentity("/opt/homebrew/bin/task");
    const nodeIdentity = await executableIdentity(process.execPath);

    const definition = proof({
      ...fixture,
      taskIdentity,
      nodeIdentity,
      linkedRuntime: await inspectCccSemanticProofLinkedRuntime({
        task: taskIdentity,
        node: nodeIdentity,
        proofHost: { id: "fusion-native-semantic-proof-v2", ...nodeIdentity },
      }),
    });
    const materialized = await admitAndMaterializeCccSemanticProof({
      repositoryRoot: fixture.repository,
      baseCommit: fixture.baseCommit,
      sourceCommit: fixture.candidateCommit,
      proof: definition,
      modelWriteRoots: ["src"],
      outputRoot,
    });

    await expect(readFile(join(materialized.proofRoot, "Taskfile.yml"), "utf8"))
      .resolves.toContain("node verify/slugify.mjs src/slugify.js");
    await expect(readFile(join(materialized.proofRoot, "src", "slugify.js"), "utf8"))
      .resolves.toContain("candidate");
    await expect(readFile(join(materialized.proofRoot, ".git"), "utf8")).rejects.toThrow();
    expect((await stat(join(materialized.proofRoot, "src", "slugify.js"))).mode & 0o222).toBe(0);
    expect(materialized.closureSha256).toBe(
      computeCccPrdVerifierClosureSha256(definition.verifierClosure),
    );
    expect(materialized.candidateInputsSha256).toBe(
      computeCccPrdCandidateInputsSha256(definition.candidateInputs),
    );
    if (process.platform === "darwin") {
      const sealedNodeLib = resolve(dirname(materialized.sealedToolchain.nodeExecutable), "..", "lib");
      expect(await readdir(sealedNodeLib))
        .toEqual(expect.arrayContaining([expect.stringMatching(/^libnode\.\d+\.dylib$/u)]));
    }
  });

  it("RED-S5-runtime-candidate-set-order: materializes the exact candidate set independent of Task argv order", async () => {
    const fixture = await createGitFixture();
    const outputRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-output-"));
    roots.push(outputRoot);
    const taskfile = [
      "version: '3'",
      "tasks:",
      "  verify:slugify:",
      "    cmds:",
      "      - node verify/slugify.mjs src/slugify.js src/other.js",
      "  verify:other:",
      "    cmds:",
      "      - node verify/other.mjs src/other.js",
      "",
    ].join("\n");
    await writeFile(join(fixture.repository, "Taskfile.yml"), taskfile);
    await execFile("git", ["-C", fixture.repository, "add", "Taskfile.yml"]);
    await execFile("git", ["-C", fixture.repository, "commit", "-m", "bind two proof candidates"]);
    const baseCommit = (await execFile(
      "git",
      ["-C", fixture.repository, "rev-parse", "HEAD"],
    )).stdout.trim();
    const taskOid = (await execFile(
      "git",
      ["-C", fixture.repository, "rev-parse", `${baseCommit}:Taskfile.yml`],
    )).stdout.trim();
    await writeFile(
      join(fixture.repository, "src", "slugify.js"),
      "export const slugify = () => 'candidate-two';\n",
    );
    await execFile("git", ["-C", fixture.repository, "add", "src/slugify.js"]);
    await execFile("git", ["-C", fixture.repository, "commit", "-m", "second candidate"]);
    const sourceCommit = (await execFile(
      "git",
      ["-C", fixture.repository, "rev-parse", "HEAD"],
    )).stdout.trim();
    const taskIdentity = await executableIdentity("/opt/homebrew/bin/task");
    const nodeIdentity = await executableIdentity(process.execPath);
    const definition = proof({
      ...fixture,
      taskOid,
      taskIdentity,
      nodeIdentity,
      linkedRuntime: await inspectCccSemanticProofLinkedRuntime({
        task: taskIdentity,
        node: nodeIdentity,
        proofHost: { id: "fusion-native-semantic-proof-v2", ...nodeIdentity },
      }),
    });
    definition.verifierClosure[0] = {
      ...definition.verifierClosure[0]!,
      baseGitBlobOid: taskOid,
      sha256: sha256(taskfile),
    };
    definition.candidateInputs = ["src/other.js", "src/slugify.js"];

    await expect(admitAndMaterializeCccSemanticProof({
      repositoryRoot: fixture.repository,
      baseCommit,
      sourceCommit,
      proof: definition,
      modelWriteRoots: ["src"],
      outputRoot,
    })).resolves.toMatchObject({
      candidateInputsSha256: computeCccPrdCandidateInputsSha256(definition.candidateInputs),
    });
  });

  it("RED-S5-closure-git-custody: refuses verifier closure inside a model-owned root", async () => {
    const fixture = await createGitFixture();
    const outputRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-output-"));
    roots.push(outputRoot);
    const taskIdentity = await executableIdentity("/opt/homebrew/bin/task");
    const nodeIdentity = await executableIdentity(process.execPath);
    const definition = proof({
      ...fixture,
      taskIdentity,
      nodeIdentity,
      linkedRuntime: await inspectCccSemanticProofLinkedRuntime({
        task: taskIdentity,
        node: nodeIdentity,
        proofHost: { id: "fusion-native-semantic-proof-v2", ...nodeIdentity },
      }),
    });
    definition.verifierClosure[1] = {
      ...definition.verifierClosure[1]!,
      path: "src/slugify.js",
      baseGitBlobOid: (await execFile("git", ["-C", fixture.repository, "rev-parse", `${fixture.baseCommit}:src/slugify.js`])).stdout.trim(),
      sha256: sha256("export const slugify = () => 'base';\n"),
    };

    await expect(admitAndMaterializeCccSemanticProof({
      repositoryRoot: fixture.repository,
      baseCommit: fixture.baseCommit,
      sourceCommit: fixture.candidateCommit,
      proof: definition,
      modelWriteRoots: ["src"],
      outputRoot,
    })).rejects.toThrow("model-writeable");
  });

  it("RED-S5-task-target-closure: refuses Task targets with undeclared dynamic or dependency behavior", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.repository, "Taskfile.yml"), [
      "version: '3'",
      "includes:",
      "  hidden: ./verify/hidden.yml",
      "tasks:",
      "  verify:slugify:",
      "    deps: [hidden:test]",
      "    cmds:",
      "      - node verify/slugify.mjs src/slugify.js",
      "",
    ].join("\n"));
    await execFile("git", ["-C", fixture.repository, "add", "Taskfile.yml"]);
    await execFile("git", ["-C", fixture.repository, "commit", "-m", "unsafe task target"]);
    const unsafeBase = (await execFile("git", ["-C", fixture.repository, "rev-parse", "HEAD"])).stdout.trim();
    const taskOid = (await execFile("git", ["-C", fixture.repository, "rev-parse", `${unsafeBase}:Taskfile.yml`])).stdout.trim();
    const taskIdentity = await executableIdentity("/opt/homebrew/bin/task");
    const nodeIdentity = await executableIdentity(process.execPath);
    const definition = proof({
      ...fixture,
      taskOid,
      taskIdentity,
      nodeIdentity,
      linkedRuntime: await inspectCccSemanticProofLinkedRuntime({
        task: taskIdentity,
        node: nodeIdentity,
        proofHost: { id: "fusion-native-semantic-proof-v2", ...nodeIdentity },
      }),
    });
    definition.verifierClosure[0]!.sha256 = sha256(await readFile(join(fixture.repository, "Taskfile.yml")));
    const outputRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-output-"));
    roots.push(outputRoot);

    await expect(admitAndMaterializeCccSemanticProof({
      repositoryRoot: fixture.repository,
      baseCommit: unsafeBase,
      sourceCommit: unsafeBase,
      proof: definition,
      modelWriteRoots: ["src"],
      outputRoot,
    })).rejects.toThrow(/includes|dependencies/u);
  });

  it("RED-S5-task-target-closure: ignores unsafe behavior in an unselected verify target", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.repository, "Taskfile.yml"), [
      "version: '3'",
      "tasks:",
      "  verify:slugify:",
      "    cmds:",
      "      - node verify/slugify.mjs src/slugify.js",
      "  verify:other:",
      "    deps: [verify:slugify]",
      "    cmds:",
      "      - node verify/other.mjs src/other.js",
      "",
    ].join("\n"));
    await execFile("git", ["-C", fixture.repository, "add", "Taskfile.yml"]);
    await execFile("git", ["-C", fixture.repository, "commit", "-m", "unsafe unselected target"]);
    const unsafeBase = (await execFile("git", ["-C", fixture.repository, "rev-parse", "HEAD"])).stdout.trim();
    const taskOid = (await execFile("git", ["-C", fixture.repository, "rev-parse", `${unsafeBase}:Taskfile.yml`])).stdout.trim();
    const taskIdentity = await executableIdentity("/opt/homebrew/bin/task");
    const nodeIdentity = await executableIdentity(process.execPath);
    const definition = proof({
      ...fixture,
      taskOid,
      taskIdentity,
      nodeIdentity,
      linkedRuntime: await inspectCccSemanticProofLinkedRuntime({
        task: taskIdentity,
        node: nodeIdentity,
        proofHost: { id: "fusion-native-semantic-proof-v2", ...nodeIdentity },
      }),
    });
    definition.verifierClosure[0]!.sha256 = sha256(await readFile(join(fixture.repository, "Taskfile.yml")));
    const outputRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-output-"));
    roots.push(outputRoot);

    await expect(admitAndMaterializeCccSemanticProof({
      repositoryRoot: fixture.repository,
      baseCommit: unsafeBase,
      sourceCommit: unsafeBase,
      proof: definition,
      modelWriteRoots: ["src"],
      outputRoot,
    })).resolves.toMatchObject({
      taskTarget: "verify:slugify",
      taskArgv: ["verify:slugify"],
    });
  });

  it("RED-S5-toolchain-drift-pre-spawn: refuses executable drift immediately before spawn", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-tool-"));
    roots.push(root);
    const toolPath = join(root, "tool");
    await writeFile(toolPath, "#!/bin/sh\necho v1\n");
    await chmod(toolPath, 0o755);
    const identity = await inspectCccSemanticProofExecutable(toolPath, ["--version"]);
    await writeFile(toolPath, "#!/bin/sh\necho v2\n");
    await chmod(toolPath, 0o755);

    await expect(verifyCccSemanticProofToolchainBeforeSpawn({
      task: identity,
      node: identity,
      proofHost: { id: "test-host", ...identity },
    })).rejects.toThrow(
      "CCC semantic-proof toolchain drift detected for Task: executable bytes differ",
    );
  });

  it("RED-S5-toolchain-drift-pre-spawn: compares changed bytes before executing a replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-no-exec-"));
    roots.push(root);
    const toolPath = join(root, "tool");
    const markerPath = join(root, "replacement-ran");
    await writeFile(toolPath, "#!/bin/sh\necho v1\n");
    await chmod(toolPath, 0o755);
    const identity = await inspectCccSemanticProofExecutable(toolPath, ["--version"]);
    await writeFile(toolPath, [
      "#!/bin/sh",
      `touch ${markerPath}`,
      "echo v2",
      "",
    ].join("\n"));
    await chmod(toolPath, 0o755);

    await expect(verifyCccSemanticProofToolchainBeforeSpawn({
      task: identity,
      node: identity,
      proofHost: { id: "test-host", ...identity },
    })).rejects.toThrow("toolchain drift");
    await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("RED-S5-toolchain-drift-pre-spawn: refuses version-output drift even when executable bytes are unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-version-"));
    roots.push(root);
    const toolPath = join(root, "tool");
    const versionPath = join(root, "version.txt");
    await writeFile(toolPath, "#!/bin/sh\ncat \"$(dirname \"$0\")/version.txt\"\n");
    await writeFile(versionPath, "v1\n");
    await chmod(toolPath, 0o755);
    const identity = await inspectCccSemanticProofExecutable(toolPath, ["--version"]);
    await writeFile(versionPath, "v2\n");

    await expect(verifyCccSemanticProofToolchainBeforeSpawn({
      task: identity,
      node: identity,
      proofHost: { id: "test-host", ...identity },
    })).rejects.toThrow(
      "CCC semantic-proof toolchain drift detected for Task: version output differs",
    );
  });

  it("RED-S5-node-launched-proof-host: probes a sealed JavaScript proof host through sealed Node", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-node-host-"));
    roots.push(root);
    const taskPath = join(root, "task");
    const proofHostPath = join(root, "proof-host.mjs");
    await writeFile(taskPath, "#!/bin/sh\nprintf 'Task version: test\\n'\n");
    await writeFile(proofHostPath, [
      "if (process.argv[2] === '--version') {",
      "  process.stdout.write('proof-host-node-test\\n');",
      "}",
      "",
    ].join("\n"));
    await Promise.all([chmod(taskPath, 0o755), chmod(proofHostPath, 0o755)]);
    const [taskIdentity, nodeIdentity, canonicalProofHost] = await Promise.all([
      executableIdentity(taskPath),
      executableIdentity(process.execPath),
      realpath(proofHostPath),
    ]);
    const proofHostBytes = await readFile(canonicalProofHost);
    const proofHostProbe = await execFile(process.execPath, [canonicalProofHost, "--version"], {
      encoding: "buffer",
    });
    const proofHostVersionOutput = Buffer.concat([proofHostProbe.stdout, proofHostProbe.stderr]);

    await expect(verifyCccSemanticProofToolchainBeforeSpawn({
      task: taskIdentity,
      node: nodeIdentity,
      proofHost: {
        id: "fusion-cli-semantic-proof-host.v1",
        executablePath: canonicalProofHost,
        executableSha256: sha256(proofHostBytes),
        version: proofHostVersionOutput.toString("utf8").trim(),
        versionOutputSha256: sha256(proofHostVersionOutput),
      },
      linkedRuntime: [],
    })).resolves.toBeUndefined();
  });

  it("RED-S5-linked-runtime-drift: refuses stale linked runtime manifest while executables still match", async () => {
    if (process.platform !== "darwin") return;
    const fixture = await createGitFixture();
    const outputRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-output-"));
    roots.push(outputRoot);
    const taskIdentity = await executableIdentity("/opt/homebrew/bin/task");
    const nodeIdentity = await executableIdentity(process.execPath);
    const definition = proof({ ...fixture, taskIdentity, nodeIdentity });
    definition.executionToolchain.linkedRuntime = [{
      platform: "darwin",
      loaderRole: "node",
      loaderPath: nodeIdentity.executablePath,
      requestedPath: "@rpath/libnode.137.dylib",
      canonicalPath: resolve(dirname(nodeIdentity.executablePath), "..", "lib", "libnode.137.dylib"),
      sha256: "0".repeat(64),
    }];

    await expect(admitAndMaterializeCccSemanticProof({
      repositoryRoot: fixture.repository,
      baseCommit: fixture.baseCommit,
      sourceCommit: fixture.candidateCommit,
      proof: definition,
      modelWriteRoots: ["src"],
      outputRoot,
    })).rejects.toThrow(/linked runtime|toolchain/u);
  });

  it("RED-S5-linked-runtime-key-order: accepts an exact persisted manifest after JSON key canonicalization", async () => {
    if (process.platform !== "darwin") return;
    const fixture = await createGitFixture();
    const outputRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-output-"));
    roots.push(outputRoot);
    const taskIdentity = await executableIdentity("/opt/homebrew/bin/task");
    const nodeIdentity = await executableIdentity(process.execPath);
    const linkedRuntime = await inspectCccSemanticProofLinkedRuntime({
      task: taskIdentity,
      node: nodeIdentity,
      proofHost: { id: "fusion-native-semantic-proof-v2", ...nodeIdentity },
    });
    const definition = proof({
      ...fixture,
      taskIdentity,
      nodeIdentity,
      linkedRuntime: linkedRuntime.map((entry) => ({
        canonicalPath: entry.canonicalPath,
        loaderPath: entry.loaderPath,
        loaderRole: entry.loaderRole,
        platform: entry.platform,
        requestedPath: entry.requestedPath,
        sha256: entry.sha256,
      })),
    });

    await expect(admitAndMaterializeCccSemanticProof({
      repositoryRoot: fixture.repository,
      baseCommit: fixture.baseCommit,
      sourceCommit: fixture.candidateCommit,
      proof: definition,
      modelWriteRoots: ["src"],
      outputRoot,
    })).resolves.toMatchObject({
      taskTarget: "verify:slugify",
    });
  });

  it("RED-S5-sealed-toolchain: materializes controller-owned tool copies before originals can be swapped", async () => {
    const fixture = await createGitFixture();
    const outputRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-output-"));
    const toolRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-tools-"));
    roots.push(outputRoot, toolRoot);
    const taskPath = join(toolRoot, "task");
    const nodePath = join(toolRoot, "node");
    const proofHostPath = join(toolRoot, "proof-host.mjs");
    await Promise.all([
      writeFile(taskPath, "#!/bin/sh\nprintf 'Task version: sealed-test\\n'\n"),
      writeFile(nodePath, "#!/bin/sh\nprintf 'Node version: sealed-test\\n'\n"),
      writeFile(proofHostPath, "#!/bin/sh\nprintf 'proof host sealed-test\\n'\n"),
    ]);
    await Promise.all([chmod(taskPath, 0o755), chmod(nodePath, 0o755), chmod(proofHostPath, 0o755)]);
    const [taskIdentity, nodeIdentity, proofHostIdentity] = await Promise.all([
      executableIdentity(taskPath),
      executableIdentity(nodePath),
      executableIdentity(proofHostPath),
    ]);
    const definition = proof({
      ...fixture,
      taskIdentity,
      nodeIdentity,
    });
    definition.executionToolchain.proofHost = {
      id: "fusion-native-semantic-proof-v2",
      ...proofHostIdentity,
    };
    definition.executionToolchain.linkedRuntime = [];

    const materialized = await admitAndMaterializeCccSemanticProof({
      repositoryRoot: fixture.repository,
      baseCommit: fixture.baseCommit,
      sourceCommit: fixture.candidateCommit,
      proof: definition,
      modelWriteRoots: ["src"],
      outputRoot,
    });

    await Promise.all([
      writeFile(taskPath, "#!/bin/sh\nprintf 'Task version: swapped\\n'\n"),
      writeFile(nodePath, "#!/bin/sh\nprintf 'Node version: swapped\\n'\n"),
      writeFile(proofHostPath, "#!/bin/sh\nprintf 'proof host swapped\\n'\n"),
    ]);
    await Promise.all([chmod(taskPath, 0o755), chmod(nodePath, 0o755), chmod(proofHostPath, 0o755)]);

    const sealedToolchain = (materialized as {
      sealedToolchain?: {
        taskExecutable: string;
        nodeExecutable: string;
        proofHostExecutable: string;
      };
    }).sealedToolchain;
    expect(sealedToolchain).toEqual({
      taskExecutable: expect.stringContaining(join(outputRoot, "toolchain")),
      nodeExecutable: expect.stringContaining(join(outputRoot, "toolchain")),
      proofHostExecutable: expect.stringContaining(join(outputRoot, "toolchain")),
    });
    expect(await readFile(sealedToolchain!.taskExecutable, "utf8")).toContain("sealed-test");
    expect(await readFile(sealedToolchain!.nodeExecutable, "utf8")).toContain("sealed-test");
    expect(await readFile(sealedToolchain!.proofHostExecutable, "utf8")).toContain("sealed-test");
    expect((await stat(sealedToolchain!.taskExecutable)).mode & 0o222).toBe(0);
  });

  it("preserves ESM proof-host version identity after sealing outside its package", async () => {
    const fixture = await createGitFixture();
    const outputRoot = await mkdtemp("/private/tmp/ccc-semantic-proof-output-");
    const hostPackageRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-esm-host-"));
    roots.push(outputRoot, hostPackageRoot);
    const proofHostPath = join(hostPackageRoot, "proof-host.js");
    await writeFile(join(hostPackageRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(
      proofHostPath,
      await readFile(resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../cli/dist/ccc-campaign-proof-admission.js",
      )),
    );
    await chmod(proofHostPath, 0o755);

    const taskIdentity = await executableIdentity("/opt/homebrew/bin/task");
    const nodeIdentity = await executableIdentity(process.execPath);
    const canonicalProofHost = await realpath(proofHostPath);
    const proofHostProbe = await execFile(
      nodeIdentity.executablePath,
      [canonicalProofHost, "--version"],
      { encoding: "buffer", env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" } },
    );
    const proofHostVersionOutput = Buffer.concat([
      proofHostProbe.stdout,
      proofHostProbe.stderr,
    ]);
    expect(proofHostProbe.stderr.toString("utf8")).toBe("");
    const proofHostIdentity = {
      id: CCC_PRD_SEMANTIC_PROOF_HOST_ID,
      executablePath: canonicalProofHost,
      executableSha256: sha256(await readFile(canonicalProofHost)),
      version: proofHostVersionOutput.toString("utf8").trim(),
      versionOutputSha256: sha256(proofHostVersionOutput),
    };
    const linkedRuntime = await inspectCccSemanticProofLinkedRuntime({
      task: taskIdentity,
      node: nodeIdentity,
      proofHost: proofHostIdentity,
    });
    const definition = proof({
      ...fixture,
      taskIdentity,
      nodeIdentity,
      linkedRuntime,
    });
    definition.executionToolchain.proofHost = proofHostIdentity;

    const materialized = await admitAndMaterializeCccSemanticProof({
      repositoryRoot: fixture.repository,
      baseCommit: fixture.baseCommit,
      sourceCommit: fixture.candidateCommit,
      proof: definition,
      modelWriteRoots: ["src"],
      outputRoot,
    });

    expect(materialized.sealedExecutionToolchain.proofHost).toMatchObject({
      executableSha256: proofHostIdentity.executableSha256,
      version: proofHostIdentity.version,
      versionOutputSha256: proofHostIdentity.versionOutputSha256,
    });
    const sealedModuleContext = join(
      dirname(materialized.sealedExecutionToolchain.proofHost.executablePath),
      "package.json",
    );
    expect(JSON.parse(await readFile(sealedModuleContext, "utf8"))).toEqual({
      type: "module",
    });
    expect((await stat(sealedModuleContext)).mode & 0o222).toBe(0);
    const sealedProofHostProbe = await execFile(
      materialized.sealedExecutionToolchain.node.executablePath,
      [materialized.sealedExecutionToolchain.proofHost.executablePath, "--version"],
      { encoding: "buffer", env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" } },
    );
    expect(sealedProofHostProbe.stderr.toString("utf8")).toBe("");
    await expect(verifyCccSemanticProofToolchainBeforeSpawn(
      materialized.sealedExecutionToolchain,
    )).resolves.toBeUndefined();
  });

  it("RED-R1-python-semantic-v2-task-and-runtime: admits only the closure-owned Python adapter and seals every runtime category", async () => {
    const fixture = await createGitFixture();
    const outputRoot = await mkdtemp(join(tmpdir(), "ccc-python-semantic-proof-output-"));
    const toolRootRaw = await mkdtemp(join(tmpdir(), "ccc-python-semantic-proof-runtime-"));
    const toolRoot = await realpath(toolRootRaw);
    roots.push(outputRoot, toolRootRaw);
    const adapterPath = "verify/python_adapter.py";
    const targetPath = "fixtures/python-target";
    await mkdir(join(fixture.repository, "fixtures/python-target"), { recursive: true });
    await writeFile(join(fixture.repository, adapterPath), "print('adapter')\n");
    await writeFile(join(fixture.repository, targetPath, "target.py"), "print('target')\n");
    await writeFile(join(fixture.repository, "Taskfile.yml"), [
      "version: '3'",
      "tasks:",
      "  verify:slugify:",
      "    cmds:",
      `      - python3 ${adapterPath} --target ${targetPath}`,
      "",
    ].join("\n"));
    await execFile("git", ["-C", fixture.repository, "add", "Taskfile.yml", adapterPath, targetPath]);
    await execFile("git", ["-C", fixture.repository, "commit", "-m", "python semantic proof baseline"]);
    const baseCommit = (await execFile("git", ["-C", fixture.repository, "rev-parse", "HEAD"])).stdout.trim();
    const sourceCommit = baseCommit;
    const gitOid = async (path: string) => (
      await execFile("git", ["-C", fixture.repository, "rev-parse", `${baseCommit}:${path}`])
    ).stdout.trim();
    const taskIdentity = await executableIdentity("/opt/homebrew/bin/task");
    const nodeIdentity = await executableIdentity(process.execPath);
    const pythonPath = join(toolRoot, "python3");
    await writeFile(pythonPath, "#!/bin/sh\nprintf 'Python 3.12.10\\n'\n", { mode: 0o755 });
    await chmod(pythonPath, 0o755);
    const pythonIdentity = await executableIdentity(pythonPath);
    const runtimeFiles = {
      stdlib: join(toolRoot, "lib/python3.12/os.py"),
      sitePackages: join(toolRoot, "lib/python3.12/site-packages/fixture.py"),
      extensionModules: join(toolRoot, "lib/python3.12/lib-dynload/fixture.so"),
      dylibClosure: join(toolRoot, "lib/libpython3.12.dylib"),
    } as const;
    await Promise.all(Object.entries(runtimeFiles).map(async ([, path]) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `runtime:${path}\n`);
    }));
    const runtimeEntry = async (path: string) => ({
      path,
      sha256: sha256(await readFile(path)),
    });
    const definition = proof({
      ...fixture,
      taskOid: await gitOid("Taskfile.yml"),
      taskIdentity,
      nodeIdentity,
      linkedRuntime: [],
    }) as any;
    definition.verifierClosure[0] = {
      ...definition.verifierClosure[0],
      baseGitBlobOid: await gitOid("Taskfile.yml"),
      sha256: sha256(await readFile(join(fixture.repository, "Taskfile.yml"))),
    };
    definition.verifierClosure[1] = {
      role: "harness",
      path: adapterPath,
      baseGitBlobOid: await gitOid(adapterPath),
      sha256: sha256(await readFile(join(fixture.repository, adapterPath))),
    };
    definition.verifierClosure.push({
      role: "fixture",
      path: `${targetPath}/target.py`,
      baseGitBlobOid: await gitOid(`${targetPath}/target.py`),
      sha256: sha256(await readFile(join(fixture.repository, `${targetPath}/target.py`))),
    });
    definition.verifierProfile = {
      schema: "ccc-prd.verifier.python-adapter.v1",
      adapterPath,
      targetPath,
    };
    definition.executionToolchain.python = {
      ...pythonIdentity,
      runtimeManifest: {
        schema: "ccc-prd.python-runtime-manifest.v1",
        interpreter: await runtimeEntry(pythonPath),
        stdlibRoot: join(toolRoot, "lib/python3.12"),
        pythonHomeRoot: toolRoot,
        sitePackagesRoots: [join(toolRoot, "lib/python3.12/site-packages")],
        extensionModuleRoots: [join(toolRoot, "lib/python3.12/lib-dynload")],
        runtimeSupport: [await runtimeEntry(runtimeFiles.dylibClosure)],
        stdlib: [await runtimeEntry(runtimeFiles.stdlib)],
        sitePackages: [await runtimeEntry(runtimeFiles.sitePackages)],
        extensionModules: [await runtimeEntry(runtimeFiles.extensionModules)],
        dylibClosure: [],
      },
    };
    definition.executionToolchain.linkedRuntime = await inspectCccSemanticProofLinkedRuntime({
      task: taskIdentity,
      node: nodeIdentity,
      proofHost: { id: "fusion-native-semantic-proof-v2", ...nodeIdentity },
    });

    const materialized = await admitAndMaterializeCccSemanticProof({
      repositoryRoot: fixture.repository,
      baseCommit,
      sourceCommit,
      proof: definition,
      modelWriteRoots: ["src"],
      outputRoot,
    });

    expect(materialized.taskArgv).toEqual(["verify:slugify"]);
    expect(materialized.sealedExecutionToolchain.python?.executablePath)
      .toContain(join(outputRoot, "toolchain"));
    expect(materialized.sealedExecutionToolchain.python?.runtimeManifest.stdlib[0]?.path)
      .toContain(join(outputRoot, "toolchain"));
    expect(await readFile(materialized.sealedExecutionToolchain.python!.runtimeManifest.sitePackages[0]!.path, "utf8"))
      .toContain("runtime:");
    const sealedPython = materialized.sealedExecutionToolchain.python!;
    expect(sealedPython.executableSha256).toBe(
      sha256(await readFile(sealedPython.executablePath)),
    );
    for (const entry of [
      ...sealedPython.runtimeManifest.stdlib,
      ...sealedPython.runtimeManifest.sitePackages,
      ...sealedPython.runtimeManifest.extensionModules,
      ...sealedPython.runtimeManifest.dylibClosure,
      ...sealedPython.runtimeManifest.runtimeSupport,
    ]) {
      expect(entry.sha256).toBe(sha256(await readFile(entry.path)));
    }
  });

  it("RED-R1-taskfile-selected-target-python: validates only the selected strict Python target", async () => {
    const {
      fixture,
      proofBaseCommit,
      outputRoot,
      definition,
    } = await createPythonMaterializationFixture([
      "  setup:",
      "    desc: Install project dependencies",
      "    cmds:",
      "      - uv sync",
      "  build:",
      "    cmds:",
      "      - make all",
      "  verify:node:",
      "    deps: [setup]",
      "    cmds:",
      "      - node verify/other.mjs src/other.js",
    ]);

    await expect(admitAndMaterializeCccSemanticProof({
      repositoryRoot: fixture.repository,
      baseCommit: proofBaseCommit,
      sourceCommit: proofBaseCommit,
      proof: definition,
      modelWriteRoots: ["src"],
      outputRoot,
    })).resolves.toMatchObject({
      taskTarget: "verify:slugify",
      taskArgv: ["verify:slugify"],
    });
  });

  it("RED-R1-python-runtime-canonical-path: refuses a runtime file reached through a symlinked parent", async () => {
    const {
      fixture,
      proofBaseCommit,
      outputRoot,
      toolRoot,
      definition,
    } = await createPythonMaterializationFixture();
    const stdlibRoot = join(toolRoot, "lib/python3.12");
    const canonicalDirectory = join(stdlibRoot, "canonical");
    const symlinkedDirectory = join(stdlibRoot, "symlinked");
    const canonicalPath = join(canonicalDirectory, "stdlib.py");
    const requestedPath = join(symlinkedDirectory, "stdlib.py");
    await mkdir(canonicalDirectory, { recursive: true });
    await writeFile(canonicalPath, "runtime:canonical\n");
    await symlink(canonicalDirectory, symlinkedDirectory, "dir");
    definition.executionToolchain.python!.runtimeManifest.stdlib = [{
      path: requestedPath,
      sha256: sha256(await readFile(canonicalPath)),
    }];

    await expect(admitAndMaterializeCccSemanticProof({
      repositoryRoot: fixture.repository,
      baseCommit: proofBaseCommit,
      sourceCommit: proofBaseCommit,
      proof: definition,
      modelWriteRoots: ["src"],
      outputRoot,
    })).rejects.toThrow(/runtime path must be canonical|Python interpreter|Python runtime manifest/i);
  });

  it("RED-R1-python-runtime-identity: refuses a same-byte replacement between path metadata and open", async () => {
    const { definition, runtimeFiles } = await createPythonMaterializationFixture();
    const replacementPath = join(dirname(runtimeFiles.stdlib), "stdlib-replacement.py");
    await writeFile(replacementPath, await readFile(runtimeFiles.stdlib));
    runtimePathToSwap = runtimeFiles.stdlib;
    replacementPathToSwap = replacementPath;
    try {
      await expect(verifyCccSemanticProofToolchainBeforeSpawn(
        definition.executionToolchain,
      )).rejects.toThrow("CCC semantic-proof Python runtime manifest drift detected before spawn");
    } finally {
      runtimePathToSwap = undefined;
      replacementPathToSwap = undefined;
    }
  });

  it.runIf(darwinMachOFixtureRunnable)(
    "RED-L18-self-id-dylib: seals a maturin-shaped extension module whose LC_ID_DYLIB is an unresolvable @rpath name",
    async () => {
      const {
        fixture,
        proofBaseCommit,
        outputRoot,
        definition,
        runtimeFiles,
      } = await createPythonMaterializationFixture();
      const bytes = await compileDarwinFixtureDylib(MACH_O_FIXTURE_SELF_ID);
      await writeFile(runtimeFiles.extensionModules, bytes);
      definition.executionToolchain.python!.runtimeManifest.extensionModules = [{
        path: runtimeFiles.extensionModules,
        sha256: sha256(bytes),
      }];

      const materialized = await admitAndMaterializeCccSemanticProof({
        repositoryRoot: fixture.repository,
        baseCommit: proofBaseCommit,
        sourceCommit: proofBaseCommit,
        proof: definition,
        modelWriteRoots: ["src"],
        outputRoot,
      });

      const sealedExtensionModule = materialized.sealedExecutionToolchain.python!
        .runtimeManifest.extensionModules[0]!.path;
      expect(sealedExtensionModule).toContain(join(outputRoot, "toolchain"));
      // The sealed bytes are untouched: no -id rewrite, no relink, no re-sign.
      expect(sha256(await readFile(sealedExtensionModule))).toBe(sha256(bytes));
      expect(await darwinInstallNameIds(sealedExtensionModule))
        .toEqual([MACH_O_FIXTURE_SELF_ID]);
      // otool -L still reports the self id as its first line; only the parser
      // now knows that line is the file's own identity, not a dependency.
      const linkedOutput = (await execFile("/usr/bin/otool", ["-L", sealedExtensionModule])).stdout;
      expect(linkedOutput.split("\n")[1]?.trim().split(/\s+/u)[0]).toBe(MACH_O_FIXTURE_SELF_ID);
    },
  );

  it.runIf(darwinMachOFixtureRunnable)(
    "RED-L18-genuine-unresolvable-load-dependency: still refuses an @rpath LOAD dependency that is not the Mach-O's own id",
    async () => {
      const {
        fixture,
        proofBaseCommit,
        outputRoot,
        definition,
        runtimeFiles,
      } = await createPythonMaterializationFixture();
      const bytes = await compileDarwinFixtureDylib(
        MACH_O_FIXTURE_SELF_ID,
        MACH_O_FIXTURE_MISSING_DEPENDENCY,
      );
      await writeFile(runtimeFiles.extensionModules, bytes);
      definition.executionToolchain.python!.runtimeManifest.extensionModules = [{
        path: runtimeFiles.extensionModules,
        sha256: sha256(bytes),
      }];

      await expect(admitAndMaterializeCccSemanticProof({
        repositoryRoot: fixture.repository,
        baseCommit: proofBaseCommit,
        sourceCommit: proofBaseCommit,
        proof: definition,
        modelWriteRoots: ["src"],
        outputRoot,
      })).rejects.toThrow(
        `CCC semantic-proof sealed runtime graph escaped toolchain root: ${MACH_O_FIXTURE_MISSING_DEPENDENCY}`,
      );
    },
  );

  it.runIf(
    runRealPythonSealSmoke
      && process.platform === "darwin"
      && existsSync("/usr/bin/sandbox-exec")
      && existsSync("/opt/homebrew/bin/task"),
  )("RED-R1-python-semantic-v2-real-sealed-smoke: runs the real sealed Python interpreter with sealed PYTHONHOME/PYTHONPATH", async () => {
    const fixture = await createGitFixture();
    const outputRoot = await mkdtemp(join(tmpdir(), "ccc-python-real-proof-output-"));
    roots.push(outputRoot);
    const pythonLauncherPath = [
      "/opt/homebrew/opt/python@3.14/bin/python3.14",
      "/opt/homebrew/opt/python@3.13/bin/python3.13",
      "/opt/homebrew/opt/python@3.12/bin/python3.12",
      "/usr/bin/python3",
    ].find(existsSync) ?? (await execFile("which", ["python3"])).stdout.trim();
    const canonicalPythonLauncher = await realpath(pythonLauncherPath);
    const frameworkPythonPath = resolve(
      dirname(canonicalPythonLauncher),
      "../Resources/Python.app/Contents/MacOS/Python",
    );
    const pythonPath = existsSync(frameworkPythonPath)
      ? await realpath(frameworkPythonPath)
      : canonicalPythonLauncher;
    const pythonIdentity = await executableIdentity(pythonPath);
    const discoveryRoot = await mkdtemp(join(tmpdir(), "ccc-python-real-discovery-"));
    roots.push(discoveryRoot);
    const discoveryPath = join(discoveryRoot, "manifest.json");
    const discoveryScript = [
      "import json, os, sys, sysconfig",
      "paths = sysconfig.get_paths()",
      "stdlib_root = os.path.realpath(paths.get('stdlib') or '')",
      "python_home_root = os.path.realpath(sys.prefix)",
      "site_roots = sorted({os.path.realpath(paths[k]) for k in ('purelib', 'platlib') if paths.get(k)})",
      "framework_python = os.path.realpath(os.path.join(os.path.dirname(sys.executable), '..', 'Resources', 'Python.app', 'Contents', 'MacOS', 'Python'))",
      "runtime_support = [framework_python] if os.path.isfile(framework_python) and not os.path.islink(framework_python) else []",
      "def files(root):",
      "  out = []",
      "  if not root or not os.path.isdir(root): return out",
      "  for base, dirs, names in os.walk(root, followlinks=False):",
      "    dirs[:] = sorted(d for d in dirs if not os.path.islink(os.path.join(base, d)))",
      "    for name in sorted(names):",
      "      path = os.path.join(base, name)",
      "      if os.path.isfile(path) and not os.path.islink(path): out.append(os.path.realpath(path))",
      "  return sorted(set(out))",
      "payload = {'stdlibRoot': stdlib_root, 'pythonHomeRoot': python_home_root, 'sitePackagesRoots': site_roots, 'extensionModuleRoots': [stdlib_root, *site_roots], 'runtimeSupport': runtime_support, 'stdlib': files(stdlib_root), 'purelib': files(paths.get('purelib')), 'platlib': files(paths.get('platlib'))}",
      "with open(sys.argv[1], 'x', encoding='utf-8') as output:",
      "  json.dump(payload, output, separators=(',', ':'))",
    ].join("\n");
    await execFile(
      pythonIdentity.executablePath,
      ["-c", discoveryScript, discoveryPath],
    );
    const discovered = JSON.parse(await readFile(discoveryPath, "utf8")) as {
      stdlibRoot: string;
      pythonHomeRoot: string;
      sitePackagesRoots: string[];
      extensionModuleRoots: string[];
      runtimeSupport: string[];
      stdlib: string[];
      purelib: string[];
      platlib: string[];
    };
    const runtimeFiles = async (key: "stdlib" | "purelib" | "platlib") => Promise.all(discovered[key].map(async (path) => ({
      path,
      sha256: sha256(await readFile(path)),
    })));
    const stdlib = await runtimeFiles("stdlib");
    const purelib = await runtimeFiles("purelib");
    const platlib = await runtimeFiles("platlib");
    const runtimeSupport = await Promise.all(discovered.runtimeSupport.map(async (path) => ({
      path,
      sha256: sha256(await readFile(path)),
    })));
    const uniqueRuntimeFiles = (entries: readonly { path: string; sha256: string }[]) => [
      ...new Map(entries.map((entry) => [entry.path, entry])).values(),
    ];
    const allSite = uniqueRuntimeFiles([...purelib, ...platlib]);
    const extensionModules = uniqueRuntimeFiles([...stdlib, ...allSite]
      .filter((entry) => /\.(?:so|dylib|pyd|dll)(?:\.[0-9.]+)?$/u.test(entry.path)));
    const extensionPaths = new Set(extensionModules.map((entry) => entry.path));
    const sitePackages = uniqueRuntimeFiles(allSite.filter((entry) => !extensionPaths.has(entry.path)));
    const dylibPaths = new Set<string>();
    const dylibRequestedPaths = new Map<string, Set<string>>();
    const dylibLoaders = [
      pythonIdentity.executablePath,
      ...extensionModules.map((entry) => entry.path),
      ...runtimeSupport.map((entry) => entry.path),
    ];
    while (dylibLoaders.length > 0) {
      const loader = dylibLoaders.shift()!;
      const otool = await execFile("/usr/bin/otool", ["-L", loader]);
      for (const line of otool.stdout.split("\n").slice(1)) {
        const path = line.trim().split(/\s+/u)[0];
        if (path && path.startsWith("/") && !path.startsWith("/usr/lib/") && !path.startsWith("/System/Library/") && existsSync(path)) {
          const canonical = await realpath(path);
          const requested = dylibRequestedPaths.get(canonical) ?? new Set<string>();
          requested.add(path);
          dylibRequestedPaths.set(canonical, requested);
          if (!dylibPaths.has(canonical)) {
            dylibPaths.add(canonical);
            dylibLoaders.push(canonical);
          }
        }
      }
    }
    const dylibClosure = await Promise.all([...dylibPaths].sort().map(async (path) => ({
      path,
      sha256: sha256(await readFile(path)),
      requestedPaths: [...(dylibRequestedPaths.get(path) ?? [])].sort(),
    })));
    expect(dylibClosure.some((entry) => entry.path.includes("mpdecimal"))).toBe(true);
    const adapterPath = "verify/python_adapter.py";
    const targetPath = "fixtures/python-target";
    const originalStdlibFile = stdlib.find((entry) => entry.path.endsWith("/os.py"))?.path ?? stdlib[0]!.path;
    await mkdir(join(fixture.repository, targetPath), { recursive: true });
    await writeFile(join(fixture.repository, adapterPath), [
      "import json, os, sys, zlib",
      "from pathlib import Path",
      "target = Path(sys.argv[sys.argv.index('--target') + 1]) / 'target.txt'",
      `original = ${JSON.stringify(originalStdlibFile)}`,
      "try:",
      "    Path(original).read_bytes()",
      "    original_read = True",
      "except Exception:",
      "    original_read = False",
      "print(json.dumps({'target': target.read_text(), 'prefix': sys.prefix, 'zlib': zlib.ZLIB_VERSION, 'original_read': original_read, 'pythonhome': os.environ.get('PYTHONHOME', ''), 'pythonpath': os.environ.get('PYTHONPATH', '')}, sort_keys=True))",
      "",
    ].join("\n"));
    await writeFile(join(fixture.repository, targetPath, "target.txt"), "sealed-python\n");
    await writeFile(join(fixture.repository, "Taskfile.yml"), [
      "version: '3'",
      "tasks:",
      "  verify:slugify:",
      "    cmds:",
      `      - python3 ${adapterPath} --target ${targetPath}`,
      "",
    ].join("\n"));
    await execFile("git", ["-C", fixture.repository, "add", "Taskfile.yml", adapterPath, targetPath]);
    await execFile("git", ["-C", fixture.repository, "commit", "-m", "real python semantic proof baseline"]);
    const baseCommit = (await execFile("git", ["-C", fixture.repository, "rev-parse", "HEAD"])).stdout.trim();
    const gitOid = async (path: string) => (
      await execFile("git", ["-C", fixture.repository, "rev-parse", `${baseCommit}:${path}`])
    ).stdout.trim();
    const taskIdentity = await executableIdentity("/opt/homebrew/bin/task");
    const nodeIdentity = await executableIdentity(process.execPath);
    const definition = proof({
      ...fixture,
      taskOid: await gitOid("Taskfile.yml"),
      taskIdentity,
      nodeIdentity,
      linkedRuntime: await inspectCccSemanticProofLinkedRuntime({
        task: taskIdentity,
        node: nodeIdentity,
        proofHost: { id: "fusion-native-semantic-proof-v2", ...nodeIdentity },
      }),
    }) as any;
    definition.verifierClosure[0] = {
      ...definition.verifierClosure[0],
      baseGitBlobOid: await gitOid("Taskfile.yml"),
      sha256: sha256(await readFile(join(fixture.repository, "Taskfile.yml"))),
    };
    definition.verifierClosure[1] = {
      role: "harness",
      path: adapterPath,
      baseGitBlobOid: await gitOid(adapterPath),
      sha256: sha256(await readFile(join(fixture.repository, adapterPath))),
    };
    definition.verifierClosure.push({
      role: "fixture",
      path: `${targetPath}/target.txt`,
      baseGitBlobOid: await gitOid(`${targetPath}/target.txt`),
      sha256: sha256(await readFile(join(fixture.repository, `${targetPath}/target.txt`))),
    });
    definition.verifierProfile = {
      schema: "ccc-prd.verifier.python-adapter.v1",
      adapterPath,
      targetPath,
    };
    definition.executionToolchain.python = {
      ...pythonIdentity,
      runtimeManifest: {
        schema: "ccc-prd.python-runtime-manifest.v1",
        interpreter: { path: pythonIdentity.executablePath, sha256: pythonIdentity.executableSha256 },
        stdlibRoot: await realpath(discovered.stdlibRoot),
        pythonHomeRoot: await realpath(discovered.pythonHomeRoot),
        sitePackagesRoots: await Promise.all((discovered.sitePackagesRoots ?? []).map((path) => realpath(path))),
        extensionModuleRoots: [
          await realpath(discovered.stdlibRoot),
          ...await Promise.all((discovered.sitePackagesRoots ?? []).map((path) => realpath(path))),
        ],
        runtimeSupport,
        stdlib,
        sitePackages,
        extensionModules,
        dylibClosure,
      },
    };
    const materialized = await admitAndMaterializeCccSemanticProof({
      repositoryRoot: fixture.repository,
      baseCommit,
      sourceCommit: baseCommit,
      proof: definition,
      modelWriteRoots: ["src"],
      outputRoot,
    });
    const sealedPython = materialized.sealedExecutionToolchain.python!;
    const pythonHome = sealedPython.runtimeManifest.pythonHomeRoot;
    const pythonPathRoots = [
      ...sealedPython.runtimeManifest.sitePackagesRoots,
      ...sealedPython.runtimeManifest.extensionModuleRoots,
    ];
    const result = await runCccSemanticProofSandboxedProcess({
      proofRoot: materialized.proofRoot,
      scratchRoot: materialized.scratchRoot,
      taskExecutable: materialized.sealedExecutionToolchain.task.executablePath,
      nodeExecutable: materialized.sealedExecutionToolchain.node.executablePath,
      pythonExecutable: sealedPython.executablePath,
      pythonHome,
      pythonPathRoots,
      pythonRuntimeFiles: [
        sealedPython.runtimeManifest.interpreter.path,
        ...sealedPython.runtimeManifest.dylibClosure.map(({ path }) => path),
        ...sealedPython.runtimeManifest.runtimeSupport.map(({ path }) => path),
      ],
      pythonRuntimeExecutables: sealedPython.runtimeManifest.runtimeSupport.map(({ path }) => path),
      deniedReadRoots: [fixture.repository, dirname(pythonIdentity.executablePath), dirname(originalStdlibFile)],
      executable: materialized.sealedExecutionToolchain.task.executablePath,
      args: materialized.taskArgv,
      proofEnvironment: {
        CCC_PROOF_ID: definition.id,
        CCC_PROOF_PHASE: "task",
        CCC_PROOF_SOURCE_COMMIT: baseCommit,
        CCC_PROOF_SOURCE_TREE: (await execFile("git", ["-C", fixture.repository, "rev-parse", `${baseCommit}^{tree}`])).stdout.trim(),
      },
      timeoutMs: 120_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim()) as { target: string; prefix: string; zlib: string; original_read: boolean; pythonhome: string };
    expect(output.target).toBe("sealed-python\n");
    expect(output.prefix).toContain(join(outputRoot, "toolchain"));
    expect(output.zlib).toBeTruthy();
    expect(output.pythonhome).toBe(pythonHome);
    expect(output.original_read).toBe(false);
  }, 120_000);

  it("RED-S5-transient-version-probe: retries one timed-out immutable executable probe", async () => {
    const toolRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-probe-retry-"));
    roots.push(toolRoot);
    const toolPath = join(toolRoot, "tool");
    await writeFile(toolPath, "#!/bin/sh\nprintf 'proof-tool 1.0\\n'\n", { mode: 0o755 });
    await chmod(toolPath, 0o755);
    const canonicalToolPath = await realpath(toolPath);
    let probeCount = 0;
    const timeoutError = () => Object.assign(new Error("forced transient version-probe timeout"), {
      code: null,
      killed: true,
      signal: "SIGTERM",
    });

    vi.resetModules();
    vi.doMock("node:child_process", () => {
      const fakeExecFile = (
        file: string,
        args: readonly string[] = [],
        options: unknown,
        callback?: (error: Error | null, stdout: Buffer | string, stderr: Buffer | string) => void,
      ) => {
        const cb = typeof options === "function"
          ? options as (error: Error | null, stdout: Buffer | string, stderr: Buffer | string) => void
          : callback;
        if (file === canonicalToolPath && args[0] === "--version" && probeCount++ === 0) {
          queueMicrotask(() => cb?.(timeoutError(), Buffer.alloc(0), Buffer.alloc(0)));
          return {} as never;
        }
        return actualExecFile(file, args as string[], options as never, cb as never);
      };
      Object.assign(fakeExecFile, {
        [promisify.custom]: async (
          file: string,
          args: readonly string[] = [],
          options: unknown,
        ) => {
          if (file === canonicalToolPath && args[0] === "--version" && probeCount++ === 0) {
            throw timeoutError();
          }
          return execFile(file, args as string[], options as never);
        },
      });
      return { execFile: fakeExecFile };
    });
    try {
      const materialization = await import("../ccc-campaign-proof-materialization.js");
      await expect(materialization.inspectCccSemanticProofExecutable(
        canonicalToolPath,
        ["--version"],
      )).resolves.toMatchObject({ version: "proof-tool 1.0" });
      expect(probeCount).toBe(2);
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("RED-S6-version-probe-diagnostics: reports exit code, signal, and stderr on a non-transient probe failure", async () => {
    const toolRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-probe-diag-"));
    roots.push(toolRoot);
    const toolPath = join(toolRoot, "tool");
    await writeFile(toolPath, "#!/bin/sh\nprintf 'boom' 1>&2\nexit 7\n", { mode: 0o755 });
    await chmod(toolPath, 0o755);

    // A plain non-zero exit with no timeout must not be mistaken for one, and
    // the killed/exit/stderr fields the raw execFile rejection carries must
    // survive into the message that campaign custody-refusal actually reads
    // (it only ever looks at `error.message`).
    await expect(inspectCccSemanticProofExecutable(toolPath, ["--version"])).rejects.toThrow(
      /exit=7 signal=null timedOut=false after \d+ms stderr: "boom"/,
    );
  });

  it("RED-S6-version-probe-diagnostics: labels a double SIGTERM-timeout instead of a bare 'Command failed'", async () => {
    const toolRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-probe-timeout-diag-"));
    roots.push(toolRoot);
    const toolPath = join(toolRoot, "tool");
    await writeFile(toolPath, "#!/bin/sh\nprintf 'proof-tool 1.0\\n'\n", { mode: 0o755 });
    await chmod(toolPath, 0o755);
    const canonicalToolPath = await realpath(toolPath);
    let probeCount = 0;
    const timeoutError = () => Object.assign(new Error(`Command failed: ${canonicalToolPath} --version`), {
      code: null,
      killed: true,
      signal: "SIGTERM",
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });

    vi.resetModules();
    vi.doMock("node:child_process", () => {
      const fakeExecFile = (
        file: string,
        args: readonly string[] = [],
        options: unknown,
        callback?: (error: Error | null, stdout: Buffer | string, stderr: Buffer | string) => void,
      ) => {
        const cb = typeof options === "function"
          ? options as (error: Error | null, stdout: Buffer | string, stderr: Buffer | string) => void
          : callback;
        if (file === canonicalToolPath && args[0] === "--version") {
          probeCount++;
          queueMicrotask(() => cb?.(timeoutError(), Buffer.alloc(0), Buffer.alloc(0)));
          return {} as never;
        }
        return actualExecFile(file, args as string[], options as never, cb as never);
      };
      Object.assign(fakeExecFile, {
        [promisify.custom]: async (
          file: string,
          args: readonly string[] = [],
          options: unknown,
        ) => {
          if (file === canonicalToolPath && args[0] === "--version") {
            probeCount++;
            throw timeoutError();
          }
          return execFile(file, args as string[], options as never);
        },
      });
      return { execFile: fakeExecFile };
    });
    try {
      const materialization = await import("../ccc-campaign-proof-materialization.js");
      // Both attempts (the original probe and the existing transient-timeout
      // retry) time out here, matching the live halt where the retry raced
      // the same contention and lost twice. This must still be exactly one
      // retry, not more: the fix is a longer bound per attempt, not extra
      // attempts that could mask a real hang.
      await expect(materialization.inspectCccSemanticProofExecutable(
        canonicalToolPath,
        ["--version"],
      )).rejects.toThrow(/exit=null signal=SIGTERM timedOut=true after \d+ms/);
      expect(probeCount).toBe(2);
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("RED-S6-version-probe-timeout: sealed-executable version probes keep a cold-start-safe margin", () => {
    // Pinned to the 2026-09-05 measurement (see EXECUTABLE_PROBE_TIMEOUT_MS's
    // doc comment): 20 concurrent seal+probe operations pushed several real
    // cold-start probes past the previous 10s bound and up to ~9.9s among the
    // survivors, matching a live double-timeout halt at that same bound.
    expect(EXECUTABLE_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("RED-S5-linked-runtime-otool-custody: refuses a Mach-O dependency graph when otool inspection fails", async () => {
    if (process.platform !== "darwin") return;
    const fixture = await createGitFixture();
    const outputRoot = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-output-"));
    roots.push(outputRoot);
    const taskIdentity = await executableIdentity("/opt/homebrew/bin/task");
    const nodeIdentity = await executableIdentity(process.execPath);
    const definition = proof({
      ...fixture,
      taskIdentity,
      nodeIdentity,
      linkedRuntime: await inspectCccSemanticProofLinkedRuntime({
        task: taskIdentity,
        node: nodeIdentity,
        proofHost: { id: "fusion-native-semantic-proof-v2", ...nodeIdentity },
      }),
    });
    const sealedNodeSuffix = join("toolchain", ...nodeIdentity.executablePath.split("/").filter(Boolean));
    vi.resetModules();
    vi.doMock("node:child_process", () => {
      const fakeExecFile = (
        file: string,
        args: readonly string[] = [],
        options: unknown,
        callback?: (error: Error | null, stdout: Buffer | string, stderr: Buffer | string) => void,
      ) => {
        const cb = typeof options === "function"
          ? options as (error: Error | null, stdout: Buffer | string, stderr: Buffer | string) => void
          : callback;
        if (
          file === "/usr/bin/otool"
          && args[0] === "-L"
          && typeof args[1] === "string"
          && args[1].endsWith(sealedNodeSuffix)
        ) {
          queueMicrotask(() => cb?.(new Error("forced otool inspection failure"), "", ""));
          return {} as never;
        }
        return actualExecFile(file, args as string[], options as never, cb as never);
      };
      Object.assign(fakeExecFile, {
        [promisify.custom]: async (
          file: string,
          args: readonly string[] = [],
          options: unknown,
        ) => {
          if (
            file === "/usr/bin/otool"
            && args[0] === "-L"
            && typeof args[1] === "string"
            && args[1].endsWith(sealedNodeSuffix)
          ) {
            throw new Error("forced otool inspection failure");
          }
          return execFile(file, args as string[], options as never);
        },
      });
      return { execFile: fakeExecFile };
    });
    try {
      const materialization = await import("../ccc-campaign-proof-materialization.js");
      await expect(materialization.admitAndMaterializeCccSemanticProof({
        repositoryRoot: fixture.repository,
        baseCommit: fixture.baseCommit,
        sourceCommit: fixture.candidateCommit,
        proof: definition,
        modelWriteRoots: ["src"],
        outputRoot,
      })).rejects.toThrow("otool inspection failed");
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  const realCPythonSealRunnable = relativeInstallNameCPython !== undefined
    && process.platform === "darwin"
    && existsSync("/opt/homebrew/bin/task");

  // Copies the discovered interpreter and its libpython into a throwaway tree so
  // the seal never touches the operator's live toolchain. `dylibDirectoryName`
  // decides whether the copy preserves the bin/../lib relationship the relative
  // install name depends on.
  async function createRealCPythonMaterializationFixture(options: {
    dylibDirectoryName: string;
    copyStdlib: boolean;
  }) {
    const source = relativeInstallNameCPython!;
    const fixture = await createGitFixture();
    const outputRoot = await mkdtemp(join(tmpdir(), "ccc-real-cpython-proof-output-"));
    const toolRootRaw = await mkdtemp(join(tmpdir(), "ccc-real-cpython-proof-runtime-"));
    const toolRoot = await realpath(toolRootRaw);
    roots.push(outputRoot, toolRootRaw);
    const interpreterPath = join(toolRoot, "bin", basename(source.interpreterPath));
    // The copied interpreter must stay runnable in its own tree, so libpython
    // always lands where its relative install name points. `dylibDirectoryName`
    // only changes where the manifest *declares* the dylib: pointing it
    // elsewhere breaks the bin/../lib relationship inside the seal and forces
    // the rewrite the fix normally avoids.
    const runnableDylibPath = join(toolRoot, "lib", basename(source.dylibPath));
    const dylibPath = join(toolRoot, options.dylibDirectoryName, basename(source.dylibPath));
    const stdlibRoot = join(toolRoot, "lib", source.stdlibDirectoryName);
    const sitePackagesRoot = join(stdlibRoot, "site-packages");
    const extensionModuleRoot = join(stdlibRoot, "lib-dynload");
    await mkdir(dirname(interpreterPath), { recursive: true });
    await mkdir(dirname(runnableDylibPath), { recursive: true });
    await mkdir(dirname(dylibPath), { recursive: true });
    await cp(source.interpreterPath, interpreterPath);
    await cp(source.dylibPath, runnableDylibPath);
    if (dylibPath !== runnableDylibPath) await cp(source.dylibPath, dylibPath);
    await chmod(interpreterPath, 0o755);
    await chmod(runnableDylibPath, 0o644);
    await chmod(dylibPath, 0o644);
    if (options.copyStdlib) {
      // Startup only needs the pure-Python core, and sealing hashes every file
      // it is handed, so leave out the large subtrees an interpreter identity
      // probe never touches.
      const skippedStdlibDirectories = new Set([
        "__pycache__",
        "ensurepip",
        "idlelib",
        "lib2to3",
        "site-packages",
        "test",
        "tests",
        "tkinter",
      ]);
      await cp(join(source.installRoot, "lib", source.stdlibDirectoryName), stdlibRoot, {
        recursive: true,
        dereference: false,
        filter: (from) => !skippedStdlibDirectories.has(basename(from)),
      });
    }
    await mkdir(sitePackagesRoot, { recursive: true });
    await mkdir(extensionModuleRoot, { recursive: true });

    const adapterPath = "verify/python_adapter.py";
    const targetPath = "fixtures/python-target";
    await mkdir(join(fixture.repository, targetPath), { recursive: true });
    await writeFile(join(fixture.repository, adapterPath), "print('adapter')\n");
    await writeFile(join(fixture.repository, targetPath, "target.py"), "print('target')\n");
    await writeFile(join(fixture.repository, "Taskfile.yml"), [
      "version: '3'",
      "tasks:",
      "  verify:slugify:",
      "    cmds:",
      `      - python3 ${adapterPath} --target ${targetPath}`,
      "",
    ].join("\n"));
    await execFile("git", ["-C", fixture.repository, "add", "Taskfile.yml", adapterPath, targetPath]);
    await execFile("git", ["-C", fixture.repository, "commit", "-m", "real cpython proof baseline"]);
    const baseCommit = (await execFile("git", ["-C", fixture.repository, "rev-parse", "HEAD"])).stdout.trim();
    const gitOid = async (path: string) => (
      await execFile("git", ["-C", fixture.repository, "rev-parse", `${baseCommit}:${path}`])
    ).stdout.trim();

    const runtimeEntry = async (path: string) => ({ path, sha256: sha256(await readFile(path)) });
    const walkFiles = async (root: string): Promise<string[]> => {
      const collected: string[] = [];
      const visit = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const child = join(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) await visit(child);
          else if (entry.isFile()) collected.push(child);
        }
      };
      await visit(root);
      return collected.sort();
    };
    const stdlibFiles = options.copyStdlib
      ? (await walkFiles(stdlibRoot)).filter((path) => !path.startsWith(`${extensionModuleRoot}/`))
      : [];

    const taskIdentity = await executableIdentity("/opt/homebrew/bin/task");
    const nodeIdentity = await executableIdentity(process.execPath);
    const pythonIdentity = await executableIdentity(interpreterPath);
    const definition = proof({
      ...fixture,
      taskOid: await gitOid("Taskfile.yml"),
      taskIdentity,
      nodeIdentity,
      linkedRuntime: [],
    });
    definition.verifierClosure[0] = {
      ...definition.verifierClosure[0],
      baseGitBlobOid: await gitOid("Taskfile.yml"),
      sha256: sha256(await readFile(join(fixture.repository, "Taskfile.yml"))),
    };
    definition.verifierClosure[1] = {
      role: "harness",
      path: adapterPath,
      baseGitBlobOid: await gitOid(adapterPath),
      sha256: sha256(await readFile(join(fixture.repository, adapterPath))),
    };
    definition.verifierClosure.push({
      role: "fixture",
      path: `${targetPath}/target.py`,
      baseGitBlobOid: await gitOid(`${targetPath}/target.py`),
      sha256: sha256(await readFile(join(fixture.repository, `${targetPath}/target.py`))),
    });
    definition.verifierProfile = {
      schema: "ccc-prd.verifier.python-adapter.v1",
      adapterPath,
      targetPath,
    };
    definition.executionToolchain.python = {
      ...pythonIdentity,
      runtimeManifest: {
        schema: "ccc-prd.python-runtime-manifest.v1",
        interpreter: await runtimeEntry(interpreterPath),
        stdlibRoot,
        pythonHomeRoot: toolRoot,
        sitePackagesRoots: [sitePackagesRoot],
        extensionModuleRoots: [extensionModuleRoot],
        // When the declared dylib sits outside `lib/`, the runnable copy still
        // has to reach the seal so the interpreter can answer its identity
        // probe; declaring it as runtime support does that without making it
        // the rewrite target.
        runtimeSupport: dylibPath === runnableDylibPath
          ? []
          : [await runtimeEntry(runnableDylibPath)],
        stdlib: await Promise.all(stdlibFiles.map(runtimeEntry)),
        sitePackages: [],
        extensionModules: [],
        dylibClosure: [{
          ...(await runtimeEntry(dylibPath)),
          requestedPaths: [source.requestedPath],
        }],
      },
    };
    definition.executionToolchain.linkedRuntime = await inspectCccSemanticProofLinkedRuntime({
      task: taskIdentity,
      node: nodeIdentity,
      proofHost: { id: "fusion-native-semantic-proof-v2", ...nodeIdentity },
    });
    return { fixture, definition, outputRoot, proofBaseCommit: baseCommit, source, toolRoot };
  }

  it.runIf(realCPythonSealRunnable)(
    "RED-L17-headerpad: seals a real relative-install-name CPython without relinking its load commands",
    async () => {
      const { fixture, definition, outputRoot, proofBaseCommit, source } =
        await createRealCPythonMaterializationFixture({
          dylibDirectoryName: "lib",
          copyStdlib: true,
        });

      const materialization = await admitAndMaterializeCccSemanticProof({
        repositoryRoot: fixture.repository,
        baseCommit: proofBaseCommit,
        sourceCommit: proofBaseCommit,
        proof: definition,
        modelWriteRoots: ["src"],
        outputRoot,
      });

      const toolchainRoot = join(await realpath(outputRoot), "toolchain");
      // The sealed root is far longer than the ~70 bytes of spare load-command
      // space, which is exactly why rewriting to an absolute mirrored path is
      // impossible here.
      expect(toolchainRoot.length).toBeGreaterThan(70);

      const sealedPython = materialization.sealedExecutionToolchain.python!;
      const sealedInterpreter = sealedPython.executablePath;
      expect(sealedInterpreter.startsWith(`${toolchainRoot}/`)).toBe(true);

      const linked = await execFile("/usr/bin/otool", ["-L", sealedInterpreter]);
      expect(linked.stdout).toContain(source.requestedPath);
      const resolvedDylib = resolve(
        dirname(sealedInterpreter),
        source.requestedPath.slice(EXECUTABLE_PATH_PREFIX.length),
      );
      expect(resolvedDylib.startsWith(`${toolchainRoot}/`)).toBe(true);
      expect(existsSync(resolvedDylib)).toBe(true);

      const sealedHome = sealedPython.runtimeManifest.pythonHomeRoot;
      const probe = await execFile(sealedInterpreter, ["-c", "import sys; print(sys.prefix)"], {
        env: {
          HOME: dirname(outputRoot),
          TMPDIR: dirname(outputRoot),
          LANG: "C",
          LC_ALL: "C",
          PYTHONHOME: sealedHome,
          PYTHONNOUSERSITE: "1",
          PYTHONDONTWRITEBYTECODE: "1",
          DYLD_PRINT_LIBRARIES: "1",
        },
      });
      expect(probe.stdout.trim()).toBe(sealedHome);

      const canonicalToolchainRoot = await realpath(toolchainRoot);
      const loadedLibraries = probe.stderr
        .split("\n")
        .filter((line) => line.includes("dyld["))
        .map((line) => line.trim().split(/\s+/u).at(-1))
        .filter((path): path is string => Boolean(path?.startsWith("/")));
      expect(loadedLibraries.length).toBeGreaterThan(0);
      const escaped = loadedLibraries.filter((path) => !(
        path.startsWith("/usr/lib/")
        || path.startsWith("/System/")
        || path.startsWith(`${toolchainRoot}/`)
        || path.startsWith(`${canonicalToolchainRoot}/`)
      ));
      expect(escaped).toEqual([]);
      expect(loadedLibraries.some((path) => path.endsWith(basename(source.dylibPath)))).toBe(true);
    },
    120_000,
  );

  it.runIf(realCPythonSealRunnable)(
    "RED-L17-headerpad: carries the install_name_tool stderr into the refusal when a rewrite cannot fit",
    async () => {
      const { fixture, definition, outputRoot, proofBaseCommit } =
        await createRealCPythonMaterializationFixture({
          dylibDirectoryName: "dylibs",
          copyStdlib: false,
        });

      const rejection = await admitAndMaterializeCccSemanticProof({
        repositoryRoot: fixture.repository,
        baseCommit: proofBaseCommit,
        sourceCommit: proofBaseCommit,
        proof: definition,
        modelWriteRoots: ["src"],
        outputRoot,
      }).then(() => undefined, (error: unknown) => error);

      expect(rejection).toBeInstanceOf(Error);
      const message = (rejection as Error).message;
      expect(message).toContain("/usr/bin/install_name_tool");
      expect(message).toContain("-change");
      expect(message).toContain("exit 1");
      expect(message).toContain("stderr:");
      expect(message).toContain("larger updated load commands do not fit");
      expect(message).toContain("headerpad");
    },
    120_000,
  );
});
