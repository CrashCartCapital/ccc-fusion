import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  applySchemaBaseline,
  getAppliedMigrations,
  SCHEMA_BASELINE_VERSION,
} from "../../postgres/schema-applier.js";

const TABLE = "ccc_campaign_proof_attempts";
const NEW_COLUMNS = [
  "attempt_contract_version",
  "phase",
  "verifier_closure_sha256",
  "candidate_inputs_sha256",
  "execution_toolchain_sha256",
  "terminal_envelope",
  "terminal_envelope_sha256",
  "proof_evidence",
  "proof_evidence_sha256",
] as const;

async function proofAttemptShape(harness: PgTestHarness) {
  return {
    columns: await harness.adminDb.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = ${TABLE}
      ORDER BY ordinal_position
    `),
    constraints: await harness.adminDb.execute(sql`
      SELECT conname, contype, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'project.ccc_campaign_proof_attempts'::regclass
      ORDER BY conname
    `),
    indexes: await harness.adminDb.execute(sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'project' AND tablename = ${TABLE}
      ORDER BY indexname
    `),
    authorizationPromptSchemaConstraint: await harness.adminDb.execute(sql`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid =
        'project.ccc_campaign_execution_authorization_members'::regclass
        AND conname = 'ccc_campaign_execution_auth_members_prompt_schema_check'
    `),
  };
}

describe("CCC campaign semantic-proof v2 migration registry", () => {
  it("RED-S5-PARITY: registers 0040 as the explicit schema ceiling", () => {
    const applierSource = readFileSync(
      fileURLToPath(new URL("../../postgres/schema-applier.ts", import.meta.url)),
      "utf8",
    );
    expect(SCHEMA_BASELINE_VERSION).toBe("0040");
    expect(applierSource).toContain("0040_ccc_campaign_semantic_proof_v2.sql");
  });
});

