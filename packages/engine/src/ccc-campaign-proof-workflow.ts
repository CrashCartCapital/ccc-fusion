import type {
  CccCampaignTaskContext,
  CccPrdProof,
  RunAuditEventInput,
  TaskDetail,
  WorkflowExtensionRegistry,
  WorkflowProofAdmissionEvaluator,
  WorkflowProofAdmissionEvaluatorResult,
  WorkflowIrNode,
} from "@fusion/core";
import {
  CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  canonicalCccPrdJson,
  compareCccPrdCodeUnits,
  computeCccPrdProofDefinitionSha256,
  createCccCampaignAuthorityBinding,
  getWorkflowExtensionRegistry,
} from "@fusion/core";
import {
  CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION,
  CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
  CCC_CAMPAIGN_PROOF_ADMISSION_REGISTRY_ID,
  CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK,
  createCccCampaignProofAdmissionEvaluatorInput,
} from "./ccc-campaign-proof-admission.js";
import { PermanentError } from "./engine-errors.js";
import type {
  WorkflowMaterializedVisitIdentity,
  WorkflowNodeSealedExecution,
} from "./workflow-graph-executor.js";

export type CccCampaignProofWorkflowStore = {
  getCccCampaignContextForTask(
    taskId: string,
  ): CccCampaignTaskContext | null | Promise<CccCampaignTaskContext | null>;
  recordFencedCccCampaignProofAudit(input: {
    workItemId: string;
    originTaskId: string;
    leaseOwner: string;
    attempt: number;
    runId: string;
    event: RunAuditEventInput;
  }): unknown | Promise<unknown>;
};

export type CccCampaignProofWorkItemFence = Readonly<{
  workItemId: string;
  leaseOwner: string;
  attempt: number;
  runId: string;
  eventTimestamp: string;
}>;

export type CreateCccCampaignProofNodeAdmissionInput = Readonly<{
  store: CccCampaignProofWorkflowStore;
  originTaskId: string;
  fence: CccCampaignProofWorkItemFence;
  registry?: WorkflowExtensionRegistry;
  requireExecutionBinding?: true;
}>;

export type CccCampaignProofAdmissionExecutionBinding = Readonly<{
  semanticTask: TaskDetail;
  visitIdentity: WorkflowMaterializedVisitIdentity;
  execution: WorkflowNodeSealedExecution;
}>;

export type CccCampaignProofNodeAdmission = (
  node: WorkflowIrNode,
  signal?: AbortSignal,
  binding?: CccCampaignProofAdmissionExecutionBinding,
) => Promise<void>;

export function createCccCampaignProofNodeAdmission(
  input: CreateCccCampaignProofNodeAdmissionInput,
): CccCampaignProofNodeAdmission {
  const fence = requireWorkItemFence(input.fence);
  const originTaskId = requireCanonicalText(input.originTaskId, "origin task id");
  const registry = input.registry ?? getWorkflowExtensionRegistry();
  const requireExecutionBinding = input.requireExecutionBinding === true;

  return async (node, signal, binding) => {
    if (isOrchestrationOnlyNode(node)) return;
    if (requireExecutionBinding) {
      requireExactExecutionBinding(binding, node, originTaskId, fence);
    }
    const liveSignal = requireLiveSignal(signal);
    const semanticTaskId = requireNodeSemanticTaskId(node);
    const [originContext, nodeContext] = await Promise.all([
      input.store.getCccCampaignContextForTask(originTaskId),
      input.store.getCccCampaignContextForTask(semanticTaskId),
    ]);
    const origin = requireCampaignContext(originContext, originTaskId);
    const context = requireCampaignContext(nodeContext, semanticTaskId);
    assertCampaignCustody(origin, context);
    if (context.taskId !== semanticTaskId || context.semanticTaskId !== semanticTaskId) {
      refuse(`CCC proof node ${node.id} task identity does not match persisted custody`);
    }

    const proofs = requireTaskProofs(context);
    for (const proof of proofs) {
      liveSignal.throwIfAborted();
      await admitProof({
        store: input.store,
        registry,
        originTaskId: origin.taskId,
        context,
        node,
        proof,
        fence,
        signal: liveSignal,
      });
    }
  };
}

