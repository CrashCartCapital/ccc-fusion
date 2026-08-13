import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CCC_PRD_SEMANTIC_PROOF_HOST_ID,
  assertCccPrdSemanticProofV2Custody,
  computeCccPrdProofDefinitionSha256,
  computeCccPrdProofV2AdmissionDigests,
  hydrateCccPrdSemanticProofV2Custody,
  type CccPrdProofV2,
} from "../ccc-prd/index.js";

const execFile = promisify(execFileCallback);
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

  it("RED-S5-multi-target-taskfile: admits a selected proof target when every frozen verify target is strict", async () => {
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

  it("RED-S5-multi-target-taskfile-negative: refuses unsafe behavior hidden in an unselected target", async () => {
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
    })).rejects.toThrow(/dependencies behavior is forbidden/u);
  });

  it("RED-S5-multi-target-canonical-path: refuses a noncanonical path hidden in an unselected target", async () => {
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
    })).rejects.toThrow(/must be a canonical target-relative path/u);
  });
});
