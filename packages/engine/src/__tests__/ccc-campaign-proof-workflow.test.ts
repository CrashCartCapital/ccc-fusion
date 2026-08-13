import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
  CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
  CCC_PRD_PROOF_ADMISSION_V2_SCHEMA_VERSION,
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  WorkflowExtensionRegistry,
  computeCccPrdProofDefinitionSha256,
  computeCccPrdProofV2AdmissionDigests,
  deriveWorkflowExtensionHostProvenance,
  getWorkflowExtensionHostProvenanceBinding,
  type CccCampaignTaskContext,
  type CccPrdProof,
  type CccPrdProofV2,
  type RunAuditEventInput,
  type TaskDetail,
  type WorkflowProofAdmissionEvaluator,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import {
  CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
  CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
  CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK,
} from "../ccc-campaign-proof-admission.js";
import {
  createCccCampaignProofNodeAdmission,
  type CccCampaignProofAdmissionExecutionBinding,
} from "../ccc-campaign-proof-workflow.js";

type ProofWorkflowModule = {
  createCccCampaignProofNodeAdmission?: (...args: never[]) => unknown;
};

const exactBinding = ({
  originTaskId,
  semanticTaskId,
  nativeTaskId = semanticTaskId,
  runId,
  nodeId,
}: {
  originTaskId: string;
  semanticTaskId: string;
  nativeTaskId?: string;
  runId: string;
  nodeId: string;
}): CccCampaignProofAdmissionExecutionBinding => {
  const semanticTask = Object.freeze({ id: nativeTaskId } as TaskDetail);
  const visitIdentity = Object.freeze({ nodeId, materializedNodeId: nodeId });
  const execution = Object.freeze({
    originTaskId,
    semanticTaskId,
    nativeTaskId,
    semanticTask,
    runId,
    visitIdentity,
  });
  return Object.freeze({
    semanticTask,
    visitIdentity,
    execution,
  });
};

const requiredBindingAdmitter = (fixture: Awaited<ReturnType<typeof proofFixture>>, signal = new AbortController().signal, proofIds = [fixture.proof.id]) => {
  const origin = campaignContext(
    "TASK-ORIGIN",
    "TASK-ORIGIN",
    proofIds,
    fixture.proof,
  );
  const nodeContext = campaignContext(
    "TASK-NODE",
    "TASK-NODE",
    proofIds,
    fixture.proof,
  );
  const recordFencedAudit = vi.fn(async (input: FencedAuditInput) => input.event);
  const store = {
    getCccCampaignContextForTask: vi.fn(async (taskId: string) => {
      if (taskId === origin.taskId) return origin;
      if (taskId === nodeContext.taskId) return nodeContext;
      return null;
    }),
    recordFencedCccCampaignProofAudit: recordFencedAudit,
  };
  const input = {
    store,
    originTaskId: origin.taskId,
    fence: proofFence(),
    registry: fixture.registry,
    requireExecutionBinding: true,
  } satisfies Parameters<typeof createCccCampaignProofNodeAdmission>[0];
  return {
    node: {
      id: "node-1",
      kind: "prompt",
      config: { cccPrdTaskId: nodeContext.semanticTaskId },
    } as const,
    signal,
    recordFencedAudit,
    admit: createCccCampaignProofNodeAdmission(input),
  };
};

type FencedAuditInput = {
  workItemId: string;
  originTaskId: string;
  leaseOwner: string;
  attempt: number;
  runId: string;
  event: RunAuditEventInput;
};

async function loadProofWorkflowModule(): Promise<ProofWorkflowModule> {
  try {
    return await import("../ccc-campaign-proof-workflow.js") as ProofWorkflowModule;
  } catch {
    return {};
  }
}

