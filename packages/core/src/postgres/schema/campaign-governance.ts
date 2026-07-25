import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { PgColumn } from "drizzle-orm/pg-core";
import { cccPrdImports } from "./ccc-prd-import.js";
import { PROJECT_SCHEMA } from "./_shared.js";

const campaignGovernanceSchema = pgSchema(PROJECT_SCHEMA);

type CampaignBindingColumns = {
  projectId: PgColumn;
  campaignProjectId: PgColumn;
  campaignImportId: PgColumn;
  campaignId: PgColumn;
  campaignTaskId: PgColumn;
  campaignActionId: PgColumn;
  campaignActionTarget: PgColumn;
  campaignIdempotencyKey: PgColumn;
  campaignPacketHash: PgColumn;
  campaignSidecarHash: PgColumn;
  campaignBundleHash: PgColumn;
  campaignTargetRepository: PgColumn;
  campaignTargetBase: PgColumn;
  campaignProviderId: PgColumn;
  campaignModelId: PgColumn;
  campaignTransport: PgColumn;
  campaignManifestHash: PgColumn;
  campaignBindingHash: PgColumn;
};

const campaignBindingCheck = (table: CampaignBindingColumns, eventKey?: PgColumn) => sql`
  (
    ${table.campaignProjectId} IS NULL
    AND ${table.campaignImportId} IS NULL
    AND ${table.campaignId} IS NULL
    AND ${table.campaignTaskId} IS NULL
    AND ${table.campaignActionId} IS NULL
    AND ${table.campaignActionTarget} IS NULL
    AND ${table.campaignIdempotencyKey} IS NULL
    AND ${table.campaignPacketHash} IS NULL
    AND ${table.campaignSidecarHash} IS NULL
    AND ${table.campaignBundleHash} IS NULL
    AND ${table.campaignTargetRepository} IS NULL
    AND ${table.campaignTargetBase} IS NULL
    AND ${table.campaignProviderId} IS NULL
    AND ${table.campaignModelId} IS NULL
    AND ${table.campaignTransport} IS NULL
    AND ${table.campaignManifestHash} IS NULL
    AND ${table.campaignBindingHash} IS NULL
    ${eventKey ? sql`AND ${eventKey} IS NULL` : sql``}
  )
  OR (
    ${table.campaignProjectId} IS NOT NULL
    AND ${table.campaignImportId} IS NOT NULL
    AND ${table.campaignId} IS NOT NULL
    AND ${table.campaignTaskId} IS NOT NULL
    AND ${table.campaignActionId} IS NOT NULL
    AND ${table.campaignActionTarget} IS NOT NULL
    AND ${table.campaignIdempotencyKey} IS NOT NULL
    AND ${table.campaignPacketHash} IS NOT NULL
    AND ${table.campaignSidecarHash} IS NOT NULL
    AND ${table.campaignBundleHash} IS NOT NULL
    AND ${table.campaignTargetRepository} IS NOT NULL
    AND ${table.campaignTargetBase} IS NOT NULL
    AND ${table.campaignProviderId} IS NOT NULL
    AND ${table.campaignModelId} IS NOT NULL
    AND ${table.campaignTransport} IS NOT NULL
    AND ${table.campaignManifestHash} IS NOT NULL
    AND ${table.campaignBindingHash} IS NOT NULL
    ${eventKey ? sql`AND ${eventKey} IS NOT NULL` : sql``}
    AND ${table.campaignProjectId} = ${table.projectId}
  )
`;

export const runAuditEvents = campaignGovernanceSchema.table("run_audit_events", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  timestamp: text("timestamp").notNull(),
  taskId: text("task_id"),
  agentId: text("agent_id").notNull(),
  runId: text("run_id").notNull(),
  domain: text("domain").notNull(),
  mutationType: text("mutation_type").notNull(),
  target: text("target").notNull(),
  metadata: jsonb("metadata"),
  campaignProjectId: text("campaign_project_id"),
  campaignImportId: text("campaign_import_id"),
  campaignId: text("campaign_id"),
  campaignTaskId: text("campaign_task_id"),
  campaignActionId: text("campaign_action_id"),
  campaignActionTarget: text("campaign_action_target"),
  campaignIdempotencyKey: text("campaign_idempotency_key"),
  campaignPacketHash: text("campaign_packet_hash"),
  campaignSidecarHash: text("campaign_sidecar_hash"),
  campaignBundleHash: text("campaign_bundle_hash"),
  campaignTargetRepository: text("campaign_target_repository"),
  campaignTargetBase: text("campaign_target_base"),
  campaignProviderId: text("campaign_provider_id"),
  campaignModelId: text("campaign_model_id"),
  campaignTransport: text("campaign_transport"),
  campaignManifestHash: text("campaign_manifest_hash"),
  campaignBindingHash: text("campaign_binding_hash"),
  campaignEventKey: text("campaign_event_key"),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxRunAuditEventsRunIdTimestamp").on(t.runId, t.timestamp),
  index("idxRunAuditEventsTaskIdTimestamp").on(t.taskId, t.timestamp),
  index("idxRunAuditEventsTimestamp").on(t.timestamp),
  index("idx_run_audit_events_campaign_import").on(t.projectId, t.campaignImportId),
  uniqueIndex("ux_run_audit_events_campaign_event")
    .on(t.projectId, t.campaignEventKey)
    .where(sql`${t.campaignEventKey} IS NOT NULL`),
  check("run_audit_events_campaign_binding_check", campaignBindingCheck(t, t.campaignEventKey)),
  foreignKey({
    name: "run_audit_events_campaign_import_fkey",
    columns: [t.projectId, t.campaignImportId],
    foreignColumns: [cccPrdImports.projectId, cccPrdImports.importId],
  }).onDelete("no action").onUpdate("no action"),
]);

