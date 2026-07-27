import { realpath } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { canonicalCccPrdJson, compareCccPrdCodeUnits } from "../ccc-prd/contract.js";
import type { CccPrdTask } from "../ccc-prd/types.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import { createCccCampaignAuthorityBinding } from "./canonical.js";
import { reconstructCccCampaignCustody } from "./custody.js";
import {
  CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
  CccCampaignContextError,
  type CccCampaignActionLease,
  type CccCampaignActionLookup,
  type CccCampaignAuthorityBinding,
  type CccCampaignContext,
  type CccCampaignTaskContext,
} from "./types.js";

export { CccCampaignContextError } from "./types.js";

function projectIdFor(layer: AsyncDataLayer): string {
  return layer.projectId?.trim() || "__legacy_unscoped__";
}

function requireIsoTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new CccCampaignContextError(`${label} is not a canonical ISO timestamp`);
  }
  return timestamp;
}

const LEASE_KEYS = [
  "actionId",
  "actionTarget",
  "approvalRequestId",
  "bindingHash",
  "claimToken",
  "claimedAt",
  "expiresAt",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requireLeaseText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new CccCampaignContextError(`${label} must be a non-empty canonical string`);
  }
  return value;
}

function requireLeaseHash(value: unknown, label: string): string {
  const hash = requireLeaseText(value, label);
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new CccCampaignContextError(`${label} must be a lowercase SHA-256 hash`);
  }
  return hash;
}

function requireCanonicalProofIds(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CccCampaignContextError(`${label} must be a non-empty canonical proof ID set`);
  }
  const proofIds = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry !== entry.trim()) {
      throw new CccCampaignContextError(`${label}[${index}] must be a non-empty canonical string`);
    }
    return entry;
  });
  const canonical = [...proofIds].sort(compareCccPrdCodeUnits);
  if (
    new Set(proofIds).size !== proofIds.length
    || canonicalCccPrdJson(proofIds) !== canonicalCccPrdJson(canonical)
  ) {
    throw new CccCampaignContextError(`${label} must be unique and sorted canonically`);
  }
  return Object.freeze([...proofIds]);
}

function taskProofIds(
  bundleTasks: readonly CccPrdTask[],
  semanticTaskId: string,
  taskId: string,
): readonly string[] {
  const matches = bundleTasks.filter(({ id }) => id === semanticTaskId);
  if (matches.length !== 1) {
    throw new CccCampaignContextError(
      `Task ${taskId} has no exact semantic campaign task authority`,
    );
  }
  return requireCanonicalProofIds(
    matches[0]!.proofIds,
    `Task ${taskId} semantic campaign proof IDs`,
  );
}

function requireCanonicalProtectedActionIds(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new CccCampaignContextError(`${label} must be a canonical protected-action ID set`);
  }
  const actionIds = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry !== entry.trim()) {
      throw new CccCampaignContextError(`${label}[${index}] must be a non-empty canonical string`);
    }
    return entry;
  });
  const canonical = [...actionIds].sort(compareCccPrdCodeUnits);
  if (
    new Set(actionIds).size !== actionIds.length
    || canonicalCccPrdJson(actionIds) !== canonicalCccPrdJson(canonical)
  ) {
    throw new CccCampaignContextError(`${label} must be unique and sorted canonically`);
  }
  return Object.freeze([...actionIds]);
}

function taskProtectedActionIds(
  bundleTasks: readonly CccPrdTask[],
  semanticTaskId: string,
  taskId: string,
): readonly string[] {
  const matches = bundleTasks.filter(({ id }) => id === semanticTaskId);
  if (matches.length !== 1) {
    throw new CccCampaignContextError(
      `Task ${taskId} has no exact semantic campaign task authority`,
    );
  }
  return requireCanonicalProtectedActionIds(
    matches[0]!.protectedActionIds,
    `Task ${taskId} semantic campaign protected-action IDs`,
  );
}

function assertProtectedActionIdsExist(
  actionIds: readonly string[],
  bundleActionIds: readonly string[],
  taskId: string,
): void {
  const bundleActionSet = new Set(bundleActionIds);
  if (!actionIds.every((actionId) => bundleActionSet.has(actionId))) {
    throw new CccCampaignContextError(
      `Task ${taskId} campaign protected-action IDs are not declared bundle actions`,
    );
  }
}

