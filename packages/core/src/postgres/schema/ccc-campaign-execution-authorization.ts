import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { approvalRequests } from "./campaign-governance.js";
import { cccPrdImports } from "./ccc-prd-import.js";
import { PROJECT_SCHEMA } from "./_shared.js";

const cccCampaignExecutionAuthorizationSchema = pgSchema(PROJECT_SCHEMA);

/**
 * FNXC:CCCCampaignExecutionAuthorization 2026-08-12:
 * One immutable parent binds the complete sealed campaign launch. Mutable
 * work-item attempts, leases, request counters, and timestamps are deliberately
 * absent from the authorization digest custody stored here.
 */
export const cccCampaignExecutionAuthorizations =
  cccCampaignExecutionAuthorizationSchema.table(
    "ccc_campaign_execution_authorizations",
    {
      projectId: text("project_id").notNull().default(
        sql`COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__')`,
      ),
      authorizationId: text("authorization_id").notNull(),
      schemaVersion: text("schema_version").notNull(),
      importId: text("import_id").notNull(),
      campaignId: text("campaign_id").notNull(),
      idempotencyKey: text("idempotency_key").notNull(),
      workflowId: text("workflow_id").notNull(),
      workItemId: text("work_item_id").notNull(),
      workflowIrHash: text("workflow_ir_hash").notNull(),
      packetHash: text("packet_hash").notNull(),
      sidecarHash: text("sidecar_hash").notNull(),
      bundleHash: text("bundle_hash").notNull(),
      manifestHash: text("manifest_hash").notNull(),
      executionPolicySha256: text("execution_policy_sha256").notNull(),
      targetRepository: text("target_repository").notNull(),
      targetBase: text("target_base").notNull(),
      campaignStartedAt: text("campaign_started_at").notNull(),
      campaignDeadlineAt: text("campaign_deadline_at").notNull(),
      maxRequests: integer("max_requests").notNull(),
      maxConcurrency: integer("max_concurrency").notNull(),
      memberSetHash: text("member_set_hash").notNull(),
      authorizationDigest: text("authorization_digest").notNull(),
      expectedRequestCount: integer("expected_request_count").notNull(),
      status: text("status").notNull(),
      requesterActorId: text("requester_actor_id").notNull(),
      requesterActorType: text("requester_actor_type").notNull(),
      requesterActorName: text("requester_actor_name").notNull(),
      notBeforeAt: text("not_before_at").notNull(),
      expiresAt: text("expires_at").notNull(),
      claimToken: text("claim_token"),
      claimedAt: text("claimed_at"),
      settledAt: text("settled_at"),
      createdAt: text("created_at").notNull(),
      updatedAt: text("updated_at").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.projectId, t.authorizationId] }),
      unique("ccc_campaign_execution_authorizations_project_import_unique")
        .on(t.projectId, t.importId),
      unique("ccc_campaign_execution_authorizations_project_digest_unique")
        .on(t.projectId, t.authorizationDigest),
      foreignKey({
        name: "ccc_campaign_execution_authorizations_import_fkey",
        columns: [t.projectId, t.importId],
        foreignColumns: [cccPrdImports.projectId, cccPrdImports.importId],
      }).onDelete("no action").onUpdate("no action"),
      index("idx_ccc_campaign_execution_authorizations_campaign")
        .on(t.projectId, t.campaignId),
      index("idx_ccc_campaign_execution_authorizations_status")
        .on(t.projectId, t.status, t.createdAt),
      check(
        "ccc_campaign_execution_authorizations_schema_version_check",
        sql`${t.schemaVersion} = 'ccc-campaign.execution-authorization.v1'`,
      ),
      check(
        "ccc_campaign_execution_authorizations_identity_check",
        sql`${t.authorizationId} = 'ccc-execution-authorization-' || ${t.authorizationDigest}`,
      ),
      check(
        "ccc_campaign_execution_authorizations_hashes_check",
        sql`
          ${t.workflowIrHash} ~ '^[0-9a-f]{64}$'
          AND ${t.packetHash} ~ '^[0-9a-f]{64}$'
          AND ${t.sidecarHash} ~ '^[0-9a-f]{64}$'
          AND ${t.bundleHash} ~ '^[0-9a-f]{64}$'
          AND ${t.manifestHash} ~ '^[0-9a-f]{64}$'
          AND ${t.executionPolicySha256} ~ '^[0-9a-f]{64}$'
          AND ${t.targetBase} ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
          AND ${t.memberSetHash} ~ '^[0-9a-f]{64}$'
          AND ${t.authorizationDigest} ~ '^[0-9a-f]{64}$'
        `,
      ),
      check(
        "ccc_campaign_execution_authorizations_bounds_check",
        sql`
          ${t.maxRequests} > 0
          AND ${t.maxConcurrency} > 0
          AND ${t.expectedRequestCount} >= 0
          AND ${t.expectedRequestCount} <= ${t.maxRequests}
        `,
      ),
      check(
        "ccc_campaign_execution_authorizations_window_check",
        sql`
          ${t.campaignStartedAt} <= ${t.notBeforeAt}
          AND ${t.notBeforeAt} <= ${t.expiresAt}
          AND ${t.expiresAt} <= ${t.campaignDeadlineAt}
        `,
      ),
      check(
        "ccc_campaign_execution_authorizations_status_check",
        sql`${t.status} IN ('issued', 'claimed', 'settled')`,
      ),
      check(
        "ccc_campaign_execution_authorizations_lifecycle_check",
        sql`
          (
            ${t.status} = 'issued'
            AND ${t.claimToken} IS NULL
            AND ${t.claimedAt} IS NULL
            AND ${t.settledAt} IS NULL
          )
          OR (
            ${t.status} = 'claimed'
            AND ${t.claimToken} IS NOT NULL
            AND ${t.claimedAt} IS NOT NULL
            AND ${t.settledAt} IS NULL
          )
          OR (
            ${t.status} = 'settled'
            AND ${t.claimToken} IS NOT NULL
            AND ${t.claimedAt} IS NOT NULL
            AND ${t.settledAt} IS NOT NULL
            AND ${t.claimedAt} <= ${t.settledAt}
          )
        `,
      ),
    ],
  );

