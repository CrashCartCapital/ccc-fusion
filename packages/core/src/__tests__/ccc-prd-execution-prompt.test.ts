import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createCccPrdImportTestBundle,
  createCccPrdImportTestProductExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../__test-utils__/ccc-prd-import-fixture.js";
import { computeCccPrdSemanticBundleSha256 } from "../ccc-prd/contract.js";
import {
  buildCccPrdProjection,
  buildCccPrdTaskExecutionPrompt,
} from "../ccc-prd/projection.js";
import type { CccPrdSemanticBundle } from "../ccc-prd/types.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function semanticBundleV2(): CccPrdSemanticBundle {
  const base = createCccPrdImportTestBundle("/tmp/ccc-prompt-v2", "prompt-v2");
  const task = base.tasks[0]!;
  const requirement = base.requirements[0]!;
  const acceptedText = "Return an empty string for empty input.";
  const deferredClauseId = "AC-REQ-prompt-v2-002";
  const deferredReason = "DEFERRED_REASON_MUST_NOT_ENTER_THE_TASK_PROMPT";
  const acceptedClause = {
    id: "AC-REQ-prompt-v2-001",
    requirementId: requirement.id,
    text: acceptedText,
    proofIds: ["PROOF-prompt-v2"],
    span: {
      path: "docs/PRD.md",
      byteStart: 120,
      byteEnd: 120 + Buffer.byteLength(acceptedText),
      line: 14,
      column: 25,
      endLine: 14,
      endColumn: 25 + acceptedText.length,
      sha256: HASH_A,
      excerptSha256: HASH_B,
    },
  };
  const foreignClauseText = "THIS_FOREIGN_CLAUSE_MUST_NOT_ENTER_THE_TASK_PROMPT";
  const foreignClause = {
    ...acceptedClause,
    id: "AC-REQ-foreign-001",
    requirementId: "REQ-foreign",
    text: foreignClauseText,
    proofIds: ["PROOF-foreign"],
    span: {
      ...acceptedClause.span,
      byteStart: 400,
      byteEnd: 400 + Buffer.byteLength(foreignClauseText),
      excerptSha256: "c".repeat(64),
    },
  };
  const foreignRequirement = {
    ...requirement,
    id: "REQ-foreign",
    proofIds: ["PROOF-foreign"],
    acceptanceClauses: [foreignClause],
    acceptanceDispositions: [],
  };
  const proof = {
    schema: "ccc-prd.proof.v2",
    id: "PROOF-prompt-v2",
    requirementIds: [requirement.id],
    clauseIds: [acceptedClause.id],
    phases: ["task", "final_integrated"],
    command: "task verify:slugify",
    positiveOracle: "all declared semantic cases pass",
    positiveCases: [{ id: "CASE-empty", description: "empty input stays empty" }],
    negativeControls: [{ id: "CONTROL-nonempty", description: "a nonempty defect fails" }],
    verifierClosure: [{
      role: "task_runner",
      path: "Taskfile.yml",
      baseGitBlobOid: "1".repeat(40),
      sha256: HASH_A,
    }],
    candidateInputs: ["src/slugify.js"],
    executionToolchain: {
      task: {
        executablePath: "/opt/ccc/task",
        executableSha256: HASH_A,
        version: "3.44.1",
        versionOutputSha256: HASH_B,
      },
      node: {
        executablePath: "/opt/ccc/node",
        executableSha256: HASH_B,
        version: "24.6.0",
        versionOutputSha256: HASH_A,
      },
      proofHost: {
        id: "proof-host",
        executablePath: "/opt/ccc/proof-host",
        executableSha256: HASH_A,
        version: "2.0.0",
        versionOutputSha256: HASH_B,
      },
      linkedRuntime: [],
    },
    spans: [],
    confidence: "high",
  };
  const withoutHash = {
    ...base,
    schema: "ccc-prd.bundle.v2",
    requirements: [{
      ...requirement,
      proofIds: [proof.id],
      acceptanceClauses: [acceptedClause],
      acceptanceDispositions: [{
        clauseId: deferredClauseId,
        requirementId: requirement.id,
        kind: "deferred",
        reason: deferredReason,
        span: {
          ...acceptedClause.span,
          byteStart: 300,
          byteEnd: 300 + Buffer.byteLength(deferredReason),
          line: 16,
          endLine: 16,
          excerptSha256: HASH_B,
        },
      }],
    }, foreignRequirement],
    proofs: [proof, {
      ...proof,
      id: "PROOF-foreign",
      requirementIds: [foreignRequirement.id],
      clauseIds: [foreignClause.id],
    }],
    tasks: [{ ...task, proofIds: [proof.id] }],
  } as unknown as CccPrdSemanticBundle;
  return {
    ...withoutHash,
    bundleHash: computeCccPrdSemanticBundleSha256(withoutHash),
  } as CccPrdSemanticBundle;
}