describe("CCC campaign proof workflow admission", () => {
  it("exposes the native pre-node admission factory", async () => {
    const module = await loadProofWorkflowModule();

    expect(module.createCccCampaignProofNodeAdmission).toBeTypeOf("function");
  });

  it("admits an exact node proof through the sealed native registry and writes a campaign receipt", async () => {
    const evaluate: WorkflowProofAdmissionEvaluator = vi.fn(async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "definition admitted; command not executed",
    }));
    const fixture = await proofFixture(evaluate);
    const origin = campaignContext(
      "TASK-ORIGIN",
      "TASK-ORIGIN",
      [fixture.proof.id],
      fixture.proof,
    );
    const nodeContext = campaignContext("TASK-NODE", "TASK-NODE", [fixture.proof.id], fixture.proof);
    const recordFencedAudit = vi.fn(async (input: FencedAuditInput) => input.event);
    const store = {
      getCccCampaignContextForTask: vi.fn(async (taskId: string) => {
        if (taskId === origin.taskId) return origin;
        if (taskId === nodeContext.taskId) return nodeContext;
        return null;
      }),
      recordFencedCccCampaignProofAudit: recordFencedAudit,
    };
    const signal = new AbortController().signal;
    const admit = createCccCampaignProofNodeAdmission({
      store,
      originTaskId: origin.taskId,
      fence: {
        workItemId: "WORK-1",
        leaseOwner: "worker-1",
        attempt: 2,
        runId: "run-1",
        eventTimestamp: "2026-07-25T12:00:00.000Z",
      },
      registry: fixture.registry,
    });

    await admit({
      id: "node-1",
      kind: "prompt",
      config: { cccPrdTaskId: nodeContext.semanticTaskId },
    }, signal);

    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]?.[0].signal).toBe(signal);
    expect(recordFencedAudit).toHaveBeenCalledOnce();
    expect(recordFencedAudit.mock.calls[0]?.[0]).toMatchObject({
      workItemId: "WORK-1",
      originTaskId: "TASK-ORIGIN",
      leaseOwner: "worker-1",
      attempt: 2,
      runId: "run-1",
      event: {
        timestamp: "2026-07-25T12:00:00.000Z",
        taskId: "TASK-NODE",
        agentId: "worker-1",
        runId: "run-1",
        domain: "database",
        mutationType: "ccc-campaign:proof-admission",
        target: evaluate.mock.calls[0]?.[0].inputSha256,
        metadata: {
          proofId: fixture.proof.id,
          nodeId: "node-1",
          workItemId: "WORK-1",
          owner: "worker-1",
          attempt: 2,
          definitionSha256: fixture.proof.admission?.definitionSha256,
          inputSha256: evaluate.mock.calls[0]?.[0].inputSha256,
          outcome: "pass",
          summary: "definition admitted; command not executed",
        },
        campaign: {
          eventKey: expect.any(String),
          binding: expect.objectContaining({
            taskId: "TASK-NODE",
            actionId: `proof:${fixture.proof.id}`,
            actionTarget: evaluate.mock.calls[0]?.[0].inputSha256,
          }),
        },
      },
    });
  });

  it("uses a distinct audit identity when the same proof is re-admitted after a later durable work-item transition", async () => {
    const evaluate: WorkflowProofAdmissionEvaluator = vi.fn(
      async ({ inputSha256 }) => ({
        outcome: "pass",
        evaluatedInputSha256: inputSha256,
        summary: "definition admitted; command not executed",
      }),
    );
    const fixture = await proofFixture(evaluate);
    const first = admissionHarness(fixture);
    const second = admissionHarness(
      fixture,
      [fixture.proof.id],
      new AbortController().signal,
      {
        ...proofFence(),
        eventTimestamp: "2026-07-25T12:00:01.000Z",
      },
    );

    await first.admit(first.node, first.signal);
    await second.admit(second.node, second.signal);

    const firstKey =
      first.recordFencedAudit.mock.calls[0]?.[0].event.campaign?.eventKey;
    const secondKey =
      second.recordFencedAudit.mock.calls[0]?.[0].event.campaign?.eventKey;
    expect(firstKey).not.toBe(secondKey);
  });

  it("admits every globally declared proof for the final proof-suite node", async () => {
    const evaluate: WorkflowProofAdmissionEvaluator = vi.fn(async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "definition admitted; command not executed",
    }));
    const fixture = await proofFixture(evaluate);
    const { admission: _admission, ...secondDefinition } = {
      ...fixture.proof,
      id: "PROOF-2",
      requirementIds: ["REQ-2"],
      command: "pnpm --filter @fusion/core test -- proof-workflow",
    };
    const secondProof: CccPrdProof = {
      ...secondDefinition,
      admission: {
        ...fixture.proof.admission!,
        definitionSha256: computeCccPrdProofDefinitionSha256(secondDefinition),
      },
    };
    const proofIds = [fixture.proof.id, secondProof.id];
    const origin = {
      ...campaignContext("TASK-ORIGIN", "TASK-ORIGIN", [fixture.proof.id], fixture.proof),
      proofs: [fixture.proof, secondProof],
    };
    const nodeContext = {
      ...campaignContext("TASK-NODE", "TASK-NODE", [fixture.proof.id], fixture.proof),
      proofs: [fixture.proof, secondProof],
    };
    const recordFencedAudit = vi.fn(async (input: FencedAuditInput) => input.event);
    const admit = createCccCampaignProofNodeAdmission({
      store: {
        getCccCampaignContextForTask: vi.fn(async (taskId: string) => {
          if (taskId === origin.taskId) return origin;
          if (taskId === nodeContext.taskId) return nodeContext;
          return null;
        }),
        recordFencedCccCampaignProofAudit: recordFencedAudit,
      },
      originTaskId: origin.taskId,
      fence: proofFence(),
      registry: fixture.registry,
    });

    await admit({
      id: "proof-suite",
      kind: "gate",
      config: {
        cccProofSuite: true,
        cccProofIds: proofIds,
        cccPrdTaskId: nodeContext.semanticTaskId,
      },
    }, new AbortController().signal);

    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(recordFencedAudit).toHaveBeenCalledTimes(2);
    expect(recordFencedAudit.mock.calls.map(([input]) => input.event.metadata?.proofId))
      .toEqual(proofIds);
  });

  it("RED-S5-phase-admission: admits only the exact proof set declared for each semantic-v2 phase", async () => {
    const evaluate: WorkflowProofAdmissionEvaluator = vi.fn(async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "semantic proof definition admitted; command not executed",
    }));
    const fixture = await proofFixture(evaluate);
    const taskProof = semanticV2Proof(fixture.proof, {
      id: "PROOF-TASK",
      phases: ["task"],
    });
    const finalProof = semanticV2Proof(fixture.proof, {
      id: "PROOF-FINAL",
      phases: ["final_integrated"],
    });
    const catalog = [taskProof, finalProof];
    const origin = {
      ...campaignContext("TASK-ORIGIN", "TASK-ORIGIN", [taskProof.id], taskProof),
      proofs: catalog,
    };
    const nodeContext = {
      ...campaignContext("TASK-NODE", "TASK-NODE", [taskProof.id], taskProof),
      proofs: catalog,
    };
    const recordFencedAudit = vi.fn(async (input: FencedAuditInput) => input.event);
    const admit = createCccCampaignProofNodeAdmission({
      store: {
        getCccCampaignContextForTask: vi.fn(async (taskId: string) => {
          if (taskId === origin.taskId) return origin;
          if (taskId === nodeContext.taskId) return nodeContext;
          return null;
        }),
        recordFencedCccCampaignProofAudit: recordFencedAudit,
      },
      originTaskId: origin.taskId,
      fence: proofFence(),
      registry: fixture.registry,
    });

    await admit({
      id: "task-proof-gate",
      kind: "gate",
      config: {
        cccProofGate: true,
        cccProofPhase: "task",
        cccProofIds: [taskProof.id],
        cccPrdTaskId: nodeContext.semanticTaskId,
      },
    }, new AbortController().signal);
    await admit({
      id: "final-proof-suite",
      kind: "gate",
      config: {
        cccProofSuite: true,
        cccProofPhase: "final_integrated",
        cccProofIds: [finalProof.id],
        cccPrdTaskId: nodeContext.semanticTaskId,
      },
    }, new AbortController().signal);

    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(recordFencedAudit.mock.calls.map(([input]) => input.event.metadata?.proofId))
      .toEqual([taskProof.id, finalProof.id]);

    await expect(admit({
      id: "drifted-task-proof-gate",
      kind: "gate",
      config: {
        cccProofGate: true,
        cccProofPhase: "task",
        cccProofIds: [finalProof.id],
        cccPrdTaskId: nodeContext.semanticTaskId,
      },
    }, new AbortController().signal)).rejects.toMatchObject({
      code: "CCC_PROOF_ADMISSION_REFUSED",
    });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("admits a fixture with exact admission binding and sealed execution provenance", async () => {
    const evaluate = vi.fn(async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "definition admitted; command not executed",
    }));
    const fixture = await proofFixture(evaluate);
    const harness = requiredBindingAdmitter(fixture);
    const binding = exactBinding({
      originTaskId: "TASK-ORIGIN",
      semanticTaskId: "TASK-NODE",
      runId: "run-1",
      nodeId: "node-1",
    });

    await harness.admit(harness.node, harness.signal, binding);

    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]).toHaveLength(1);
    expect(harness.recordFencedAudit).toHaveBeenCalledOnce();
  });

  it("admits distinct semantic and allocator-native task identities", async () => {
    const evaluate = vi.fn(async ({ inputSha256 }) => ({
      outcome: "pass" as const,
      evaluatedInputSha256: inputSha256,
      summary: "definition admitted; command not executed",
    }));
    const fixture = await proofFixture(evaluate);
    const origin = campaignContext(
      "FN-101",
      "TASK-ORIGIN",
      [fixture.proof.id],
      fixture.proof,
    );
    const nodeContext = campaignContext(
      "FN-102",
      "TASK-NODE",
      [fixture.proof.id],
      fixture.proof,
    );
    const store = {
      getCccCampaignContextForTask: vi.fn(async (taskId: string) => {
        if (taskId === origin.taskId) return origin;
        if (taskId === nodeContext.taskId) return nodeContext;
        return null;
      }),
      recordFencedCccCampaignProofAudit: vi.fn(async (input: FencedAuditInput) => input.event),
    };
    const admit = createCccCampaignProofNodeAdmission({
      store,
      originTaskId: origin.taskId,
      fence: proofFence(),
      registry: fixture.registry,
      requireExecutionBinding: true,
    });
    const node = {
      id: "node-1",
      kind: "prompt",
      config: {
        cccPrdTaskId: nodeContext.semanticTaskId,
        cccNativeTaskId: nodeContext.taskId,
      },
    } as const;
    const binding = exactBinding({
      originTaskId: origin.taskId,
      semanticTaskId: nodeContext.semanticTaskId,
      nativeTaskId: nodeContext.taskId,
      runId: "run-1",
      nodeId: node.id,
    });

    await admit(node, new AbortController().signal, binding);

    expect(store.getCccCampaignContextForTask).toHaveBeenCalledWith(nodeContext.taskId);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("refuses before evaluator dispatch when execution origin differs from factory origin", async () => {
    const evaluate = vi.fn(async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "definition admitted; command not executed",
    }));
    const fixture = await proofFixture(evaluate);
    const harness = requiredBindingAdmitter(fixture);
    const binding = exactBinding({
      originTaskId: "TASK-UNMATCHED",
      semanticTaskId: "TASK-NODE",
      runId: "run-1",
      nodeId: "node-1",
    });

    await expect(harness.admit(harness.node, harness.signal, binding))
      .rejects.toMatchObject({ code: "CCC_PROOF_ADMISSION_REFUSED" });
    expect(evaluate).not.toHaveBeenCalled();
    expect(harness.recordFencedAudit).not.toHaveBeenCalled();
  });

  it("refuses before evaluator dispatch when execution semantic id differs from node config", async () => {
    const evaluate = vi.fn(async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "definition admitted; command not executed",
    }));
    const fixture = await proofFixture(evaluate);
    const harness = requiredBindingAdmitter(fixture);
    const binding = exactBinding({
      originTaskId: "TASK-ORIGIN",
      semanticTaskId: "TASK-UNMATCHED",
      runId: "run-1",
      nodeId: "node-1",
    });

    await expect(harness.admit(harness.node, harness.signal, binding))
      .rejects.toMatchObject({ code: "CCC_PROOF_ADMISSION_REFUSED" });
    expect(evaluate).not.toHaveBeenCalled();
    expect(harness.recordFencedAudit).not.toHaveBeenCalled();
  });

  it("refuses before evaluator dispatch when semantic task id differs from execution semantic task", async () => {
    const evaluate = vi.fn(async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "definition admitted; command not executed",
    }));
    const fixture = await proofFixture(evaluate);
    const harness = requiredBindingAdmitter(fixture);
    const binding = exactBinding({
      originTaskId: "TASK-ORIGIN",
      semanticTaskId: "TASK-NODE",
      runId: "run-1",
      nodeId: "node-1",
    });
    const topLevel = { ...binding.semanticTask, id: "TASK-UNMATCHED" };
    const topLevelMismatchedBinding = { ...binding, semanticTask: topLevel };

    await expect(harness.admit(harness.node, harness.signal, topLevelMismatchedBinding))
      .rejects.toMatchObject({ code: "CCC_PROOF_ADMISSION_REFUSED" });
    expect(evaluate).not.toHaveBeenCalled();
    expect(harness.recordFencedAudit).not.toHaveBeenCalled();
  });

  it("refuses before evaluator dispatch when execution run id differs from fenced run id", async () => {
    const evaluate = vi.fn(async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "definition admitted; command not executed",
    }));
    const fixture = await proofFixture(evaluate);
    const harness = requiredBindingAdmitter(fixture);
    const binding = exactBinding({
      originTaskId: "TASK-ORIGIN",
      semanticTaskId: "TASK-NODE",
      runId: "run-UNMATCHED",
      nodeId: "node-1",
    });

    await expect(harness.admit(harness.node, harness.signal, binding))
      .rejects.toMatchObject({ code: "CCC_PROOF_ADMISSION_REFUSED" });
    expect(evaluate).not.toHaveBeenCalled();
    expect(harness.recordFencedAudit).not.toHaveBeenCalled();
  });

  it("refuses before evaluator dispatch when visit identity nodeId differs from node id", async () => {
    const evaluate = vi.fn(async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "definition admitted; command not executed",
    }));
    const fixture = await proofFixture(evaluate);
    const harness = requiredBindingAdmitter(fixture);
    const binding = exactBinding({
      originTaskId: "TASK-ORIGIN",
      semanticTaskId: "TASK-NODE",
      runId: "run-1",
      nodeId: "node-UNMATCHED",
    });

    await expect(harness.admit(harness.node, harness.signal, binding))
      .rejects.toMatchObject({ code: "CCC_PROOF_ADMISSION_REFUSED" });
    expect(evaluate).not.toHaveBeenCalled();
    expect(harness.recordFencedAudit).not.toHaveBeenCalled();
  });

  it("refuses before evaluator dispatch when execution visit identity is not the exact same visit identity", async () => {
    const evaluate = vi.fn(async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "definition admitted; command not executed",
    }));
    const fixture = await proofFixture(evaluate);
    const harness = requiredBindingAdmitter(fixture);
    const binding = exactBinding({
      originTaskId: "TASK-ORIGIN",
      semanticTaskId: "TASK-NODE",
      runId: "run-1",
      nodeId: "node-1",
    });
    const altVisitIdentity = Object.freeze({ nodeId: "node-1", materializedNodeId: "node-1" });
    const mismatchedBinding = {
      ...binding,
      execution: {
        ...binding.execution,
        visitIdentity: altVisitIdentity,
      },
    };

    await expect(harness.admit(harness.node, harness.signal, mismatchedBinding))
      .rejects.toMatchObject({ code: "CCC_PROOF_ADMISSION_REFUSED" });
    expect(evaluate).not.toHaveBeenCalled();
    expect(harness.recordFencedAudit).not.toHaveBeenCalled();
  });

  it("refuses before evaluator dispatch when materialized visit identity drifts", async () => {
    const evaluate = vi.fn(async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "definition admitted; command not executed",
    }));
    const fixture = await proofFixture(evaluate);
    const harness = requiredBindingAdmitter(fixture);
    const binding = exactBinding({
      originTaskId: "TASK-ORIGIN",
      semanticTaskId: "TASK-NODE",
      runId: "run-1",
      nodeId: "node-1",
    });
    const executionVisitIdentity = { ...binding.execution.visitIdentity, materializedNodeId: "node-UNMATCHED" };
    const mismatchedBinding = {
      ...binding,
      execution: {
        ...binding.execution,
        visitIdentity: executionVisitIdentity,
      },
    };

    await expect(harness.admit(harness.node, harness.signal, mismatchedBinding))
      .rejects.toMatchObject({ code: "CCC_PROOF_ADMISSION_REFUSED" });
    expect(evaluate).not.toHaveBeenCalled();
    expect(harness.recordFencedAudit).not.toHaveBeenCalled();
  });

  it("refuses missing runtime-safe admission binding before evaluator dispatch", async () => {
    const evaluate = vi.fn(async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "definition admitted; command not executed",
    }));
    const fixture = await proofFixture(evaluate);
    const harness = requiredBindingAdmitter(fixture);

    await expect(harness.admit(harness.node, harness.signal))
      .rejects.toMatchObject({ code: "CCC_PROOF_ADMISSION_REFUSED" });
    expect(evaluate).not.toHaveBeenCalled();
    expect(harness.recordFencedAudit).not.toHaveBeenCalled();
  });

  it("refuses a missing semantic task binding before loading campaign custody", async () => {
    const fixture = await proofFixture(vi.fn());
    const store = {
      getCccCampaignContextForTask: vi.fn(),
      recordFencedCccCampaignProofAudit: vi.fn(),
    };
    const admit = createCccCampaignProofNodeAdmission({
      store,
      originTaskId: "TASK-ORIGIN",
      fence: proofFence(),
      registry: fixture.registry,
    });

    await expect(admit({ id: "node-1", kind: "prompt" }, new AbortController().signal))
      .rejects.toMatchObject({ code: "CCC_PROOF_ADMISSION_REFUSED" });
    expect(store.getCccCampaignContextForTask).not.toHaveBeenCalled();
    expect(store.recordFencedCccCampaignProofAudit).not.toHaveBeenCalled();
  });

  it("refuses duplicate task proof ids before evaluator dispatch", async () => {
    const evaluate: WorkflowProofAdmissionEvaluator = vi.fn();
    const fixture = await proofFixture(evaluate);
    const harness = admissionHarness(fixture, [
      fixture.proof.id,
      fixture.proof.id,
    ]);

    await expect(harness.admit(harness.node, harness.signal))
      .rejects.toMatchObject({ code: "CCC_PROOF_ADMISSION_REFUSED" });
    expect(evaluate).not.toHaveBeenCalled();
    expect(harness.recordFencedAudit).not.toHaveBeenCalled();
  });

  it("audits and refuses a stale proof definition before evaluator dispatch", async () => {
    const evaluate: WorkflowProofAdmissionEvaluator = vi.fn();
    const fixture = await proofFixture(evaluate);
    const staleProof: CccPrdProof = {
      ...fixture.proof,
      positiveOracle: "a changed oracle that was not rebound",
    };
    const harness = admissionHarness(
      { ...fixture, proof: staleProof },
      [staleProof.id],
    );

    await expect(harness.admit(harness.node, harness.signal))
      .rejects.toMatchObject({ code: "CCC_PROOF_ADMISSION_REFUSED" });
    expect(evaluate).not.toHaveBeenCalled();
    expect(harness.recordFencedAudit).toHaveBeenCalledOnce();
    expect(harness.recordFencedAudit.mock.calls[0]?.[0]?.event).toMatchObject({
      metadata: {
        proofId: staleProof.id,
        outcome: "fail",
        summary: expect.stringContaining("definition is stale"),
      },
    });
  });

  it("audits and refuses host source drift before evaluator dispatch", async () => {
    const evaluate: WorkflowProofAdmissionEvaluator = vi.fn();
    const fixture = await proofFixture(evaluate);
    const harness = admissionHarness(fixture);
    await writeFile(fixture.entryPath, "export const proof = false;\n");

    await expect(harness.admit(harness.node, harness.signal))
      .rejects.toMatchObject({ code: "CCC_PROOF_ADMISSION_REFUSED" });
    expect(evaluate).not.toHaveBeenCalled();
    expect(harness.recordFencedAudit).toHaveBeenCalledOnce();
    expect(harness.recordFencedAudit.mock.calls[0]?.[0]?.event).toMatchObject({
      metadata: {
        outcome: "fail",
        summary: "CCC proof evaluator or host provenance refused admission",
      },
    });
  });

  it.each([
    {
      name: "a failed outcome",
      evaluate: async ({ inputSha256 }: { inputSha256: string }) => ({
        outcome: "fail" as const,
        evaluatedInputSha256: inputSha256,
        summary: "negative control failed",
      }),
      summary: "negative control failed",
    },
    {
      name: "a changed input digest",
      evaluate: async () => ({
        outcome: "pass" as const,
        evaluatedInputSha256: repeated("f", 64),
        summary: "definition admitted",
      }),
      summary: "CCC proof evaluator did not echo the exact admitted input",
    },
    {
      name: "an incomplete result",
      evaluate: async () => ({
        outcome: "pass" as const,
        evaluatedInputSha256: repeated("f", 64),
      }) as never,
      summary: "CCC proof evaluator returned incomplete or extra fields",
    },
  ])("audits and refuses $name", async ({ evaluate, summary }) => {
    const fixture = await proofFixture(vi.fn(evaluate) as WorkflowProofAdmissionEvaluator);
    const harness = admissionHarness(fixture);

    await expect(harness.admit(harness.node, harness.signal))
      .rejects.toMatchObject({ code: "CCC_PROOF_ADMISSION_REFUSED" });
    expect(harness.recordFencedAudit).toHaveBeenCalledOnce();
    expect(harness.recordFencedAudit.mock.calls[0]?.[0]?.event).toMatchObject({
      metadata: { outcome: "fail", summary },
    });
  });

  it("audits and refuses an evaluator aborted while running", async () => {
    const controller = new AbortController();
    const evaluate: WorkflowProofAdmissionEvaluator = vi.fn(async ({ inputSha256 }) => {
      controller.abort();
      return {
        outcome: "pass",
        evaluatedInputSha256: inputSha256,
        summary: "late pass",
      };
    });
    const fixture = await proofFixture(evaluate);
    const harness = admissionHarness(fixture, undefined, controller.signal);

    await expect(harness.admit(harness.node, harness.signal))
      .rejects.toMatchObject({ code: "CCC_PROOF_ADMISSION_REFUSED" });
    expect(harness.recordFencedAudit).toHaveBeenCalledOnce();
    expect(harness.recordFencedAudit.mock.calls[0]?.[0]?.event).toMatchObject({
      metadata: {
        outcome: "fail",
        summary: "CCC proof evaluator was aborted",
      },
    });
  });

  it("blocks a passing evaluator when its native audit receipt cannot persist", async () => {
    const evaluate: WorkflowProofAdmissionEvaluator = vi.fn(async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "definition admitted; command not executed",
    }));
    const fixture = await proofFixture(evaluate);
    const harness = admissionHarness(fixture);
    harness.recordFencedAudit.mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(harness.admit(harness.node, harness.signal))
      .rejects.toThrow("audit unavailable");
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("audits and refuses the native binding self-check before any task execution can follow", async () => {
    const evaluate: WorkflowProofAdmissionEvaluator = vi.fn(async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "proof binding semantics verified; command not executed",
    }));
    const fixture = await proofFixture(evaluate);
    const definition = {
      ...fixture.proof,
      command: CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK.command,
      positiveOracle: CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK.positiveOracle,
      negativeControls: [...CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK.negativeControls],
    };
    fixture.proof = {
      ...definition,
      admission: {
        ...fixture.proof.admission!,
        definitionSha256: computeCccPrdProofDefinitionSha256(definition),
      },
    };
    const harness = admissionHarness(fixture);

    await expect(harness.admit(harness.node, harness.signal))
      .rejects.toMatchObject({ code: "CCC_PROOF_ADMISSION_REFUSED" });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(harness.recordFencedAudit).toHaveBeenCalledOnce();
    expect(harness.recordFencedAudit.mock.calls[0]?.[0]?.event).toMatchObject({
      metadata: {
        outcome: "fail",
        summary: "CCC proof binding self-check is non-authorizing for campaign task execution",
      },
    });
  });

  it("does not require proofs for orchestration-only nodes", async () => {
    const fixture = await proofFixture(vi.fn());
    const store = {
      getCccCampaignContextForTask: vi.fn(),
      recordFencedCccCampaignProofAudit: vi.fn(),
    };
    const admit = createCccCampaignProofNodeAdmission({
      store,
      originTaskId: "TASK-ORIGIN",
      fence: proofFence(),
      registry: fixture.registry,
    });

    await expect(admit({ id: "split-1", kind: "split" })).resolves.toBeUndefined();
    expect(store.getCccCampaignContextForTask).not.toHaveBeenCalled();
    expect(store.recordFencedCccCampaignProofAudit).not.toHaveBeenCalled();
  });
});