function requireExactExecutionBinding(
  binding: CccCampaignProofAdmissionExecutionBinding | undefined,
  node: WorkflowIrNode,
  originTaskId: string,
  fence: CccCampaignProofWorkItemFence,
): void {
  if (!binding || typeof binding !== "object") {
    refuse("CCC proof admission requires a sealed execution binding");
  }
  const execution = binding.execution;
  if (!execution || !Object.isFrozen(execution)) {
    refuse("CCC proof admission execution binding is not frozen");
  }
  const visitIdentity = binding.visitIdentity;
  if (!visitIdentity || !Object.isFrozen(visitIdentity)) {
    refuse("CCC proof admission visit identity is not frozen");
  }
  const nodeSemanticTaskId = requireNodeSemanticTaskId(node);
  if (
    execution.originTaskId !== originTaskId
    || execution.semanticTaskId !== nodeSemanticTaskId
    || binding.semanticTask !== execution.semanticTask
    || binding.semanticTask.id !== execution.semanticTaskId
    || execution.semanticTask.id !== execution.semanticTaskId
    || execution.runId !== fence.runId
    || binding.visitIdentity !== execution.visitIdentity
    || execution.visitIdentity.nodeId !== node.id
    || requireCanonicalText(execution.visitIdentity.materializedNodeId, "materialized node id")
      !== execution.visitIdentity.materializedNodeId
  ) {
    refuse("CCC proof admission execution binding does not match the sealed node visit");
  }
}

type AdmitProofInput = Readonly<{
  store: CccCampaignProofWorkflowStore;
  registry: WorkflowExtensionRegistry;
  originTaskId: string;
  context: CccCampaignTaskContext;
  node: WorkflowIrNode;
  proof: CccPrdProof;
  fence: CccCampaignProofWorkItemFence;
  signal: AbortSignal;
}>;

const ORCHESTRATION_ONLY_NODE_KINDS = new Set<WorkflowIrNode["kind"]>([
  "start",
  "end",
  "split",
  "join",
  "foreach",
  "loop",
  "optional-group",
]);

function isOrchestrationOnlyNode(node: WorkflowIrNode): boolean {
  return ORCHESTRATION_ONLY_NODE_KINDS.has(node.kind);
}

function refuse(message: string): never {
  throw new PermanentError(message, "CCC_PROOF_ADMISSION_REFUSED");
}

function requireCanonicalText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    refuse(`CCC proof ${label} must be a non-empty canonical string`);
  }
  return value;
}

function requireWorkItemFence(
  fence: CccCampaignProofWorkItemFence,
): CccCampaignProofWorkItemFence {
  if (!fence || typeof fence !== "object") {
    refuse("CCC proof work-item fence is missing");
  }
  const attempt = fence.attempt;
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    refuse("CCC proof work-item attempt must be a positive safe integer");
  }
  const eventTimestamp = requireCanonicalText(fence.eventTimestamp, "event timestamp");
  if (
    !Number.isFinite(Date.parse(eventTimestamp))
    || new Date(eventTimestamp).toISOString() !== eventTimestamp
  ) {
    refuse("CCC proof event timestamp must be canonical ISO-8601");
  }
  return Object.freeze({
    workItemId: requireCanonicalText(fence.workItemId, "work-item id"),
    leaseOwner: requireCanonicalText(fence.leaseOwner, "lease owner"),
    attempt,
    runId: requireCanonicalText(fence.runId, "run id"),
    eventTimestamp,
  });
}

function requireLiveSignal(signal: AbortSignal | undefined): AbortSignal {
  if (!signal) refuse("CCC proof admission requires a live cancellation signal");
  signal.throwIfAborted();
  return signal;
}

function requireNodeSemanticTaskId(node: WorkflowIrNode): string {
  return requireCanonicalText(node.config?.cccPrdTaskId, `node ${node.id} cccPrdTaskId`);
}

function requireCampaignContext(
  value: CccCampaignTaskContext | null,
  taskId: string,
): CccCampaignTaskContext {
  if (!value) refuse(`CCC proof task ${taskId} has no campaign custody`);
  return value;
}

function assertCampaignCustody(
  origin: CccCampaignTaskContext,
  node: CccCampaignTaskContext,
): void {
  const scalarFields = [
    "projectId",
    "importId",
    "idempotencyKey",
    "campaignId",
    "packetHash",
    "sidecarHash",
    "bundleHash",
    "manifestHash",
    "sourceVersion",
  ] as const;
  for (const field of scalarFields) {
    if (origin[field] !== node[field]) {
      refuse(`CCC proof node campaign custody differs at ${field}`);
    }
  }
  if (
    canonicalCccPrdJson(origin.targetRepository)
      !== canonicalCccPrdJson(node.targetRepository)
    || canonicalCccPrdJson(origin.bounds) !== canonicalCccPrdJson(node.bounds)
    || canonicalCccPrdJson(origin.executionPolicy)
      !== canonicalCccPrdJson(node.executionPolicy)
  ) {
    refuse("CCC proof node campaign custody differs from the origin task");
  }
}

