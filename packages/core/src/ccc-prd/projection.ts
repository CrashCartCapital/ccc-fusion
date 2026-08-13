import { createHash } from "node:crypto";
import type { CccCampaignExecutionPolicy, CccCampaignExecutionRoute } from "../ccc-campaign/types.js";
import type { Task } from "../types.js";
import { canonicalCccPrdJson, compareCccPrdCodeUnits } from "./contract.js";
import {
  CCC_PRD_BUNDLE_V2_SCHEMA_VERSION,
  CCC_PRD_EXECUTION_PROMPT_V1_SCHEMA_VERSION,
  CCC_PRD_EXECUTION_PROMPT_V2_SCHEMA_VERSION,
} from "./types.js";
import type {
  CccPrdExecutionPrompt,
  CccPrdProofV2,
  CccPrdRequirementV2,
  CccPrdSemanticBundle,
  CccPrdSemanticBundleV2,
  CccPrdTask,
} from "./types.js";

export const CCC_PRD_IMPORT_PREPARED_STATUS = "ccc-prd-import-prepared";
export {
  CCC_PRD_EXECUTION_PROMPT_V1_SCHEMA_VERSION,
  CCC_PRD_EXECUTION_PROMPT_V2_SCHEMA_VERSION,
};
/** @deprecated Frozen v1 alias; use the version-specific prompt constant. */
export const CCC_PRD_EXECUTION_PROMPT_SCHEMA =
  CCC_PRD_EXECUTION_PROMPT_V1_SCHEMA_VERSION;

export type PreparedCccPrdProjection = {
  schema: "ccc-prd.import-projection.v1";
  importId: string;
  identityHash: string;
  bundleHash: string;
  state: "prepared";
  runnable: false;
  taskFiles: Array<{
    id: string;
    taskJson: string;
    prompt: string;
  }>;
  artifactFiles: Array<{
    id: string;
    content: string;
    taskId: string;
  }>;
};

export function nativeCccPrdScopedId(importId: string, semanticId: string): string {
  return `${importId}--${semanticId}`;
}

export type CccPrdNativeTaskIds = ReadonlyMap<string, string>;

export function nativeCccPrdTaskId(
  semanticTaskId: string,
  nativeTaskIds?: CccPrdNativeTaskIds,
): string {
  return nativeTaskIds?.get(semanticTaskId) ?? semanticTaskId;
}

export function preparedCccPrdTask(
  source: CccPrdTask,
  missionId: string,
  identityHash: string,
  bundleHash: string,
  targetBase: string,
  route: CccCampaignExecutionRoute,
  now: string,
  nativeTaskIds?: CccPrdNativeTaskIds,
): Task & { state: "prepared"; runnable: false } {
  const nativeTaskId = nativeCccPrdTaskId(source.id, nativeTaskIds);
  return {
    id: nativeTaskId,
    lineageId: `ccc-prd:${identityHash.slice(0, 24)}:${source.id}`,
    title: source.title,
    description: source.description,
    priority: "normal",
    column: "triage",
    status: CCC_PRD_IMPORT_PREPARED_STATUS,
    dependencies: source.dependencyTaskIds.map((taskId) =>
      nativeCccPrdTaskId(taskId, nativeTaskIds)),
    steps: [],
    currentStep: 0,
    log: [{ timestamp: now, action: "CCC PRD import prepared" }],
    paused: true,
    userPaused: true,
    pausedReason: CCC_PRD_IMPORT_PREPARED_STATUS,
    missionId,
    sourceType: "api",
    sourceMetadata: {
      bundleHash,
      semanticTaskId: source.id,
      requirementIds: source.requirementIds,
      proofIds: source.proofIds,
      accountableProducer: source.accountableProducer,
      ...(route.executor
        ? {
          cccCampaignExecution: {
            ...route,
            ownedPaths: [...(route.ownedPaths ?? [])],
            allowedWriteRoots: [...(route.allowedWriteRoots ?? [])],
          },
        }
        : {}),
    },
    baseCommitSha: targetBase,
    modelProvider: route.providerId,
    modelId: route.modelId,
    createdAt: now,
    updatedAt: now,
    columnMovedAt: now,
    state: "prepared",
    runnable: false,
  };
}

