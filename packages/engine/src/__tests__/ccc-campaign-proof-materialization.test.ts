import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  computeCccPrdCandidateInputsSha256,
  computeCccPrdVerifierClosureSha256,
  type CccPrdProofV2,
} from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitAndMaterializeCccSemanticProof,
  inspectCccSemanticProofExecutable,
  inspectCccSemanticProofLinkedRuntime,
  verifyCccSemanticProofToolchainBeforeSpawn,
} from "../ccc-campaign-proof-materialization.js";

const execFile = promisify(execFileCallback);
const actualExecFile = execFileCallback;
const roots: string[] = [];
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

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

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    const makeWriteable = async (path: string): Promise<void> => {
      await chmod(path, 0o755).catch(() => undefined);
      const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
      await Promise.all(entries.map(async (entry) => {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await makeWriteable(child);
        else await chmod(child, 0o644).catch(() => undefined);
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

  it("RED-S5-task-target-closure: refuses unsafe behavior in an unselected verify target", async () => {
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
    })).rejects.toThrow(/dependencies/u);
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
    })).rejects.toThrow("toolchain drift");
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
    })).rejects.toThrow("toolchain drift");
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
});