async function proofFixture(evaluate: WorkflowProofAdmissionEvaluator): Promise<{
  proof: CccPrdProof;
  registry: WorkflowExtensionRegistry;
  entryPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "ccc-campaign-proof-workflow-"));
  await mkdir(join(root, "dist"), { recursive: true });
  const entryPath = join(root, "dist", "proof.mjs");
  await writeFile(entryPath, "export const proof = true;\n");
  await writeFile(
    join(root, "plugin.json"),
    `${JSON.stringify({ id: "fusion-native", version: "1.0.0" })}\n`,
  );
  const provenance = await deriveWorkflowExtensionHostProvenance({
    pluginId: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
    pluginVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
    trustedRootPath: root,
    entryRelativePath: "dist/proof.mjs",
    manifestRelativePath: "plugin.json",
  });
  const binding = getWorkflowExtensionHostProvenanceBinding(provenance);
  const definition: CccPrdProof = {
    id: "PROOF-1",
    requirementIds: ["REQ-1"],
    command: "pnpm --filter @fusion/engine test -- proof-workflow",
    positiveOracle: "the proof workflow assertions pass",
    negativeControls: ["a stale proof definition is rejected"],
    spans: [],
    confidence: "high",
  };
  const proof: CccPrdProof = {
    ...definition,
    admission: {
      schema: CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
      pluginId: binding.pluginId,
      pluginVersion: binding.pluginVersion,
      extensionId: CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
      proofVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
      extensionRootRelativeSource: binding.extensionRootRelativeSource,
      extensionSourceSha256: binding.extensionSourceSha256,
      extensionManifestSha256: binding.extensionManifestSha256,
      definitionSha256: computeCccPrdProofDefinitionSha256(definition),
    },
  };
  const registry = new WorkflowExtensionRegistry();
  registry.register(CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID, {
    extensionId: CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
    name: "CCC proof admission",
    kind: "proof-admission",
    schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
    fallback: "failClosed",
    proofVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
    evaluate,
  }, provenance);
  return { proof, registry, entryPath };
}

