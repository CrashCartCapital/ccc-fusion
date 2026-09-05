import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  CccPrdImportError,
  drizzleSql,
  importCccPrdBundle,
  planCccPrdCampaignDriftStop,
  reconcileCccPrdImport,
} from "@fusion/core";
import {
  createAdmittedCccPrdImportTestProductFixture,
  createCccPrdImportTestProductExecutionPolicy,
} from "../../../core/src/__test-utils__/ccc-prd-import-fixture.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  applyCccCampaignDriftStop,
  computeCccCampaignDriftStopConfirmation,
} from "../ccc-campaign-drift-stop.js";

/*
 * The blocker this file exists for.
 *
 * `ccc_prd_imports_state_check` restricted the state column to
 * ('prepared','projecting','active'). The unit tests mock the import-row write,
 * so on a real database the close would cancel the work item, pause the tasks,
 * and only then be rejected by the constraint -- leaving the campaign active,
 * runnable, and still re-projecting its task directories, which is the exact
 * failure the whole path exists to end.
 *
 * Nothing here is mocked. This drives the real close against a real database
 * and re-reads the row afterwards.
 */

const STOP_REASON = "campaign manifest drift blocks every ordinary control";

pgDescribe("closing a drifted CCC campaign against a real database", () => {
  const h = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_drift_stop",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function importedCampaign(key: string) {
    // A fresh product campaign must be a controller-admitted semantic v2
    // bundle, built through the real custody hydrator rather than declared.
    const { bundle, semanticProofToolchainPaths } =
      await createAdmittedCccPrdImportTestProductFixture(h.rootDir(), key);
    return importCccPrdBundle({
      bundle,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(bundle),
      semanticProofToolchainPaths,
      idempotencyKey: key,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
  }

  /**
   * Reproduces the pre-#66 copier by rewriting the stored manifest so it no
   * longer matches what re-derivation produces. The bundle is untouched, which
   * is exactly the live shape: bundle custody intact, manifest copy stale.
   */
  async function driftTheStoredManifest(key: string): Promise<void> {
    await h.layer().db.execute(drizzleSql`
      UPDATE project.ccc_prd_imports
      SET campaign_manifest = jsonb_set(
        campaign_manifest,
        '{proofs}',
        '[]'::jsonb
      )
      WHERE idempotency_key = ${key}
    `);
  }

  async function importRow(key: string) {
    const rows = (await h.layer().db.execute(drizzleSql`
      SELECT state, runnable, last_error
      FROM project.ccc_prd_imports
      WHERE idempotency_key = ${key}
    `)) as unknown as Array<{ state: string; runnable: number; last_error: string | null }>;
    return rows[0]!;
  }

  it("RED-L18-blocker: writes the terminal state the check constraint must allow", async () => {
    const key = "drift-stop-terminal";
    await importedCampaign(key);
    await driftTheStoredManifest(key);

    const plan = await planCccPrdCampaignDriftStop({
      layer: h.layer(),
      rootDir: h.rootDir(),
      idempotencyKey: key,
    });
    expect(plan).not.toBeNull();
    expect(plan!.driftReason).toBe("campaign manifest drift");

    const result = await applyCccCampaignDriftStop({
      plan: plan!,
      reason: STOP_REASON,
      confirmation: computeCccCampaignDriftStopConfirmation(plan!),
      store: h.store(),
      layer: h.layer(),
    });

    expect(result.workItemState).toBe("cancelled");
    expect(result.unresolvedEffectsPreserved).toBe(true);

    // The write the missing migration rejected. Re-read from the database
    // rather than trusting the return value.
    const row = await importRow(key);
    expect(row.state).toBe("stopped");
    expect(Number(row.runnable)).toBe(0);
    expect(row.last_error).toContain("custody-drift: campaign manifest drift");
    expect(row.last_error).toContain("ccc-operator:campaign-stopped:");
  });

  it("RED-L18-blocker: a stopped import refuses reconcile, so it stops re-projecting", async () => {
    const key = "drift-stop-reconcile";
    await importedCampaign(key);
    await driftTheStoredManifest(key);

    const plan = await planCccPrdCampaignDriftStop({
      layer: h.layer(),
      rootDir: h.rootDir(),
      idempotencyKey: key,
    });
    await applyCccCampaignDriftStop({
      plan: plan!,
      reason: STOP_REASON,
      confirmation: computeCccCampaignDriftStopConfirmation(plan!),
      store: h.store(),
      layer: h.layer(),
    });

    const refusal = await reconcileCccPrdImport({
      idempotencyKey: key,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(CccPrdImportError);
    expect((refusal as CccPrdImportError).code).toBe("CCC_PRD_IMPORT_STOPPED");
    expect((refusal as CccPrdImportError).message)
      .toContain("custody-drift: campaign manifest drift");
  });

  it("RED-L18-2: a second close refuses instead of overwriting the first stop", async () => {
    const key = "drift-stop-twice";
    await importedCampaign(key);
    await driftTheStoredManifest(key);

    const plan = await planCccPrdCampaignDriftStop({
      layer: h.layer(),
      rootDir: h.rootDir(),
      idempotencyKey: key,
    });
    await applyCccCampaignDriftStop({
      plan: plan!,
      reason: STOP_REASON,
      confirmation: computeCccCampaignDriftStopConfirmation(plan!),
      store: h.store(),
      layer: h.layer(),
    });
    const afterFirst = await importRow(key);

    const refusal = await planCccPrdCampaignDriftStop({
      layer: h.layer(),
      rootDir: h.rootDir(),
      idempotencyKey: key,
    }).catch((error: unknown) => error);

    expect((refusal as CccPrdImportError).code).toBe("CCC_PRD_IMPORT_STOPPED");
    // The first stop's recorded reason is still exactly what it was.
    expect((await importRow(key)).last_error).toBe(afterFirst.last_error);
  });

  it("RED-L18-1: refuses a campaign whose custody still reconstructs", async () => {
    const key = "drift-stop-healthy";
    await importedCampaign(key);

    const refusal = await planCccPrdCampaignDriftStop({
      layer: h.layer(),
      rootDir: h.rootDir(),
      idempotencyKey: key,
    }).catch((error: unknown) => error);

    expect((refusal as CccPrdImportError).code)
      .toBe("CCC_PRD_CAMPAIGN_CUSTODY_INTACT");
    // A healthy campaign is untouched: still active, still runnable.
    const row = await importRow(key);
    expect(row.state).toBe("active");
    expect(Number(row.runnable)).toBe(1);
  });
});
