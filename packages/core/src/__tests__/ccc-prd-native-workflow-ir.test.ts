import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createCccPrdImportTestBundle,
  createCccPrdImportTestProductExecutionPolicy,
} from "../__test-utils__/ccc-prd-import-fixture.js";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import { nativeWorkflowIr } from "../ccc-prd/importer.js";
import type {
  CccPrdProofPhase,
  CccPrdProofV2,
  CccPrdSemanticBundleV2,
  CccPrdSourceSpan,
} from "../ccc-prd/types.js";

const SHA256 = "a".repeat(64);
const GIT_OID = "b".repeat(40);

function span(): CccPrdSourceSpan & { excerptSha256: string } {
  return {
    path: "packet.md",
    byteStart: 0,
    byteEnd: 1,
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 2,
    sha256: SHA256,
    excerptSha256: SHA256,
  };
}

function proof(
  ordinal: number,
  phases: CccPrdProofPhase[] = ["task", "final_integrated"],
): CccPrdProofV2 {
  const id = `PROOF-S5-${ordinal}`;
  const requirementId = `REQ-S5-${ordinal}`;
  return {
    schema: "ccc-prd.proof.v2",
    id,
    requirementIds: [requirementId],
    clauseIds: [`AC-${requirementId}-1`],
    phases,
    command: `task verify:s5-${ordinal}`,
    positiveOracle: `task ${ordinal} passes`,
    positiveCases: [{ id: `CASE-S5-${ordinal}`, description: "The admitted candidate passes." }],
    negativeControls: [{ id: `CONTROL-S5-${ordinal}`, description: "The known-bad candidate fails." }],
    verifierClosure: [{
      role: "task_runner",
      path: `Taskfile.s5-${ordinal}.yml`,
      baseGitBlobOid: GIT_OID,
      sha256: SHA256,
    }],
    candidateInputs: [`src/task-${ordinal}.ts`],
    executionToolchain: {
      task: {
        executablePath: "/usr/local/bin/task",
        executableSha256: SHA256,
        version: "v3.44.1",
        versionOutputSha256: SHA256,
      },
      node: {
        executablePath: "/usr/local/bin/node",
        executableSha256: SHA256,
        version: "v24.0.0",
        versionOutputSha256: SHA256,
      },
      proofHost: {
        id: "ccc-proof-host",
        executablePath: "/usr/local/bin/ccc-proof-host",
        executableSha256: SHA256,
        version: "v2",
        versionOutputSha256: SHA256,
      },
      linkedRuntime: [],
    },
    spans: [span()],
    confidence: "high",
  };
}

function semanticV2Bundle(
  taskDependencies: readonly (readonly number[])[],
): CccPrdSemanticBundleV2 {
  const seed = createCccPrdImportTestBundle("/tmp/red-s5-task-gate-release", "s5-v2");
  const workflowId = "WF-S5";
  const taskIds = taskDependencies.map((_dependencies, index) => `TASK-S5-${index + 1}`);
  const proofs = taskIds.map((_taskId, index) => proof(index + 1));
  const requirements = taskIds.map((_taskId, index) => {
    const ordinal = index + 1;
    const requirementId = `REQ-S5-${ordinal}`;
    const proofId = `PROOF-S5-${ordinal}`;
    return {
      id: requirementId,
      statement: `Implement task ${ordinal}.`,
      acceptance: `Task ${ordinal} is proven.`,
      accountableProducer: `owner-${ordinal}`,
      dependencies: [],
      proofIds: [proofId],
      spans: [span()],
      confidence: "high" as const,
      acceptanceClauses: [{
        id: `AC-${requirementId}-1`,
        requirementId,
        text: `Task ${ordinal} passes its admitted proof.`,
        proofIds: [proofId],
        span: span(),
      }],
      acceptanceDispositions: [],
    };
  });
  const tasks = taskIds.map((id, index) => ({
    id,
    title: `Task ${index + 1}`,
    description: `Implement task ${index + 1}.`,
    accountableProducer: `owner-${index + 1}`,
    requirementIds: [`REQ-S5-${index + 1}`],
    dependencyTaskIds: taskDependencies[index]!.map((dependency) => taskIds[dependency - 1]!),
    proofIds: [`PROOF-S5-${index + 1}`],
    workflowId,
    documentIds: [],
    artifactIds: [],
    protectedActionIds: [],
    ownedPaths: [`src/task-${index + 1}.ts`],
    allowedWriteRoots: [`src/task-${index + 1}.ts`],
    spans: [span()],
  }));
  const edges = tasks.flatMap((task, index) => taskDependencies[index]!.map((dependency) => ({
    id: `EDGE-S5-${index + 1}-${dependency}`,
    fromTaskId: task.id,
    toTaskId: taskIds[dependency - 1]!,
    kind: "depends_on" as const,
  })));
  const dependedUpon = new Set(edges.map(({ toTaskId }) => toTaskId));

  return {
    ...seed,
    schema: "ccc-prd.bundle.v2",
    bundleHash: "d".repeat(64),
    requirements,
    proofs,
    tasks,
    edges,
    workflows: [{
      id: workflowId,
      title: "S5 task-gated workflow",
      taskIds,
      entryTaskIds: tasks.filter(({ dependencyTaskIds }) => dependencyTaskIds.length === 0).map(({ id }) => id),
      terminalTaskIds: taskIds.filter((id) => !dependedUpon.has(id)),
      spans: [span()],
    }],
    documents: [],
    artifacts: [],
    bounds: { ...seed.bounds, maxRequests: taskIds.length },
  };
}