function assertProofIdsExist(
  proofIds: readonly string[],
  bundleProofIds: readonly string[],
  taskId: string,
): void {
  const bundleProofSet = new Set(bundleProofIds);
  if (!proofIds.every((proofId) => bundleProofSet.has(proofId))) {
    throw new CccCampaignContextError(
      `Task ${taskId} campaign proof IDs are not declared bundle proofs`,
    );
  }
}

function nativeTaskProofIds(
  sourceMetadata: unknown,
  taskId: string,
  bundleHash: string,
): readonly string[] {
  if (!isRecord(sourceMetadata)) {
    throw new CccCampaignContextError(`Task ${taskId} native source metadata is missing`);
  }
  if (sourceMetadata.bundleHash !== bundleHash) {
    throw new CccCampaignContextError(
      `Task ${taskId} native source metadata bundle hash does not match campaign custody`,
    );
  }
  return requireCanonicalProofIds(
    sourceMetadata.proofIds,
    `Task ${taskId} native source metadata proof IDs`,
  );
}

function assertExactProofIds(
  actual: readonly string[],
  expected: readonly string[],
  taskId: string,
): void {
  if (canonicalCccPrdJson(actual) !== canonicalCccPrdJson(expected)) {
    throw new CccCampaignContextError(
      `Task ${taskId} campaign proof IDs do not match immutable semantic task authority`,
    );
  }
}

function exactLeaseKeys(value: Record<string, unknown>, actionId: string): void {
  const observed = Object.keys(value).sort(compareCccPrdCodeUnits);
  const expected = [...LEASE_KEYS].sort(compareCccPrdCodeUnits);
  if (canonicalCccPrdJson(observed) !== canonicalCccPrdJson(expected)) {
    throw new CccCampaignContextError(
      `CCC campaign action lease ${actionId} fields must be exactly ${expected.join(", ")}`,
    );
  }
}

function parseCccCampaignActionLease(
  value: unknown,
  actionId: string,
  campaignDeadlineAt: string,
): CccCampaignActionLease {
  requireLeaseText(actionId, "CCC campaign action lease key");
  if (!isRecord(value)) {
    throw new CccCampaignContextError(`CCC campaign action lease ${actionId} must be an object`);
  }
  exactLeaseKeys(value, actionId);
  const lease: CccCampaignActionLease = {
    actionId: requireLeaseText(value.actionId, `CCC campaign action lease ${actionId} actionId`),
    actionTarget: requireLeaseText(
      value.actionTarget,
      `CCC campaign action lease ${actionId} actionTarget`,
    ),
    approvalRequestId: requireLeaseText(
      value.approvalRequestId,
      `CCC campaign action lease ${actionId} approvalRequestId`,
    ),
    claimToken: requireLeaseText(
      value.claimToken,
      `CCC campaign action lease ${actionId} claimToken`,
    ),
    claimedAt: requireLeaseText(
      value.claimedAt,
      `CCC campaign action lease ${actionId} claimedAt`,
    ),
    expiresAt: requireLeaseText(
      value.expiresAt,
      `CCC campaign action lease ${actionId} expiresAt`,
    ),
    bindingHash: requireLeaseHash(
      value.bindingHash,
      `CCC campaign action lease ${actionId} bindingHash`,
    ),
  };
  if (lease.actionId !== actionId) {
    throw new CccCampaignContextError(
      `CCC campaign action lease ${actionId} key does not match actionId`,
    );
  }
  const claimedAt = requireIsoTimestamp(lease.claimedAt, `CCC campaign action lease ${actionId} claimedAt`);
  const expiresAt = requireIsoTimestamp(lease.expiresAt, `CCC campaign action lease ${actionId} expiresAt`);
  const deadlineAt = requireIsoTimestamp(campaignDeadlineAt, "campaignDeadlineAt");
  if (expiresAt <= claimedAt || expiresAt > deadlineAt) {
    throw new CccCampaignContextError(
      `CCC campaign action lease ${actionId} expiry must be after claim and no later than campaign deadline`,
    );
  }
  return lease;
}

