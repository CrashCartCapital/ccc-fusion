import { createHash } from "node:crypto";
import { canonicalCccPrdJson } from "../ccc-prd/contract.js";
import type { CccPrdSemanticBundle } from "../ccc-prd/types.js";

export const CCC_PRD_TEST_SOURCE_HASH = "a".repeat(64);
export const CCC_PRD_TEST_BASE = "b".repeat(40);

function span(path = "packet.md") {
  return {
    path,
    byteStart: 0,
    byteEnd: 1,
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 2,
    sha256: CCC_PRD_TEST_SOURCE_HASH,
    excerptSha256: CCC_PRD_TEST_SOURCE_HASH,
  };
}

export function hashCccPrdImportTestBundle(
  bundleWithoutHash: Omit<CccPrdSemanticBundle, "bundleHash">,
): CccPrdSemanticBundle {
  return {
    ...bundleWithoutHash,
    bundleHash: createHash("sha256")
      .update(canonicalCccPrdJson(bundleWithoutHash), "utf8")
      .digest("hex"),
  };
}

export function rehashCccPrdImportTestBundle(
  bundleWithOldHash: CccPrdSemanticBundle,
): CccPrdSemanticBundle {
  const { bundleHash: _oldBundleHash, ...bundleWithoutHash } = bundleWithOldHash;
  return hashCccPrdImportTestBundle(bundleWithoutHash);
}

export function createCccPrdImportTestBundle(
  targetRoot: string,
  suffix = "base",
): CccPrdSemanticBundle {
  const requirementId = `REQ-${suffix}`;
  const taskId = `TASK-${suffix}`;
  const terminalTaskId = `TASK-terminal-${suffix}`;
  const proofId = `PROOF-${suffix}`;
  const workflowId = `WF-${suffix}`;
  const documentId = `DOC-${suffix}`;
  const artifactId = `ART-${suffix}`;
  const sourceId = `SOURCE-${suffix}`;
  const edgeId = `EDGE-${suffix}`;
  const campaignId = `CAMPAIGN-${suffix}`;
  const auditId = `AUDIT-${suffix}`;
  const workItemId = `WORK-${suffix}`;
  return hashCccPrdImportTestBundle({
    kind: "bundle",
    schema: "ccc-prd.bundle.v1",
    sourceVersion: "phase-c-test",
    sourceHash: CCC_PRD_TEST_SOURCE_HASH,
    sidecarHash: "c".repeat(64),
    orderedSources: [{
      path: "packet.md",
      role: "root",
      authoritative: true,
      sha256: CCC_PRD_TEST_SOURCE_HASH,
      byteLength: 1,
    }],
    provenance: {
      authoringAdapterId: "phase-c-test",
      proposalHash: "e".repeat(64),
      packetHash: CCC_PRD_TEST_SOURCE_HASH,
    },
    authorityRoles: [{
      id: "AUTH-root",
      role: "root",
      sourcePaths: ["packet.md"],
      accountableProducer: "phase-c-test",
    }],
    requirements: [{
      id: requirementId,
      statement: "Import atomically.",
      acceptance: "No runnable partial state.",
      accountableProducer: "phase-c-test",
      dependencies: [],
      proofIds: [proofId],
      spans: [span()],
      confidence: "high",
    }],
    proofs: [{
      id: proofId,
      requirementIds: [requirementId],
      command: "pnpm test",
      positiveOracle: "import active",
      negativeControls: ["rollback"],
      spans: [span()],
      confidence: "high",
    }],
    tasks: [
      {
        id: taskId,
        title: "Import-owned task",
        description: "A task projected only after commit.",
        accountableProducer: "phase-c-test",
        requirementIds: [requirementId],
        dependencyTaskIds: [],
        proofIds: [proofId],
        workflowId,
        documentIds: [documentId],
        artifactIds: [artifactId],
        protectedActionIds: [],
        spans: [span()],
      },
      {
        id: terminalTaskId,
        title: "Terminal import-owned task",
        description: "Dependent terminal task.",
        accountableProducer: "phase-c-test",
        requirementIds: [requirementId],
        dependencyTaskIds: [taskId],
        proofIds: [proofId],
        workflowId,
        documentIds: [],
        artifactIds: [],
        protectedActionIds: [],
        spans: [span()],
      },
    ],
    edges: [{
      id: edgeId,
      fromTaskId: terminalTaskId,
      toTaskId: taskId,
      kind: "depends_on",
    }],
    workflows: [{
      id: workflowId,
      title: "Import workflow",
      taskIds: [taskId, terminalTaskId],
      entryTaskIds: [taskId],
      terminalTaskIds: [terminalTaskId],
      spans: [span()],
    }],
    documents: [{
      id: documentId,
      taskId,
      key: "PROMPT.md",
      title: "Prompt",
      content: "import-owned prompt",
      spans: [span()],
    }],
    artifacts: [{
      id: artifactId,
      taskId,
      type: "text",
      title: "Import evidence",
      mimeType: "text/plain",
      content: "artifact bytes",
      spans: [span()],
    }],
    importIntents: [
      { id: campaignId, entityType: "campaign", entityId: campaignId, operation: "create", target: targetRoot },
      { id: taskId, entityType: "task", entityId: taskId, operation: "create", target: targetRoot },
      { id: terminalTaskId, entityType: "task", entityId: terminalTaskId, operation: "create", target: targetRoot },
      { id: edgeId, entityType: "dependency_edge", entityId: edgeId, operation: "create", target: targetRoot },
      { id: workflowId, entityType: "workflow", entityId: workflowId, operation: "create", target: targetRoot },
      { id: documentId, entityType: "document", entityId: documentId, operation: "create", target: targetRoot },
      { id: artifactId, entityType: "artifact", entityId: artifactId, operation: "create", target: targetRoot },
      { id: sourceId, entityType: "source", entityId: sourceId, operation: "create", target: targetRoot },
      { id: workItemId, entityType: "work_item", entityId: workItemId, operation: "create", target: targetRoot },
      { id: auditId, entityType: "run_audit", entityId: auditId, operation: "create", target: targetRoot },
    ],
    protectedActions: [],
    bounds: { maxRequests: 1, maxDurationMs: 1_000, maxConcurrency: 1 },
    admittedWriteRoots: [{ path: targetRoot, purpose: "disposable test target" }],
    targetRepository: { path: targetRoot, baseCommit: CCC_PRD_TEST_BASE },
    nonGoals: ["No live providers."],
    confidence: "high",
  });
}
