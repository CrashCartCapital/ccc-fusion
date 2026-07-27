import { createHash } from "node:crypto";
import type {
  CccPrdProof,
  WorkflowProofAdmissionEvaluatorInput,
  WorkflowProofAdmissionEvaluatorResult,
  WorkflowProofAdmissionExtensionContribution,
} from "@fusion/core";

const CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION = "ccc-prd.proof-admission.v1" as const;
const WORKFLOW_EXTENSION_SCHEMA_VERSION = 1 as const;

export const CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID = "fusion-native" as const;
export const CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION = "1.0.0" as const;
export const CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID = "ccc-proof-admission" as const;
export const CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION = "ccc-proof-admission.v1" as const;
export const CCC_CAMPAIGN_PROOF_ADMISSION_REGISTRY_ID =
  "plugin:fusion-native:ccc-proof-admission" as const;

export const CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK = Object.freeze({
  command: "ccc-proof-admission:binding-self-check.v1",
  positiveOracle: "immutable proof binding semantics are verified",
  negativeControls: Object.freeze([
    "stale evaluator input hash is refused",
    "stale proof definition hash is refused",
  ]),
});

const LOWER_HEX_SHA256_PATTERN = new RegExp("^[0-9a-f]{64}$", "u");
const TASK_VERIFY_DECLARATION_PATTERN = new RegExp(
  "^task verify:[a-z0-9][a-z0-9:-]{0,63}(?: --(?: [a-z0-9][a-z0-9:._/-]{0,63}){0,8})?$",
  "u",
);
const MAX_PROOF_DECLARATION_LENGTH = 512;
const MAX_PROOF_REQUIREMENT_IDS = 64;
const MAX_PROOF_REQUIREMENT_ID_LENGTH = 128;
const MAX_PROOF_ORACLE_LENGTH = 512;
const MAX_PROOF_NEGATIVE_CONTROLS = 3;
const MAX_PROOF_NEGATIVE_CONTROL_LENGTH = 512;
const DISALLOWED_PROOF_DECLARATION_TOKENS = new Set([
  "true",
  "exit",
  "sh",
  "bash",
  "node",
  "rm",
  "curl",
  "python",
  "python3",
  "git",
  "gh",
  "pnpm",
  "npm",
  "npx",
  "bun",
  "deno",
  "ruby",
  "perl",
  "java",
  "go",
  "cargo",
  "make",
]);

export type CccCampaignProofAdmissionDigestInput = Omit<
  WorkflowProofAdmissionEvaluatorInput,
  "inputSha256" | "signal"
>;

export type CccCampaignProofAdmissionEvaluatorInputSeed = Omit<
  WorkflowProofAdmissionEvaluatorInput,
  "inputSha256"
>;