export function assertCccCampaignActionLease(
  value: unknown,
  actionId: string,
  campaignDeadlineAt: string,
): CccCampaignActionLease {
  return parseCccCampaignActionLease(value, actionId, campaignDeadlineAt);
}

function parseCccCampaignActionLeases(
  value: unknown,
  campaignDeadlineAt: string,
): Record<string, CccCampaignActionLease> {
  if (!isRecord(value)) {
    throw new CccCampaignContextError("CCC campaign action leases must be an object");
  }
  const leases: Record<string, CccCampaignActionLease> = {};
  for (const actionId of Object.keys(value).sort(compareCccPrdCodeUnits)) {
    leases[actionId] = parseCccCampaignActionLease(
      value[actionId],
      actionId,
      campaignDeadlineAt,
    );
  }
  return leases;
}

function parseCccCampaignActionLeaseBuckets(
  value: unknown,
  campaignDeadlineAt: string,
): Record<string, Record<string, CccCampaignActionLease>> {
  if (!isRecord(value)) {
    throw new CccCampaignContextError("CCC campaign action leases must be an object");
  }
  const buckets: Record<string, Record<string, CccCampaignActionLease>> = {};
  for (const taskId of Object.keys(value).sort(compareCccPrdCodeUnits)) {
    requireLeaseText(taskId, "CCC campaign action lease task key");
    const bucket = value[taskId];
    if (isRecord(bucket) && typeof bucket.actionId === "string") {
      throw new CccCampaignContextError(
        "CCC campaign action leases must be keyed by task ID; legacy flat lease rows are unsupported",
      );
    }
    buckets[taskId] = parseCccCampaignActionLeases(bucket, campaignDeadlineAt);
  }
  return buckets;
}

