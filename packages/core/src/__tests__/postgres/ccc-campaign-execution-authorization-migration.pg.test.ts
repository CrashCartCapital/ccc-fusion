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
import { projectTableNames } from "../../postgres/schema/project.js";

const AUTHORIZATION_TABLES = [
  "ccc_campaign_execution_authorization_members",
  "ccc_campaign_execution_authorizations",
] as const;

const AUTHORIZATION_COLUMNS = [
  "project_id",
  "authorization_id",
  "schema_version",
  "import_id",
  "campaign_id",
  "idempotency_key",
  "workflow_id",
  "work_item_id",
  "workflow_ir_hash",
  "packet_hash",
  "sidecar_hash",
  "bundle_hash",
  "manifest_hash",
  "execution_policy_sha256",
  "target_repository",
  "target_base",
  "campaign_started_at",
  "campaign_deadline_at",
  "max_requests",
  "max_concurrency",
  "member_set_hash",
  "authorization_digest",
  "expected_request_count",
  "status",
  "requester_actor_id",
  "requester_actor_type",
  "requester_actor_name",
  "not_before_at",
  "expires_at",
  "claim_token",
  "claimed_at",
  "settled_at",
  "created_at",
  "updated_at",
] as const;

const MEMBER_COLUMNS = [
  "project_id",
  "authorization_id",
  "ordinal",
  "native_task_id",
  "semantic_task_id",
  "action_id",
  "action_target",
  "provider_id",
  "model_id",
  "transport",
  "prompt_schema",
  "prompt_sha256",
  "route_sha256",
  "binding_hash",
  "approval_request_id",
  "member_hash",
] as const;

const EXPECTED_CONSTRAINTS = [
  "ccc_campaign_execution_auth_members_prompt_schema_check",
  "ccc_campaign_execution_auth_members_semantic_task_unique",
  "ccc_campaign_execution_authorization_members_approval_fkey",
  "ccc_campaign_execution_authorization_members_approval_id_check",
  "ccc_campaign_execution_authorization_members_approval_unique",
  "ccc_campaign_execution_authorization_members_authorization_fkey",
  "ccc_campaign_execution_authorization_members_binding_unique",
  "ccc_campaign_execution_authorization_members_hashes_check",
  "ccc_campaign_execution_authorization_members_member_hash_unique",
  "ccc_campaign_execution_authorization_members_native_task_unique",
  "ccc_campaign_execution_authorization_members_ordinal_check",
  "ccc_campaign_execution_authorization_members_pkey",
  "ccc_campaign_execution_authorization_members_task_action_unique",
  "ccc_campaign_execution_authorization_members_transport_check",
  "ccc_campaign_execution_authorizations_bounds_check",
  "ccc_campaign_execution_authorizations_hashes_check",
  "ccc_campaign_execution_authorizations_identity_check",
  "ccc_campaign_execution_authorizations_import_fkey",
  "ccc_campaign_execution_authorizations_lifecycle_check",
  "ccc_campaign_execution_authorizations_pkey",
  "ccc_campaign_execution_authorizations_project_digest_unique",
  "ccc_campaign_execution_authorizations_project_import_unique",
  "ccc_campaign_execution_authorizations_schema_version_check",
  "ccc_campaign_execution_authorizations_status_check",
  "ccc_campaign_execution_authorizations_window_check",
] as const;

const EXPECTED_INDEXES = [
  "ccc_campaign_execution_auth_members_semantic_task_unique",
  "ccc_campaign_execution_authorization_members_approval_unique",
  "ccc_campaign_execution_authorization_members_binding_unique",
  "ccc_campaign_execution_authorization_members_member_hash_unique",
  "ccc_campaign_execution_authorization_members_native_task_unique",
  "ccc_campaign_execution_authorization_members_pkey",
  "ccc_campaign_execution_authorization_members_task_action_unique",
  "ccc_campaign_execution_authorizations_pkey",
  "ccc_campaign_execution_authorizations_project_digest_unique",
  "ccc_campaign_execution_authorizations_project_import_unique",
  "idx_ccc_campaign_execution_authorization_members_task_action",
  "idx_ccc_campaign_execution_authorizations_campaign",
  "idx_ccc_campaign_execution_authorizations_status",
] as const;

