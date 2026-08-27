import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import * as readyModule from "../ccc-campaign-ready.js";

const execFile = promisify(execFileCallback);
const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const hasTask = spawnSync("task", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfTools = hasGit && hasTask ? describe : describe.skip;
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function fixture(value = "ready") {
  const root = await mkdtemp(join(tmpdir(), "fusion-campaign-ready-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Fusion Test");
  await git(root, "config", "user.email", "fusion@test.invalid");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "value.txt"), "base\n");
  await writeFile(
    join(root, "Taskfile.yml"),
    [
      "version: '3'",
      "tasks:",
      "  verify:ready:",
      "    cmds:",
      "      - node -e \"const fs=require('fs'); if(fs.readFileSync('src/value.txt','utf8').trim()!=='ready') process.exit(1); fs.writeFileSync('verifier-side-effect.txt','verified')\"",
      "",
    ].join("\n"),
  );
  await git(root, "add", "Taskfile.yml", "src/value.txt");
  await git(root, "commit", "-m", "base");
  const baseCommit = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "src", "value.txt"), `${value}\n`);
  return {
    root,
    campaign: {
      taskId: "READY-native-1",
      semanticTaskId: "READY-1",
      proofIds: ["PROOF-READY"],
      targetRepository: { path: root, baseCommit },
      route: {
        taskId: "READY-1",
        providerId: "fixture",
        modelId: "fixture",
        transport: "pi",
        executor: "model",
        toolMode: "coding",
        worktreeMode: "isolated",
        ownedPaths: ["src/value.txt"],
        allowedWriteRoots: ["src/value.txt"],
        commitPolicy: "required",
      },
      proofs: [{
        id: "PROOF-READY",
        requirementIds: ["REQ-READY"],
        command: "task verify:ready",
        positiveOracle: "candidate is ready",
        negativeControls: [],
        spans: [],
        confidence: "high",
      }],
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describeIfTools("CCC campaign readiness shadow verifier", () => {
  it("verifies the candidate in a disposable shadow without polluting the source worktree", async () => {
    const { root, campaign } = await fixture();
    const verifyCandidate = (readyModule as any).verifyCccCampaignReadyCandidate;

    const result = await verifyCandidate({
      taskId: campaign.taskId,
      worktreePath: root,
      campaign,
      timeoutMs: 30_000,
    });

    expect(result).toMatchObject({
      ready: true,
      taskId: campaign.taskId,
      verifiedWorktreePath: await realpath(root),
      verifiedStartCommit: campaign.targetRepository.baseCommit,
      frozenBaseCommit: campaign.targetRepository.baseCommit,
      allowedRoots: ["src/value.txt"],
      candidateFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    await expect(readFile(join(root, "src", "value.txt"), "utf8")).resolves.toBe("ready\n");
    await expect(readFile(join(root, "verifier-side-effect.txt"), "utf8")).rejects.toThrow();
  });

  it.sequential("verifies headlessly when checkout requires an interactive Git safety prompt", async () => {
    const { root, campaign } = await fixture();
    const guardRoot = await mkdtemp(join(tmpdir(), "fusion-headless-git-guard-"));
    roots.push(guardRoot);
    const guardedGit = join(guardRoot, "git");
    const guardMarker = join(guardRoot, "invocations.log");
    await writeFile(
      guardedGit,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$FUSION_TEST_GIT_GUARD_MARKER\"",
        "for arg in \"$@\"; do",
        "  if [ \"$arg\" = \"checkout\" ]; then",
        "    echo \"headless Git policy blocks checkout\" >&2",
        "    exit 126",
        "  fi",
        "done",
        "PATH=\"$FUSION_TEST_AMBIENT_PATH\"",
        "export PATH",
        "exec git \"$@\"",
        "",
      ].join("\n"),
    );
    await chmod(guardedGit, 0o755);
    const previousPath = process.env.PATH;
    const ambientPath = previousPath ?? "";
    const previousDelegatePath = process.env.FUSION_TEST_AMBIENT_PATH;
    const previousMarkerPath = process.env.FUSION_TEST_GIT_GUARD_MARKER;
    process.env.PATH = `${guardRoot}${delimiter}${ambientPath}`;
    process.env.FUSION_TEST_AMBIENT_PATH = ambientPath;
    process.env.FUSION_TEST_GIT_GUARD_MARKER = guardMarker;

    try {
      const result = await (readyModule as any).verifyCccCampaignReadyCandidate({
        taskId: campaign.taskId,
        worktreePath: root,
        campaign,
        timeoutMs: 30_000,
      });

      expect(result).toMatchObject({
        ready: true,
        taskId: campaign.taskId,
        candidateFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const invocations = await readFile(guardMarker, "utf8");
      expect(invocations).toContain("switch --quiet --detach HEAD");
      const invokedCheckout = invocations
        .trim()
        .split("\n")
        .some((line) => line.split(/\s+/u).includes("checkout"));
      expect(invokedCheckout).toBe(false);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      if (previousDelegatePath === undefined) {
        delete process.env.FUSION_TEST_AMBIENT_PATH;
      } else {
        process.env.FUSION_TEST_AMBIENT_PATH = previousDelegatePath;
      }
      if (previousMarkerPath === undefined) {
        delete process.env.FUSION_TEST_GIT_GUARD_MARKER;
      } else {
        process.env.FUSION_TEST_GIT_GUARD_MARKER = previousMarkerPath;
      }
    }
  });

  it("refuses foreign paths before running the sealed verifier", async () => {
    const { root, campaign } = await fixture();
    await writeFile(join(root, "foreign.txt"), "not admitted\n");
    const verifyCandidate = (readyModule as any).verifyCccCampaignReadyCandidate;

    const result = await verifyCandidate({
      taskId: campaign.taskId,
      worktreePath: root,
      campaign,
      timeoutMs: 30_000,
    });

    expect(result).toMatchObject({ ready: false });
    expect(result.summary).toContain("foreign.txt");
  });

  it("returns verifier failure output as bounded repair feedback", async () => {
    const { root, campaign } = await fixture("wrong");
    const verifyCandidate = (readyModule as any).verifyCccCampaignReadyCandidate;

    const result = await verifyCandidate({
      taskId: campaign.taskId,
      worktreePath: root,
      campaign,
      timeoutMs: 30_000,
    });

    expect(result).toMatchObject({ ready: false });
    expect(result.summary).toMatch(/verify:ready|exit 1/i);
  });

  it("fails closed when a legacy route has no allowed write roots", async () => {
    const { root, campaign } = await fixture();
    delete (campaign.route as any).allowedWriteRoots;
    const verifyCandidate = (readyModule as any).verifyCccCampaignReadyCandidate;

    const result = await verifyCandidate({
      taskId: campaign.taskId,
      worktreePath: root,
      campaign,
      timeoutMs: 30_000,
    });

    expect(result).toMatchObject({ ready: false });
    expect(result.summary).toContain("no allowed write roots");
  });

  it("refuses a candidate whose native or semantic task identity does not match custody", async () => {
    const { root, campaign } = await fixture();
    const verifyCandidate = (readyModule as any).verifyCccCampaignReadyCandidate;

    const nativeMismatch = await verifyCandidate({
      taskId: "WRONG-native-task",
      worktreePath: root,
      campaign,
      timeoutMs: 30_000,
    });
    const semanticMismatch = await verifyCandidate({
      taskId: campaign.taskId,
      worktreePath: root,
      campaign: {
        ...campaign,
        route: { ...campaign.route, taskId: "WRONG-semantic-task" },
      },
      timeoutMs: 30_000,
    });

    expect(nativeMismatch).toMatchObject({ ready: false });
    expect(nativeMismatch.summary).toMatch(/task identity/i);
    expect(semanticMismatch).toMatchObject({ ready: false });
    expect(semanticMismatch.summary).toMatch(/task identity/i);
  });

  it("length-frames untracked binary bytes so file-boundary lookalikes cannot collide", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "src", "value.txt"), "base\n");
    const firstPath = join(root, "src", "a.bin");
    const secondPath = join(root, "src", "b.bin");
    const oldUnframedSecondHeader =
      "\0untracked-path\0src/b.bin\0executable\0" + "0" + "\0bytes\0";
    await writeFile(firstPath, Buffer.from(`${oldUnframedSecondHeader}payload`, "utf8"));
    const fingerprint = (readyModule as any).fingerprintCccCampaignReadyCandidate;

    const oneFile = await fingerprint({ worktreePath: root, allowedRoots: ["src"] });
    await writeFile(firstPath, Buffer.alloc(0));
    await writeFile(secondPath, Buffer.from("payload", "utf8"));
    const twoFiles = await fingerprint({ worktreePath: root, allowedRoots: ["src"] });

    expect(oneFile).not.toBe(twoFiles);
  });

  it("scopes phase-transition fingerprints to admitted roots", async () => {
    const { root } = await fixture();
    const fingerprint = (readyModule as any).fingerprintCccCampaignAllowedCandidate;

    const baseline = await fingerprint({ worktreePath: root, allowedRoots: ["src"] });
    await writeFile(join(root, "outside.txt"), "unrelated\n");
    const outsideOnly = await fingerprint({ worktreePath: root, allowedRoots: ["src"] });
    await writeFile(join(root, "src", "inside.txt"), "admitted\n");
    const admittedChange = await fingerprint({ worktreePath: root, allowedRoots: ["src"] });

    expect(outsideOnly).toBe(baseline);
    expect(admittedChange).not.toBe(baseline);
  });
});