function legacyPromptForTask(bundle: CccPrdSemanticBundle, task: CccPrdTask): string {
  const prompt = bundle.documents.find((document) =>
    document.taskId === task.id && document.key.toLowerCase() === "prompt.md");
  if (prompt) return prompt.content;
  return `# ${task.title}\n\n${task.description}\n`;
}

function linkedById<T extends { id: string }>(
  values: readonly T[],
  ids: readonly string[],
  label: string,
): T[] {
  const byId = new Map(values.map((value) => [value.id, value]));
  return ids.map((id) => {
    const value = byId.get(id);
    if (!value) {
      throw new Error(`CCC PRD execution prompt references unknown ${label} ${id}`);
    }
    return value;
  });
}

function bulletList(values: readonly string[]): string[] {
  return values.length > 0
    ? values.map((value) => `- ${value}`)
    : ["- None declared."];
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort(compareCccPrdCodeUnits);
}

function taskLinkedV2Requirements(
  bundle: CccPrdSemanticBundleV2,
  task: CccPrdTask,
): CccPrdRequirementV2[] {
  return linkedById(
    bundle.requirements,
    sortedStrings(task.requirementIds),
    "requirement",
  );
}

function taskLinkedV2Proofs(
  bundle: CccPrdSemanticBundleV2,
  task: CccPrdTask,
): CccPrdProofV2[] {
  return linkedById(bundle.proofs, sortedStrings(task.proofIds), "proof");
}