async function authorizationShape(harness: PgTestHarness) {
  return {
    columns: await harness.adminDb.execute(sql`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'project'
        AND table_name IN (
          'ccc_campaign_execution_authorizations',
          'ccc_campaign_execution_authorization_members'
        )
      ORDER BY table_name, ordinal_position
    `),
    constraints: await harness.adminDb.execute(sql`
      SELECT relation.relname AS table_name, con.conname, con.contype,
        pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class relation ON relation.oid = con.conrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'project'
        AND relation.relname IN (
          'ccc_campaign_execution_authorizations',
          'ccc_campaign_execution_authorization_members'
        )
      ORDER BY table_name, conname
    `),
    indexes: await harness.adminDb.execute(sql`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'project'
        AND tablename IN (
          'ccc_campaign_execution_authorizations',
          'ccc_campaign_execution_authorization_members'
        )
      ORDER BY tablename, indexname
    `),
  };
}

describe("CCC campaign execution-authorization migration registry", () => {
  it("Slice 2 RED: registers migration 0039 and both aggregate custody tables", () => {
    const applierSource = readFileSync(
      fileURLToPath(new URL("../../postgres/schema-applier.ts", import.meta.url)),
      "utf8",
    );
    expect(SCHEMA_BASELINE_VERSION).toBe("0040");
    expect(applierSource).toContain("0039_ccc_campaign_execution_authorization.sql");
    expect(projectTableNames).toEqual(expect.arrayContaining(AUTHORIZATION_TABLES));
    expect(new Set(projectTableNames).size).toBe(projectTableNames.length);
  });
});

