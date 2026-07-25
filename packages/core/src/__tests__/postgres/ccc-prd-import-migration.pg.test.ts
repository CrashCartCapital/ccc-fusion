import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { importCccPrdBundle, reconcileCccPrdImport } from "../../index.js";
import { TaskStore } from "../../store.js";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  createCccPrdImportTestBundle,
  createCccPrdImportTestExecutionPolicy,
} from "../../__test-utils__/ccc-prd-import-fixture.js";
import {
  applySchemaBaseline,
  getAppliedMigrations,
  SCHEMA_BASELINE_VERSION,
} from "../../postgres/index.js";
import {
  CCC_CAMPAIGN_NATIVE_ENFORCEMENT_VERSION,
  CCC_PRD_IMPORTS_VERSION,
} from "../../postgres/schema-applier.js";
import { projectTableNames } from "../../postgres/schema/project.js";

describe("CCC PRD import migration registry", () => {
  it("keeps migration 0035 immutable and registers every custody table", () => {
    expect(CCC_PRD_IMPORTS_VERSION).toBe("0035");
    expect(CCC_CAMPAIGN_NATIVE_ENFORCEMENT_VERSION).toBe("0036");
    expect(Number(SCHEMA_BASELINE_VERSION))
      .toBeGreaterThanOrEqual(Number(CCC_PRD_IMPORTS_VERSION));
    expect(projectTableNames).toEqual(expect.arrayContaining([
      "ccc_prd_imports",
      "ccc_prd_import_sources",
      "ccc_prd_import_entities",
    ]));
    expect(new Set(projectTableNames).size).toBe(projectTableNames.length);
  });
});