function requireTaskProofs(context: CccCampaignTaskContext): CccPrdProof[] {
  if (!Array.isArray(context.proofIds) || context.proofIds.length === 0) {
    refuse(`CCC proof task ${context.semanticTaskId} declares no proof ids`);
  }
  const proofIds = context.proofIds.map((proofId) =>
    requireCanonicalText(proofId, `task ${context.semanticTaskId} proof id`));
  if (new Set(proofIds).size !== proofIds.length) {
    refuse(`CCC proof task ${context.semanticTaskId} declares duplicate proof ids`);
  }
  if (!Array.isArray(context.proofs)) {
    refuse(`CCC proof task ${context.semanticTaskId} has no campaign proof catalog`);
  }
  return proofIds.map((proofId) => {
    const matches = context.proofs.filter((proof) => proof?.id === proofId);
    if (matches.length !== 1) {
      refuse(`CCC proof ${proofId} does not have one exact campaign definition`);
    }
    return matches[0]!;
  });
}

async function admitProof(input: AdmitProofInput): Promise<void> {
  const definitionSha256 = computeCccPrdProofDefinitionSha256(input.proof);
  const evaluatorInput = createCccCampaignProofAdmissionEvaluatorInput({
    campaignId: input.context.campaignId,
    importId: input.context.importId,
    bundleHash: input.context.bundleHash,
    manifestHash: input.context.manifestHash,
    taskId: input.context.taskId,
    nodeId: input.node.id,
    workItemId: input.fence.workItemId,
    owner: input.fence.leaseOwner,
    attempt: input.fence.attempt,
    proofDefinitionSha256: definitionSha256,
    proof: input.proof,
    signal: input.signal,
  });
  let result: WorkflowProofAdmissionEvaluatorResult;
  try {
    const evaluator = await requireProofEvaluator(
      input.registry,
      input.proof,
      definitionSha256,
    );
    input.signal.throwIfAborted();
    result = await evaluator(evaluatorInput);
    input.signal.throwIfAborted();
  } catch (error) {
    const summary = proofRefusalSummary(error, input.signal);
    await recordProofAdmission(input, definitionSha256, evaluatorInput.inputSha256, {
      outcome: "fail",
      evaluatedInputSha256: evaluatorInput.inputSha256,
      summary,
    });
    refuse(summary);
  }

  const resultRefusal = validateEvaluatorResult(result, evaluatorInput.inputSha256);
  if (resultRefusal) {
    const summary = resultRefusal;
    await recordProofAdmission(input, definitionSha256, evaluatorInput.inputSha256, {
      outcome: "fail",
      evaluatedInputSha256: evaluatorInput.inputSha256,
      summary,
    });
    refuse(summary);
  }
  if (isNativeConformanceSelfCheck(input.proof)) {
    const summary = "CCC proof binding self-check is non-authorizing for campaign task execution";
    await recordProofAdmission(input, definitionSha256, evaluatorInput.inputSha256, {
      outcome: "fail",
      evaluatedInputSha256: evaluatorInput.inputSha256,
      summary,
    });
    refuse(summary);
  }
  await recordProofAdmission(input, definitionSha256, evaluatorInput.inputSha256, result);
}

function isNativeConformanceSelfCheck(proof: CccPrdProof): boolean {
  return proof.command === CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK.command
    && proof.positiveOracle === CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK.positiveOracle
    && Array.isArray(proof.negativeControls)
    && proof.negativeControls.length === CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK.negativeControls.length
    && proof.negativeControls.every(
      (control, index) => control === CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK.negativeControls[index],
    );
}