export const approvalRequests = campaignGovernanceSchema.table("approval_requests", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  status: text("status").notNull(),
  requesterActorId: text("requester_actor_id").notNull(),
  requesterActorType: text("requester_actor_type").notNull(),
  requesterActorName: text("requester_actor_name").notNull(),
  targetActionCategory: text("target_action_category").notNull(),
  targetActionOperation: text("target_action_operation").notNull(),
  targetActionSummary: text("target_action_summary").notNull(),
  targetResourceType: text("target_resource_type").notNull(),
  targetResourceId: text("target_resource_id").notNull(),
  targetContext: jsonb("target_context"),
  taskId: text("task_id"),
  runId: text("run_id"),
  requestedAt: text("requested_at").notNull(),
  decidedAt: text("decided_at"),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  notBeforeAt: text("not_before_at"),
  expiresAt: text("expires_at"),
  claimToken: text("claim_token"),
  claimedAt: text("claimed_at"),
  campaignProjectId: text("campaign_project_id"),
  campaignImportId: text("campaign_import_id"),
  campaignId: text("campaign_id"),
  campaignTaskId: text("campaign_task_id"),
  campaignActionId: text("campaign_action_id"),
  campaignActionTarget: text("campaign_action_target"),
  campaignIdempotencyKey: text("campaign_idempotency_key"),
  campaignPacketHash: text("campaign_packet_hash"),
  campaignSidecarHash: text("campaign_sidecar_hash"),
  campaignBundleHash: text("campaign_bundle_hash"),
  campaignTargetRepository: text("campaign_target_repository"),
  campaignTargetBase: text("campaign_target_base"),
  campaignProviderId: text("campaign_provider_id"),
  campaignModelId: text("campaign_model_id"),
  campaignTransport: text("campaign_transport"),
  campaignManifestHash: text("campaign_manifest_hash"),
  campaignBindingHash: text("campaign_binding_hash"),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxApprovalRequestsStatusCreatedAt").on(t.status, t.createdAt),
  index("idxApprovalRequestsRequesterCreatedAt").on(t.requesterActorId, t.createdAt),
  index("idxApprovalRequestsTaskCreatedAt").on(t.taskId, t.createdAt),
  index("idx_approval_requests_campaign_import").on(t.projectId, t.campaignImportId),
  uniqueIndex("ux_approval_requests_campaign_action")
    .on(t.projectId, t.campaignImportId, t.campaignActionId)
    .where(sql`${t.campaignProjectId} IS NOT NULL`),
  check("approval_requests_status_check", sql`${t.status} IN ('pending', 'approved', 'denied', 'completed', 'issued', 'claimed', 'consumed', 'expired')`),
  check("approval_requests_campaign_binding_check", campaignBindingCheck(t)),
  check("approval_requests_campaign_lifecycle_check", sql`
    (
      ${t.campaignProjectId} IS NULL
      AND ${t.notBeforeAt} IS NULL
      AND ${t.expiresAt} IS NULL
      AND ${t.claimToken} IS NULL
      AND ${t.claimedAt} IS NULL
      AND ${t.status} IN ('pending', 'approved', 'denied', 'completed')
    )
    OR (
      ${t.campaignProjectId} IS NOT NULL
      AND ${t.notBeforeAt} IS NOT NULL
      AND ${t.expiresAt} IS NOT NULL
      AND ${t.notBeforeAt} <= ${t.expiresAt}
      AND (
        (${t.status} = 'issued' AND ${t.claimToken} IS NULL AND ${t.claimedAt} IS NULL)
        OR (${t.status} = 'claimed' AND ${t.claimToken} IS NOT NULL AND ${t.claimedAt} IS NOT NULL)
        OR (${t.status} = 'consumed' AND ${t.claimToken} IS NOT NULL AND ${t.claimedAt} IS NOT NULL AND ${t.completedAt} IS NOT NULL)
        OR (${t.status} = 'denied' AND ${t.claimToken} IS NULL AND ${t.claimedAt} IS NULL AND ${t.decidedAt} IS NOT NULL)
        OR (${t.status} = 'expired' AND ${t.decidedAt} IS NOT NULL AND (
          (${t.claimToken} IS NULL AND ${t.claimedAt} IS NULL)
          OR (${t.claimToken} IS NOT NULL AND ${t.claimedAt} IS NOT NULL)
        ))
      )
    )
  `),
  foreignKey({
    name: "approval_requests_campaign_import_fkey",
    columns: [t.projectId, t.campaignImportId],
    foreignColumns: [cccPrdImports.projectId, cccPrdImports.importId],
  }).onDelete("no action").onUpdate("no action"),
]);

export const approvalRequestAuditEvents = campaignGovernanceSchema.table("approval_request_audit_events", {
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  id: text("id").notNull(),
  requestId: text("request_id").notNull(),
  eventType: text("event_type").notNull(),
  actorId: text("actor_id").notNull(),
  actorType: text("actor_type").notNull(),
  actorName: text("actor_name").notNull(),
  note: text("note"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxApprovalRequestAuditRequestCreatedAt").on(t.requestId, t.createdAt, t.id),
  index("idxApprovalRequestAuditProjectCreatedAt").on(t.projectId, t.createdAt),
]);
