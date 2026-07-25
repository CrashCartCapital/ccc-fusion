import { createHash } from "node:crypto";
import {
  CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  canonicalCccPrdJson,
  computeCccPrdProofDefinitionSha256,
  type CccPrdProof,
  type WorkflowProofAdmissionEvaluatorInput,
  type WorkflowProofAdmissionEvaluatorResult,
  type WorkflowProofAdmissionExtensionContribution,
} from "@fusion/core";

export const CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID = "fusion-native" as const;
export const CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_VERSION = "1.0.0" as const;
export const CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID = "ccc-proof-admission" as const;
export const CCC_CAMPAIGN_PROOF_ADMISSION_PROOF_VERSION = "ccc-proof-admission.v1" as const;
export const CCC_CAMPAIGN_PROOF_ADMISSION_REGISTRY_ID =
  "plugin:fusion-native:ccc-proof-admission" as const;

const LOWER_HEX_SHA256_PATTERN = new RegExp("^[0-9a-f]{64}$", "u");
const COLLAPSE_WHITESPACE_PATTERN = new RegExp("\\s+", "gu");
const TRAILING_PUNCTUATION_PATTERN = new RegExp("[.;]+$", "u");
const GENERIC_ECHO_PATTERN = new RegExp(
  "^(?:echo|printf)\\s+['\"]?(?:ok|true|false|pass|passed|success|failure)['\"]?$",
  "u",
);
const TRUE_EXECUTABLE_PATTERN = new RegExp("^(?:\\/(?:usr\\/)?bin\\/)?true$", "u");
const SHELL_WRAPPER_PATTERN = new RegExp(
  "^(?:(?:\\/usr)?\\/bin\\/)?(?:sh|bash|zsh|dash|ksh)\\s+-c\\s+(.+)$",
  "u",
);
const NODE_WRAPPER_PATTERN = new RegExp(
  "^(?:node|nodejs)(?:\\.exe)?\\s+(?:-e|--eval)\\s+(.+)$",
  "u",
);
const TRAILING_SEMICOLON_PATTERN = new RegExp(";+$", "u");

export type CccCampaignProofAdmissionDigestInput = Omit<
  WorkflowProofAdmissionEvaluatorInput,
  "inputSha256" | "signal"
>;

export type CccCampaignProofAdmissionEvaluatorInputSeed = Omit<
  WorkflowProofAdmissionEvaluatorInput,
  "inputSha256"
>;

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
    || requirementIds.some((requirementId) => (
      typeof requirementId !== "string" || requirementId.trim() === ""
    ))
    || new Set(requirementIds).size !== requirementIds.length
  ) {
    return fail("proof requirement ids are missing or duplicated");
  }

  const command = input.proof.command;
  const positiveOracle = input.proof.positiveOracle;
  const negativeControls = input.proof.negativeControls;
  if (
    typeof command !== "string"
    || command.trim() === ""
    || isGenericProofDeclaration(command)
  ) {
    return fail("proof verifier command is blank or generic");
  }
  if (
    typeof positiveOracle !== "string"
    || positiveOracle.trim() === ""
    || isGenericProofDeclaration(positiveOracle)
  ) {
    return fail("proof positive oracle is blank or generic");
  }
  if (
    !Array.isArray(negativeControls)
    || negativeControls.length === 0
    || negativeControls.some((control) => (
      typeof control !== "string"
      || control.trim() === ""
      || isGenericProofDeclaration(control)
    ))
    || new Set(negativeControls).size !== negativeControls.length
  ) {
    return fail("proof negative controls are blank, generic, or duplicated");
  }
  if (negativeControls.some((control) => control.trim() === positiveOracle.trim())) {
    return fail("proof positive oracle is repeated as a negative control");
  }

  input.signal.throwIfAborted();
  return Object.freeze({
    outcome: "pass",
    evaluatedInputSha256,
    summary: "definition admitted; command not executed",
  });
}

const GENERIC_PROOF_DECLARATIONS = new Set([
  ":",
  "true",
  "false",
  "ok",
  "pass",
  "passed",
  "success",
  "succeeded",
  "failure",
  "failed",
  "exit 0",
  "exit 1",
  "zero exit",
  "nonzero exit",
  "command succeeds",
  "command fails",
]);

function isGenericProofDeclaration(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(COLLAPSE_WHITESPACE_PATTERN, " ")
    .replace(TRAILING_PUNCTUATION_PATTERN, "");
  if (GENERIC_PROOF_DECLARATIONS.has(normalized)) return true;
  if (
    GENERIC_ECHO_PATTERN.test(normalized)
    || TRUE_EXECUTABLE_PATTERN.test(normalized)
  ) {
    return true;
  }
  const shellWrapper = normalized.match(SHELL_WRAPPER_PATTERN);
  if (shellWrapper) {
    return isGenericProofDeclaration(unwrapSingleShellArgument(shellWrapper[1]!));
  }
  const nodeWrapper = normalized.match(NODE_WRAPPER_PATTERN);
  if (nodeWrapper) {
    const script = unwrapSingleShellArgument(nodeWrapper[1]!)
      .replace(COLLAPSE_WHITESPACE_PATTERN, "")
      .replace(TRAILING_SEMICOLON_PATTERN, "");
    return script === "process.exit(0)" || script === "process.exitCode=0";
  }
  return false;
}

function unwrapSingleShellArgument(value: string): string {
  if (
    value.length >= 2
    && ((value.startsWith("'") && value.endsWith("'"))
      || (value.startsWith("\"") && value.endsWith("\"")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export const CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION:
WorkflowProofAdmissionExtensionContribution = Object.freeze({
  extensionId: CCC_CAMPAIGN_PROOF_ADMISSION_EXTENSION_ID,
  name: "CCC proof admission",
  description: "Admits structurally bound CCC campaign proof definitions without executing them.",
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