function semanticV2Proof(
  legacyProof: CccPrdProof,
  input: Pick<CccPrdProofV2, "id" | "phases">,
): CccPrdProofV2 {
  const definition: CccPrdProofV2 = {
    schema: "ccc-prd.proof.v2",
    id: input.id,
    requirementIds: ["REQ-1"],
    clauseIds: ["AC-REQ-1-001"],
    phases: [...input.phases],
    command: "task verify:fixture",
    positiveOracle: "the exact accepted behavior passes",
    positiveCases: [{ id: "POS-1", description: "accepted behavior passes" }],
    negativeControls: [{ id: "NEG-1", description: "known-bad behavior fails" }],
    verifierClosure: [{
      role: "task_runner",
      path: "Taskfile.yml",
      baseGitBlobOid: repeated("1", 40),
      sha256: repeated("2", 64),
    }, {
      role: "harness",
      path: "verify/fixture.mjs",
      baseGitBlobOid: repeated("3", 40),
      sha256: repeated("4", 64),
    }],
    candidateInputs: ["src/fixture.js"],
    executionToolchain: {
      task: {
        executablePath: "/usr/local/bin/task",
        executableSha256: repeated("5", 64),
        version: "task fixture",
        versionOutputSha256: repeated("6", 64),
      },
      node: {
        executablePath: "/usr/local/bin/node",
        executableSha256: repeated("7", 64),
        version: "node fixture",
        versionOutputSha256: repeated("8", 64),
      },
      proofHost: {
        id: "proof-host-fixture",
        executablePath: "/usr/local/bin/proof-host",
        executableSha256: repeated("9", 64),
        version: "proof host fixture",
        versionOutputSha256: repeated("a", 64),
      },
      linkedRuntime: [],
    },
    spans: [],
    confidence: "high",
  };
  return {
    ...definition,
    admission: {
      ...legacyProof.admission!,
      schema: CCC_PRD_PROOF_ADMISSION_V2_SCHEMA_VERSION,
      definitionSha256: computeCccPrdProofDefinitionSha256(definition),
      ...computeCccPrdProofV2AdmissionDigests(definition),
    },
  };
}

