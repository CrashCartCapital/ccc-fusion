import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { cccPrdImports } from "./ccc-prd-import.js";
import { tasks } from "./project.js";
import { PROJECT_SCHEMA } from "./_shared.js";

const cccPlanningSchema = pgSchema(PROJECT_SCHEMA);

/**
 * FNXC:CccPlanningRuns 2026-10-14:
 * Drizzle mirror of migration 0042: the pre-import anchor for one
 * request-to-code planning run. It holds identity, the admitted grant, the
 * spend counters and the operator control request; per-call history stays
 * append-only in project.run_audit_events. Every key and foreign key starts
 * with project_id, because 0006 rebuilt the task key as (project_id, id) and
 * the boot ownership audit refuses any globally scoped key. The SQL also makes
 * both the task and the import foreign keys DEFERRABLE INITIALLY IMMEDIATE (the
 * 0037 precedent; project-partition promotion refuses a non-deferrable key
 * between two re-keyed tables, errata E2-60) and adds the row guard trigger,
 * named zz_ccc_planning_runs_guard so it fires after fusion_assign_project_id
 * (errata E2-63). Drizzle cannot express either; the migration file is
 * authoritative.
 */
export const cccPlanningRuns = cccPlanningSchema.table(
  "ccc_planning_runs",
  {
    projectId: text("project_id").notNull().default(
      sql`COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__')`,
    ),
    runId: text("run_id").notNull(),
    planningTaskId: text("planning_task_id").notNull(),
    mode: text("mode").$type<"spec" | "build">().notNull(),
    budgetProfile: text("budget_profile").$type<"standard" | "large">().notNull(),
    roleProfile: text("role_profile").$type<"full-v2" | "adaptive-v2" | "lean-v2">().notNull(),
    policyVersion: text("policy_version").notNull(),
    policyDigest: text("policy_digest").notNull(),
    requestDigest: text("request_digest").notNull(),
    requestBytes: integer("request_bytes").notNull(),
    targetRepository: text("target_repository").notNull(),
    admittedBase: text("admitted_base").notNull(),
    grantDigest: text("grant_digest").notNull(),
    authorityReceiptSha256: text("authority_receipt_sha256").notNull(),
    authorityReceiptJson: text("authority_receipt_json").notNull(),
    runtimeDistManifestSha256: text("runtime_dist_manifest_sha256").notNull(),
    amendmentSeq: integer("amendment_seq").notNull().default(0),
    revision: integer("revision").notNull().default(1),
    state: text("state").notNull(),
    stateCode: text("state_code"),
    deadlineAt: text("deadline_at").notNull(),
    planningAllocation: integer("planning_allocation").notNull(),
    implementationAllocation: integer("implementation_allocation").notNull(),
    reviewProofAllocation: integer("review_proof_allocation").notNull(),
    planningSpent: integer("planning_spent").notNull().default(0),
    reviewProofSpent: integer("review_proof_spent").notNull().default(0),
    researchFetchAllocation: integer("research_fetch_allocation").notNull(),
    researchFetchSpent: integer("research_fetch_spent").notNull().default(0),
    researchBytesAllocation: bigint("research_bytes_allocation", { mode: "number" }).notNull(),
    researchBytesSpent: bigint("research_bytes_spent", { mode: "number" }).notNull().default(0),
    repairEpochState: text("repair_epoch_state")
      .$type<"unopened" | "open" | "closed">()
      .notNull()
      .default("unopened"),
    repairChunksUsed: integer("repair_chunks_used").notNull().default(0),
    reviewEpochs: integer("review_epochs").notNull().default(0),
    stagnantEpochs: integer("stagnant_epochs").notNull().default(0),
    controlSeq: integer("control_seq").notNull().default(0),
    controlRequest: text("control_request").$type<"pause" | "cancel" | "resume">(),
    controlRevision: integer("control_revision"),
    controlRequestedAt: text("control_requested_at"),
    awaitingDecisionId: text("awaiting_decision_id"),
    importIntentDigest: text("import_intent_digest"),
    importIdempotencyKey: text("import_idempotency_key"),
    importId: text("import_id"),
    implementationTransferred: integer("implementation_transferred"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.runId] }),
    unique("ccc_planning_runs_task_unique").on(t.projectId, t.planningTaskId),
    unique("ccc_planning_runs_import_unique").on(t.projectId, t.importId),
    unique("ccc_planning_runs_import_key_unique").on(t.projectId, t.importIdempotencyKey),
    unique("ccc_planning_runs_authority_receipt_unique").on(t.projectId, t.authorityReceiptSha256),
    foreignKey({
      name: "ccc_planning_runs_task_fkey",
      columns: [t.projectId, t.planningTaskId],
      foreignColumns: [tasks.projectId, tasks.id],
    }).onDelete("no action").onUpdate("no action"),
    foreignKey({
      name: "ccc_planning_runs_import_fkey",
      columns: [t.projectId, t.importId],
      foreignColumns: [cccPrdImports.projectId, cccPrdImports.importId],
    }).onDelete("no action").onUpdate("no action"),
    index("idx_ccc_planning_runs_project_state").on(t.projectId, t.state),
    check("ccc_planning_runs_run_id_check", sql`${t.runId} ~ '^ccc-plan:[0-9a-f]{24}$'`),
    check("ccc_planning_runs_mode_check", sql`${t.mode} IN ('spec', 'build')`),
    check("ccc_planning_runs_budget_profile_check", sql`${t.budgetProfile} IN ('standard', 'large')`),
    check(
      "ccc_planning_runs_role_profile_check",
      sql`${t.roleProfile} IN ('full-v2', 'adaptive-v2', 'lean-v2')`,
    ),
    check(
      "ccc_planning_runs_digest_check",
      sql`
        ${t.policyDigest} ~ '^[a-f0-9]{64}$' AND ${t.requestDigest} ~ '^[a-f0-9]{64}$'
        AND ${t.grantDigest} ~ '^[a-f0-9]{64}$' AND ${t.authorityReceiptSha256} ~ '^[a-f0-9]{64}$'
        AND ${t.runtimeDistManifestSha256} ~ '^[a-f0-9]{64}$'
        AND (${t.importIntentDigest} IS NULL OR ${t.importIntentDigest} ~ '^[a-f0-9]{64}$')
      `,
    ),
    check("ccc_planning_runs_base_check", sql`${t.admittedBase} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`),
    check("ccc_planning_runs_request_bytes_check", sql`${t.requestBytes} BETWEEN 1 AND 4194304`),
    // FNXC:CccPlanningRuns 2026-10-14-13:36 (errata E2-64): deadline_at is cast with ::timestamptz by the guard, so only the toISOString() form is stored.
    check(
      "ccc_planning_runs_deadline_check",
      sql`${t.deadlineAt} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'`,
    ),
    check(
      "ccc_planning_runs_sequence_check",
      sql`${t.revision} BETWEEN 1 AND 999 AND ${t.amendmentSeq} >= 0 AND ${t.controlSeq} >= 0`,
    ),
    check(
      "ccc_planning_runs_state_check",
      sql`${t.state} IN (
        'admitted', 'running', 'awaiting_intent', 'awaiting_budget', 'awaiting_execution_authority',
        'blocked_prerequisite', 'blocked_provider', 'budget_exhausted', 'unknown_effect', 'paused',
        'cancelling', 'cancelled', 'spec_ready', 'importing', 'building', 'verification_failed',
        'accepted', 'delivering', 'delivered', 'failed')`,
    ),
    check(
      "ccc_planning_runs_state_code_check",
      sql`
        (${t.stateCode} IS NULL OR ${t.stateCode} ~ '^CCC_[A-Z0-9_]{1,120}$')
        AND (${t.state} NOT IN ('awaiting_budget', 'blocked_prerequisite', 'blocked_provider', 'budget_exhausted',
                                'unknown_effect', 'verification_failed', 'failed') OR ${t.stateCode} IS NOT NULL)
      `,
    ),
    check(
      "ccc_planning_runs_decision_check",
      sql`(${t.state} = 'awaiting_intent') = (${t.awaitingDecisionId} IS NOT NULL)`,
    ),
    check(
      "ccc_planning_runs_planning_spend_check",
      sql`${t.planningSpent} BETWEEN 0 AND ${t.planningAllocation}`,
    ),
    check(
      "ccc_planning_runs_review_spend_check",
      sql`${t.reviewProofSpent} BETWEEN 0 AND ${t.reviewProofAllocation}`,
    ),
    check(
      "ccc_planning_runs_research_check",
      sql`
        ${t.researchFetchSpent} BETWEEN 0 AND ${t.researchFetchAllocation}
        AND ${t.researchBytesSpent} BETWEEN 0 AND ${t.researchBytesAllocation}
        AND ${t.researchFetchAllocation} >= 0 AND ${t.researchBytesAllocation} >= 0
      `,
    ),
    check(
      "ccc_planning_runs_allocation_check",
      sql`
        ${t.planningAllocation} > 0 AND ${t.implementationAllocation} >= 0 AND ${t.reviewProofAllocation} >= 0
        AND (${t.mode} = 'build' OR (${t.implementationAllocation} = 0 AND ${t.reviewProofAllocation} = 0))
      `,
    ),
    check(
      "ccc_planning_runs_repair_check",
      sql`${t.repairEpochState} IN ('unopened', 'open', 'closed') AND ${t.repairChunksUsed} BETWEEN 0 AND 4`,
    ),
    check(
      "ccc_planning_runs_review_epoch_check",
      sql`${t.reviewEpochs} >= 0 AND ${t.stagnantEpochs} BETWEEN 0 AND 2`,
    ),
    check(
      "ccc_planning_runs_control_check",
      sql`
        (${t.controlRequest} IS NULL OR ${t.controlRequest} IN ('pause', 'cancel', 'resume'))
        AND ((${t.controlRequest} IS NULL) = (${t.controlRevision} IS NULL))
        AND ((${t.controlRequest} IS NULL) = (${t.controlRequestedAt} IS NULL))
      `,
    ),
    check(
      "ccc_planning_runs_import_link_check",
      sql`
        ((${t.importIdempotencyKey} IS NULL) = (${t.importIntentDigest} IS NULL))
        AND (${t.importIdempotencyKey} IS NULL OR (
              ${t.mode} = 'build'
              AND ${t.importIdempotencyKey} ~ '^ccc-plan:[0-9a-f]{24}:r[1-9][0-9]{0,2}$'
              AND starts_with(${t.importIdempotencyKey}, ${t.runId} || ':r')))
        AND (${t.importId} IS NULL OR ${t.importIdempotencyKey} IS NOT NULL)
        AND ((${t.importId} IS NULL) = (${t.implementationTransferred} IS NULL))
        AND (${t.implementationTransferred} IS NULL
             OR ${t.implementationTransferred} BETWEEN 1 AND LEAST(${t.implementationAllocation}, 10000))
      `,
    ),
  ],
);

export type CccPlanningRunRow = typeof cccPlanningRuns.$inferSelect;
export type CccPlanningRunInsert = typeof cccPlanningRuns.$inferInsert;