function buildCccPrdTaskExecutionPromptV2(
  bundle: CccPrdSemanticBundleV2,
  task: CccPrdTask,
  route: CccCampaignExecutionRoute,
): CccPrdExecutionPrompt {
  const requirements = taskLinkedV2Requirements(bundle, task);
  const proofs = taskLinkedV2Proofs(bundle, task);
  const documents = linkedById(
    bundle.documents,
    sortedStrings(task.documentIds),
    "document",
  );
  const artifacts = linkedById(
    bundle.artifacts,
    sortedStrings(task.artifactIds),
    "artifact",
  );
  const protectedActions = linkedById(
    bundle.protectedActions,
    sortedStrings(task.protectedActionIds),
    "protected action",
  );
  const lines: string[] = [
    "# CCC Fusion sealed execution task",
    "",
    `Execution prompt schema: ${CCC_PRD_EXECUTION_PROMPT_V2_SCHEMA_VERSION}`,
    `Frozen bundle SHA-256: ${bundle.bundleHash}`,
    `Semantic task: ${task.id}`,
    `Accountable producer: ${task.accountableProducer}`,
    "",
    "## Task",
    "",
    `### ${task.title}`,
    "",
    task.description,
    "",
    "## Repository and write custody",
    "",
    `- Target repository: ${bundle.targetRepository.path}`,
    `- Frozen base commit: ${bundle.targetRepository.baseCommit}`,
    `- Executor: ${route.executor ?? "legacy"}`,
    `- Transport: ${route.transport}`,
    `- Worktree mode: ${route.worktreeMode ?? "unspecified"}`,
    `- Commit policy: ${route.commitPolicy ?? "unspecified"}`,
    "- Owned paths:",
    ...bulletList(sortedStrings(route.ownedPaths ?? [])),
    "- Allowed write roots:",
    ...bulletList(sortedStrings(route.allowedWriteRoots ?? [])),
    "",
    "Modify no path outside the allowed write roots. Work only in the isolated task worktree. Do not run git add, git commit, or mutate Git refs: the campaign controller validates the final source bytes and creates the task-branch commit. Do not perform landing, publication, credential, billing, deletion, upstream-write, or other protected actions. The campaign controller owns commit creation, proof execution, and human approval gates.",
    "",
    "## Source-owned acceptance clauses",
    "",
    "Only the exact undispositioned clauses below are product acceptance authority. Requirement summaries and other prose are informative.",
    "",
  ];
  for (const requirement of requirements) {
    const dispositionIds = new Set(
      requirement.acceptanceDispositions.map((disposition) => disposition.clauseId),
    );
    const acceptedClauses = [...requirement.acceptanceClauses]
      .filter((clause) => !dispositionIds.has(clause.id))
      .sort((left, right) => compareCccPrdCodeUnits(left.id, right.id));
    lines.push(
      `### ${requirement.id}`,
      "",
      `Statement: ${requirement.statement}`,
      "",
      `Informative acceptance summary: ${requirement.acceptance}`,
      "",
      `Accountable producer: ${requirement.accountableProducer}`,
      "",
      "Requirement dependencies:",
      ...bulletList(sortedStrings(requirement.dependencies)),
      "",
    );
    for (const clause of acceptedClauses) {
      lines.push(
        `#### ${clause.id}`,
        "",
        clause.text,
        "",
        `Source: ${clause.span.path} bytes ${clause.span.byteStart}-${clause.span.byteEnd}; lines ${clause.span.line}:${clause.span.column}-${clause.span.endLine}:${clause.span.endColumn}`,
        `Source excerpt SHA-256: ${clause.span.excerptSha256}`,
        `Linked proof IDs: ${sortedStrings(clause.proofIds).join(", ")}`,
        "",
      );
    }
  }
  lines.push("## Expected proof", "");
  for (const proof of proofs) {
    lines.push(
      `### ${proof.id}`,
      "",
      `Command: ${proof.command}`,
      "",
      `Positive oracle: ${proof.positiveOracle}`,
      "",
      `Allowed phases: ${sortedStrings(proof.phases).join(", ")}`,
      `Covered clause IDs: ${sortedStrings(proof.clauseIds).join(", ")}`,
      "",
      "Positive cases:",
      ...[...proof.positiveCases]
        .sort((left, right) => compareCccPrdCodeUnits(left.id, right.id))
        .map((proofCase) => `- ${proofCase.id}: ${proofCase.description}`),
      "",
      "Negative controls:",
      ...[...proof.negativeControls]
        .sort((left, right) => compareCccPrdCodeUnits(left.id, right.id))
        .map((control) => `- ${control.id}: ${control.description}`),
      "",
      "Verifier closure:",
      ...[...proof.verifierClosure]
        .sort((left, right) => compareCccPrdCodeUnits(left.path, right.path))
        .map((entry) =>
          `- ${entry.role}: ${entry.path}; base blob ${entry.baseGitBlobOid}; SHA-256 ${entry.sha256}`),
      "",
      "Candidate inputs:",
      ...bulletList(sortedStrings(proof.candidateInputs)),
      "",
      `Task executable: ${proof.executionToolchain.task.executablePath}; SHA-256 ${proof.executionToolchain.task.executableSha256}; version ${proof.executionToolchain.task.version}; version-output SHA-256 ${proof.executionToolchain.task.versionOutputSha256}`,
      `Node executable: ${proof.executionToolchain.node.executablePath}; SHA-256 ${proof.executionToolchain.node.executableSha256}; version ${proof.executionToolchain.node.version}; version-output SHA-256 ${proof.executionToolchain.node.versionOutputSha256}`,
      `Proof host: ${proof.executionToolchain.proofHost.id}; ${proof.executionToolchain.proofHost.executablePath}; SHA-256 ${proof.executionToolchain.proofHost.executableSha256}; version ${proof.executionToolchain.proofHost.version}; version-output SHA-256 ${proof.executionToolchain.proofHost.versionOutputSha256}`,
      `Linked runtime entries: ${proof.executionToolchain.linkedRuntime.length}`,
      ...[...proof.executionToolchain.linkedRuntime]
        .sort((left, right) => compareCccPrdCodeUnits(left.canonicalPath, right.canonicalPath))
        .map((entry) =>
          `- ${entry.platform} ${entry.loaderRole}: ${entry.requestedPath} -> ${entry.canonicalPath}; loader ${entry.loaderPath}; SHA-256 ${entry.sha256}`),
      "",
    );
  }
  lines.push("## Task documents", "");
  if (documents.length === 0) {
    lines.push("None declared.", "");
  } else {
    for (const document of documents) {
      lines.push(`### ${document.title} (${document.key})`, "", document.content, "");
    }
  }
  lines.push("## Expected artifacts", "");
  if (artifacts.length === 0) {
    lines.push("None declared.", "");
  } else {
    for (const artifact of artifacts) {
      lines.push(
        `### ${artifact.title} (${artifact.id})`,
        "",
        `Type: ${artifact.type}`,
        `MIME type: ${artifact.mimeType}`,
        "",
        artifact.content,
        "",
      );
    }
  }
  lines.push(
    "## Non-goals",
    "",
    ...bulletList(sortedStrings(bundle.nonGoals)),
    "",
    "## Protected actions",
    "",
  );
  if (protectedActions.length === 0) {
    lines.push("None declared.", "");
  } else {
    for (const action of protectedActions) {
      lines.push(
        `- ${action.id}: ${action.kind} on ${action.target}; requires human decision ${action.operatorDecision}.`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## Completion handoff",
    "",
    "Implement every admitted acceptance clause above, leave only admitted source edits in the worktree, and stop before Git commit. The campaign controller will validate those bytes, create the task-branch commit, and run the commit-bound verifier. Stop before every protected action. Report changed paths, tests you ran, and any blocker without claiming final proof or landing.",
    "",
  );
  const content = lines.join("\n");
  return {
    schema: CCC_PRD_EXECUTION_PROMPT_V2_SCHEMA_VERSION,
    content,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

/**
 * Build the exact coding prompt persisted in the workflow IR and projected to
 * PROMPT.md. It deliberately derives only from the frozen semantic bundle and
 * admitted route, so runtime dispatch cannot silently drop or invent product
 * meaning after review.
 */
export function buildCccPrdTaskExecutionPrompt(
  bundle: CccPrdSemanticBundle,
  task: CccPrdTask,
  route: CccCampaignExecutionRoute,
): CccPrdExecutionPrompt {
  if (bundle.schema === CCC_PRD_BUNDLE_V2_SCHEMA_VERSION) {
    return buildCccPrdTaskExecutionPromptV2(bundle, task, route);
  }
  const requirements = linkedById(
    bundle.requirements,
    task.requirementIds,
    "requirement",
  );
  const proofs = linkedById(bundle.proofs, task.proofIds, "proof");
  const documents = linkedById(bundle.documents, task.documentIds, "document");
  const artifacts = linkedById(bundle.artifacts, task.artifactIds, "artifact");
  const protectedActions = linkedById(
    bundle.protectedActions,
    task.protectedActionIds,
    "protected action",
  );
  const lines: string[] = [
    "# CCC Fusion sealed execution task",
    "",
    `Execution prompt schema: ${CCC_PRD_EXECUTION_PROMPT_SCHEMA}`,
    `Frozen bundle SHA-256: ${bundle.bundleHash}`,
    `Semantic task: ${task.id}`,
    `Accountable producer: ${task.accountableProducer}`,
    "",
    "## Task",
    "",
    `### ${task.title}`,
    "",
    task.description,
    "",
    "## Repository and write custody",
    "",
    `- Target repository: ${bundle.targetRepository.path}`,
    `- Frozen base commit: ${bundle.targetRepository.baseCommit}`,
    `- Executor: ${route.executor ?? "legacy"}`,
    `- Transport: ${route.transport}`,
    `- Worktree mode: ${route.worktreeMode ?? "unspecified"}`,
    `- Commit policy: ${route.commitPolicy ?? "unspecified"}`,
    "- Owned paths:",
    ...bulletList(route.ownedPaths ?? []),
    "- Allowed write roots:",
    ...bulletList(route.allowedWriteRoots ?? []),
    "",
    "Modify no path outside the allowed write roots. Work only in the isolated task worktree. Do not run git add, git commit, or mutate Git refs: the campaign controller validates the final source bytes and creates the task-branch commit. Do not perform landing, publication, credential, billing, deletion, upstream-write, or other protected actions. The campaign controller owns commit creation, proof execution, and human approval gates.",
    "",
    "## Requirements and acceptance",
    "",
  ];
  for (const requirement of requirements) {
    lines.push(
      `### ${requirement.id}`,
      "",
      `Statement: ${requirement.statement}`,
      "",
      `Acceptance: ${requirement.acceptance}`,
      "",
      `Accountable producer: ${requirement.accountableProducer}`,
      "",
      "Requirement dependencies:",
      ...bulletList(requirement.dependencies),
      "",
    );
  }
  lines.push("## Expected proof", "");
  for (const proof of proofs) {
    lines.push(
      `### ${proof.id}`,
      "",
      `Command: ${proof.command}`,
      "",
      `Positive oracle: ${proof.positiveOracle}`,
      "",
      "Negative controls:",
      ...bulletList(proof.negativeControls),
      "",
    );
  }
  lines.push("## Task documents", "");
  if (documents.length === 0) {
    lines.push("None declared.", "");
  } else {
    for (const document of documents) {
      lines.push(
        `### ${document.title} (${document.key})`,
        "",
        document.content,
        "",
      );
    }
  }
  lines.push("## Expected artifacts", "");
  if (artifacts.length === 0) {
    lines.push("None declared.", "");
  } else {
    for (const artifact of artifacts) {
      lines.push(
        `### ${artifact.title} (${artifact.id})`,
        "",
        `Type: ${artifact.type}`,
        `MIME type: ${artifact.mimeType}`,
        "",
        artifact.content,
        "",
      );
    }
  }
  lines.push(
    "## Non-goals",
    "",
    ...bulletList(bundle.nonGoals),
    "",
    "## Protected actions",
    "",
  );
  if (protectedActions.length === 0) {
    lines.push("None declared.", "");
  } else {
    for (const action of protectedActions) {
      lines.push(
        `- ${action.id}: ${action.kind} on ${action.target}; requires human decision ${action.operatorDecision}.`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## Completion handoff",
    "",
    "Implement the admitted change, leave only admitted source edits in the worktree, and stop before Git commit. The campaign controller will validate those bytes, create the task-branch commit, and run the commit-bound verifier. Stop before every protected action. Report changed paths, tests you ran, and any blocker without claiming final proof or landing.",
    "",
  );
  const content = lines.join("\n");
  return {
    schema: CCC_PRD_EXECUTION_PROMPT_SCHEMA,
    content,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

export function buildCccPrdProjection(input: {
  bundle: CccPrdSemanticBundle;
  executionPolicy: CccCampaignExecutionPolicy;
  importId: string;
  identityHash: string;
  campaignId: string;
  now: string;
  nativeTaskIds?: CccPrdNativeTaskIds;
}): PreparedCccPrdProjection {
  const routes = new Map(input.executionPolicy.routes.map((route) => [route.taskId, route]));
  const taskFiles = input.bundle.tasks.map((source) => {
    const route = routes.get(source.id);
    if (!route) {
      throw new Error(`CCC campaign execution route disappeared for ${source.id}`);
    }
    const executionPrompt = input.executionPolicy.schema === "ccc-campaign.execution-policy.v2"
      ? buildCccPrdTaskExecutionPrompt(input.bundle, source, route)
      : undefined;
    const basePrepared = preparedCccPrdTask(
      source,
      input.campaignId,
      input.identityHash,
      input.bundle.bundleHash,
      input.bundle.targetRepository.baseCommit,
      route,
      input.now,
      input.nativeTaskIds,
    );
    const prepared = executionPrompt
      ? {
          ...basePrepared,
          sourceMetadata: {
            ...basePrepared.sourceMetadata,
            cccExecutionPrompt: {
              schema: executionPrompt.schema,
              sha256: executionPrompt.sha256,
            },
          },
        }
      : basePrepared;
    return {
      id: prepared.id,
      taskJson: `${canonicalCccPrdJson(prepared)}\n`,
      prompt: executionPrompt?.content ?? legacyPromptForTask(input.bundle, source),
    };
  });
  const artifactFiles = input.bundle.tasks.flatMap((task) =>
    input.bundle.artifacts
      .filter((artifact) => artifact.taskId === task.id)
      .map((artifact) => ({
        id: nativeCccPrdScopedId(input.importId, artifact.id),
        content: artifact.content,
        taskId: nativeCccPrdTaskId(task.id, input.nativeTaskIds),
      })));
  return {
    schema: "ccc-prd.import-projection.v1",
    importId: input.importId,
    identityHash: input.identityHash,
    bundleHash: input.bundle.bundleHash,
    state: "prepared",
    runnable: false,
    taskFiles,
    artifactFiles,
  };
}