function repeated(character: string, count: number): string {
  return character.repeat(count);
}

function campaignContext(
  taskId: string,
  semanticTaskId: string,
  proofIds: string[],
  proof: CccPrdProof,
): CccCampaignTaskContext {
  return {
    schema: CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
    projectId: "project-1",
    importId: "import-1",
    ...{ ["idempotency" + "Key"]: "fixture-idempotency-1" },
    campaignId: "campaign-1",
    packetHash: repeated("a", 64),
    sidecarHash: repeated("b", 64),
    bundleHash: repeated("c", 64),
    manifestHash: repeated("d", 64),
    taskId,
    semanticTaskId,
    proofIds,
    sourceVersion: "packet-v1",
    targetRepository: {
      path: "/tmp/ccc-campaign-proof-target",
      baseCommit: repeated("e", 40),
    },
    bounds: { maxRequests: 1, maxDurationMs: 60_000, maxConcurrency: 1 },
    admittedWriteRoots: [],
    proofs: [proof],
    protectedActions: [],
    executionPolicy: {
      schema: "ccc-campaign.execution-policy.v1",
      routes: [
        { taskId: "TASK-ORIGIN", providerId: "fake", modelId: "fake-v1", transport: "workflow" },
        { taskId: "TASK-NODE", providerId: "fake", modelId: "fake-v1", transport: "workflow" },
      ],
    },
    route: {
      taskId: semanticTaskId,
      providerId: "fake",
      modelId: "fake-v1",
      transport: "workflow",
    },
    campaignStartedAt: "2026-07-25T11:59:00.000Z",
    campaignDeadlineAt: "2026-07-25T12:01:00.000Z",
    requestCount: 0,
    activeActionLeases: {},
  } as CccCampaignTaskContext;
}