pgDescribe("CCC PRD import migration 0034 to 0035", () => {
  let upgraded: PgTestHarness | null = null;
  let fresh: PgTestHarness | null = null;

  afterEach(async () => {
    await upgraded?.teardown();
    await fresh?.teardown();
    upgraded = null;
    fresh = null;
  });

  it("upgrades once with fresh-shape parity, forced RLS, triggers, FKs, checks, and indexes", async () => {
    upgraded = await createTaskStoreForTest({
      prefix: "fusion_ccc_prd_upgrade",
      copyFromGolden: true,
    });
    await upgraded.adminDb.execute(sql.raw(`
      DROP TABLE project.ccc_prd_import_sources;
      DROP TABLE project.ccc_prd_import_entities;
      DROP TABLE project.ccc_prd_imports;
      DELETE FROM public.fusion_schema_migrations WHERE version IN ('0035', '0036');
    `));
    expect(await getAppliedMigrations(upgraded.adminDb)).toContain("0034");
    expect(await getAppliedMigrations(upgraded.adminDb)).not.toContain("0035");
    expect(await getAppliedMigrations(upgraded.adminDb)).not.toContain("0036");

    expect(await applySchemaBaseline(upgraded.adminDb, { pluginHooks: [] }))
      .toMatchObject({ applied: true });
    expect(await getAppliedMigrations(upgraded.adminDb)).toContain("0035");
    expect(await getAppliedMigrations(upgraded.adminDb)).toContain("0036");
    expect(await applySchemaBaseline(upgraded.adminDb, { pluginHooks: [] })).toEqual({
      applied: false,
      pluginHooksRun: 0,
    });

    const custodyCatalog = (await upgraded.adminDb.execute(sql`
      SELECT c.relname AS table_name,
        c.relrowsecurity AS rls,
        c.relforcerowsecurity AS forced,
        EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'project' AND tablename = c.relname
            AND policyname = 'fusion_project_isolation'
        ) AS policy,
        EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = c.oid AND tgname = 'fusion_assign_project_id'
            AND NOT tgisinternal
        ) AS trigger
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'project'
        AND c.relname IN (
          'ccc_prd_imports',
          'ccc_prd_import_sources',
          'ccc_prd_import_entities'
        )
      ORDER BY c.relname
    `)) as unknown as Array<{
      table_name: string;
      rls: boolean;
      forced: boolean;
      policy: boolean;
      trigger: boolean;
    }>;
    expect(custodyCatalog).toEqual([
      { table_name: "ccc_prd_import_entities", rls: true, forced: true, policy: true, trigger: true },
      { table_name: "ccc_prd_import_sources", rls: true, forced: true, policy: true, trigger: true },
      { table_name: "ccc_prd_imports", rls: true, forced: true, policy: true, trigger: true },
    ]);

    const foreignKeys = (await upgraded.adminDb.execute(sql`
      SELECT conname, confdeltype, condeferrable, condeferred,
        confrelid = 'project.ccc_prd_imports'::regclass AS targets_import
      FROM pg_constraint
      WHERE conname IN (
        'ccc_prd_import_sources_import_fkey',
        'ccc_prd_import_entities_import_fkey'
      )
      ORDER BY conname
    `)) as unknown as Array<{
      conname: string;
      confdeltype: string;
      condeferrable: boolean;
      condeferred: boolean;
      targets_import: boolean;
    }>;
    expect(foreignKeys).toEqual([
      {
        conname: "ccc_prd_import_entities_import_fkey",
        confdeltype: "c",
        condeferrable: true,
        condeferred: false,
        targets_import: true,
      },
      {
        conname: "ccc_prd_import_sources_import_fkey",
        confdeltype: "c",
        condeferrable: true,
        condeferred: false,
        targets_import: true,
      },
    ]);

    const constraintNames = (await upgraded.adminDb.execute(sql`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid IN (
        'project.ccc_prd_imports'::regclass,
        'project.ccc_prd_import_sources'::regclass,
        'project.ccc_prd_import_entities'::regclass
      )
      ORDER BY conname
    `)) as unknown as Array<{ conname: string }>;
    expect(constraintNames.map(({ conname }) => conname)).toEqual(expect.arrayContaining([
      "ccc_prd_imports_state_check",
      "ccc_prd_imports_runnable_check",
      "ccc_prd_imports_request_count_check",
      "ccc_prd_imports_state_runnable_check",
      "ccc_prd_import_sources_authoritative_check",
      "ccc_prd_import_sources_ordinal_check",
      "ccc_prd_import_sources_byte_length_check",
      "ccc_prd_import_entities_type_check",
      "ccc_prd_import_entities_ordinal_check",
    ]));

    const indexNames = (await upgraded.adminDb.execute(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'project'
        AND tablename IN (
          'ccc_prd_imports',
          'ccc_prd_import_sources',
          'ccc_prd_import_entities'
        )
      ORDER BY indexname
    `)) as unknown as Array<{ indexname: string }>;
    expect(indexNames.map(({ indexname }) => indexname)).toEqual(expect.arrayContaining([
      "idx_ccc_prd_imports_state",
      "idx_ccc_prd_imports_identity",
      "idx_ccc_prd_imports_campaign_manifest",
      "idx_ccc_prd_import_entities_native",
    ]));

    const importShape = async (target: PgTestHarness) => ({
      columns: await target.adminDb.execute(sql`
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
      constraints: await target.adminDb.execute(sql`
        SELECT c.relname AS table_name, con.conname, con.contype,
          pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'project'
          AND c.relname IN (
            'ccc_prd_imports',
            'ccc_prd_import_sources',
            'ccc_prd_import_entities'
          )
        ORDER BY c.relname, con.conname
      `),
      indexes: await target.adminDb.execute(sql`
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
    });
    fresh = await createTaskStoreForTest({
      prefix: "fusion_ccc_prd_fresh",
      copyFromGolden: true,
    });
    expect(await importShape(upgraded)).toEqual(await importShape(fresh));
  });
});

pgDescribe("CCC PRD import migration 0035 to 0036", () => {
  let populated: PgTestHarness | null = null;

  afterEach(async () => {
    await populated?.teardown();
    populated = null;
  });

  it("marks a populated runnable 0035 import unadmitted and refuses restart reconciliation", async () => {
    populated = await createTaskStoreForTest({
      prefix: "fusion_ccc_prd_populated_0035",
      copyFromGolden: true,
    });
    const harness = populated;
    const suffix = "populated-0035";
    const taskId = `TASK-${suffix}`;
    const idempotencyKey = "test-test-test-0035";
    const bundle = createCccPrdImportTestBundle(harness.rootDir, suffix);
    const emissions: unknown[] = [];
    const observer = {
      emissions,
      emit: (value: unknown) => emissions.push(value),
    };
    await expect(importCccPrdBundle({
      bundle,
      executionPolicy: createCccPrdImportTestExecutionPolicy(bundle),
      idempotencyKey,
      store: harness.store,
      layer: harness.layer,
      rootDir: harness.rootDir,
      effects: observer,
      events: observer,
    })).resolves.toMatchObject({
      state: "active",
      runnable: true,
    });
    await expect(harness.store.getCccCampaignContextForTask(taskId))
      .resolves.toMatchObject({ taskId, idempotencyKey });
    expect(emissions).toEqual([]);

    await harness.adminDb.execute(sql.raw(`
      ALTER TABLE project.ccc_prd_imports
        DROP COLUMN execution_policy,
        DROP COLUMN campaign_manifest,
        DROP COLUMN campaign_manifest_hash,
        DROP COLUMN campaign_started_at,
        DROP COLUMN campaign_deadline_at,
        DROP COLUMN request_count,
        DROP COLUMN active_action_leases;
      DELETE FROM public.fusion_schema_migrations WHERE version = '0036';
    `));
    expect(await getAppliedMigrations(harness.adminDb)).toContain("0035");
    expect(await getAppliedMigrations(harness.adminDb)).not.toContain("0036");

    expect(await applySchemaBaseline(harness.adminDb, { pluginHooks: [] }))
      .toMatchObject({ applied: true });
    const readCampaignState = () => harness.adminDb.execute(sql`
      SELECT
        state,
        runnable,
        execution_policy,
        campaign_manifest,
        projection_owner,
        projection_lease_until,
        activated_at,
        request_count,
        active_action_leases
      FROM project.ccc_prd_imports
      WHERE idempotency_key = ${idempotencyKey}
    `);
    const migratedRows = await readCampaignState();
    expect(migratedRows).toEqual([{
      state: "active",
      runnable: 1,
      execution_policy: {
        schema: "ccc-campaign.execution-policy.unadmitted.v0",
        routes: [],
      },
      campaign_manifest: expect.objectContaining({
        schema: "ccc-campaign.manifest.unadmitted.v0",
      }),
      projection_owner: null,
      projection_lease_until: null,
      activated_at: expect.any(String),
      request_count: 0,
      active_action_leases: {},
    }]);

    const restarted = new TaskStore(
      harness.rootDir,
      undefined,
      { asyncLayer: harness.layer },
    );
    await expect(restarted.getTask(taskId)).resolves.toMatchObject({ id: taskId });
    await expect(restarted.getCccCampaignContextForTask(taskId))
      .rejects.toMatchObject({ code: "CCC_CAMPAIGN_CONTEXT_REFUSED" });
    await expect(reconcileCccPrdImport({
      idempotencyKey,
      store: restarted,
      layer: harness.layer,
      rootDir: harness.rootDir,
      effects: observer,
      events: observer,
    })).rejects.toMatchObject({
      code: "CCC_PRD_IMPORT_CAMPAIGN_CUSTODY_REFUSED",
    });

    const refusedRows = await readCampaignState();
    expect(refusedRows).toEqual(migratedRows);
    expect(emissions).toEqual([]);
  });
});
