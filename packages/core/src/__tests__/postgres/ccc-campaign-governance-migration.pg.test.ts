import { afterEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  createCccPrdImportTestBundle,
  createCccPrdImportTestExecutionPolicy,
} from "../../__test-utils__/ccc-prd-import-fixture.js";
import { importCccPrdBundle } from "../../ccc-prd/importer.js";
import {
  applySchemaBaseline,
  getAppliedMigrations,
} from "../../postgres/schema-applier.js";

const CAMPAIGN_TUPLE_COLUMNS = [
  "campaign_project_id",
  "campaign_import_id",
  "campaign_id",
  "campaign_task_id",
  "campaign_action_id",
  "campaign_action_target",
  "campaign_idempotency_key",
  "campaign_packet_hash",
  "campaign_sidecar_hash",
  "campaign_bundle_hash",
  "campaign_target_repository",
  "campaign_target_base",
  "campaign_provider_id",
  "campaign_model_id",
  "campaign_transport",
  "campaign_manifest_hash",
  "campaign_binding_hash",
] as const;

async function expectPgError(
  promise: Promise<unknown>,
  matcher: RegExp,
): Promise<void> {
  try {
    await promise;
    expect.fail(`Expected PostgreSQL refusal matching ${matcher}`);
  } catch (error) {
    const wrapped = error as Error & { cause?: Error };
    expect(`${wrapped.message} ${wrapped.cause?.message ?? ""}`).toMatch(matcher);
  }
}

