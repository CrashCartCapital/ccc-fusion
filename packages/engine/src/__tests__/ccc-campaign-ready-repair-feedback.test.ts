import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import * as readyModule from "../ccc-campaign-ready.js";

const {
  MAX_CCC_CAMPAIGN_REPAIR_FEEDBACK_RENDER_CHARS,
  renderCccCampaignRepairFeedback,
} = readyModule;

const execFile = promisify(execFileCallback);
const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const hasTask = spawnSync("task", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfTools = hasGit && hasTask ? describe : describe.skip;
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

const CANDIDATE_BYTES = "const ready = 'no';"; // 19 bytes, no trailing newline

function proofEvidencePayload(overrides: Record<string, unknown> = {}, extraPassingClauses = 200): string {
  // Padding lives inside a well-formed (schema-conformant) clauseResults
  // array, not as an extra top-level field — an extra field would itself be
  // malformed shape and defeat the "large but well-formed payload" case this
  // fixture exists to exercise.
  const padClauses = Array.from({ length: extraPassingClauses }, (_, index) => ({
    clauseId: `PAD-${"x".repeat(20)}-${index}`,
    passed: true,
  }));
  const payload = {
    schema: "ccc-prd.proof-evidence.v2",
    proofId: "PROOF-READY",
    phase: "task",
    sourceCommit: "0".repeat(40),
    sourceTree: "0".repeat(40),
    passed: false,
    clauseResults: [
      { clauseId: "AC-001", passed: true },
      { clauseId: "AC-002", passed: false },
      ...padClauses,
    ],
    positiveCaseResults: [
      { caseId: "CASE-001", passed: false },
    ],
    negativeControlResults: [
      { controlId: "CTRL-001", passed: true },
    ],
    ...overrides,
  };
  return JSON.stringify(payload);
}

async function mktempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fusion-campaign-repair-feedback-"));
  roots.push(root);
  return root;
}

async function baseFixture() {
  const root = await mktempRoot();
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Fusion Test");
  await git(root, "config", "user.email", "fusion@test.invalid");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "base.txt"), "base\n");
  return root;
}