export async function loadCccCampaignContextForTask(
  layer: AsyncDataLayer,
  rootDir: string,
  taskId: string,
  tx?: DbTransaction,
  lockForUpdate = false,
): Promise<CccCampaignTaskContext | null> {
  const projectId = projectIdFor(layer);
  const query = tx ?? layer.db;
  const selection = query
    .select({
      projectId: schema.project.cccPrdImports.projectId,
      idempotencyKey: schema.project.cccPrdImports.idempotencyKey,
      importId: schema.project.cccPrdImports.importId,
      identityHash: schema.project.cccPrdImports.identityHash,
      bundleHash: schema.project.cccPrdImports.bundleHash,
      packetHash: schema.project.cccPrdImports.packetHash,
      sidecarHash: schema.project.cccPrdImports.sidecarHash,
      sourceVersion: schema.project.cccPrdImports.sourceVersion,
      targetRepository: schema.project.cccPrdImports.targetRepository,
      targetBase: schema.project.cccPrdImports.targetBase,
      state: schema.project.cccPrdImports.state,
      runnable: schema.project.cccPrdImports.runnable,
      canonicalBundle: schema.project.cccPrdImports.canonicalBundle,
      executionPolicy: schema.project.cccPrdImports.executionPolicy,
      campaignManifest: schema.project.cccPrdImports.campaignManifest,
      campaignManifestHash: schema.project.cccPrdImports.campaignManifestHash,
      campaignStartedAt: schema.project.cccPrdImports.campaignStartedAt,
      campaignDeadlineAt: schema.project.cccPrdImports.campaignDeadlineAt,
      requestCount: schema.project.cccPrdImports.requestCount,
      activeActionLeases: schema.project.cccPrdImports.activeActionLeases,
      semanticTaskId: schema.project.cccPrdImportEntities.entityId,
      nativeTaskId: schema.project.cccPrdImportEntities.nativeId,
      nativeTaskSourceMetadata: schema.project.tasks.sourceMetadata,
    })
    .from(schema.project.cccPrdImports)
    .innerJoin(
      schema.project.cccPrdImportEntities,
      and(
        eq(
          schema.project.cccPrdImportEntities.projectId,
          schema.project.cccPrdImports.projectId,
        ),
        eq(
          schema.project.cccPrdImportEntities.importId,
          schema.project.cccPrdImports.importId,
        ),
      ),
    )
    .innerJoin(
      schema.project.tasks,
      and(
        eq(schema.project.tasks.projectId, schema.project.cccPrdImportEntities.projectId),
        eq(schema.project.tasks.id, schema.project.cccPrdImportEntities.nativeId),
      ),
    )
    .where(and(
      eq(schema.project.cccPrdImportEntities.projectId, projectId),
      eq(schema.project.cccPrdImportEntities.entityType, "task"),
      eq(schema.project.cccPrdImportEntities.nativeId, taskId),
    ))
    .limit(2);
  const rows = lockForUpdate ? await selection.for("update") : await selection;
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new CccCampaignContextError(
      `Task ${taskId} has ambiguous CCC campaign custody`,
    );
  }

  const row = rows[0]!;
  if (row.state !== "active" || row.runnable !== 1) {
    throw new CccCampaignContextError(
      `Task ${taskId} belongs to a non-runnable CCC campaign import`,
    );
  }
  let custody;
  try {
    custody = reconstructCccCampaignCustody(row);
  } catch {
    throw new CccCampaignContextError(
      `Task ${taskId} campaign custody is missing, unadmitted, or drifted`,
    );
  }
  const { bundle, executionPolicy, manifest, manifestHash } = custody;
  let physicalRoot: string;
  try {
    physicalRoot = await realpath(rootDir);
  } catch {
    throw new CccCampaignContextError(
      `Task ${taskId} campaign target is unavailable`,
    );
  }
  if (
    row.targetRepository !== physicalRoot
    || manifest.targetRepository.path !== physicalRoot
  ) {
    throw new CccCampaignContextError(
      `Task ${taskId} campaign target does not match its TaskStore root`,
    );
  }

  const route = executionPolicy.routes.find(
    ({ taskId: routeTaskId }) => routeTaskId === row.semanticTaskId,
  );
  if (!route || row.nativeTaskId !== taskId) {
    throw new CccCampaignContextError(
      `Task ${taskId} has no exact persisted campaign execution route`,
    );
  }
  const proofIds = taskProofIds(bundle.tasks, row.semanticTaskId, taskId);
  assertProofIdsExist(
    proofIds,
    bundle.proofs.map(({ id }) => id),
    taskId,
  );
  const metadataProofIds = nativeTaskProofIds(
    row.nativeTaskSourceMetadata,
    taskId,
    bundle.bundleHash,
  );
  assertExactProofIds(metadataProofIds, proofIds, taskId);
  const protectedActionIds = taskProtectedActionIds(bundle.tasks, row.semanticTaskId, taskId);
  assertProtectedActionIdsExist(
    protectedActionIds,
    bundle.protectedActions.map(({ id }) => id),
    taskId,
  );
  const startedAt = requireIsoTimestamp(row.campaignStartedAt, "campaignStartedAt");
  const deadlineAt = requireIsoTimestamp(row.campaignDeadlineAt, "campaignDeadlineAt");
  if (deadlineAt !== startedAt + bundle.bounds.maxDurationMs) {
    throw new CccCampaignContextError(
      `Task ${taskId} campaign deadline is inconsistent with its admitted bound`,
    );
  }
  if (!Number.isSafeInteger(row.requestCount) || row.requestCount < 0) {
    throw new CccCampaignContextError(
      `Task ${taskId} campaign request count is invalid`,
    );
  }
  const actionLeaseBuckets = parseCccCampaignActionLeaseBuckets(
    row.activeActionLeases,
    row.campaignDeadlineAt,
  );
  const activeActionLeases = actionLeaseBuckets[taskId] ?? {};

  const context: CccCampaignTaskContext = {
    schema: CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
    projectId: manifest.projectId,
    importId: manifest.importId,
    idempotencyKey: manifest.idempotencyKey,
    campaignId: manifest.campaignId,
    taskId,
    semanticTaskId: row.semanticTaskId,
    proofIds,
    protectedActionIds,
    packetHash: manifest.packetHash,
    sidecarHash: manifest.sidecarHash,
    bundleHash: manifest.bundleHash,
    manifestHash,
    sourceVersion: manifest.sourceVersion,
    targetRepository: manifest.targetRepository,
    bounds: manifest.bounds,
    admittedWriteRoots: manifest.admittedWriteRoots,
    proofs: manifest.proofs,
    protectedActions: manifest.protectedActions,
    executionPolicy: manifest.executionPolicy,
    route: { ...route },
    campaignStartedAt: manifest.campaignStartedAt,
    campaignDeadlineAt: manifest.campaignDeadlineAt,
    requestCount: row.requestCount,
    activeActionLeases,
  };
  for (const [actionId, lease] of Object.entries(activeActionLeases)) {
    const binding = createCccCampaignAuthorityBinding(context, {
      actionId,
      actionTarget: lease.actionTarget,
      requireProtected: true,
    });
    if (lease.bindingHash !== binding.bindingHash) {
      throw new CccCampaignContextError(
        `CCC campaign action lease ${actionId} binding does not match persisted campaign context`,
      );
    }
  }
  return context;
}