pgDescribe("CCC campaign execution-authorization migration 0038 to 0039", () => {
  let upgraded: PgTestHarness | null = null;
  let fresh: PgTestHarness | null = null;

  afterEach(async () => {
    await upgraded?.teardown();
    await fresh?.teardown();
    upgraded = null;
    fresh = null;
  });

  it("Slice 2 RED: upgrades once with fresh parity, exact FKs, forced RLS, policy, trigger, and grants", async () => {
    upgraded = await createTaskStoreForTest({
      prefix: "fusion_ccc_execution_authorization_upgrade_0039",
      copyFromGolden: true,
    });
    await upgraded.adminDb.execute(sql.raw(`
      DROP TABLE IF EXISTS project.ccc_campaign_execution_authorization_members;
      DROP TABLE IF EXISTS project.ccc_campaign_execution_authorizations;
      DELETE FROM public.fusion_schema_migrations WHERE version IN ('0039', '0040');
    `));
    expect(await getAppliedMigrations(upgraded.adminDb)).toContain("0038");
    expect(await getAppliedMigrations(upgraded.adminDb)).not.toContain("0039");
    expect(await getAppliedMigrations(upgraded.adminDb)).not.toContain("0040");

    expect(await applySchemaBaseline(upgraded.adminDb, { pluginHooks: [] }))
      .toEqual({ applied: true, pluginHooksRun: 0 });
    expect(await getAppliedMigrations(upgraded.adminDb)).toContain("0039");
    expect(await getAppliedMigrations(upgraded.adminDb)).toContain("0040");
    expect(await applySchemaBaseline(upgraded.adminDb, { pluginHooks: [] }))
      .toEqual({ applied: false, pluginHooksRun: 0 });

    const columns = (await upgraded.adminDb.execute(sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'project'
        AND table_name IN (
          'ccc_campaign_execution_authorizations',
          'ccc_campaign_execution_authorization_members'
        )
      ORDER BY table_name, ordinal_position
    `)) as unknown as Array<{ table_name: string; column_name: string }>;
    expect(columns.filter(({ table_name }) => table_name === AUTHORIZATION_TABLES[1])
      .map(({ column_name }) => column_name)).toEqual(AUTHORIZATION_COLUMNS);
    expect(columns.filter(({ table_name }) => table_name === AUTHORIZATION_TABLES[0])
      .map(({ column_name }) => column_name)).toEqual(MEMBER_COLUMNS);

    const constraintNames = (await upgraded.adminDb.execute(sql`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid IN (
        'project.ccc_campaign_execution_authorizations'::regclass,
        'project.ccc_campaign_execution_authorization_members'::regclass
      )
      ORDER BY conname
    `)) as unknown as Array<{ conname: string }>;
    expect(constraintNames.map(({ conname }) => conname)).toEqual(EXPECTED_CONSTRAINTS);

    const foreignKeys = (await upgraded.adminDb.execute(sql`
      SELECT con.conname, target.relname AS target_table, con.confdeltype,
        con.confupdtype, con.condeferrable, con.condeferred
      FROM pg_constraint con
      JOIN pg_class target ON target.oid = con.confrelid
      WHERE con.conname IN (
        'ccc_campaign_execution_authorizations_import_fkey',
        'ccc_campaign_execution_authorization_members_authorization_fkey',
        'ccc_campaign_execution_authorization_members_approval_fkey'
      )
      ORDER BY con.conname
    `)) as unknown as Array<{
      conname: string;
      target_table: string;
      confdeltype: string;
      confupdtype: string;
      condeferrable: boolean;
      condeferred: boolean;
    }>;
    expect(foreignKeys).toEqual([
      {
        conname: "ccc_campaign_execution_authorization_members_approval_fkey",
        target_table: "approval_requests",
        confdeltype: "a",
        confupdtype: "a",
        condeferrable: true,
        condeferred: false,
      },
      {
        conname: "ccc_campaign_execution_authorization_members_authorization_fkey",
        target_table: "ccc_campaign_execution_authorizations",
        confdeltype: "c",
        confupdtype: "a",
        condeferrable: true,
        condeferred: false,
      },
      {
        conname: "ccc_campaign_execution_authorizations_import_fkey",
        target_table: "ccc_prd_imports",
        confdeltype: "a",
        confupdtype: "a",
        condeferrable: true,
        condeferred: false,
      },
    ]);

    const indexNames = (await upgraded.adminDb.execute(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'project'
        AND tablename IN (
          'ccc_campaign_execution_authorizations',
          'ccc_campaign_execution_authorization_members'
        )
      ORDER BY indexname
    `)) as unknown as Array<{ indexname: string }>;
    expect(indexNames.map(({ indexname }) => indexname)).toEqual(EXPECTED_INDEXES);

    const ownership = (await upgraded.adminDb.execute(sql`
      SELECT relation.relname AS table_name,
        relation.relrowsecurity AS rls,
        relation.relforcerowsecurity AS forced,
        EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'project'
            AND tablename = relation.relname
            AND policyname = 'fusion_project_isolation'
        ) AS policy,
        EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = relation.oid
            AND tgname = 'fusion_assign_project_id'
            AND NOT tgisinternal
        ) AS trigger,
        has_table_privilege('fusion_runtime', relation.oid, 'SELECT')
          AND has_table_privilege('fusion_runtime', relation.oid, 'INSERT')
          AND has_table_privilege('fusion_runtime', relation.oid, 'UPDATE')
          AND has_table_privilege('fusion_runtime', relation.oid, 'DELETE')
          AS runtime_grants
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'project'
        AND relation.relname IN (
          'ccc_campaign_execution_authorizations',
          'ccc_campaign_execution_authorization_members'
        )
      ORDER BY relation.relname
    `)) as unknown as Array<{
      table_name: string;
      rls: boolean;
      forced: boolean;
      policy: boolean;
      trigger: boolean;
      runtime_grants: boolean;
    }>;
    expect(ownership).toEqual(AUTHORIZATION_TABLES.map((table_name) => ({
      table_name,
      rls: true,
      forced: true,
      policy: true,
      trigger: true,
      runtime_grants: true,
    })));

    fresh = await createTaskStoreForTest({
      prefix: "fusion_ccc_execution_authorization_fresh_0039",
      copyFromGolden: true,
    });
    expect(await authorizationShape(upgraded)).toEqual(await authorizationShape(fresh));
  });
});