function campaignFor(root: string, baseCommit: string) {
  return {
    taskId: "READY-repair-1",
    semanticTaskId: "READY-repair-1",
    proofIds: ["PROOF-READY"],
    targetRepository: { path: root, baseCommit },
    route: {
      taskId: "READY-repair-1",
      providerId: "fixture",
      modelId: "fixture",
      transport: "pi",
      executor: "model",
      toolMode: "coding",
      worktreeMode: "isolated",
      ownedPaths: ["src"],
      allowedWriteRoots: ["src"],
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
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describeIfTools("CCC campaign readiness repair-feedback envelope", () => {
  it("reports observed bytes captured before the verifier ran, even when the verifier command mutates the shadow candidate", async () => {
    const root = await baseFixture();
    const payload = proofEvidencePayload();
    expect(payload.length).toBeGreaterThan(2_200);
    await writeFile(
      join(root, "Taskfile.yml"),
      [
        "version: '3'",
        "tasks:",
        "  verify:ready:",
        "    cmds:",
        "      - node verify-and-mutate.cjs",
        "",
      ].join("\n"),
    );
    // A script file (not an inline -e string) avoids shell/YAML quoting
    // fragility around the large embedded JSON payload. Mutates the
    // candidate file inside its own cwd (the shadow clone), then prints
    // proof evidence and fails. Observed bytes must still reflect the
    // pre-mutation content, since they were captured before this ran.
    await writeFile(
      join(root, "verify-and-mutate.cjs"),
      [
        "const fs = require('fs');",
        "fs.writeFileSync('src/change.js', 'MUTATED-BY-VERIFIER');",
        `process.stdout.write(${JSON.stringify(payload)});`,
        "process.exit(1);",
        "",
      ].join("\n"),
    );
    await git(root, "add", "Taskfile.yml", "src/base.txt", "verify-and-mutate.cjs");
    await git(root, "commit", "-m", "base");
    const baseCommit = await git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "src", "change.js"), CANDIDATE_BYTES);
    const campaign = campaignFor(root, baseCommit);
    const verifyCandidate = (readyModule as any).verifyCccCampaignReadyCandidate;

    const result = await verifyCandidate({
      taskId: campaign.taskId,
      worktreePath: root,
      campaign,
      timeoutMs: 30_000,
    });

    expect(result.ready).toBe(false);
    expect(typeof result.summary).toBe("string");

    const feedback = result.repairFeedback;
    expect(feedback).toBeDefined();
    expect(feedback.verdict).toBe("failed");
    expect(feedback.verifierCommand).toBe("task verify:ready");
    // The sandboxed process supervisor can remap the raw exit code (e.g. via
    // sandbox-exec) so this only asserts a nonzero failure code was captured,
    // not the exact numeric value.
    expect(typeof feedback.exitCode).toBe("number");
    expect(feedback.exitCode).toBeGreaterThan(0);

    expect(feedback.proofEvidence).toBeDefined();
    expect(feedback.proofEvidence.schema).toBe("ccc-prd.proof-evidence.v2");
    expect(feedback.proofEvidence.passed).toBe(false);
    const failingClauses = feedback.proofEvidence.clauseResults
      .filter((entry: any) => !entry.passed)
      .map((entry: any) => entry.clauseId);
    expect(failingClauses).toEqual(["AC-002"]);
    const failingCases = feedback.proofEvidence.positiveCaseResults
      .filter((entry: any) => !entry.passed)
      .map((entry: any) => entry.caseId);
    expect(failingCases).toEqual(["CASE-001"]);

    const expectedBytes = Buffer.byteLength(CANDIDATE_BYTES, "utf8");
    const expectedSha256 = createHash("sha256").update(CANDIDATE_BYTES, "utf8").digest("hex");
    const observedFile = feedback.observedCandidate.find(
      (entry: any) => entry.path === "src/change.js",
    );
    expect(observedFile).toBeDefined();
    expect(observedFile.kind).toBe("file");
    expect(observedFile.bytes).toBe(expectedBytes);
    expect(observedFile.bytes).toBe(19);
    expect(observedFile.sha256).toBe(expectedSha256);
    expect(observedFile.endsWithNewline).toBe(false);
    // Sanity: the verifier really did mutate the shadow's copy; the fixture
    // itself would be broken (not proving anything about pre-verifier
    // capture) if the mutation never happened.
    expect(observedFile.sha256).not.toBe(
      createHash("sha256").update("MUTATED-BY-VERIFIER", "utf8").digest("hex"),
    );

    expect(feedback.diagnosticTail.length).toBeLessThanOrEqual(2_000);
    expect(feedback.diagnosticTruncated).toBe(true);

    const rendered = renderCccCampaignRepairFeedback(feedback);
    const firstLine = rendered.split("\n")[0];
    expect(firstLine).toMatch(/FAILED/i);
    expect(firstLine).toContain("task verify:ready");
    expect(rendered).toContain("AC-002");
    expect(rendered).toContain("CASE-001");
    expect(rendered).toContain("src/change.js");
    expect(rendered).toContain("19 bytes");
    expect(rendered).toContain("endsWithNewline=false");
    expect(rendered.length).toBeLessThanOrEqual(MAX_CCC_CAMPAIGN_REPAIR_FEEDBACK_RENDER_CHARS);
  });

  it("records a labeled parse issue and still renders verdict/exit/observed facts when the verifier prints malformed proof-evidence JSON", async () => {
    const root = await baseFixture();
    // Matches the schema field, but is missing required keys — malformed.
    const malformed = JSON.stringify({
      schema: "ccc-prd.proof-evidence.v2",
      passed: false,
      // Missing proofId, phase, sourceCommit, sourceTree, and result arrays.
    });
    await writeFile(
      join(root, "Taskfile.yml"),
      [
        "version: '3'",
        "tasks:",
        "  verify:ready:",
        "    cmds:",
        "      - node verify-malformed.cjs",
        "",
      ].join("\n"),
    );
    // A script file avoids shell/YAML quoting fragility around the embedded
    // JSON payload's nested double quotes.
    await writeFile(
      join(root, "verify-malformed.cjs"),
      [
        `process.stdout.write(${JSON.stringify(malformed)});`,
        "process.exit(1);",
        "",
      ].join("\n"),
    );
    await git(root, "add", "Taskfile.yml", "src/base.txt", "verify-malformed.cjs");
    await git(root, "commit", "-m", "base");
    const baseCommit = await git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "src", "change.js"), CANDIDATE_BYTES);
    const campaign = campaignFor(root, baseCommit);
    const verifyCandidate = (readyModule as any).verifyCccCampaignReadyCandidate;

    const result = await verifyCandidate({
      taskId: campaign.taskId,
      worktreePath: root,
      campaign,
      timeoutMs: 30_000,
    });

    expect(result.ready).toBe(false);
    const feedback = result.repairFeedback;
    expect(feedback).toBeDefined();
    expect(feedback.proofEvidence).toBeUndefined();
    expect(typeof feedback.proofEvidenceParseIssue).toBe("string");
    expect(feedback.proofEvidenceParseIssue.length).toBeGreaterThan(0);

    const rendered = renderCccCampaignRepairFeedback(feedback);
    const firstLine = rendered.split("\n")[0];
    expect(firstLine).toMatch(/FAILED/i);
    expect(firstLine).toContain("task verify:ready");
    expect(rendered).toContain("src/change.js");
    expect(rendered).toContain("19 bytes");
    expect(rendered).toMatch(/unavailable/i);
  });
});