export type CccCampaignActionLeaseClaim = {
  approvalRequestId: string;
  claimToken: string;
  claimedAt: string;
  expiresAt: string;
};

export type CccCampaignActionLeaseResult = {
  lease: CccCampaignActionLease;
  binding: CccCampaignAuthorityBinding;
};

type CccCampaignActionLeaseBaseInput = {
  layer: AsyncDataLayer;
  rootDir: string;
  taskId: string;
  action: CccCampaignActionLookup;
  tx?: DbTransaction;
};

export type ClaimCccCampaignActionLeaseInput = CccCampaignActionLeaseBaseInput & {
  claim: CccCampaignActionLeaseClaim;
};

export type InspectCccCampaignActionLeaseInput = CccCampaignActionLeaseBaseInput;

export type SettleCccCampaignActionLeaseInput = CccCampaignActionLeaseBaseInput & {
  claimToken: string;
};

export interface CccCampaignAuthorityStore {
  getCccCampaignContextForTaskWithinTransaction(
    tx: DbTransaction,
    taskId: string,
  ): Promise<CccCampaignTaskContext | null>;
  claimCccCampaignActionLease(
    taskId: string,
    action: Pick<CccCampaignActionLookup, "actionId" | "actionTarget">,
    claim: CccCampaignActionLeaseClaim,
    tx?: DbTransaction,
  ): Promise<CccCampaignActionLeaseResult>;
  inspectCccCampaignActionLease(
    taskId: string,
    action: Pick<CccCampaignActionLookup, "actionId" | "actionTarget">,
    tx?: DbTransaction,
  ): Promise<CccCampaignActionLeaseResult | null>;
  settleCccCampaignActionLease(
    taskId: string,
    action: Pick<CccCampaignActionLookup, "actionId" | "actionTarget">,
    claimToken: string,
    tx?: DbTransaction,
  ): Promise<void>;
}

function requireCampaignContext(
  context: CccCampaignContext | null,
  taskId: string,
): CccCampaignContext {
  if (!context) {
    throw new CccCampaignContextError(`Task ${taskId} has no persisted CCC campaign context`);
  }
  return context;
}

function createProtectedLeaseBinding(
  context: CccCampaignContext,
  action: CccCampaignActionLookup,
): CccCampaignAuthorityBinding {
  return createCccCampaignAuthorityBinding(context, {
    actionId: action.actionId,
    actionTarget: action.actionTarget,
    requireProtected: true,
  });
}

function createActionLease(
  binding: CccCampaignAuthorityBinding,
  claim: CccCampaignActionLeaseClaim,
  campaignDeadlineAt: string,
): CccCampaignActionLease {
  if (!claim || typeof claim !== "object") {
    throw new CccCampaignContextError("CCC campaign action lease claim is missing");
  }
  const lease: CccCampaignActionLease = {
    actionId: binding.actionId,
    actionTarget: binding.actionTarget,
    approvalRequestId: requireLeaseText(
      claim.approvalRequestId,
      `CCC campaign action lease ${binding.actionId} approvalRequestId`,
    ),
    claimToken: requireLeaseText(
      claim.claimToken,
      `CCC campaign action lease ${binding.actionId} claimToken`,
    ),
    claimedAt: requireLeaseText(
      claim.claimedAt,
      `CCC campaign action lease ${binding.actionId} claimedAt`,
    ),
    expiresAt: requireLeaseText(
      claim.expiresAt,
      `CCC campaign action lease ${binding.actionId} expiresAt`,
    ),
    bindingHash: binding.bindingHash,
  };
  parseCccCampaignActionLease(lease, lease.actionId, campaignDeadlineAt);
  return lease;
}

