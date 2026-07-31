import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createCccPrdImportTestBundle,
  createCccPrdImportTestProductExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../__test-utils__/ccc-prd-import-fixture.js";
import {
  buildCccPrdProjection,
  buildCccPrdTaskExecutionPrompt,
} from "../ccc-prd/projection.js";

describe("CCC PRD sealed coding prompt", () => {
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
