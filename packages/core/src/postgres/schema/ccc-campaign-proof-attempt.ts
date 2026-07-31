import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import type { CccCampaignProofAttemptState } from "../../ccc-campaign/types.js";
import { PROJECT_SCHEMA } from "./_shared.js";
import { cccPrdImports } from "./ccc-prd-import.js";

const cccCampaignProofSchema = pgSchema(PROJECT_SCHEMA);

export const cccCampaignProofAttempts = cccCampaignProofSchema.table(
  "ccc_campaign_proof_attempts",
  {
    projectId: text("project_id").notNull().default(
      sql`COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__')`,
    ),
    attemptKey: text("attempt_key").notNull(),
    controllerToken: text("controller_token").notNull(),
    importId: text("import_id").notNull(),
    campaignId: text("campaign_id").notNull(),
    taskId: text("task_id").notNull(),
    semanticTaskId: text("semantic_task_id").notNull(),
    proofId: text("proof_id").notNull(),
    packetHash: text("packet_hash").notNull(),
    sidecarHash: text("sidecar_hash").notNull(),
    bundleHash: text("bundle_hash").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    campaignBindingHash: text("campaign_binding_hash").notNull(),
    targetRepository: text("target_repository").notNull(),
    targetBase: text("target_base").notNull(),
    sourceCommit: text("source_commit").notNull(),
    sourceTree: text("source_tree").notNull(),
    definitionSha256: text("definition_sha256").notNull(),
    command: text("command").notNull(),
    commandSha256: text("command_sha256").notNull(),
    workItemId: text("work_item_id").notNull(),
    runId: text("run_id").notNull(),
    workItemAttempt: integer("work_item_attempt").notNull(),
    state: text("state").$type<CccCampaignProofAttemptState>().notNull(),
    resultSuccess: integer("result_success"),
    exitCode: integer("exit_code"),
    durationMs: bigint("duration_ms", { mode: "number" }),
    stdoutSha256: text("stdout_sha256"),
    stderrSha256: text("stderr_sha256"),
    stdoutTail: text("stdout_tail"),
    stderrTail: text("stderr_tail"),
    timedOut: integer("timed_out"),
    killed: integer("killed"),
    warnings: jsonb("warnings").$type<string[]>(),
    changedPathsSha256: text("changed_paths_sha256"),
    negativeControlLabel: text("negative_control_label"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    dispatchedAt: text("dispatched_at"),
    settledAt: text("settled_at"),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.attemptKey] }),
    foreignKey({
      name: "ccc_campaign_proof_attempts_import_fkey",
      columns: [t.projectId, t.importId],
      foreignColumns: [cccPrdImports.projectId, cccPrdImports.importId],
    }).onDelete("no action").onUpdate("no action"),
    index("idx_ccc_campaign_proof_attempts_campaign_commit").on(
      t.projectId,
      t.importId,
      t.sourceCommit,
      t.proofId,
    ),
    check(
      "ccc_campaign_proof_attempts_state_check",
      sql`${t.state} IN ('reserved', 'dispatched_unknown', 'committed', 'proved_failed')`,
    ),
    check(
      "ccc_campaign_proof_attempts_work_item_attempt_check",
      sql`${t.workItemAttempt} > 0`,
    ),
    check(
      "ccc_campaign_proof_attempts_result_shape_check",
      sql`
        (
          ${t.state} = 'reserved'
          AND ${t.dispatchedAt} IS NULL
          AND ${t.settledAt} IS NULL
          AND ${t.resultSuccess} IS NULL
          AND ${t.exitCode} IS NULL
          AND ${t.durationMs} IS NULL
          AND ${t.stdoutSha256} IS NULL
          AND ${t.stderrSha256} IS NULL
          AND ${t.stdoutTail} IS NULL
          AND ${t.stderrTail} IS NULL
          AND ${t.timedOut} IS NULL
          AND ${t.killed} IS NULL
          AND ${t.warnings} IS NULL
        )
        OR (
          ${t.state} = 'dispatched_unknown'
          AND ${t.dispatchedAt} IS NOT NULL
          AND ${t.settledAt} IS NULL
          AND ${t.resultSuccess} IS NULL
          AND ${t.exitCode} IS NULL
          AND ${t.durationMs} IS NULL
          AND ${t.stdoutSha256} IS NULL
          AND ${t.stderrSha256} IS NULL
          AND ${t.stdoutTail} IS NULL
          AND ${t.stderrTail} IS NULL
          AND ${t.timedOut} IS NULL
          AND ${t.killed} IS NULL
          AND ${t.warnings} IS NULL
        )
        OR (
          ${t.state} IN ('committed', 'proved_failed')
          AND ${t.dispatchedAt} IS NOT NULL
          AND ${t.settledAt} IS NOT NULL
          AND ${t.resultSuccess} IN (0, 1)
          AND ${t.durationMs} >= 0
          AND ${t.stdoutSha256} IS NOT NULL
          AND ${t.stderrSha256} IS NOT NULL
          AND ${t.stdoutTail} IS NOT NULL
          AND ${t.stderrTail} IS NOT NULL
          AND ${t.timedOut} IN (0, 1)
          AND ${t.killed} IN (0, 1)
          AND jsonb_typeof(${t.warnings}) = 'array'
          AND (
            (${t.state} = 'committed' AND ${t.resultSuccess} = 1)
            OR (${t.state} = 'proved_failed' AND ${t.resultSuccess} = 0)
          )
        )
      `,
    ),
  ],
);
