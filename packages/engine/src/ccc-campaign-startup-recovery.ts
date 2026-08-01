import type { TaskStore } from "@fusion/core";
import {
  drizzleSql,
  inspectCccPrdProductStatus,
  postgresSchema,
} from "@fusion/core";

export const CCC_CAMPAIGN_UNCERTAIN_EFFECT_RECOVERY_REASON =
  "ccc-permanent:CCC_CAMPAIGN_UNCERTAIN_EXTERNAL_EFFECT_REQUIRES_OPERATOR";

export type CccCampaignStartupRecovery = Readonly<{
  workItemId: string;
  taskId: string;
  runId: string;
  attempt: number;
  previousLeaseOwner: string;
  providerAttemptKeys: readonly string[];
  proofAttemptKeys: readonly string[];
  recoveredAt: string;
}>;

type StartupRecoveryInput = Readonly<{
  store: TaskStore;
  rootDir: string;
  currentLeaseOwner: string;
}>;

function priorRuntimeLeaseOwner(
  candidate: string | null,
  projectId: string,
  currentLeaseOwner: string,
): candidate is string {
  if (candidate === null || candidate === currentLeaseOwner) return false;
  const legacyOwner = `in-process-runtime:${projectId}`;
  return candidate === legacyOwner
    || candidate.startsWith(`${legacyOwner}:`);
}

/**
 * Park only running campaign work whose provider or verifier dispatch already
 * crossed the durable unknown-effect boundary in a prior engine boot.
 *
 * The caller must hold the project engine singleton and supply its unique boot
 * lease owner. That makes an older owner conclusive crash evidence without
 * waiting for the ten-minute execution lease or stealing from a live engine.
 */
export async function recoverCccCampaignUncertainEffectsOnStartup(
  input: StartupRecoveryInput,
): Promise<readonly CccCampaignStartupRecovery[]> {
  const layer = input.store.getAsyncLayer();
  if (!layer) {
    throw new Error(
      "CCC campaign startup recovery requires PostgreSQL project custody",
    );
  }
  const projectId = layer.projectId;
  if (!projectId) {
    throw new Error(
      "CCC campaign startup recovery requires an explicit project partition",
    );
  }
  const workItems = postgresSchema.project.workflowWorkItems;
  const running = await layer.db
    .select({
      id: workItems.id,
      runId: workItems.runId,
      taskId: workItems.taskId,
      state: workItems.state,
      attempt: workItems.attempt,
      leaseOwner: workItems.leaseOwner,
    })
    .from(workItems)
    .where(drizzleSql`
      ${workItems.projectId} = ${projectId}
      AND ${workItems.kind} = 'task'
      AND ${workItems.state} = 'running'
      AND ${workItems.leaseOwner} IS NOT NULL
    `);
  const statusByImport = new Map<
    string,
    Awaited<ReturnType<typeof inspectCccPrdProductStatus>>
  >();
  const recovered: CccCampaignStartupRecovery[] = [];

  for (const workItem of running) {
    if (
      !priorRuntimeLeaseOwner(
        workItem.leaseOwner,
        projectId,
        input.currentLeaseOwner,
      )
    ) {
      continue;
    }
    const context = await input.store.getCccCampaignContextForTask(
      workItem.taskId,
    );
    if (!context) continue;
    let status = statusByImport.get(context.idempotencyKey);
    if (status === undefined) {
      status = await inspectCccPrdProductStatus({
        idempotencyKey: context.idempotencyKey,
        layer,
        rootDir: input.rootDir,
      });
      statusByImport.set(context.idempotencyKey, status);
    }
    if (!status) {
      throw new Error(
        `CCC campaign startup recovery lost product status for ${context.idempotencyKey}`,
      );
    }
    const providerAttemptKeys = status.providerAttempts
      .filter((attempt) =>
        attempt.state === "dispatched_unknown"
        && attempt.workItemFence?.workItemId === workItem.id
        && attempt.workItemFence.runId === workItem.runId
        && attempt.workItemFence.attempt === workItem.attempt)
      .map(({ attemptKey }) => attemptKey);
    const proofAttemptKeys = status.proofs
      .flatMap(({ attempts }) => attempts)
      .filter((attempt) =>
        attempt.state === "dispatched_unknown"
        && attempt.workItemId === workItem.id
        && attempt.runId === workItem.runId
        && attempt.workItemAttempt === workItem.attempt)
      .map(({ attemptKey }) => attemptKey);
    if (providerAttemptKeys.length === 0 && proofAttemptKeys.length === 0) {
      continue;
    }
    const recoveredAt = new Date().toISOString();
    await input.store.transitionWorkflowWorkItem(
      workItem.id,
      "manual-required",
      {
        now: recoveredAt,
        expectedState: "running",
        expectedLeaseOwner: workItem.leaseOwner,
        expectedAttempt: workItem.attempt,
        attempt: workItem.attempt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: CCC_CAMPAIGN_UNCERTAIN_EFFECT_RECOVERY_REASON,
        blockedReason: CCC_CAMPAIGN_UNCERTAIN_EFFECT_RECOVERY_REASON,
      },
    );
    recovered.push(Object.freeze({
      workItemId: workItem.id,
      taskId: workItem.taskId,
      runId: workItem.runId,
      attempt: workItem.attempt,
      previousLeaseOwner: workItem.leaseOwner,
      providerAttemptKeys: Object.freeze(providerAttemptKeys),
      proofAttemptKeys: Object.freeze(proofAttemptKeys),
      recoveredAt,
    }));
  }

  return Object.freeze(recovered);
}