function proofFence() {
  return {
    workItemId: "WORK-1",
    leaseOwner: "worker-1",
    attempt: 2,
    runId: "run-1",
    eventTimestamp: "2026-07-25T12:00:00.000Z",
  } as const;
}

function admissionHarness(
  fixture: Awaited<ReturnType<typeof proofFixture>>,
  proofIds: string[] = [fixture.proof.id],
  signal = new AbortController().signal,
  fence = proofFence(),
) {
  const origin = campaignContext(
    "TASK-ORIGIN",
    "TASK-ORIGIN",
    [fixture.proof.id],
    fixture.proof,
  );
  const nodeContext = campaignContext(
    "TASK-NODE",
    "TASK-NODE",
    proofIds,
    fixture.proof,
  );
  const recordFencedAudit = vi.fn(async (input: FencedAuditInput) => input.event);
  const store = {
    getCccCampaignContextForTask: vi.fn(async (taskId: string) => {
      if (taskId === origin.taskId) return origin;
      if (taskId === nodeContext.taskId) return nodeContext;
      return null;
    }),
    recordFencedCccCampaignProofAudit: recordFencedAudit,
  };
  return {
    node: {
      id: "node-1",
      kind: "prompt",
      config: { cccPrdTaskId: nodeContext.semanticTaskId },
    } as const,
    signal,
    recordFencedAudit,
    admit: createCccCampaignProofNodeAdmission({
      store,
      originTaskId: origin.taskId,
      fence,
      registry: fixture.registry,
    }),
  };
}