describe("CCC PRD sealed coding prompt", () => {
  it("RED-S4-prompt-v2: renders only exact accepted clauses linked to the task with source custody", () => {
    const bundle = semanticBundleV2();
    const policy = createCccPrdImportTestProductExecutionPolicy(bundle);
    const sealed = buildCccPrdTaskExecutionPrompt(bundle, bundle.tasks[0]!, policy.routes[0]!);

    expect(sealed.schema).toBe("ccc-prd.execution-prompt.v2");
    expect(sealed.content).toContain("AC-REQ-prompt-v2-001");
    expect(sealed.content).toContain("Return an empty string for empty input.");
    expect(sealed.content).toContain("docs/PRD.md");
    expect(sealed.content).toContain("bytes 120-159");
    expect(sealed.content).toContain(HASH_B);
    expect(sealed.content).not.toContain("AC-REQ-prompt-v2-002");
    expect(sealed.content).not.toContain("DEFERRED_REASON_MUST_NOT_ENTER_THE_TASK_PROMPT");
    expect(sealed.content).not.toContain("THIS_FOREIGN_CLAUSE_MUST_NOT_ENTER_THE_TASK_PROMPT");
  });

  it("RED-S4-prompt-custody: either exact clause text or its excerpt hash changes bundle and prompt identity", () => {
    const base = semanticBundleV2();
    const policy = createCccPrdImportTestProductExecutionPolicy(base);
    const originalPrompt = buildCccPrdTaskExecutionPrompt(base, base.tasks[0]!, policy.routes[0]!);
    const requirement = base.requirements[0] as unknown as {
      acceptanceClauses: Array<{ text: string; span: { excerptSha256: string } }>;
    };
    const mutations = [
      {
        ...requirement.acceptanceClauses[0],
        text: "Return EMPTY for empty input.",
      },
      {
        ...requirement.acceptanceClauses[0],
        span: {
          ...requirement.acceptanceClauses[0]!.span,
          excerptSha256: "d".repeat(64),
        },
      },
    ];
    for (const mutation of mutations) {
      const changedWithoutHash = {
        ...base,
        requirements: [{
          ...base.requirements[0],
          acceptanceClauses: [mutation, ...requirement.acceptanceClauses.slice(1)],
        }, ...base.requirements.slice(1)],
      } as unknown as CccPrdSemanticBundle;
      const changed = {
        ...changedWithoutHash,
        bundleHash: computeCccPrdSemanticBundleSha256(changedWithoutHash),
      } as CccPrdSemanticBundle;
      const changedPrompt = buildCccPrdTaskExecutionPrompt(
        changed,
        changed.tasks[0]!,
        policy.routes[0]!,
      );

      expect(changed.bundleHash).not.toBe(base.bundleHash);
      expect(changedPrompt.sha256).not.toBe(originalPrompt.sha256);
    }
  });

  it("RED-S4-prompt-v1-stability: preserves the exact frozen v1 execution-prompt bytes", () => {
    const bundle = createCccPrdImportTestBundle(
      "/tmp/ccc-v1-byte-stability",
      "v1-byte-stability",
    );
    const route = createCccPrdImportTestProductExecutionPolicy(bundle).routes[0]!;
    const sealed = buildCccPrdTaskExecutionPrompt(bundle, bundle.tasks[0]!, route);

    expect(sealed.schema).toBe("ccc-prd.execution-prompt.v1");
    expect(sealed.sha256).toBe("786d9293f5174b812a27ca36b06dea7a223bfae1f81efb3f9f88b6e4fd2bd578");
  });

  it("carries requirement, acceptance, proof, document, path, non-goal, and protected-action facts that are absent from task.description", () => {
    const base = createCccPrdImportTestBundle("/tmp/ccc-prompt-target", "sealed");
    const task = base.tasks[0]!;
    const requirement = base.requirements[0]!;
    const proof = base.proofs[0]!;
    const document = base.documents[0]!;
    const protectedAction = {
      id: "ACTION-SEALED-MERGE",
      kind: "merge" as const,
      target: "refs/heads/main",
      operatorDecision: "approve_merge" as const,
      requiresOperatorDecision: true as const,
      spans: task.spans,
    };
    const bundle = rehashCccPrdImportTestBundle({
      ...base,
      requirements: [{
        ...requirement,
        statement: "ESSENTIAL_REQUIREMENT_ONLY",
        acceptance: "ESSENTIAL_ACCEPTANCE_ONLY",
      }],
      proofs: [{
        ...proof,
        command: "task essential:verifier",
        positiveOracle: "ESSENTIAL_POSITIVE_ORACLE_ONLY",
        negativeControls: ["ESSENTIAL_NEGATIVE_CONTROL_ONLY"],
      }],
      tasks: [{
        ...task,
        description: "Generic description with none of the essential details.",
        protectedActionIds: [protectedAction.id],
      }, ...base.tasks.slice(1)],
      documents: [{
        ...document,
        key: "prompt.md",
        content: "ESSENTIAL_DOCUMENT_ONLY",
      }],
      protectedActions: [protectedAction],
      nonGoals: ["ESSENTIAL_NON_GOAL_ONLY"],
    });
    const policy = createCccPrdImportTestProductExecutionPolicy(bundle);
    const route = policy.routes[0]!;

    const sealed = buildCccPrdTaskExecutionPrompt(bundle, bundle.tasks[0]!, route);

    expect(sealed.schema).toBe("ccc-prd.execution-prompt.v1");
    expect(sealed.content).toContain("ESSENTIAL_REQUIREMENT_ONLY");
    expect(sealed.content).toContain("ESSENTIAL_ACCEPTANCE_ONLY");
    expect(sealed.content).toContain("task essential:verifier");
    expect(sealed.content).toContain("ESSENTIAL_POSITIVE_ORACLE_ONLY");
    expect(sealed.content).toContain("ESSENTIAL_NEGATIVE_CONTROL_ONLY");
    expect(sealed.content).toContain("ESSENTIAL_DOCUMENT_ONLY");
    expect(sealed.content).toContain("ESSENTIAL_NON_GOAL_ONLY");
    expect(sealed.content).toContain(route.ownedPaths[0]!);
    expect(sealed.content).toContain(route.allowedWriteRoots[0]!);
    expect(sealed.content).toContain(protectedAction.operatorDecision);
    expect(sealed.content).toContain(
      "Do not run git add, git commit, or mutate Git refs",
    );
    expect(sealed.content).toContain(
      "campaign controller will validate those bytes",
    );
    expect(sealed.sha256).toBe(
      createHash("sha256").update(sealed.content, "utf8").digest("hex"),
    );

    const projection = buildCccPrdProjection({
      bundle,
      executionPolicy: policy,
      importId: "ccc-prd-import-sealed",
      identityHash: "1".repeat(64),
      campaignId: "ccc-prd-import-sealed--CAMPAIGN-sealed",
      now: "2026-07-31T00:00:00.000Z",
    });
    expect(projection.taskFiles[0]!.prompt).toBe(sealed.content);
    expect(JSON.parse(projection.taskFiles[0]!.taskJson)).toMatchObject({
      sourceMetadata: {
        cccExecutionPrompt: {
          schema: sealed.schema,
          sha256: sealed.sha256,
        },
      },
    });
  });
});