async function createCampaignCustody(
  harness: PgTestHarness,
  suffix: string,
) {
  const bundle = createCccPrdImportTestBundle(harness.rootDir, suffix);
  const idempotencyKey = `ccc-governance-${suffix}`;
  await importCccPrdBundle({
    bundle,
    executionPolicy: createCccPrdImportTestExecutionPolicy(bundle),
    idempotencyKey,
    store: harness.store,
    layer: harness.layer,
    rootDir: harness.rootDir,
  });
  const rows = await harness.adminDb.execute(sql`
    SELECT project_id, import_id, idempotency_key, packet_hash, sidecar_hash,
      bundle_hash, target_repository, target_base, campaign_manifest_hash
    FROM project.ccc_prd_imports
    WHERE idempotency_key = ${idempotencyKey}
  `);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function custodyShape(harness: PgTestHarness) {
  return {
    columns: await harness.adminDb.execute(sql`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'project'
        AND table_name IN (
          'ccc_prd_imports',
          'ccc_prd_import_sources',
          'ccc_prd_import_entities'
        )
      ORDER BY table_name, ordinal_position
    `),
    constraints: await harness.adminDb.execute(sql`
      SELECT relation.relname AS table_name, conname, contype, pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class relation ON relation.oid = con.conrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'project'
        AND relation.relname IN (
          'ccc_prd_imports',
          'ccc_prd_import_sources',
          'ccc_prd_import_entities'
        )
      ORDER BY table_name, conname
    `),
    indexes: await harness.adminDb.execute(sql`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'project'
        AND tablename IN (
          'ccc_prd_imports',
          'ccc_prd_import_sources',
          'ccc_prd_import_entities'
        )
      ORDER BY tablename, indexname
    `),
  };
}

pgDescribe("CCC campaign governance migration 0036 to 0037", () => {
  let harness: PgTestHarness | null = null;

  afterEach(async () => {
    await harness?.teardown();
    harness = null;
  });

  it("upgrades final governance columns, constraints, imports, indexes, and project ownership without changing Wave 5 custody", async () => {
    harness = await createTaskStoreForTest({
      prefix: "fusion_ccc_campaign_governance_upgrade_0037",
      copyFromGolden: true,
    });
    const beforeCustody = await custodyShape(harness);
    await harness.adminDb.execute(sql.raw(`
      ALTER TABLE project.run_audit_events
        DROP CONSTRAINT IF EXISTS run_audit_events_campaign_binding_check,
        DROP CONSTRAINT IF EXISTS run_audit_events_campaign_import_fkey,
        DROP COLUMN IF EXISTS campaign_event_key,
        DROP COLUMN IF EXISTS campaign_binding_hash,
        DROP COLUMN IF EXISTS campaign_manifest_hash,
        DROP COLUMN IF EXISTS campaign_transport,
        DROP COLUMN IF EXISTS campaign_model_id,
        DROP COLUMN IF EXISTS campaign_provider_id,
        DROP COLUMN IF EXISTS campaign_target_base,
        DROP COLUMN IF EXISTS campaign_target_repository,
        DROP COLUMN IF EXISTS campaign_bundle_hash,
        DROP COLUMN IF EXISTS campaign_sidecar_hash,
        DROP COLUMN IF EXISTS campaign_packet_hash,
        DROP COLUMN IF EXISTS campaign_idempotency_key,
        DROP COLUMN IF EXISTS campaign_action_target,
        DROP COLUMN IF EXISTS campaign_action_id,
        DROP COLUMN IF EXISTS campaign_task_id,
        DROP COLUMN IF EXISTS campaign_id,
        DROP COLUMN IF EXISTS campaign_import_id,
        DROP COLUMN IF EXISTS campaign_project_id;
      ALTER TABLE project.approval_requests
        DROP CONSTRAINT IF EXISTS approval_requests_campaign_lifecycle_check,
        DROP CONSTRAINT IF EXISTS approval_requests_status_check,
        DROP CONSTRAINT IF EXISTS approval_requests_campaign_binding_check,
        DROP CONSTRAINT IF EXISTS approval_requests_campaign_import_fkey,
        DROP COLUMN IF EXISTS claimed_at,
        DROP COLUMN IF EXISTS claim_token,
        DROP COLUMN IF EXISTS expires_at,
        DROP COLUMN IF EXISTS not_before_at,
        DROP COLUMN IF EXISTS campaign_binding_hash,
        DROP COLUMN IF EXISTS campaign_manifest_hash,
        DROP COLUMN IF EXISTS campaign_transport,
        DROP COLUMN IF EXISTS campaign_model_id,
        DROP COLUMN IF EXISTS campaign_provider_id,
        DROP COLUMN IF EXISTS campaign_target_base,
        DROP COLUMN IF EXISTS campaign_target_repository,
        DROP COLUMN IF EXISTS campaign_bundle_hash,
        DROP COLUMN IF EXISTS campaign_sidecar_hash,
        DROP COLUMN IF EXISTS campaign_packet_hash,
        DROP COLUMN IF EXISTS campaign_idempotency_key,
        DROP COLUMN IF EXISTS campaign_action_target,
        DROP COLUMN IF EXISTS campaign_action_id,
        DROP COLUMN IF EXISTS campaign_task_id,
        DROP COLUMN IF EXISTS campaign_id,
        DROP COLUMN IF EXISTS campaign_import_id,
        DROP COLUMN IF EXISTS campaign_project_id;
      ALTER TABLE project.ccc_effect_receipts
        DROP CONSTRAINT IF EXISTS ccc_effect_receipts_campaign_binding_check,
        DROP CONSTRAINT IF EXISTS ccc_effect_receipts_campaign_import_fkey,
        DROP COLUMN IF EXISTS campaign_binding_hash,
        DROP COLUMN IF EXISTS campaign_manifest_hash,
        DROP COLUMN IF EXISTS campaign_transport,
        DROP COLUMN IF EXISTS campaign_model_id,
        DROP COLUMN IF EXISTS campaign_provider_id,
        DROP COLUMN IF EXISTS campaign_target_base,
        DROP COLUMN IF EXISTS campaign_target_repository,
        DROP COLUMN IF EXISTS campaign_bundle_hash,
        DROP COLUMN IF EXISTS campaign_sidecar_hash,
        DROP COLUMN IF EXISTS campaign_packet_hash,
        DROP COLUMN IF EXISTS campaign_idempotency_key,
        DROP COLUMN IF EXISTS campaign_action_target,
        DROP COLUMN IF EXISTS campaign_action_id,
        DROP COLUMN IF EXISTS campaign_task_id,
        DROP COLUMN IF EXISTS campaign_id,
        DROP COLUMN IF EXISTS campaign_import_id,
        DROP COLUMN IF EXISTS campaign_project_id;
      DROP INDEX IF EXISTS project.idx_run_audit_events_campaign_import;
      DROP INDEX IF EXISTS project.ux_run_audit_events_campaign_event;
      DROP INDEX IF EXISTS project.idx_approval_requests_campaign_import;
      DROP INDEX IF EXISTS project.ux_approval_requests_campaign_action;
      DROP INDEX IF EXISTS project.idx_ccc_effect_receipts_campaign_import;
      DELETE FROM public.fusion_schema_migrations WHERE version = '0037';
    `));

    expect(await applySchemaBaseline(harness.adminDb, { pluginHooks: [] }))
      .toEqual({ applied: true, pluginHooksRun: 0 });
    expect(await applySchemaBaseline(harness.adminDb, { pluginHooks: [] }))
      .toEqual({ applied: false, pluginHooksRun: 0 });
    expect(await custodyShape(harness)).toEqual(beforeCustody);

    const campaignColumns = (await harness.adminDb.execute(sql`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'project'
        AND table_name IN (
          'run_audit_events',
          'approval_requests',
          'ccc_effect_receipts'
        )
        AND column_name LIKE 'campaign_%'
      ORDER BY table_name, column_name
    `)) as unknown as Array<{
      table_name: string;
      column_name: string;
      is_nullable: string;
    }>;
    for (const tableName of [
      "run_audit_events",
      "approval_requests",
      "ccc_effect_receipts",
    ]) {
      expect(campaignColumns.filter((column) => column.table_name === tableName))
        .toEqual(expect.arrayContaining(CAMPAIGN_TUPLE_COLUMNS.map((column_name) => ({
          table_name: tableName,
          column_name,
          is_nullable: "YES",
        }))));
    }
    expect(campaignColumns).toContainEqual({
      table_name: "run_audit_events",
      column_name: "campaign_event_key",
      is_nullable: "YES",
    });
    const approvalLifecycleColumns = await harness.adminDb.execute(sql`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'project'
        AND table_name = 'approval_requests'
        AND column_name IN ('not_before_at', 'expires_at', 'claim_token', 'claimed_at')
      ORDER BY column_name
    `);
    expect(approvalLifecycleColumns).toEqual([
      { column_name: "claim_token", is_nullable: "YES" },
      { column_name: "claimed_at", is_nullable: "YES" },
      { column_name: "expires_at", is_nullable: "YES" },
      { column_name: "not_before_at", is_nullable: "YES" },
    ]);

    const governanceCatalog = (await harness.adminDb.execute(sql`
      SELECT relation.relname AS table_name, con.conname, con.contype,
        con.condeferrable, con.condeferred, con.confdeltype,
        pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class relation ON relation.oid = con.conrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'project'
        AND relation.relname IN (
          'run_audit_events',
          'approval_requests',
          'approval_request_audit_events',
          'ccc_effect_receipts'
        )
      ORDER BY relation.relname, con.conname
    `)) as unknown as Array<{
      table_name: string;
      conname: string;
      contype: string;
      condeferrable: boolean;
      condeferred: boolean;
      confdeltype: string;
      definition: string;
    }>;
    expect(governanceCatalog).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table_name: "run_audit_events",
        conname: "run_audit_events_campaign_binding_check",
        contype: "c",
      }),
      expect.objectContaining({
        table_name: "approval_requests",
        conname: "approval_requests_campaign_binding_check",
        contype: "c",
      }),
      expect.objectContaining({
        table_name: "approval_requests",
        conname: "approval_requests_status_check",
        contype: "c",
      }),
      expect.objectContaining({
        table_name: "approval_requests",
        conname: "approval_requests_campaign_lifecycle_check",
        contype: "c",
      }),
      expect.objectContaining({
        table_name: "ccc_effect_receipts",
        conname: "ccc_effect_receipts_campaign_binding_check",
        contype: "c",
      }),
      ...[
        ["run_audit_events", "run_audit_events_campaign_import_fkey"],
        ["approval_requests", "approval_requests_campaign_import_fkey"],
        ["ccc_effect_receipts", "ccc_effect_receipts_campaign_import_fkey"],
      ].map(([table_name, conname]) => expect.objectContaining({
        table_name,
        conname,
        contype: "f",
        condeferrable: true,
        condeferred: false,
        confdeltype: "a",
        definition: expect.stringContaining("FOREIGN KEY (project_id, campaign_import_id)"),
      })),
      ...[
        "run_audit_events",
        "approval_requests",
        "approval_request_audit_events",
      ].map((table_name) => expect.objectContaining({
        table_name,
        contype: "p",
        definition: expect.stringContaining("PRIMARY KEY (project_id, id)"),
      })),
    ]));

    const indexes = (await harness.adminDb.execute(sql`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'project'
        AND indexname IN (
          'idx_run_audit_events_campaign_import',
          'ux_run_audit_events_campaign_event',
          'idx_approval_requests_campaign_import',
          'ux_approval_requests_campaign_action',
          'idx_ccc_effect_receipts_campaign_import'
        )
      ORDER BY indexname
    `)) as unknown as Array<{ tablename: string; indexname: string; indexdef: string }>;
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tablename: "run_audit_events",
        indexname: "ux_run_audit_events_campaign_event",
        indexdef: expect.stringContaining("WHERE (campaign_event_key IS NOT NULL)"),
      }),
      expect.objectContaining({
        tablename: "approval_requests",
        indexname: "ux_approval_requests_campaign_action",
        indexdef: expect.stringContaining("WHERE (campaign_project_id IS NOT NULL)"),
      }),
      expect.objectContaining({
        tablename: "approval_requests",
        indexname: "ux_approval_requests_campaign_action",
        indexdef: expect.stringContaining("(project_id, campaign_import_id, campaign_action_id)"),
      }),
      ...[
        ["run_audit_events", "idx_run_audit_events_campaign_import"],
        ["approval_requests", "idx_approval_requests_campaign_import"],
        ["ccc_effect_receipts", "idx_ccc_effect_receipts_campaign_import"],
      ].map(([tablename, indexname]) => expect.objectContaining({ tablename, indexname })),
    ]));

    const ownership = (await harness.adminDb.execute(sql`
      SELECT relation.relname AS table_name, relation.relrowsecurity AS rls,
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
        ) AS trigger
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'project'
        AND relation.relname IN (
          'run_audit_events',
          'approval_requests',
          'approval_request_audit_events',
          'ccc_effect_receipts'
        )
      ORDER BY relation.relname
    `)) as unknown as Array<{
      table_name: string;
      rls: boolean;
      forced: boolean;
      policy: boolean;
      trigger: boolean;
    }>;
    expect(ownership).toEqual([
      { table_name: "approval_request_audit_events", rls: true, forced: true, policy: true, trigger: true },
      { table_name: "approval_requests", rls: true, forced: true, policy: true, trigger: true },
      { table_name: "ccc_effect_receipts", rls: true, forced: true, policy: true, trigger: true },
      { table_name: "run_audit_events", rls: true, forced: true, policy: true, trigger: true },
    ]);
  });

  it("rejects partial, foreign, owner-mismatched, and duplicate campaign authority while preserving readable legacy rows", async () => {
    harness = await createTaskStoreForTest({
      prefix: "fusion_ccc_campaign_governance_bindings_0037",
      copyFromGolden: true,
    });
    const custody = await createCampaignCustody(harness, "binding-0037");
    const now = "2026-07-25T12:00:00.000Z";
    const expires = "2026-07-25T13:00:00.000Z";

    await harness.adminDb.execute(sql`
      INSERT INTO project.run_audit_events(
        project_id, id, timestamp, task_id, agent_id, run_id, domain, mutation_type, target
      ) VALUES (
        ${custody.project_id}, 'legacy-audit-0037', ${now}, NULL, 'agent', 'run', 'domain', 'mutation', 'target'
      )
    `);
    await harness.adminDb.execute(sql`
      INSERT INTO project.approval_requests(
        project_id, id, status, requester_actor_id, requester_actor_type, requester_actor_name,
        target_action_category, target_action_operation, target_action_summary,
        target_resource_type, target_resource_id, requested_at, created_at, updated_at
      ) VALUES (
        ${custody.project_id}, 'legacy-approval-0037', 'pending', 'actor', 'human', 'Actor',
        'category', 'operation', 'summary', 'resource', 'resource-id', ${now}, ${now}, ${now}
      )
    `);
    await harness.adminDb.execute(sql`
      INSERT INTO project.ccc_effect_receipts(
        project_id, effect_scope_id, logical_key, turn_key, slot_ordinal, tool_authority,
        arguments_digest, state, controller_token, created_at, updated_at
      ) VALUES (
        ${custody.project_id}, 'legacy-scope-0037', 'legacy-effect-0037', 'turn', 0,
        'tool.write', 'digest', 'reserved', 'controller', ${now}, ${now}
      )
    `);
    const legacy = await harness.adminDb.execute(sql`
      SELECT
        (SELECT campaign_project_id FROM project.run_audit_events WHERE id = 'legacy-audit-0037') AS audit_project,
        (SELECT campaign_project_id FROM project.approval_requests WHERE id = 'legacy-approval-0037') AS approval_project,
        (SELECT campaign_project_id FROM project.ccc_effect_receipts
          WHERE effect_scope_id = 'legacy-scope-0037' AND logical_key = 'legacy-effect-0037') AS effect_project
    `);
    expect(legacy).toEqual([{ audit_project: null, approval_project: null, effect_project: null }]);

    await expectPgError(harness.adminDb.execute(sql`
      INSERT INTO project.run_audit_events(
        project_id, id, timestamp, agent_id, run_id, domain, mutation_type, target, campaign_project_id
      ) VALUES (
        ${custody.project_id}, 'partial-audit-0037', ${now}, 'agent', 'run', 'domain', 'mutation', 'target', ${custody.project_id}
      )
    `), /run_audit_events_campaign_binding_check/i);
    await expectPgError(harness.adminDb.execute(sql`
      INSERT INTO project.approval_requests(
        project_id, id, status, requester_actor_id, requester_actor_type, requester_actor_name,
        target_action_category, target_action_operation, target_action_summary,
        target_resource_type, target_resource_id, requested_at, created_at, updated_at, campaign_project_id
      ) VALUES (
        ${custody.project_id}, 'partial-approval-0037', 'issued', 'actor', 'human', 'Actor',
        'category', 'operation', 'summary', 'resource', 'resource-id', ${now}, ${now}, ${now}, ${custody.project_id}
      )
    `), /approval_requests_campaign_binding_check/i);
    await expectPgError(harness.adminDb.execute(sql`
      INSERT INTO project.ccc_effect_receipts(
        project_id, effect_scope_id, logical_key, turn_key, slot_ordinal, tool_authority,
        arguments_digest, state, controller_token, created_at, updated_at, campaign_project_id
      ) VALUES (
        ${custody.project_id}, 'partial-scope-0037', 'partial-effect-0037', 'turn', 0,
        'tool.write', 'digest', 'reserved', 'controller', ${now}, ${now}, ${custody.project_id}
      )
    `), /ccc_effect_receipts_campaign_binding_check/i);

    await harness.adminDb.execute(sql`
      INSERT INTO project.run_audit_events(
        project_id, id, timestamp, agent_id, run_id, domain, mutation_type, target,
        campaign_project_id, campaign_import_id, campaign_id, campaign_task_id,
        campaign_action_id, campaign_action_target, campaign_idempotency_key,
        campaign_packet_hash, campaign_sidecar_hash, campaign_bundle_hash,
        campaign_target_repository, campaign_target_base, campaign_provider_id,
        campaign_model_id, campaign_transport, campaign_manifest_hash, campaign_binding_hash,
        campaign_event_key
      ) VALUES (
        ${custody.project_id}, 'campaign-audit-0037', ${now}, 'agent', 'run', 'domain', 'mutation', 'target',
        ${custody.project_id}, ${custody.import_id}, 'campaign', 'task', 'action', 'target', ${custody.idempotency_key},
        ${custody.packet_hash}, ${custody.sidecar_hash}, ${custody.bundle_hash},
        ${custody.target_repository}, ${custody.target_base}, 'provider', 'model', 'pi',
        ${custody.campaign_manifest_hash}, 'binding', 'event-0037'
      )
    `);
    await expectPgError(harness.adminDb.execute(sql`
      INSERT INTO project.run_audit_events(
        project_id, id, timestamp, agent_id, run_id, domain, mutation_type, target,
        campaign_project_id, campaign_import_id, campaign_id, campaign_task_id,
        campaign_action_id, campaign_action_target, campaign_idempotency_key,
        campaign_packet_hash, campaign_sidecar_hash, campaign_bundle_hash,
        campaign_target_repository, campaign_target_base, campaign_provider_id,
        campaign_model_id, campaign_transport, campaign_manifest_hash, campaign_binding_hash,
        campaign_event_key
      ) VALUES (
        ${custody.project_id}, 'campaign-audit-duplicate-0037', ${now}, 'agent', 'run', 'domain', 'mutation', 'target',
        ${custody.project_id}, ${custody.import_id}, 'campaign', 'task', 'action', 'changed-target', ${custody.idempotency_key},
        ${custody.packet_hash}, ${custody.sidecar_hash}, ${custody.bundle_hash},
        ${custody.target_repository}, ${custody.target_base}, 'provider', 'model', 'pi',
        ${custody.campaign_manifest_hash}, 'changed-binding', 'event-0037'
      )
    `), /ux_run_audit_events_campaign_event|unique constraint/i);

    await harness.adminDb.execute(sql`
      INSERT INTO project.ccc_effect_receipts(
        project_id, effect_scope_id, logical_key, turn_key, slot_ordinal, tool_authority,
        arguments_digest, state, controller_token, created_at, updated_at,
        campaign_project_id, campaign_import_id, campaign_id, campaign_task_id,
        campaign_action_id, campaign_action_target, campaign_idempotency_key,
        campaign_packet_hash, campaign_sidecar_hash, campaign_bundle_hash,
        campaign_target_repository, campaign_target_base, campaign_provider_id,
        campaign_model_id, campaign_transport, campaign_manifest_hash, campaign_binding_hash
      ) VALUES (
        ${custody.project_id}, 'campaign-scope-0037', 'campaign-effect-0037', 'turn', 0, 'tool.write',
        'digest', 'reserved', 'token', ${now}, ${now},
        ${custody.project_id}, ${custody.import_id}, 'campaign', 'task', 'effect-action', 'target',
        ${custody.idempotency_key}, ${custody.packet_hash}, ${custody.sidecar_hash}, ${custody.bundle_hash},
        ${custody.target_repository}, ${custody.target_base}, 'provider', 'model', 'pi',
        ${custody.campaign_manifest_hash}, 'binding'
      )
    `);

    await expectPgError(harness.adminDb.execute(sql`
      INSERT INTO project.approval_requests(
        project_id, id, status, requester_actor_id, requester_actor_type, requester_actor_name,
        target_action_category, target_action_operation, target_action_summary, target_resource_type,
        target_resource_id, requested_at, created_at, updated_at, not_before_at, expires_at,
        campaign_project_id, campaign_import_id, campaign_id, campaign_task_id, campaign_action_id,
        campaign_action_target, campaign_idempotency_key, campaign_packet_hash, campaign_sidecar_hash,
        campaign_bundle_hash, campaign_target_repository, campaign_target_base, campaign_provider_id,
        campaign_model_id, campaign_transport, campaign_manifest_hash, campaign_binding_hash
      ) VALUES (
        'other-project', 'owner-mismatch-0037', 'issued', 'actor', 'human', 'Actor',
        'category', 'operation', 'summary', 'resource', 'resource-id', ${now}, ${now}, ${now}, ${now}, ${expires},
        ${custody.project_id}, ${custody.import_id}, 'campaign', 'task', 'owner-mismatch', 'target',
        ${custody.idempotency_key}, ${custody.packet_hash}, ${custody.sidecar_hash}, ${custody.bundle_hash},
        ${custody.target_repository}, ${custody.target_base}, 'provider', 'model', 'pi',
        ${custody.campaign_manifest_hash}, 'binding'
      )
    `), /approval_requests_campaign_binding_check|campaign_import_fkey/i);
  });

  it("enforces campaign approval lifecycle fields and real import custody", async () => {
    harness = await createTaskStoreForTest({
      prefix: "fusion_ccc_campaign_governance_lifecycle_0037",
      copyFromGolden: true,
    });
    const custody = await createCampaignCustody(harness, "lifecycle-0037");
    const now = "2026-07-25T12:00:00.000Z";
    const expires = "2026-07-25T13:00:00.000Z";
    const insertApproval = (id: string, status: string, actionId: string, extras = sql``) => harness!.adminDb.execute(sql`
      INSERT INTO project.approval_requests(
        project_id, id, status, requester_actor_id, requester_actor_type, requester_actor_name,
        target_action_category, target_action_operation, target_action_summary, target_resource_type,
        target_resource_id, requested_at, created_at, updated_at, not_before_at, expires_at,
        campaign_project_id, campaign_import_id, campaign_id, campaign_task_id, campaign_action_id,
        campaign_action_target, campaign_idempotency_key, campaign_packet_hash, campaign_sidecar_hash,
        campaign_bundle_hash, campaign_target_repository, campaign_target_base, campaign_provider_id,
        campaign_model_id, campaign_transport, campaign_manifest_hash, campaign_binding_hash,
        claim_token, claimed_at, decided_at, completed_at
      ) VALUES (
        ${custody.project_id}, ${id}, ${status}, 'actor', 'human', 'Actor',
        'category', 'operation', 'summary', 'resource', 'resource-id', ${now}, ${now}, ${now}, ${now}, ${expires},
        ${custody.project_id}, ${custody.import_id}, 'campaign', 'task', ${actionId}, 'target',
        ${custody.idempotency_key}, ${custody.packet_hash}, ${custody.sidecar_hash}, ${custody.bundle_hash},
        ${custody.target_repository}, ${custody.target_base}, 'provider', 'model', 'pi',
        ${custody.campaign_manifest_hash}, 'binding',
        ${extras}
      )
    `);

    await insertApproval("issued-0037", "issued", "issued", sql`NULL, NULL, NULL, NULL`);
    await expectPgError(
      insertApproval("issued-duplicate-0037", "issued", "issued", sql`NULL, NULL, NULL, NULL`),
      /ux_approval_requests_campaign_action|unique constraint/i,
    );
    await expectPgError(harness.adminDb.execute(sql`
      UPDATE project.approval_requests
      SET not_before_at = '2027-01-01T00:00:00.000Z'
      WHERE project_id = ${custody.project_id}
        AND id = 'issued-0037'
    `), /approval_requests_campaign_lifecycle_check/i);
    await insertApproval("claimed-0037", "claimed", "claimed", sql`'claim', ${now}, NULL, NULL`);
    await insertApproval("consumed-0037", "consumed", "consumed", sql`'claim', ${now}, NULL, ${now}`);
    await insertApproval("denied-0037", "denied", "denied", sql`NULL, NULL, ${now}, NULL`);
    await insertApproval("expired-unclaimed-0037", "expired", "expired-unclaimed", sql`NULL, NULL, ${now}, NULL`);
    await insertApproval("expired-claimed-0037", "expired", "expired-claimed", sql`'claim', ${now}, ${now}, NULL`);

    await expectPgError(
      insertApproval("issued-with-claim-0037", "issued", "issued-with-claim", sql`'claim', ${now}, NULL, NULL`),
      /approval_requests_campaign_lifecycle_check/i,
    );
    await expectPgError(
      insertApproval("claimed-without-claim-0037", "claimed", "claimed-without-claim", sql`NULL, NULL, NULL, NULL`),
      /approval_requests_campaign_lifecycle_check/i,
    );
    await expectPgError(
      insertApproval("foreign-import-0037", "issued", "foreign-import", sql`NULL, NULL, NULL, NULL`).then(async () => {
        await harness!.adminDb.execute(sql`UPDATE project.approval_requests SET campaign_import_id = 'missing-import' WHERE id = 'foreign-import-0037'`);
      }),
      /approval_requests_campaign_import_fkey/i,
    );
  });

  it("reapplies 0037 after a fresh final baseline without structural drift", async () => {
    harness = await createTaskStoreForTest({
      prefix: "fusion_ccc_campaign_governance_fresh_idempotent_0037",
      copyFromGolden: false,
    });
    const before = await harness.adminDb.execute(sql`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'project'
        AND table_name IN ('run_audit_events', 'approval_requests', 'ccc_effect_receipts')
      ORDER BY table_name, ordinal_position
    `);
    await harness.adminDb.execute(sql`
      DELETE FROM public.fusion_schema_migrations WHERE version = '0037'
    `);
    expect(await applySchemaBaseline(harness.adminDb, { pluginHooks: [] }))
      .toEqual({ applied: true, pluginHooksRun: 0 });
    const after = await harness.adminDb.execute(sql`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'project'
        AND table_name IN ('run_audit_events', 'approval_requests', 'ccc_effect_receipts')
      ORDER BY table_name, ordinal_position
    `);
    expect(after).toEqual(before);
    expect(await applySchemaBaseline(harness.adminDb, { pluginHooks: [] }))
      .toEqual({ applied: false, pluginHooksRun: 0 });
  });

  it("quarantines only legacy unadmitted campaign, task, and work-item rows", async () => {
    harness = await createTaskStoreForTest({
      prefix: "fusion_ccc_campaign_governance_0037",
      copyFromGolden: true,
    });
    const legacyBundle = createCccPrdImportTestBundle(
      harness.rootDir,
      "legacy-governance-0037",
    );
    const currentBundle = createCccPrdImportTestBundle(
      harness.rootDir,
      "current-governance-0037",
    );
    const legacyKey = "ccc-governance-legacy-0037";
    const currentKey = "ccc-governance-current-0037";
    await importCccPrdBundle({
      bundle: legacyBundle,
      executionPolicy: createCccPrdImportTestExecutionPolicy(legacyBundle),
      idempotencyKey: legacyKey,
      store: harness.store,
      layer: harness.layer,
      rootDir: harness.rootDir,
    });
    await importCccPrdBundle({
      bundle: currentBundle,
      executionPolicy: createCccPrdImportTestExecutionPolicy(currentBundle),
      idempotencyKey: currentKey,
      store: harness.store,
      layer: harness.layer,
      rootDir: harness.rootDir,
    });

    await harness.adminDb.execute(sql`
      UPDATE project.ccc_prd_imports
      SET
        execution_policy = jsonb_build_object(
          'schema', 'ccc-campaign.execution-policy.unadmitted.v0',
          'routes', '[]'::jsonb
        ),
        campaign_manifest = jsonb_build_object(
          'schema', 'ccc-campaign.manifest.unadmitted.v0',
          'importId', import_id,
          'bundleHash', bundle_hash,
          'packetHash', packet_hash,
          'sidecarHash', sidecar_hash,
          'targetRepository', jsonb_build_object(
            'path', target_repository,
            'baseCommit', target_base
          )
        )
      WHERE idempotency_key = ${legacyKey}
    `);
    const legacyTaskRows = await harness.adminDb.execute(sql`
      SELECT e.project_id, e.native_id AS task_id
      FROM project.ccc_prd_imports i
      JOIN project.ccc_prd_import_entities e
        ON e.project_id = i.project_id
        AND e.import_id = i.import_id
        AND e.entity_type = 'task'
      WHERE i.idempotency_key = ${legacyKey}
      ORDER BY e.native_id
      LIMIT 1
    `);
    const legacyTask = legacyTaskRows[0];
    expect(legacyTask).toBeDefined();
    const dynamicLegacyWorkItemId = "WORK-legacy-governance-0037-retry";
    const now = new Date().toISOString();
    await harness.adminDb.execute(sql`
      INSERT INTO project.workflow_work_items (
        project_id,
        id,
        run_id,
        task_id,
        node_id,
        kind,
        state,
        attempt,
        lease_owner,
        lease_expires_at,
        created_at,
        updated_at
      )
      VALUES (
        ${legacyTask!.project_id},
        ${dynamicLegacyWorkItemId},
        'RUN-legacy-governance-0037-retry',
        ${legacyTask!.task_id},
        'NODE-legacy-governance-0037-retry',
        'retry',
        'runnable',
        0,
        'legacy-provider-worker',
        ${new Date(Date.now() + 60_000).toISOString()},
        ${now},
        ${now}
      )
    `);
    await harness.adminDb.execute(sql`
      DELETE FROM public.fusion_schema_migrations
      WHERE version = '0037'
    `);
    const applied = await applySchemaBaseline(harness.adminDb, {
      pluginHooks: [],
    });

    const campaigns = await harness.adminDb.execute(sql`
      SELECT idempotency_key, state, runnable, activated_at
      FROM project.ccc_prd_imports
      WHERE idempotency_key IN (${legacyKey}, ${currentKey})
      ORDER BY idempotency_key
    `);
    expect(campaigns).toEqual([
      {
        idempotency_key: currentKey,
        state: "active",
        runnable: 1,
        activated_at: expect.any(String),
      },
      {
        idempotency_key: legacyKey,
        state: "prepared",
        runnable: 0,
        activated_at: null,
      },
    ]);

    const tasks = await harness.adminDb.execute(sql`
      SELECT i.idempotency_key, t.column, t.status, t.paused, t.user_paused,
        t.paused_reason
      FROM project.ccc_prd_imports i
      JOIN project.ccc_prd_import_entities e
        ON e.project_id = i.project_id
        AND e.import_id = i.import_id
        AND e.entity_type = 'task'
      JOIN project.tasks t
        ON t.project_id = e.project_id
        AND t.id = e.native_id
      WHERE i.idempotency_key IN (${legacyKey}, ${currentKey})
      ORDER BY i.idempotency_key, t.id
    `);
    const currentTasks = tasks.filter((task) =>
      task.idempotency_key === currentKey);
    const legacyTasks = tasks.filter((task) =>
      task.idempotency_key === legacyKey);
    expect(currentTasks.length).toBeGreaterThan(0);
    expect(legacyTasks.length).toBeGreaterThan(0);
    expect(currentTasks).toEqual(currentTasks.map(() => expect.objectContaining({
      idempotency_key: currentKey,
      column: "todo",
      status: "queued",
      paused: 0,
      user_paused: 0,
    })));
    expect(legacyTasks).toEqual(legacyTasks.map(() => expect.objectContaining({
      idempotency_key: legacyKey,
      column: "triage",
      status: "ccc-prd-import-prepared",
      paused: 1,
      user_paused: 1,
      paused_reason: "ccc-prd-import-unadmitted",
    })));

    const workItems = await harness.adminDb.execute(sql`
      SELECT i.idempotency_key, w.id, w.kind, w.state, w.blocked_reason,
        w.lease_owner, w.lease_expires_at
      FROM project.ccc_prd_imports i
      JOIN project.ccc_prd_import_entities e
        ON e.project_id = i.project_id
        AND e.import_id = i.import_id
        AND e.entity_type = 'task'
      JOIN project.workflow_work_items w
        ON w.project_id = e.project_id
        AND w.task_id = e.native_id
      WHERE i.idempotency_key IN (${legacyKey}, ${currentKey})
      ORDER BY i.idempotency_key, w.id
    `);
    const currentWorkItems = workItems.filter((workItem) =>
      workItem.idempotency_key === currentKey);
    const legacyWorkItems = workItems.filter((workItem) =>
      workItem.idempotency_key === legacyKey);
    expect(currentWorkItems.length).toBeGreaterThan(0);
    expect(legacyWorkItems.length).toBeGreaterThan(1);
    expect(legacyWorkItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: dynamicLegacyWorkItemId,
        kind: "retry",
      }),
    ]));
    expect(currentWorkItems).toEqual(currentWorkItems.map(() =>
      expect.objectContaining({
        idempotency_key: currentKey,
        state: "runnable",
        blocked_reason: null,
      })));
    expect(legacyWorkItems).toEqual(legacyWorkItems.map(() =>
      expect.objectContaining({
        idempotency_key: legacyKey,
        state: "held",
        blocked_reason: "ccc-prd-import-unadmitted",
        lease_owner: null,
        lease_expires_at: null,
      })));
    expect(applied).toEqual({ applied: true, pluginHooksRun: 0 });
    expect(await getAppliedMigrations(harness.adminDb)).toContain("0037");
  });
});