/**
 * Canonically ordered members map one parent launch to the existing exact
 * task/action child approvals. Members have no lifecycle of their own: child
 * approval rows and action leases remain the dispatch and settlement authority.
 */
export const cccCampaignExecutionAuthorizationMembers =
  cccCampaignExecutionAuthorizationSchema.table(
    "ccc_campaign_execution_authorization_members",
    {
      projectId: text("project_id").notNull().default(
        sql`COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__')`,
      ),
      authorizationId: text("authorization_id").notNull(),
      ordinal: integer("ordinal").notNull(),
      nativeTaskId: text("native_task_id").notNull(),
      semanticTaskId: text("semantic_task_id").notNull(),
      actionId: text("action_id").notNull(),
      actionTarget: text("action_target").notNull(),
      providerId: text("provider_id").notNull(),
      modelId: text("model_id").notNull(),
      transport: text("transport").notNull(),
      promptSchema: text("prompt_schema").notNull(),
      promptSha256: text("prompt_sha256").notNull(),
      routeSha256: text("route_sha256").notNull(),
      bindingHash: text("binding_hash").notNull(),
      approvalRequestId: text("approval_request_id").notNull(),
      memberHash: text("member_hash").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.projectId, t.authorizationId, t.ordinal] }),
      unique("ccc_campaign_execution_authorization_members_binding_unique")
        .on(t.projectId, t.authorizationId, t.bindingHash),
      unique("ccc_campaign_execution_authorization_members_task_action_unique")
        .on(t.projectId, t.authorizationId, t.nativeTaskId, t.actionId),
      unique("ccc_campaign_execution_authorization_members_native_task_unique")
        .on(t.projectId, t.authorizationId, t.nativeTaskId),
      unique("ccc_campaign_execution_auth_members_semantic_task_unique")
        .on(t.projectId, t.authorizationId, t.semanticTaskId),
      unique("ccc_campaign_execution_authorization_members_approval_unique")
        .on(t.projectId, t.approvalRequestId),
      unique("ccc_campaign_execution_authorization_members_member_hash_unique")
        .on(t.projectId, t.authorizationId, t.memberHash),
      foreignKey({
        name: "ccc_campaign_execution_authorization_members_authorization_fkey",
        columns: [t.projectId, t.authorizationId],
        foreignColumns: [
          cccCampaignExecutionAuthorizations.projectId,
          cccCampaignExecutionAuthorizations.authorizationId,
        ],
      }).onDelete("cascade").onUpdate("no action"),
      foreignKey({
        name: "ccc_campaign_execution_authorization_members_approval_fkey",
        columns: [t.projectId, t.approvalRequestId],
        foreignColumns: [approvalRequests.projectId, approvalRequests.id],
      }).onDelete("no action").onUpdate("no action"),
      index("idx_ccc_campaign_execution_authorization_members_task_action")
        .on(t.projectId, t.nativeTaskId, t.actionId),
      check(
        "ccc_campaign_execution_authorization_members_ordinal_check",
        sql`${t.ordinal} >= 0`,
      ),
      check(
        "ccc_campaign_execution_authorization_members_transport_check",
        sql`${t.transport} IN ('pi', 'cli', 'workflow')`,
      ),
      check(
        "ccc_campaign_execution_auth_members_prompt_schema_check",
        sql`${t.promptSchema} IN ('ccc-prd.execution-prompt.v1', 'ccc-prd.execution-prompt.v2')`,
      ),
      check(
        "ccc_campaign_execution_authorization_members_hashes_check",
        sql`
          ${t.promptSha256} ~ '^[0-9a-f]{64}$'
          AND ${t.routeSha256} ~ '^[0-9a-f]{64}$'
          AND ${t.bindingHash} ~ '^[0-9a-f]{64}$'
          AND ${t.memberHash} ~ '^[0-9a-f]{64}$'
        `,
      ),
      check(
        "ccc_campaign_execution_authorization_members_approval_id_check",
        sql`${t.approvalRequestId} = 'ccc-approval-' || ${t.bindingHash}`,
      ),
    ],
  );