describe("CCC campaign repair-feedback renderer (pure, no git required)", () => {
  it("bounds the rendered envelope length by construction even with oversized fields, using omission counts instead of a trailing slice", () => {
    const oversizedCommand = "task verify:ready ".repeat(500);
    const manyFailingIds = (prefix: string) =>
      Array.from({ length: 200 }, (_, index) => ({
        [`${prefix}Id`]: `${prefix.toUpperCase()}-${"z".repeat(200)}-${index}`,
        passed: false,
      }));
    const observedCandidate = Array.from({ length: 200 }, (_, index) => ({
      path: `src/${"very-long-path-segment-".repeat(10)}${index}.js`,
      kind: "file" as const,
      bytes: index,
      sha256: "a".repeat(64),
      endsWithNewline: false,
    }));
    const feedback = {
      verdict: "failed" as const,
      verifierCommand: oversizedCommand,
      exitCode: 1,
      proofEvidence: {
        schema: "ccc-prd.proof-evidence.v2" as const,
        proofId: "PROOF-READY",
        phase: "task" as const,
        sourceCommit: "0".repeat(40),
        sourceTree: "0".repeat(40),
        passed: false,
        clauseResults: manyFailingIds("clause").map((entry: any) => ({
          clauseId: entry.clauseId,
          passed: false,
        })),
        positiveCaseResults: manyFailingIds("case").map((entry: any) => ({
          caseId: entry.caseId,
          passed: false,
        })),
        negativeControlResults: manyFailingIds("control").map((entry: any) => ({
          controlId: entry.controlId,
          passed: false,
        })),
      },
      proofEvidenceParseIssue: undefined,
      observedCandidate,
      omittedPaths: 0,
      diagnosticTail: "x".repeat(50_000),
      diagnosticTruncated: true,
    };

    const rendered = renderCccCampaignRepairFeedback(feedback as any);

    expect(rendered.length).toBeLessThanOrEqual(MAX_CCC_CAMPAIGN_REPAIR_FEEDBACK_RENDER_CHARS);
    expect(rendered).toMatch(/FAILED/i);
    expect(rendered).toMatch(/more\)/); // an omitted-count marker for failing ids
    expect(rendered).toMatch(/additional admitted path\(s\) omitted/);
  });

  it("represents a deleted or non-regular admitted path explicitly instead of forging byte facts", () => {
    const feedback = {
      verdict: "failed" as const,
      verifierCommand: "task verify:ready",
      exitCode: 1,
      proofEvidence: undefined,
      proofEvidenceParseIssue: "no ccc-prd.proof-evidence.v2 JSON object found in verifier stdout",
      observedCandidate: [
        { path: "src/removed.js", kind: "deleted" as const },
        { path: "src/link.js", kind: "non-regular" as const },
      ],
      omittedPaths: 0,
      diagnosticTail: "exit 1",
      diagnosticTruncated: false,
    };

    const rendered = renderCccCampaignRepairFeedback(feedback as any);

    expect(rendered).toContain("src/removed.js: deleted");
    expect(rendered).toContain("src/link.js: non-regular");
  });

  const NOTE_LINE = "NOTE: readiness verification runs without CCC_PROOF_* identity; any "
    + "proof/clause IDs above are the verifier's own defaults. Formal proof admission binds "
    + "the PRD's proof/clause IDs and the committed sourceCommit/sourceTree.";

  it("RED: renders the readiness caveat NOTE line after PROOF EVIDENCE and before OBSERVED CANDIDATE when proof evidence parses", () => {
    const feedback = {
      verdict: "failed" as const,
      verifierCommand: "task verify:ready",
      exitCode: 1,
      proofEvidence: {
        schema: "ccc-prd.proof-evidence.v2" as const,
        proofId: "PROOF-READY",
        phase: "task" as const,
        sourceCommit: "0".repeat(40),
        sourceTree: "0".repeat(40),
        passed: false,
        clauseResults: [{ clauseId: "AC-002", passed: false }],
        positiveCaseResults: [{ caseId: "CASE-001", passed: false }],
        negativeControlResults: [],
      },
      proofEvidenceParseIssue: undefined,
      observedCandidate: [
        { path: "src/change.js", kind: "file" as const, bytes: 19, sha256: "a".repeat(64), endsWithNewline: false },
      ],
      omittedPaths: 0,
      diagnosticTail: "exit 1",
      diagnosticTruncated: false,
    };

    const rendered = renderCccCampaignRepairFeedback(feedback as any);

    expect(rendered).toContain(NOTE_LINE);
    const proofIndex = rendered.indexOf("PROOF EVIDENCE");
    const noteIndex = rendered.indexOf(NOTE_LINE);
    const observedIndex = rendered.indexOf("OBSERVED CANDIDATE");
    expect(proofIndex).toBeGreaterThanOrEqual(0);
    expect(noteIndex).toBeGreaterThan(proofIndex);
    expect(observedIndex).toBeGreaterThan(noteIndex);
  });

  it("RED: renders the readiness caveat NOTE line after PROOF EVIDENCE and before OBSERVED CANDIDATE when proof evidence is unavailable", () => {
    const feedback = {
      verdict: "failed" as const,
      verifierCommand: "task verify:ready",
      exitCode: 1,
      proofEvidence: undefined,
      proofEvidenceParseIssue: "no ccc-prd.proof-evidence.v2 JSON object found in verifier stdout",
      observedCandidate: [
        { path: "src/removed.js", kind: "deleted" as const },
      ],
      omittedPaths: 0,
      diagnosticTail: "exit 1",
      diagnosticTruncated: false,
    };

    const rendered = renderCccCampaignRepairFeedback(feedback as any);

    expect(rendered).toContain(NOTE_LINE);
    const proofIndex = rendered.indexOf("PROOF EVIDENCE");
    const noteIndex = rendered.indexOf(NOTE_LINE);
    const observedIndex = rendered.indexOf("OBSERVED CANDIDATE");
    expect(proofIndex).toBeGreaterThanOrEqual(0);
    expect(noteIndex).toBeGreaterThan(proofIndex);
    expect(observedIndex).toBeGreaterThan(noteIndex);
  });
});