async function requireProofEvaluator(
  registry: WorkflowExtensionRegistry,
  proof: CccPrdProof,
  definitionSha256: string,
): Promise<WorkflowProofAdmissionEvaluator> {
  const admission = proof.admission;
  if (
    !admission
    || admission.schema !== CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION
    || admission.pluginId !== CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID
    || admission.pluginVersion !== CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION
    || admission.extensionId !== CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID
    || admission.proofVersion !== CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION
    || admission.definitionSha256 !== definitionSha256
  ) {
    refuse(`CCC proof ${proof.id} admission identity or definition is stale`);
  }

  const registered = registry.get(CCC_CAMPAIGN_PROOF_ADMISSION_REGISTRY_ID);
  if (
    !registered
    || registered.id !== CCC_CAMPAIGN_PROOF_ADMISSION_REGISTRY_ID
    || registered.pluginId !== CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID
    || registered.degraded
    || registered.extension.kind !== "proof-admission"
    || registered.extension.extensionId !== CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID
    || registered.extension.schemaVersion !== WORKFLOW_EXTENSION_SCHEMA_VERSION
    || registered.extension.fallback !== "failClosed"
    || registered.extension.proofVersion !== CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION
    || typeof registered.extension.evaluate !== "function"
  ) {
    refuse(`CCC proof ${proof.id} native admission extension is missing or degraded`);
  }

  const provenance = await registry.reverifyHostProvenance(
    CCC_CAMPAIGN_PROOF_ADMISSION_REGISTRY_ID,
  );
  const current = registry.get(CCC_CAMPAIGN_PROOF_ADMISSION_REGISTRY_ID);
  if (!current || current.degraded || current.extension.kind !== "proof-admission") {
    refuse(`CCC proof ${proof.id} native admission extension degraded during re-verification`);
  }
  if (
    provenance.pluginId !== admission.pluginId
    || provenance.pluginVersion !== admission.pluginVersion
    || provenance.extensionRootRelativeSource !== admission.extensionRootRelativeSource
    || provenance.extensionSourceSha256 !== admission.extensionSourceSha256
    || provenance.extensionManifestSha256 !== admission.extensionManifestSha256
  ) {
    refuse(`CCC proof ${proof.id} admission provenance does not match its sealed host`);
  }
  return current.extension.evaluate;
}

function validateEvaluatorResult(
  value: WorkflowProofAdmissionEvaluatorResult,
  inputSha256: string,
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "CCC proof evaluator returned an invalid result";
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return "CCC proof evaluator returned a non-plain result";
  }
  const keys = Object.keys(value).sort(compareCccPrdCodeUnits);
  if (
    canonicalCccPrdJson(keys)
      !== canonicalCccPrdJson(["evaluatedInputSha256", "outcome", "summary"])
  ) {
    return "CCC proof evaluator returned incomplete or extra fields";
  }
  if (value.evaluatedInputSha256 !== inputSha256) {
    return "CCC proof evaluator did not echo the exact admitted input";
  }
  if (
    typeof value.summary !== "string"
    || value.summary.length === 0
    || value.summary !== value.summary.trim()
  ) {
    return "CCC proof evaluator returned a non-canonical summary";
  }
  if (value.outcome !== "pass") {
    return value.summary;
  }
  return undefined;
}

function proofRefusalSummary(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return "CCC proof evaluator was aborted";
  if (error instanceof PermanentError) return error.message;
  return "CCC proof evaluator or host provenance refused admission";
}

async function recordProofAdmission(
  input: AdmitProofInput,
  definitionSha256: string,
  inputSha256: string,
  result: WorkflowProofAdmissionEvaluatorResult,
): Promise<void> {
  const binding = createCccCampaignAuthorityBinding(input.context, {
    actionId: `proof:${input.proof.id}`,
    actionTarget: inputSha256,
  });
  const event: RunAuditEventInput = {
    timestamp: input.fence.eventTimestamp,
    taskId: input.context.taskId,
    agentId: input.fence.leaseOwner,
    runId: input.fence.runId,
    domain: "database",
    mutationType: "ccc-campaign:proof-admission",
    target: inputSha256,
    metadata: {
      proofId: input.proof.id,
      nodeId: input.node.id,
      workItemId: input.fence.workItemId,
      owner: input.fence.leaseOwner,
      attempt: input.fence.attempt,
      definitionSha256,
      inputSha256,
      outcome: result.outcome,
      summary: result.summary,
    },
    campaign: {
      eventKey: [
        "ccc-proof-admission.v1",
        binding.bindingHash,
        input.node.id,
        input.fence.workItemId,
        String(input.fence.attempt),
      ].join(":"),
      binding,
    },
  };
  await input.store.recordFencedCccCampaignProofAudit({
    workItemId: input.fence.workItemId,
    originTaskId: input.originTaskId,
    leaseOwner: input.fence.leaseOwner,
    attempt: input.fence.attempt,
    runId: input.fence.runId,
    event,
  });
}