async function lockActionLeases(
  tx: DbTransaction,
  context: CccCampaignContext,
): Promise<Record<string, Record<string, CccCampaignActionLease>>> {
  const rows = await tx
    .select({
      projectId: schema.project.cccPrdImports.projectId,
      idempotencyKey: schema.project.cccPrdImports.idempotencyKey,
      importId: schema.project.cccPrdImports.importId,
      campaignManifestHash: schema.project.cccPrdImports.campaignManifestHash,
      campaignDeadlineAt: schema.project.cccPrdImports.campaignDeadlineAt,
      activeActionLeases: schema.project.cccPrdImports.activeActionLeases,
    })
    .from(schema.project.cccPrdImports)
    .where(and(
      eq(schema.project.cccPrdImports.projectId, context.projectId),
      eq(schema.project.cccPrdImports.idempotencyKey, context.idempotencyKey),
      eq(schema.project.cccPrdImports.importId, context.importId),
    ))
    .limit(2)
    .for("update");
  if (rows.length !== 1) {
    throw new CccCampaignContextError(
      `Task ${context.taskId} has no unique persisted CCC campaign import for its action lease`,
    );
  }
  const row = rows[0]!;
  if (
    row.campaignManifestHash !== context.manifestHash
    || row.campaignDeadlineAt !== context.campaignDeadlineAt
  ) {
    throw new CccCampaignContextError(
      `Task ${context.taskId} CCC campaign action lease context drifted before lock`,
    );
  }
  return parseCccCampaignActionLeaseBuckets(row.activeActionLeases, row.campaignDeadlineAt);
}

async function writeActionLeases(
  tx: DbTransaction,
  context: CccCampaignContext,
  actionLeaseBuckets: Record<string, Record<string, CccCampaignActionLease>>,
): Promise<void> {
  const updated = await tx
    .update(schema.project.cccPrdImports)
    .set({
      activeActionLeases: actionLeaseBuckets,
      updatedAt: new Date().toISOString(),
    })
    .where(and(
      eq(schema.project.cccPrdImports.projectId, context.projectId),
      eq(schema.project.cccPrdImports.idempotencyKey, context.idempotencyKey),
      eq(schema.project.cccPrdImports.importId, context.importId),
      eq(schema.project.cccPrdImports.campaignManifestHash, context.manifestHash),
      eq(schema.project.cccPrdImports.campaignDeadlineAt, context.campaignDeadlineAt),
    ))
    .returning({ idempotencyKey: schema.project.cccPrdImports.idempotencyKey });
  if (updated.length !== 1) {
    throw new CccCampaignContextError(
      `Task ${context.taskId} CCC campaign action lease update did not affect exactly one import`,
    );
  }
}

function assertLeaseMatchesBinding(
  lease: CccCampaignActionLease,
  binding: CccCampaignAuthorityBinding,
): void {
  if (
    lease.actionId !== binding.actionId
    || lease.actionTarget !== binding.actionTarget
    || lease.bindingHash !== binding.bindingHash
  ) {
    throw new CccCampaignContextError(
      `CCC campaign action lease ${binding.actionId} binding does not match persisted campaign context`,
    );
  }
}

function collisionMessage(
  existing: CccCampaignActionLease,
  requested: CccCampaignActionLease,
): string {
  const actionId = requested.actionId;
  if (existing.claimToken !== requested.claimToken) {
    return `CCC campaign action lease ${actionId} collision: claim token differs`;
  }
  if (existing.approvalRequestId !== requested.approvalRequestId) {
    return `CCC campaign action lease ${actionId} collision: approval request differs`;
  }
  if (existing.bindingHash !== requested.bindingHash) {
    return `CCC campaign action lease ${actionId} collision: binding hash differs`;
  }
  return `CCC campaign action lease ${actionId} collision: lease fields differ`;
}

