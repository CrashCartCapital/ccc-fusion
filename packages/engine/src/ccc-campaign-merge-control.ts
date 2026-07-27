import type { CccCampaignControlledMergeAuthority, CccCampaignTaskContext, Task } from "@fusion/core";
import { isImportedCccCampaignTask } from "./ccc-campaign-routing.js";

export class CccCampaignMergeControlError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CccCampaignMergeControlError";
  }
}

export type CccCampaignMergeCustody =
  | { kind: "ordinary" }
  | { kind: "campaign"; context: CccCampaignTaskContext };

type CampaignContextStore = {
  getCccCampaignContextForTask?: (taskId: string) => CccCampaignTaskContext | null | Promise<CccCampaignTaskContext | null>;
};

const authorityText = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new CccCampaignMergeControlError("ccc-campaign-custody-invalid", `CCC campaign custody has invalid ${field}`);
  }
  return value;
};

export function createCccCampaignMergeControl(context: CccCampaignTaskContext): Readonly<CccCampaignControlledMergeAuthority> {
  return Object.freeze({
    kind: "ccc-campaign-controlled" as const,
    version: 1 as const,
    projectId: authorityText(context.projectId, "projectId"),
    importId: authorityText(context.importId, "importId"),
    campaignId: authorityText(context.campaignId, "campaignId"),
    taskId: authorityText(context.taskId, "taskId"),
    bundleHash: authorityText(context.bundleHash, "bundleHash"),
    manifestHash: authorityText(context.manifestHash, "manifestHash"),
    targetRepository: authorityText(context.targetRepository?.path, "targetRepository"),
    targetBase: authorityText(context.targetRepository?.baseCommit, "targetBase"),
  });
}

export function matchesCccCampaignMergeControl(
  value: unknown,
  context: CccCampaignTaskContext,
): value is CccCampaignControlledMergeAuthority {
  try {
    const expected = createCccCampaignMergeControl(context);
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const candidate = value as Record<string, unknown>;
    return Reflect.ownKeys(candidate).length === Object.keys(expected).length
      && Object.entries(expected).every(([key, expectedValue]) => candidate[key] === expectedValue);
  } catch {
    return false;
  }
}

/** Resolve persisted custody before any merge mutation or dispatch. */
export async function resolveCccCampaignMergeCustody(
  store: CampaignContextStore,
  task: Pick<Task, "id" | "lineageId">,
): Promise<CccCampaignMergeCustody> {
  const imported = isImportedCccCampaignTask(task);
  const lookup = store.getCccCampaignContextForTask;
  if (typeof lookup !== "function") {
    if (imported) throw new CccCampaignMergeControlError("ccc-campaign-custody-lookup-unwired", `CCC campaign task ${task.id} has no custody lookup`);
    return { kind: "ordinary" };
  }
  let context: CccCampaignTaskContext | null;
  try {
    context = await lookup.call(store, task.id);
  } catch {
    throw new CccCampaignMergeControlError("ccc-campaign-custody-lookup-error", `CCC campaign custody lookup failed for ${task.id}`);
  }
  if (!context) {
    if (imported) throw new CccCampaignMergeControlError("ccc-campaign-custody-missing", `CCC campaign task ${task.id} has no persisted custody`);
    return { kind: "ordinary" };
  }
  if (context.taskId !== task.id) {
    throw new CccCampaignMergeControlError("ccc-campaign-custody-ambiguous", `CCC campaign custody task binding does not match ${task.id}`);
  }
  createCccCampaignMergeControl(context);
  return { kind: "campaign", context };
}
