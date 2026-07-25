import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import { reconstructCccCampaignCustody } from "./custody.js";
import {
  CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
  type CccCampaignContext,
} from "./types.js";

export class CccCampaignContextError extends Error {
  public readonly code = "CCC_CAMPAIGN_CONTEXT_REFUSED";

  public constructor(message: string) {
    super(message);
    this.name = "CccCampaignContextError";
  }
}

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

export async function loadCccCampaignContextForTask(
  layer: AsyncDataLayer,
  rootDir: string,
  taskId: string,
): Promise<CccCampaignContext | null> {
  const projectId = projectIdFor(layer);
  const rows = await layer.db
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
    })
    .from(schema.project.cccPrdImportEntities)
    .innerJoin(
      schema.project.cccPrdImports,
      and(
        eq(
          schema.project.cccPrdImports.projectId,
          schema.project.cccPrdImportEntities.projectId,
        ),
        eq(
          schema.project.cccPrdImports.importId,
          schema.project.cccPrdImportEntities.importId,
        ),
      ),
    )
    .where(and(
      eq(schema.project.cccPrdImportEntities.projectId, projectId),
      eq(schema.project.cccPrdImportEntities.entityType, "task"),
      eq(schema.project.cccPrdImportEntities.nativeId, taskId),
    ))
    .limit(2);
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
  if (
    resolve(row.targetRepository) !== resolve(rootDir)
    || resolve(row.targetRepository) !== resolve(manifest.targetRepository.path)
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
  if (
    !row.activeActionLeases
    || typeof row.activeActionLeases !== "object"
    || Array.isArray(row.activeActionLeases)
  ) {
    throw new CccCampaignContextError(
      `Task ${taskId} campaign action leases are invalid`,
    );
  }

  return {
    schema: CCC_CAMPAIGN_CONTEXT_SCHEMA_VERSION,
    projectId: manifest.projectId,
    importId: manifest.importId,
    idempotencyKey: manifest.idempotencyKey,
    campaignId: manifest.campaignId,
    taskId,
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
    campaignStartedAt: row.campaignStartedAt,
    campaignDeadlineAt: row.campaignDeadlineAt,
    requestCount: row.requestCount,
    activeActionLeases: { ...row.activeActionLeases },
  };
}