async function claimCccCampaignActionLeaseWithinTransaction(
  input: ClaimCccCampaignActionLeaseInput,
  tx: DbTransaction,
): Promise<CccCampaignActionLeaseResult> {
  const context = requireCampaignContext(
    await loadCccCampaignContextForTask(input.layer, input.rootDir, input.taskId, tx, true),
    input.taskId,
  );
  const binding = createProtectedLeaseBinding(context, input.action);
  const requested = createActionLease(binding, input.claim, context.campaignDeadlineAt);
  const actionLeaseBuckets = await lockActionLeases(tx, context);
  const leases = actionLeaseBuckets[context.taskId] ?? {};
  const existing = leases[requested.actionId];
  if (existing) {
    assertLeaseMatchesBinding(existing, binding);
    if (canonicalCccPrdJson(existing) === canonicalCccPrdJson(requested)) {
      return { lease: existing, binding };
    }
    throw new CccCampaignContextError(collisionMessage(existing, requested));
  }
  const next = { ...leases, [requested.actionId]: requested };
  await writeActionLeases(tx, context, { ...actionLeaseBuckets, [context.taskId]: next });
  return { lease: requested, binding };
}

export async function claimCccCampaignActionLease(
  input: ClaimCccCampaignActionLeaseInput,
): Promise<CccCampaignActionLeaseResult> {
  if (input.tx) return claimCccCampaignActionLeaseWithinTransaction(input, input.tx);
  return input.layer.transactionImmediate((tx) =>
    claimCccCampaignActionLeaseWithinTransaction(input, tx));
}

export async function inspectCccCampaignActionLease(
  input: InspectCccCampaignActionLeaseInput,
): Promise<CccCampaignActionLeaseResult | null> {
  const context = requireCampaignContext(
    await loadCccCampaignContextForTask(
      input.layer,
      input.rootDir,
      input.taskId,
      input.tx,
      input.tx !== undefined,
    ),
    input.taskId,
  );
  const binding = createProtectedLeaseBinding(context, input.action);
  const lease = context.activeActionLeases[binding.actionId];
  if (!lease) return null;
  assertLeaseMatchesBinding(lease, binding);
  return { lease, binding };
}

async function settleCccCampaignActionLeaseWithinTransaction(
  input: SettleCccCampaignActionLeaseInput,
  tx: DbTransaction,
): Promise<void> {
  const context = requireCampaignContext(
    await loadCccCampaignContextForTask(input.layer, input.rootDir, input.taskId, tx, true),
    input.taskId,
  );
  const binding = createProtectedLeaseBinding(context, input.action);
  const claimToken = requireLeaseText(
    input.claimToken,
    `CCC campaign action lease ${binding.actionId} claimToken`,
  );
  const actionLeaseBuckets = await lockActionLeases(tx, context);
  const leases = actionLeaseBuckets[context.taskId] ?? {};
  const lease = leases[binding.actionId];
  if (!lease) {
    throw new CccCampaignContextError(`CCC campaign action lease ${binding.actionId} is missing`);
  }
  if (lease.claimToken !== claimToken || lease.bindingHash !== binding.bindingHash) {
    throw new CccCampaignContextError(
      `CCC campaign action lease ${binding.actionId} can only settle with its winning claim token and binding`,
    );
  }
  assertLeaseMatchesBinding(lease, binding);
  const { [binding.actionId]: _settled, ...remaining } = leases;
  await writeActionLeases(tx, context, { ...actionLeaseBuckets, [context.taskId]: remaining });
}

export async function settleCccCampaignActionLease(
  input: SettleCccCampaignActionLeaseInput,
): Promise<void> {
  if (input.tx) return settleCccCampaignActionLeaseWithinTransaction(input, input.tx);
  return input.layer.transactionImmediate((tx) =>
    settleCccCampaignActionLeaseWithinTransaction(input, tx));
}