function canonicalCccPrdJson(value: unknown): string {
  const serialize = (entry: unknown, seen: Set<object>): string => {
    if (entry === null) return "null";
    if (typeof entry === "string") return JSON.stringify(entry);
    if (typeof entry === "boolean") return entry ? "true" : "false";
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new Error("CCC PRD canonical JSON numbers must be finite");
      return JSON.stringify(entry);
    }
    if (Array.isArray(entry)) {
      if (seen.has(entry)) throw new Error("CCC PRD canonical JSON must not contain cycles");
      seen.add(entry);
      const result = `[${entry.map((item) => serialize(item, seen)).join(",")}]`;
      seen.delete(entry);
      return result;
    }
    if (typeof entry === "object") {
      const object = entry as object;
      if (seen.has(object)) throw new Error("CCC PRD canonical JSON must not contain cycles");
      const prototype = Object.getPrototypeOf(object);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("CCC PRD canonical JSON values must be plain objects");
      }
      seen.add(object);
      const result = `{${Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${serialize(item, seen)}`)
        .join(",")}}`;
      seen.delete(object);
      return result;
    }
    throw new Error("CCC PRD canonical JSON values must be JSON-compatible");
  };
  return serialize(value, new Set<object>());
}

function computeCccPrdProofDefinitionSha256(proof: CccPrdProof): string {
  return createHash("sha256").update(canonicalCccPrdJson({
    id: proof.id,
    requirementIds: proof.requirementIds,
    command: proof.command,
    positiveOracle: proof.positiveOracle,
    negativeControls: proof.negativeControls,
    spans: proof.spans,
    confidence: proof.confidence,
  }), "utf8").digest("hex");
}

function cloneAndFreezeCccPrdProof(
  proof: Readonly<CccPrdProof>,
): Readonly<CccPrdProof> {
  const sealedProof: CccPrdProof = {
    id: proof.id,
    requirementIds: [...proof.requirementIds],
    command: proof.command,
    positiveOracle: proof.positiveOracle,
    negativeControls: [...proof.negativeControls],
    spans: proof.spans.map((span) => Object.freeze({ ...span })),
    confidence: proof.confidence,
    ...(proof.admission
      ? { admission: Object.freeze({ ...proof.admission }) }
      : {}),
  };
  Object.freeze(sealedProof.requirementIds);
  Object.freeze(sealedProof.negativeControls);
  Object.freeze(sealedProof.spans);
  return Object.freeze(sealedProof);
}

function projectCccCampaignProofAdmissionDigestInput(
  input: CccCampaignProofAdmissionDigestInput,
): CccCampaignProofAdmissionDigestInput {
  return {
    campaignId: input.campaignId,
    importId: input.importId,
    bundleHash: input.bundleHash,
    manifestHash: input.manifestHash,
    taskId: input.taskId,
    nodeId: input.nodeId,
    workItemId: input.workItemId,
    owner: input.owner,
    attempt: input.attempt,
    proofDefinitionSha256: input.proofDefinitionSha256,
    proof: input.proof,
  };
}

export function computeCccCampaignProofAdmissionInputSha256(
  input: CccCampaignProofAdmissionDigestInput,
): string {
  return createHash("sha256")
    .update(canonicalCccPrdJson(projectCccCampaignProofAdmissionDigestInput(input)), "utf8")
    .digest("hex");
}

export function createCccCampaignProofAdmissionEvaluatorInput(
  input: CccCampaignProofAdmissionEvaluatorInputSeed,
): WorkflowProofAdmissionEvaluatorInput {
  const digestInput = projectCccCampaignProofAdmissionDigestInput({
    ...input,
    proof: cloneAndFreezeCccPrdProof(input.proof),
  });
  return Object.freeze({
    ...digestInput,
    inputSha256: computeCccCampaignProofAdmissionInputSha256(digestInput),
    signal: input.signal,
  });
}

function isAdmissibleTaskVerifyDeclaration(command: string): boolean {
  if (
    command.length === 0
    || command.length > MAX_PROOF_DECLARATION_LENGTH
    || !TASK_VERIFY_DECLARATION_PATTERN.test(command)
  ) {
    return false;
  }
  return !command.split(" ").some((token) => DISALLOWED_PROOF_DECLARATION_TOKENS.has(token));
}

function isBoundedNonblankText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= maxLength;
}

function isAdmissibleNonSelfCheckDeclaration(
  command: string,
  positiveOracle: unknown,
  negativeControls: unknown,
): boolean {
  return isAdmissibleTaskVerifyDeclaration(command)
    && isBoundedNonblankText(positiveOracle, MAX_PROOF_ORACLE_LENGTH)
    && Array.isArray(negativeControls)
    && negativeControls.length > 0
    && negativeControls.length <= MAX_PROOF_NEGATIVE_CONTROLS
    && negativeControls.every((control) => (
      isBoundedNonblankText(control, MAX_PROOF_NEGATIVE_CONTROL_LENGTH)
    ))
    && new Set(negativeControls).size === negativeControls.length;
}

export async function evaluateCccCampaignProofAdmission(
  input: WorkflowProofAdmissionEvaluatorInput,
): Promise<WorkflowProofAdmissionEvaluatorResult> {
  input.signal.throwIfAborted();
  const { inputSha256: assertedInputSha256, signal: _signal, ...digestInput } = input;
  const evaluatedInputSha256 = computeCccCampaignProofAdmissionInputSha256(digestInput);
  const fail = (summary: string): WorkflowProofAdmissionEvaluatorResult => Object.freeze({
    outcome: "fail",
    evaluatedInputSha256,
    summary: `${summary}; command not executed`,
  });
  if (assertedInputSha256 !== evaluatedInputSha256) {
    return fail("evaluator input hash is stale");
  }

  const definitionSha256 = computeCccPrdProofDefinitionSha256(input.proof);
  const admission = input.proof.admission;
  if (
    !admission
    || admission.schema !== CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION
    || admission.pluginId !== CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID
    || admission.pluginVersion !== CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION
    || admission.extensionId !== CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID
    || admission.proofVersion !== CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION
    || !LOWER_HEX_SHA256_PATTERN.test(admission.extensionSourceSha256)
    || !LOWER_HEX_SHA256_PATTERN.test(admission.extensionManifestSha256)
  ) {
    return fail("proof admission identity is inconsistent");
  }
  if (
    input.proofDefinitionSha256 !== definitionSha256
    || admission.definitionSha256 !== definitionSha256
  ) {
    return fail("proof definition hash is stale");
  }

  const requirementIds = input.proof.requirementIds;
  if (
    !Array.isArray(requirementIds)
    || requirementIds.length === 0
    || requirementIds.length > MAX_PROOF_REQUIREMENT_IDS
    || requirementIds.some((requirementId) => (
      typeof requirementId !== "string"
      || requirementId.trim() === ""
      || requirementId.length > MAX_PROOF_REQUIREMENT_ID_LENGTH
    ))
    || new Set(requirementIds).size !== requirementIds.length
  ) {
    return fail("proof requirement ids are missing or duplicated");
  }

  const { command, positiveOracle, negativeControls } = input.proof;
  const isSelfCheck = command === CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK.command;
  if (
    (isSelfCheck && (
      positiveOracle !== CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK.positiveOracle
      || !Array.isArray(negativeControls)
      || negativeControls.length !== CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK.negativeControls.length
      || negativeControls.some(
        (control, index) => control !== CCC_CAMPAIGN_PROOF_ADMISSION_SELF_CHECK.negativeControls[index],
      )
    ))
    || (!isSelfCheck && !isAdmissibleNonSelfCheckDeclaration(
      command,
      positiveOracle,
      negativeControls,
    ))
  ) {
    return fail("unsupported proof binding declaration");
  }

  input.signal.throwIfAborted();
  return Object.freeze({
    outcome: "pass",
    evaluatedInputSha256,
    summary: isSelfCheck
      ? "proof binding semantics verified; command not executed"
      : "proof declaration is admissible; command not executed",
  });
}

export const CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION:
WorkflowProofAdmissionExtensionContribution = Object.freeze({
  extensionId: CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
  name: "CCC proof admission",
  description: "Validates fixed proof binding plus bounded task verification declarations; campaign task authorization is refused at the workflow boundary.",
  kind: "proof-admission",
  schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
  fallback: "failClosed",
  proofVersion: CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION,
  evaluate: evaluateCccCampaignProofAdmission,
});

export function createCccCampaignProofAdmissionContribution():
WorkflowProofAdmissionExtensionContribution {
  return CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION;
}
