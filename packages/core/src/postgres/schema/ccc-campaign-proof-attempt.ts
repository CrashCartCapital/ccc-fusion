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
  uniqueIndex,
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
    attemptContractVersion: text("attempt_contract_version")
      .$type<"v1" | "v2">()
      .notNull()
      .default("v1"),
    phase: text("phase").$type<"task" | "final_integrated">(),
    verifierClosureSha256: text("verifier_closure_sha256"),
    candidateInputsSha256: text("candidate_inputs_sha256"),
    executionToolchainSha256: text("execution_toolchain_sha256"),
    terminalEnvelope: jsonb("terminal_envelope").$type<Record<string, unknown>>(),
    terminalEnvelopeSha256: text("terminal_envelope_sha256"),
    proofEvidence: jsonb("proof_evidence").$type<Record<string, unknown>>(),
    proofEvidenceSha256: text("proof_evidence_sha256"),
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
    uniqueIndex("ccc_campaign_proof_attempts_v2_phase_fence_unique")
      .on(
        t.projectId,
        t.importId,
        t.proofId,
        t.phase,
        t.sourceCommit,
        t.definitionSha256,
        t.workItemId,
        t.runId,
        t.workItemAttempt,
      )
      .where(sql`${t.attemptContractVersion} = 'v2'`),
    check(
      "ccc_campaign_proof_attempts_state_check",
      sql`${t.state} IN ('reserved', 'dispatched_unknown', 'committed', 'proved_failed')`,
    ),
    check(
      "ccc_campaign_proof_attempts_work_item_attempt_check",
      sql`${t.workItemAttempt} > 0`,
    ),
    check(
      "ccc_campaign_proof_attempts_contract_version_check",
      sql`${t.attemptContractVersion} IN ('v1', 'v2')`,
    ),
    check(
      "ccc_campaign_proof_attempts_v2_custody_check",
      sql`
        (
          ${t.attemptContractVersion} = 'v1'
          AND ${t.phase} IS NULL
          AND ${t.verifierClosureSha256} IS NULL
          AND ${t.candidateInputsSha256} IS NULL
          AND ${t.executionToolchainSha256} IS NULL
          AND ${t.terminalEnvelope} IS NULL
          AND ${t.terminalEnvelopeSha256} IS NULL
          AND ${t.proofEvidence} IS NULL
          AND ${t.proofEvidenceSha256} IS NULL
        )
        OR (
          ${t.attemptContractVersion} = 'v2'
          AND ${t.phase} IS NOT NULL
          AND ${t.phase} IN ('task', 'final_integrated')
          AND ${t.verifierClosureSha256} IS NOT NULL
          AND ${t.verifierClosureSha256} ~ '^[0-9a-f]{64}$'
          AND ${t.candidateInputsSha256} IS NOT NULL
          AND ${t.candidateInputsSha256} ~ '^[0-9a-f]{64}$'
          AND ${t.executionToolchainSha256} IS NOT NULL
          AND ${t.executionToolchainSha256} ~ '^[0-9a-f]{64}$'
        )
      `,
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
          AND ${t.changedPathsSha256} IS NULL
          AND ${t.negativeControlLabel} IS NULL
          AND ${t.terminalEnvelope} IS NULL
          AND ${t.terminalEnvelopeSha256} IS NULL
          AND ${t.proofEvidence} IS NULL
          AND ${t.proofEvidenceSha256} IS NULL
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
          AND ${t.changedPathsSha256} IS NULL
          AND ${t.negativeControlLabel} IS NULL
          AND ${t.terminalEnvelope} IS NULL
          AND ${t.terminalEnvelopeSha256} IS NULL
          AND ${t.proofEvidence} IS NULL
          AND ${t.proofEvidenceSha256} IS NULL
        )
        OR (
          ${t.state} IN ('committed', 'proved_failed')
          AND ${t.dispatchedAt} IS NOT NULL
          AND ${t.settledAt} IS NOT NULL
          AND ${t.resultSuccess} IS NOT NULL
          AND ${t.resultSuccess} IN (0, 1)
          AND ${t.durationMs} IS NOT NULL
          AND ${t.durationMs} >= 0
          AND ${t.stdoutSha256} IS NOT NULL
          AND ${t.stdoutSha256} ~ '^[0-9a-f]{64}$'
          AND ${t.stderrSha256} IS NOT NULL
          AND ${t.stderrSha256} ~ '^[0-9a-f]{64}$'
          AND ${t.stdoutTail} IS NOT NULL
          AND char_length(${t.stdoutTail}) <= 8000
          AND ${t.stderrTail} IS NOT NULL
          AND char_length(${t.stderrTail}) <= 8000
          AND ${t.timedOut} IS NOT NULL
          AND ${t.timedOut} IN (0, 1)
          AND ${t.killed} IS NOT NULL
          AND ${t.killed} IN (0, 1)
          AND ${t.warnings} IS NOT NULL
          AND jsonb_typeof(${t.warnings}) = 'array'
          AND jsonb_array_length(${t.warnings}) <= 64
          AND (${t.negativeControlLabel} IS NULL OR char_length(${t.negativeControlLabel}) <= 512)
          AND (
            (
              ${t.attemptContractVersion} = 'v1'
              AND ${t.terminalEnvelope} IS NULL
              AND ${t.terminalEnvelopeSha256} IS NULL
              AND ${t.proofEvidence} IS NULL
              AND ${t.proofEvidenceSha256} IS NULL
              AND (
                (
                  ${t.state} = 'committed'
                  AND ${t.resultSuccess} = 1
                  AND ${t.exitCode} = 0
                  AND ${t.timedOut} = 0
                  AND ${t.killed} = 0
                )
                OR (${t.state} = 'proved_failed' AND ${t.resultSuccess} = 0)
              )
            )
            OR (
              ${t.attemptContractVersion} = 'v2'
              AND ${t.changedPathsSha256} IS NOT NULL
              AND ${t.changedPathsSha256} ~ '^[0-9a-f]{64}$'
              AND ${t.negativeControlLabel} IS NULL
              AND ${t.terminalEnvelope} IS NOT NULL
              AND jsonb_typeof(${t.terminalEnvelope}) = 'object'
              AND ${t.terminalEnvelope} ?& ARRAY[
                'schema', 'kind', 'proofId', 'phase', 'sourceCommit', 'sourceTree',
                'exitCode', 'durationMs', 'stdoutSha256', 'stderrSha256',
                'changedPathsSha256', 'stdoutTail', 'stderrTail', 'timedOut',
                'killed', 'warnings'
              ]
              AND octet_length(${t.terminalEnvelope}::text) <= 262144
              AND ${t.terminalEnvelopeSha256} IS NOT NULL
              AND ${t.terminalEnvelopeSha256} ~ '^[0-9a-f]{64}$'
              AND ${t.terminalEnvelope} ->> 'schema' = 'ccc-prd.proof-terminal-envelope.v2'
              AND ${t.terminalEnvelope} ->> 'phase' = ${t.phase}
              AND ${t.terminalEnvelope} ->> 'proofId' = ${t.proofId}
              AND ${t.terminalEnvelope} ->> 'sourceCommit' = ${t.sourceCommit}
              AND ${t.terminalEnvelope} ->> 'sourceTree' = ${t.sourceTree}
              AND ${t.terminalEnvelope} ->> 'stdoutSha256' = ${t.stdoutSha256}
              AND ${t.terminalEnvelope} ->> 'stderrSha256' = ${t.stderrSha256}
              AND ${t.terminalEnvelope} ->> 'changedPathsSha256' = ${t.changedPathsSha256}
              AND ${t.terminalEnvelope} ->> 'stdoutTail' = ${t.stdoutTail}
              AND ${t.terminalEnvelope} ->> 'stderrTail' = ${t.stderrTail}
              AND ${t.terminalEnvelope} -> 'warnings' = ${t.warnings}
              AND (${t.terminalEnvelope} ->> 'durationMs')::bigint = ${t.durationMs}
              AND ${t.terminalEnvelope} -> 'timedOut' = to_jsonb(${t.timedOut} = 1)
              AND ${t.terminalEnvelope} -> 'killed' = to_jsonb(${t.killed} = 1)
              AND (
                (${t.exitCode} IS NULL AND ${t.terminalEnvelope} -> 'exitCode' = 'null'::jsonb)
                OR (${t.exitCode} IS NOT NULL AND ${t.terminalEnvelope} ->> 'exitCode' = ${t.exitCode}::text)
              )
              AND (
                (
                  ${t.terminalEnvelope} ->> 'kind' = 'verified'
                  AND ${t.terminalEnvelope} ?& ARRAY['passed', 'evidence', 'evidenceSha256']
                  AND ${t.proofEvidence} IS NOT NULL
                  AND jsonb_typeof(${t.proofEvidence}) = 'object'
                  AND ${t.proofEvidence} ?& ARRAY[
                    'schema', 'proofId', 'phase', 'sourceCommit', 'sourceTree',
                    'passed', 'clauseResults', 'positiveCaseResults',
                    'negativeControlResults'
                  ]
                  AND octet_length(${t.proofEvidence}::text) <= 131072
                  AND ${t.proofEvidenceSha256} IS NOT NULL
                  AND ${t.proofEvidenceSha256} ~ '^[0-9a-f]{64}$'
                  AND ${t.terminalEnvelope} -> 'evidence' = ${t.proofEvidence}
                  AND ${t.terminalEnvelope} ->> 'evidenceSha256' = ${t.proofEvidenceSha256}
                  AND ${t.proofEvidence} ->> 'schema' = 'ccc-prd.proof-evidence.v2'
                  AND ${t.proofEvidence} ->> 'phase' = ${t.phase}
                  AND ${t.proofEvidence} ->> 'proofId' = ${t.proofId}
                  AND ${t.proofEvidence} ->> 'sourceCommit' = ${t.sourceCommit}
                  AND ${t.proofEvidence} ->> 'sourceTree' = ${t.sourceTree}
                  AND ${t.terminalEnvelope} -> 'passed' = ${t.proofEvidence} -> 'passed'
                  AND (
                    (
                      ${t.state} = 'committed'
                      AND ${t.resultSuccess} = 1
                      AND ${t.terminalEnvelope} -> 'passed' = 'true'::jsonb
                      AND ${t.exitCode} = 0
                      AND ${t.timedOut} = 0
                      AND ${t.killed} = 0
                    )
                    OR (
                      ${t.state} = 'proved_failed'
                      AND ${t.resultSuccess} = 0
                      AND ${t.terminalEnvelope} -> 'passed' = 'false'::jsonb
                      AND ${t.timedOut} = 0
                      AND ${t.killed} = 0
                    )
                  )
                )
                OR (
                  ${t.state} = 'proved_failed'
                  AND ${t.resultSuccess} = 0
                  AND ${t.terminalEnvelope} ->> 'kind' = 'execution_refused'
                  AND ${t.terminalEnvelope} ? 'code'
                  AND ${t.terminalEnvelope} ->> 'code' IN (
                    'timeout', 'killed', 'no_output', 'malformed_output',
                    'output_over_limit', 'spawn_refused', 'sandbox_refused'
                  )
                  AND ${t.proofEvidence} IS NULL
                  AND ${t.proofEvidenceSha256} IS NULL
                )
              )
            )
          )
        )
      `,
    ),
  ],
);