pgDescribe("CCC campaign semantic-proof v2 migration 0039 to 0040", () => {
  let upgraded: PgTestHarness | null = null;
  let fresh: PgTestHarness | null = null;

  afterEach(async () => {
    await upgraded?.teardown();
    await fresh?.teardown();
    upgraded = null;
    fresh = null;
  });

  it("RED-S5-PARITY: preserves a terminal v1 row and matches the fresh constrained schema", async () => {
    upgraded = await createTaskStoreForTest({
      prefix: "fusion_ccc_semantic_proof_upgrade_0040",
      copyFromGolden: true,
    });
    const digest = "a".repeat(64);
    const commit = "b".repeat(40);
    const tree = "c".repeat(40);
    await upgraded.adminDb.execute(sql`
      INSERT INTO project.ccc_prd_imports (
        project_id, idempotency_key, import_id, identity_hash, bundle_hash,
        packet_hash, sidecar_hash, source_version, target_repository,
        target_base, root_dir, staging_relative_path, state, canonical_bundle,
        transaction_witness, projection_digest, created_at, updated_at,
        execution_policy, campaign_manifest, campaign_manifest_hash,
        campaign_started_at, campaign_deadline_at
      ) VALUES (
        '__legacy_unscoped__', 'proof-v1-key', 'proof-v1-import', ${digest}, ${digest},
        ${digest}, ${digest}, 'v1', '/target', ${commit}, '/root', 'stage', 'prepared',
        '{}'::jsonb, '{}'::jsonb, ${digest}, '2026-08-12T00:00:00.000Z',
        '2026-08-12T00:00:01.000Z', '{}'::jsonb, '{}'::jsonb, ${digest},
        '2026-08-12T00:00:00.000Z', '2026-08-13T00:00:00.000Z'
      )
    `);
    await upgraded.adminDb.execute(sql`
      INSERT INTO project.ccc_campaign_proof_attempts (
        project_id, attempt_key, controller_token, import_id, campaign_id,
        task_id, semantic_task_id, proof_id, packet_hash, sidecar_hash,
        bundle_hash, manifest_hash, campaign_binding_hash, target_repository,
        target_base, source_commit, source_tree, definition_sha256, command,
        command_sha256, work_item_id, run_id, work_item_attempt, state,
        result_success, exit_code, duration_ms, stdout_sha256, stderr_sha256,
        stdout_tail, stderr_tail, timed_out, killed, warnings, created_at,
        updated_at, dispatched_at, settled_at
      ) VALUES (
        '__legacy_unscoped__', ${`ccc-proof-attempt-${digest}`},
        'ccc-proof-controller-00000000-0000-4000-8000-000000000001',
        'proof-v1-import', 'CAMPAIGN-v1', 'TASK-v1', 'SEMANTIC-v1', 'PROOF-v1',
        ${digest}, ${digest}, ${digest}, ${digest}, ${digest}, '/target', ${commit},
        ${commit}, ${tree}, ${digest}, 'task verify:legacy', ${digest},
        'WORK-v1', 'RUN-v1', 1, 'proved_failed', 0, 1, 5, ${digest}, ${digest},
        'legacy-out', 'legacy-err', 0, 0, '[]'::jsonb,
        '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:02.000Z',
        '2026-08-12T00:00:01.000Z', '2026-08-12T00:00:02.000Z'
      )
    `);

    const legacyBefore = await upgraded.adminDb.execute(sql`
      SELECT * FROM project.ccc_campaign_proof_attempts
      WHERE attempt_key = ${`ccc-proof-attempt-${digest}`}
    `);
    await upgraded.adminDb.execute(sql.raw(`
      DELETE FROM public.fusion_schema_migrations WHERE version = '0040';
      ALTER TABLE project.ccc_campaign_proof_attempts
        DROP COLUMN IF EXISTS attempt_contract_version CASCADE,
        DROP COLUMN IF EXISTS phase CASCADE,
        DROP COLUMN IF EXISTS verifier_closure_sha256 CASCADE,
        DROP COLUMN IF EXISTS candidate_inputs_sha256 CASCADE,
        DROP COLUMN IF EXISTS execution_toolchain_sha256 CASCADE,
        DROP COLUMN IF EXISTS terminal_envelope CASCADE,
        DROP COLUMN IF EXISTS terminal_envelope_sha256 CASCADE,
        DROP COLUMN IF EXISTS proof_evidence CASCADE,
        DROP COLUMN IF EXISTS proof_evidence_sha256 CASCADE;
      ALTER TABLE project.ccc_campaign_execution_authorization_members
        DROP CONSTRAINT IF EXISTS ccc_campaign_execution_auth_members_prompt_schema_check;
      ALTER TABLE project.ccc_campaign_execution_authorization_members
        ADD CONSTRAINT ccc_campaign_execution_auth_members_prompt_schema_check
          CHECK (prompt_schema = 'ccc-prd.execution-prompt.v1');
    `));
    expect(await getAppliedMigrations(upgraded.adminDb)).toContain("0039");
    expect(await getAppliedMigrations(upgraded.adminDb)).not.toContain("0040");

    expect(await applySchemaBaseline(upgraded.adminDb, { pluginHooks: [] }))
      .toEqual({ applied: true, pluginHooksRun: 0 });
    expect(await getAppliedMigrations(upgraded.adminDb)).toContain("0040");
    expect(await applySchemaBaseline(upgraded.adminDb, { pluginHooks: [] }))
      .toEqual({ applied: false, pluginHooksRun: 0 });

    const legacyAfter = await upgraded.adminDb.execute(sql`
      SELECT * FROM project.ccc_campaign_proof_attempts
      WHERE attempt_key = ${`ccc-proof-attempt-${digest}`}
    `) as unknown as Array<Record<string, unknown>>;
    expect(legacyAfter).toHaveLength(1);
    expect(legacyAfter[0]).toMatchObject((legacyBefore as unknown as Array<Record<string, unknown>>)[0]!);
    expect(legacyAfter[0]).toMatchObject({
      attempt_contract_version: "v1",
      phase: null,
      verifier_closure_sha256: null,
      candidate_inputs_sha256: null,
      execution_toolchain_sha256: null,
      terminal_envelope: null,
      terminal_envelope_sha256: null,
      proof_evidence: null,
      proof_evidence_sha256: null,
    });

    const ownership = await upgraded.adminDb.execute(sql`
      SELECT relation.relrowsecurity AS rls, relation.relforcerowsecurity AS forced,
        EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'project' AND tablename = ${TABLE}
            AND policyname = 'fusion_project_isolation'
        ) AS policy,
        EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = relation.oid AND tgname = 'fusion_assign_project_id'
            AND NOT tgisinternal
        ) AS trigger,
        has_table_privilege('fusion_runtime', relation.oid, 'SELECT,INSERT,UPDATE,DELETE')
          AS runtime_grants
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'project' AND relation.relname = ${TABLE}
    `);
    expect(ownership).toEqual([{
      rls: true,
      forced: true,
      policy: true,
      trigger: true,
      runtime_grants: true,
    }]);

    const columnNames = (await upgraded.adminDb.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = ${TABLE}
      ORDER BY ordinal_position
    `)) as unknown as Array<{ column_name: string }>;
    expect(columnNames.map(({ column_name }) => column_name))
      .toEqual(expect.arrayContaining([...NEW_COLUMNS]));

    fresh = await createTaskStoreForTest({
      prefix: "fusion_ccc_semantic_proof_fresh_0040",
      copyFromGolden: true,
    });
    const upgradedShape = await proofAttemptShape(upgraded);
    expect(upgradedShape).toEqual(await proofAttemptShape(fresh));
    const constraintDefinitions = JSON.stringify(upgradedShape.constraints);
    for (const code of [
      "timeout",
      "killed",
      "no_output",
      "malformed_output",
      "output_over_limit",
      "spawn_refused",
      "sandbox_refused",
    ]) expect(constraintDefinitions).toContain(code);
    for (const forbiddenCode of [
      "output_limit",
      "sandbox_unavailable",
      "sandbox_violation",
      "toolchain_drift",
      "custody_drift",
    ]) expect(constraintDefinitions).not.toContain(forbiddenCode);
  });
});