function buildIr(bundle: CccPrdSemanticBundleV2) {
  const nativeTaskIds = new Map(
    bundle.tasks.map((task, index) => [task.id, `FN-${9500 + index}`]),
  );
  return nativeWorkflowIr(
    bundle,
    bundle.workflows[0]!,
    createCccPrdImportTestProductExecutionPolicy(bundle),
    nativeTaskIds,
  );
}

function nodeForTask(bundle: CccPrdSemanticBundleV2, taskId: string) {
  const ir = buildIr(bundle);
  return ir.nodes.find((node) => node.kind === "prompt" && node.config?.cccPrdTaskId === taskId);
}

function taskGateFor(ir: ReturnType<typeof buildIr>, taskId: string) {
  return ir.nodes.find((node) => node.kind === "gate"
    && node.config?.cccProofGate === true
    && node.config.cccPrdTaskId === taskId);
}

describe("RED-S5-task-gate-release", () => {
  it("inserts exactly one task-phase proof gate after every task and reroutes split, join, dependency, and final release edges", () => {
    const bundle = semanticV2Bundle([[], [1], [1], [2, 3]]);
    const ir = buildIr(bundle);
    const [taskA, taskB, taskC, taskD] = bundle.tasks;
    const split = ir.nodes.find((node) => node.kind === "split" && node.config?.cccPrdTaskId === taskA!.id);
    const join = ir.nodes.find((node) => node.kind === "join" && node.config?.cccPrdTaskId === taskD!.id);
    const finalSuite = ir.nodes.find((node) => node.kind === "gate" && node.config?.cccProofSuite === true);

    expect(ir.nodes.filter((node) => node.config?.cccProofGate === true)).toHaveLength(bundle.tasks.length);
    expect(finalSuite).toMatchObject({
      config: {
        cccProofSuite: true,
        cccProofPhase: "final_integrated",
        cccProofIds: bundle.proofs.map(({ id }) => id),
      },
    });

    for (const [index, task] of bundle.tasks.entries()) {
      const taskNode = nodeForTask(bundle, task.id)!;
      const gate = taskGateFor(ir, task.id);
      expect(gate).toMatchObject({
        kind: "gate",
        config: {
          cccProofGate: true,
          cccProofPhase: "task",
          cccProofIds: [`PROOF-S5-${index + 1}`],
          cccPrdTaskId: task.id,
          cccNativeTaskId: `FN-${9500 + index}`,
          gateMode: "gate",
          toolMode: "readonly",
        },
      });
      expect(ir.edges.filter(({ from }) => from === taskNode.id)).toEqual([{
        from: taskNode.id,
        to: gate!.id,
        condition: "success",
      }]);
    }

    const gateA = taskGateFor(ir, taskA!.id)!;
    const gateB = taskGateFor(ir, taskB!.id)!;
    const gateC = taskGateFor(ir, taskC!.id)!;
    const gateD = taskGateFor(ir, taskD!.id)!;
    expect(ir.edges).toContainEqual({ from: gateA.id, to: split!.id, condition: "success" });
    expect(ir.edges).toContainEqual({ from: split!.id, to: nodeForTask(bundle, taskB!.id)!.id, condition: "success" });
    expect(ir.edges).toContainEqual({ from: split!.id, to: nodeForTask(bundle, taskC!.id)!.id, condition: "success" });
    expect(ir.edges).toContainEqual({ from: gateB.id, to: join!.id, condition: "success" });
    expect(ir.edges).toContainEqual({ from: gateC.id, to: join!.id, condition: "success" });
    expect(ir.edges).toContainEqual({ from: join!.id, to: nodeForTask(bundle, taskD!.id)!.id, condition: "success" });
    expect(ir.edges).toContainEqual({ from: gateD.id, to: finalSuite!.id, condition: "success" });
  });

  it("keeps one-task task and final attempts as distinct nodes even when they execute the same proof", () => {
    const bundle = semanticV2Bundle([[]]);
    const ir = buildIr(bundle);
    const taskGate = taskGateFor(ir, bundle.tasks[0]!.id)!;
    const finalSuite = ir.nodes.find((node) => node.config?.cccProofSuite === true)!;

    expect(taskGate.id).not.toBe(finalSuite.id);
    expect(taskGate.config).toMatchObject({
      cccProofPhase: "task",
      cccProofIds: [bundle.proofs[0]!.id],
    });
    expect(finalSuite.config).toMatchObject({
      cccProofPhase: "final_integrated",
      cccProofIds: [bundle.proofs[0]!.id],
    });
  });

  it("keeps cross-task proofs final-only and out of every task gate", () => {
    const bundle = semanticV2Bundle([[], [1]]);
    const crossTaskProof: CccPrdProofV2 = {
      ...proof(99, ["final_integrated"]),
      id: "PROOF-S5-CROSS-TASK",
      requirementIds: bundle.requirements.map(({ id }) => id),
      clauseIds: bundle.requirements.flatMap(({ acceptanceClauses }) => acceptanceClauses.map(({ id }) => id)),
    };
    bundle.proofs.push(crossTaskProof);
    for (const task of bundle.tasks) task.proofIds.push(crossTaskProof.id);
    for (const requirement of bundle.requirements) {
      requirement.proofIds.push(crossTaskProof.id);
      for (const clause of requirement.acceptanceClauses) clause.proofIds.push(crossTaskProof.id);
    }

    const ir = buildIr(bundle);
    const finalSuite = ir.nodes.find((node) => node.config?.cccProofSuite === true)!;
    expect(finalSuite.config?.cccProofIds).toContain(crossTaskProof.id);
    for (const task of bundle.tasks) {
      expect(taskGateFor(ir, task.id)?.config?.cccProofIds).not.toContain(crossTaskProof.id);
    }
  });

  it("refuses a task-phase proof linked by more than one semantic task", () => {
    const bundle = semanticV2Bundle([[], [1]]);
    bundle.tasks[1]!.proofIds.push(bundle.proofs[0]!.id);

    expect(() => buildIr(bundle)).toThrow(/task-phase proof PROOF-S5-1 must have exactly one semantic task owner/);
  });

  it("refuses a semantic task without an admitted task-phase proof", () => {
    const bundle = semanticV2Bundle([[]]);
    bundle.proofs[0]!.phases = ["final_integrated"];

    expect(() => buildIr(bundle)).toThrow(/semantic task TASK-S5-1 requires at least one task-phase proof/);
  });

  it("refuses a product workflow that would leave a semantic task without an exact gate", () => {
    const bundle = semanticV2Bundle([[], [1]]);
    const retainedTaskId = bundle.tasks[0]!.id;
    bundle.workflows[0]!.taskIds = [retainedTaskId];
    bundle.workflows[0]!.entryTaskIds = [retainedTaskId];
    bundle.workflows[0]!.terminalTaskIds = [retainedTaskId];

    expect(() => buildIr(bundle)).toThrow(/workflow WF-S5 must gate every semantic task exactly once/);
  });

  it("refuses task-phase proof coverage outside the owning task requirements", () => {
    const bundle = semanticV2Bundle([[], [1]]);
    bundle.proofs[0]!.requirementIds = [bundle.requirements[1]!.id];
    bundle.proofs[0]!.clauseIds = [bundle.requirements[1]!.acceptanceClauses[0]!.id];

    expect(() => buildIr(bundle)).toThrow(/task-phase proof PROOF-S5-1 covers requirement REQ-S5-2 outside semantic task TASK-S5-1/);
  });

  it("refuses an accepted clause without final-integrated proof coverage", () => {
    const bundle = semanticV2Bundle([[]]);
    bundle.proofs[0]!.phases = ["task"];

    expect(() => buildIr(bundle)).toThrow(/accepted clause AC-REQ-S5-1-1 has no final_integrated proof coverage/);
  });

  it("preserves the frozen v1 product graph bytes and emits no task-phase gates", () => {
    const bundle = createCccPrdImportTestBundle("/tmp/s5-v1", "s5-v1");
    const nativeTaskIds = new Map(bundle.tasks.map((task, index) => [task.id, `FN-${9000 + index}`]));
    const ir = nativeWorkflowIr(
      bundle,
      bundle.workflows[0]!,
      createCccPrdImportTestProductExecutionPolicy(bundle),
      nativeTaskIds,
    );
    const digest = createHash("sha256").update(canonicalCccPrdJson(ir)).digest("hex");

    expect(digest).toBe("38572f08bd3c4d11246998cbbd3c88c7af490454225fdcc5bd4110ee8ed7b427");
    expect(ir.nodes.some((node) => node.config?.cccProofGate === true)).toBe(false);
    expect(ir.nodes.some((node) => node.config?.cccProofPhase !== undefined)).toBe(false);
  });
});
