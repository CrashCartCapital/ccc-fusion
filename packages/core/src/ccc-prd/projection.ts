import type { CccCampaignExecutionPolicy, CccCampaignExecutionRoute } from "../ccc-campaign/types.js";
import type { Task } from "../types.js";
import { canonicalCccPrdJson } from "./contract.js";
import type { CccPrdSemanticBundle, CccPrdTask } from "./types.js";

export const CCC_PRD_IMPORT_PREPARED_STATUS = "ccc-prd-import-prepared";

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

export function preparedCccPrdTask(
  source: CccPrdTask,
  missionId: string,
  identityHash: string,
  bundleHash: string,
  targetBase: string,
  route: CccCampaignExecutionRoute,
  now: string,
): Task & { state: "prepared"; runnable: false } {
  return {
    id: source.id,
    lineageId: `ccc-prd:${identityHash.slice(0, 24)}:${source.id}`,
    title: source.title,
    description: source.description,
    priority: "normal",
    column: "triage",
    status: CCC_PRD_IMPORT_PREPARED_STATUS,
    dependencies: [...source.dependencyTaskIds],
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
      requirementIds: source.requirementIds,
      proofIds: source.proofIds,
      accountableProducer: source.accountableProducer,
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

function promptForTask(bundle: CccPrdSemanticBundle, task: CccPrdTask): string {
  const prompt = bundle.documents.find((document) =>
    document.taskId === task.id && document.key.toLowerCase() === "prompt.md");
  if (prompt) return prompt.content;
  return `# ${task.title}\n\n${task.description}\n`;
}

export function buildCccPrdProjection(input: {
  bundle: CccPrdSemanticBundle;
  executionPolicy: CccCampaignExecutionPolicy;
  importId: string;
  identityHash: string;
  campaignId: string;
  now: string;
}): PreparedCccPrdProjection {
  const routes = new Map(input.executionPolicy.routes.map((route) => [route.taskId, route]));
  const taskFiles = input.bundle.tasks.map((source) => {
    const route = routes.get(source.id);
    if (!route) {
      throw new Error(`CCC campaign execution route disappeared for ${source.id}`);
    }
    const prepared = preparedCccPrdTask(
      source,
      input.campaignId,
      input.identityHash,
      input.bundle.bundleHash,
      input.bundle.targetRepository.baseCommit,
      route,
      input.now,
    );
    return {
      id: source.id,
      taskJson: `${canonicalCccPrdJson(prepared)}\n`,
      prompt: promptForTask(input.bundle, source),
    };
  });
  const artifactFiles = input.bundle.tasks.flatMap((task) =>
    input.bundle.artifacts
      .filter((artifact) => artifact.taskId === task.id)
      .map((artifact) => ({
        id: nativeCccPrdScopedId(input.importId, artifact.id),
        content: artifact.content,
        taskId: task.id,
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
