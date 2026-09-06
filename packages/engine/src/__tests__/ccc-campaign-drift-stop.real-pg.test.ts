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

  async function workItemRow(key: string) {
    const rows = (await h.layer().db.execute(drizzleSql`
      SELECT state, last_error, blocked_reason
      FROM project.workflow_work_items
      WHERE run_id = (
        SELECT 'ccc-prd:' || import_id FROM project.ccc_prd_imports
        WHERE idempotency_key = ${key}
      )
    `)) as unknown as Array<
      { state: string; last_error: string | null; blocked_reason: string | null }
    >;
    return rows[0]!;
  }

  /**
   * Forces the campaign's one workflow work item to a terminal-with-failure
   * state directly, the way the workflow runtime itself would after a proof
   * is proved failed (`terminalAttemptResult`) -- never through this module,
   * which must never be the thing that produces this state.
   */
  async function forceWorkItemFailed(key: string, reason: string): Promise<void> {
    await h.layer().db.execute(drizzleSql`
      UPDATE project.workflow_work_items
      SET state = 'failed', last_error = ${reason}, blocked_reason = ${reason},
        lease_owner = NULL, lease_expires_at = NULL
      WHERE run_id = (
        SELECT 'ccc-prd:' || import_id FROM project.ccc_prd_imports
        WHERE idempotency_key = ${key}
      )
    `);
  }

  /**
   * A terminal-with-failure work item that still carries a live runtime
   * lease -- not a state the workflow runtime should ever actually leave
   * behind, but the close-out guard must refuse it defensively rather than
   * assume the invariant always holds.
   */
  async function forceWorkItemFailedLeased(
    key: string,
    reason: string,
  ): Promise<void> {
    await h.layer().db.execute(drizzleSql`
      UPDATE project.workflow_work_items
      SET state = 'failed', last_error = ${reason}, blocked_reason = ${reason},
        lease_owner = 'stale-runtime-owner',
        lease_expires_at = '2099-01-01T00:00:00.000Z'
      WHERE run_id = (
        SELECT 'ccc-prd:' || import_id FROM project.ccc_prd_imports
        WHERE idempotency_key = ${key}
      )
    `);
  }

  /**
   * Duplicates the one workflow work item so the run has two, ambiguously.
   * The duplicate is forced to `failed` rather than copying the original's
   * state: `idx_workflow_work_items_one_active_task_continuation` allows only
   * one row per task in an active state (`runnable`, `running`, `held`,
   * `retrying`), and this helper must not depend on which active state the
   * original happens to hold.
   */
  async function duplicateWorkItem(key: string): Promise<void> {
    await h.layer().db.execute(drizzleSql`
      INSERT INTO project.workflow_work_items (
        project_id, id, run_id, task_id, node_id, kind, state, attempt,
        retry_after, lease_owner, lease_expires_at, last_error, blocked_reason,
        stable_workflow_run_id, continuation_sequence, wait_reason,
        source_column, target_column, ir_hash, created_at, updated_at
      )
      SELECT
        project_id, id || '-dup', run_id, task_id, node_id || '-dup', kind,
        'failed', attempt, retry_after, NULL, NULL, last_error,
        blocked_reason, stable_workflow_run_id, continuation_sequence,
        wait_reason, source_column, target_column, ir_hash, created_at,
        updated_at
      FROM project.workflow_work_items
      WHERE run_id = (
        SELECT 'ccc-prd:' || import_id FROM project.ccc_prd_imports
        WHERE idempotency_key = ${key}
      )
    `);
  }

  /** Removes the one workflow work item entirely. */
  async function deleteWorkItem(key: string): Promise<void> {
    await h.layer().db.execute(drizzleSql`
      DELETE FROM project.workflow_work_items
      WHERE run_id = (
        SELECT 'ccc-prd:' || import_id FROM project.ccc_prd_imports
        WHERE idempotency_key = ${key}
      )
    `);
  }

  /** Forces the import row itself to a bare `stopped` state, without going
   * through a real close -- reproducing an already-stopped import for the
   * resumed-plan tests without depending on `applyCccCampaignDriftStop`. */
  async function forceImportStopped(key: string): Promise<void> {
    await h.layer().db.execute(drizzleSql`
      UPDATE project.ccc_prd_imports
      SET state = 'stopped', runnable = 0,
        last_error = 'ccc-operator:campaign-stopped:' || repeat('a', 64)
          || ' forced stopped for a resumed-plan test'
      WHERE idempotency_key = ${key}
    `);
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

  /*
   * Campaign l12: drifted custody AND a work item that already ended in
   * failure. `stop-drifted` used to refuse this with
   * CCC_PRD_CAMPAIGN_DRIFT_STOP_ALREADY_TERMINAL, and the ordinary control was
   * never reachable because custody would not reconstruct, so the import row
   * was stranded `active` forever.
   */
  it("RED-L23-b: closes a drifted campaign whose work item already failed, preserving its reason verbatim", async () => {
    const key = "drift-stop-failed-workitem";
    await importedCampaign(key);
    await driftTheStoredManifest(key);
    const originalFailure = "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN";
    await forceWorkItemFailed(key, originalFailure);

    const plan = await planCccPrdCampaignDriftStop({
      layer: h.layer(),
      rootDir: h.rootDir(),
      idempotencyKey: key,
    });
    expect(plan).not.toBeNull();
    expect(plan!.kind).toBe("close-out");
    expect(plan!.workItem.state).toBe("failed");
    expect(plan!.workItem.lastError).toBe(originalFailure);

    const result = await applyCccCampaignDriftStop({
      plan: plan!,
      reason: STOP_REASON,
      confirmation: computeCccCampaignDriftStopConfirmation(plan!),
      store: h.store(),
      layer: h.layer(),
    });

    expect(result.workItemWritten).toBe(false);
    expect(result.workItemState).toBe("failed");

    const row = await importRow(key);
    expect(row.state).toBe("stopped");
    expect(Number(row.runnable)).toBe(0);
    expect(row.last_error).toContain(originalFailure);
    expect(row.last_error).toContain("custody-drift: campaign manifest drift");

    // The workflow work item was never touched: its own recorded failure
    // reason is exactly what it was before the close.
    const item = await workItemRow(key);
    expect(item.state).toBe("failed");
    expect(item.last_error).toBe(originalFailure);
    expect(item.blocked_reason).toBe(originalFailure);
  });

  /*
   * Followup section 1: `transitionWorkflowWorkItem` used to be unwrapped
   * after the import-row write. If it throws -- an optimistic-concurrency
   * conflict, a transient DB error -- the import row is already permanently
   * `stopped` with no reverse transition, and the old refusal
   * (CCC_PRD_IMPORT_STOPPED unconditionally once row.state === 'stopped')
   * meant `stop-drifted` could never be run again to finish the cancel.
   */
  it("RED-L23-c: a re-run finishes an interrupted cancel when the import is already stopped", async () => {
    const key = "drift-stop-partial-apply";
    await importedCampaign(key);
    await driftTheStoredManifest(key);

    const firstPlan = await planCccPrdCampaignDriftStop({
      layer: h.layer(),
      rootDir: h.rootDir(),
      idempotencyKey: key,
    });
    expect(firstPlan!.kind).toBe("cancel");
    expect(firstPlan!.workItem.state).toBe("runnable");

    // Reproduce the exact partial-apply state: the import row already moved
    // to 'stopped' (the write that stops re-projection), but the work-item
    // cancel never landed, as if transitionWorkflowWorkItem had thrown
    // between the two writes.
    await h.layer().db.execute(drizzleSql`
      UPDATE project.ccc_prd_imports
      SET state = 'stopped', runnable = 0,
        last_error = 'ccc-operator:campaign-stopped:' || repeat('a', 64)
          || ' campaign manifest drift blocks every ordinary control | custody-drift: campaign manifest drift'
      WHERE idempotency_key = ${key}
    `);

    const resumedRefusal = await planCccPrdCampaignDriftStop({
      layer: h.layer(),
      rootDir: h.rootDir(),
      idempotencyKey: key,
    });
    // Not a refusal at all: the work item is still short of its own terminal
    // state, so there is something left to finish.
    expect(resumedRefusal).not.toBeNull();
    expect(resumedRefusal!.kind).toBe("cancel");
    expect(resumedRefusal!.importState).toBe("stopped");
    expect(resumedRefusal!.workItem.state).toBe("runnable");

    const result = await applyCccCampaignDriftStop({
      plan: resumedRefusal!,
      reason: STOP_REASON,
      confirmation: computeCccCampaignDriftStopConfirmation(resumedRefusal!),
      store: h.store(),
      layer: h.layer(),
    });

    expect(result.workItemWritten).toBe(true);
    expect(result.workItemState).toBe("cancelled");

    const item = await workItemRow(key);
    expect(item.state).toBe("cancelled");

    // A further re-run now correctly sees nothing left to finish.
    const fullyClosedRefusal = await planCccPrdCampaignDriftStop({
      layer: h.layer(),
      rootDir: h.rootDir(),
      idempotencyKey: key,
    }).catch((error: unknown) => error);
    expect((fullyClosedRefusal as CccPrdImportError).code)
      .toBe("CCC_PRD_IMPORT_STOPPED");
  });

  it("RED-L23-e: a second close-out refuses instead of overwriting the first stop", async () => {
    const key = "drift-stop-closeout-twice";
    await importedCampaign(key);
    await driftTheStoredManifest(key);
    await forceWorkItemFailed(key, "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN");

    const plan = await planCccPrdCampaignDriftStop({
      layer: h.layer(),
      rootDir: h.rootDir(),
      idempotencyKey: key,
    });
    expect(plan!.kind).toBe("close-out");
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
    // The first close-out's recorded reason is still exactly what it was.
    expect((await importRow(key)).last_error).toBe(afterFirst.last_error);
    // Idempotent all the way down: the work item was never written by either
    // attempt.
    const item = await workItemRow(key);
    expect(item.state).toBe("failed");
  });

  /*
   * Review finding: a campaign whose custody still reconstructs must never
   * be closeable through `stop-drifted`, even when its work item has already
   * ended in failure. That campaign can always reach `fn prd stop`, which has
   * its own close-out path for exactly this state; `stop-drifted` exists only
   * for a campaign no ordinary control can reach.
   */
  it("RED-review-1: refuses a non-drifted campaign's already-failed work item; that belongs to fn prd stop, not stop-drifted", async () => {
    const key = "drift-stop-intact-terminal";
    await importedCampaign(key);
    // Deliberately no driftTheStoredManifest(key): custody stays intact.
    await forceWorkItemFailed(key, "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN");

    const refusal = await planCccPrdCampaignDriftStop({
      layer: h.layer(),
      rootDir: h.rootDir(),
      idempotencyKey: key,
    }).catch((error: unknown) => error);

    expect((refusal as CccPrdImportError).code)
      .toBe("CCC_PRD_CAMPAIGN_CUSTODY_INTACT");
    // Nothing was touched: the campaign is exactly as fn prd stop would find it.
    const row = await importRow(key);
    expect(row.state).toBe("active");
    expect(Number(row.runnable)).toBe(1);
    const item = await workItemRow(key);
    expect(item.state).toBe("failed");
  });

  it("RED-review-2: refuses a close-out through stop-drifted when the terminal work item still carries a live lease", async () => {
    const key = "drift-stop-closeout-leased";
    await importedCampaign(key);
    await driftTheStoredManifest(key);
    await forceWorkItemFailedLeased(
      key,
      "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN",
    );

    const refusal = await planCccPrdCampaignDriftStop({
      layer: h.layer(),
      rootDir: h.rootDir(),
      idempotencyKey: key,
    }).catch((error: unknown) => error);

    expect((refusal as CccPrdImportError).code)
      .toBe("CCC_PRD_CAMPAIGN_DRIFT_STOP_LEASED");
    // Nothing was closed: the import is still exactly as it was.
    const row = await importRow(key);
    expect(row.state).toBe("active");
    expect(Number(row.runnable)).toBe(1);
  });

  /*
   * Review finding: resumedDriftStopPlan used to collapse "no work item",
   * "more than one work item", and "one, already terminal" into the same
   * CCC_PRD_IMPORT_STOPPED refusal. Ambiguity is a distinct, more serious
   * problem than a fully closed campaign, and must not be reported as one.
   */
  it("RED-review-3: a resumed plan refuses distinctly when the stopped import's work items are ambiguous", async () => {
    const key = "drift-stop-resume-ambiguous";
    await importedCampaign(key);
    await duplicateWorkItem(key);
    await forceImportStopped(key);

    const refusal = await planCccPrdCampaignDriftStop({
      layer: h.layer(),
      rootDir: h.rootDir(),
      idempotencyKey: key,
    }).catch((error: unknown) => error);

    expect((refusal as CccPrdImportError).code)
      .toBe("CCC_PRD_CAMPAIGN_DRIFT_STOP_WORK_ITEM_AMBIGUOUS");
  });

  it("RED-review-4: a resumed plan refuses distinctly when the stopped import has no work item at all", async () => {
    const key = "drift-stop-resume-missing";
    await importedCampaign(key);
    await deleteWorkItem(key);
    await forceImportStopped(key);

    const refusal = await planCccPrdCampaignDriftStop({
      layer: h.layer(),
      rootDir: h.rootDir(),
      idempotencyKey: key,
    }).catch((error: unknown) => error);

    expect((refusal as CccPrdImportError).code)
      .toBe("CCC_PRD_CAMPAIGN_DRIFT_STOP_WORK_ITEM_AMBIGUOUS");
  });
});
