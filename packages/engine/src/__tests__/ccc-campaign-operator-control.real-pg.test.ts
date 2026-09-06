import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  drizzleSql,
  importCccPrdBundle,
  inspectCccPrdProductStatus,
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
  applyCccCampaignOperatorControl,
  CccCampaignOperatorControlError,
} from "../ccc-campaign-operator-control.js";

/*
 * Review item 5: the ordinary `fn prd stop` close-out path (campaign l12r7's
 * shape -- custody intact, workflow work item already `failed`) had only
 * mocked-store coverage. `markCccPrdImportStopped` writes a real database row
 * through a real transaction; a mock cannot prove the check constraint, the
 * idempotency-key lookup, or the projection-lease columns actually accept
 * that write the way the drifted-stop path's own real-pg blocker (see
 * ccc-campaign-drift-stop.real-pg.test.ts) once caught a real constraint
 * rejection a mocked store could not see.
 *
 * Nothing here is mocked: a real product status is built from a real import,
 * and the real store's real AsyncDataLayer is what `applyCccCampaignOperatorControl`
 * writes through.
 */

const STOP_REASON = "operator closes this campaign after its proof was proved failed";

pgDescribe("the ordinary stop control closing an already-failed campaign against a real database", () => {
  const h = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_operator_control",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function importedCampaign(key: string) {
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
   * Forces the campaign's one workflow work item to a terminal-with-failure
   * state directly, the way the workflow runtime itself would after a proof
   * is proved failed (`terminalAttemptResult`) -- never through this control,
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

  it("RED-review: fn prd stop closes an already-failed campaign's import through the real store, preserving its reason verbatim", async () => {
    const key = "operator-control-closeout-failed";
    await importedCampaign(key);
    const originalFailure = "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN";
    await forceWorkItemFailed(key, originalFailure);

    const status = await inspectCccPrdProductStatus({
      idempotencyKey: key,
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    if (!status) throw new Error("missing product status for closeout fixture");
    expect(status.workItems[0]?.state).toBe("failed");

    const result = await applyCccCampaignOperatorControl({
      action: "stop",
      reason: STOP_REASON,
      status,
      store: h.store(),
    });

    expect(result.closedAfterTerminalFailure).toBe(true);
    expect(result.workItemState).toBe("failed");

    const row = await importRow(key);
    expect(row.state).toBe("stopped");
    expect(Number(row.runnable)).toBe(0);
    expect(row.last_error).toContain(originalFailure);

    // The workflow work item was never touched by the real store: its own
    // recorded failure reason is exactly what it was before the close.
    const item = await workItemRow(key);
    expect(item.state).toBe("failed");
    expect(item.last_error).toBe(originalFailure);
    expect(item.blocked_reason).toBe(originalFailure);
  });

  /*
   * Live proof (l12r7/l12r8, 2026-09-06 against main 2681e7309): `fn prd stop`
   * committed exactly the write proved above, then refused with
   * CCC_CAMPAIGN_CONTEXT_REFUSED ("Task KB-019 belongs to a non-runnable CCC
   * campaign import") instead of returning the campaign-closed-after-terminal-
   * failure receipt. `runCampaignLifecycleCommand` (packages/cli/src/commands/
   * prd.ts) re-derives `completedStatus` with a second real
   * `inspectCccPrdProductStatus` call after the close-out write to build that
   * receipt -- exactly the call this test makes below. The operator got a
   * refusal after their durable state had already changed.
   */
  it("a status read after the close-out write does not refuse, and reports the campaign closed -- not merely the workflow item", async () => {
    const key = "operator-control-closeout-status-after-write";
    await importedCampaign(key);
    const originalFailure = "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN";
    await forceWorkItemFailed(key, originalFailure);

    const status = await inspectCccPrdProductStatus({
      idempotencyKey: key,
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    if (!status) throw new Error("missing product status for closeout fixture");

    const result = await applyCccCampaignOperatorControl({
      action: "stop",
      reason: STOP_REASON,
      status,
      store: h.store(),
    });
    expect(result.closedAfterTerminalFailure).toBe(true);

    // This is the exact step `runCampaignLifecycleCommand` takes to build the
    // receipt's `completedStatus` right after the write above. Before the fix
    // this throws CccCampaignContextError("... belongs to a non-runnable CCC
    // campaign import") because the import row it just wrote is no longer
    // active/runnable, and `withPrdProject` converts that thrown error into a
    // refusal payload instead of ever reaching the receipt-writing code.
    const completedStatus = await inspectCccPrdProductStatus({
      idempotencyKey: key,
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    if (!completedStatus) throw new Error("product status disappeared after close-out");
    expect(completedStatus.import.state).toBe("stopped");
    expect(completedStatus.import.runnable).toBe(false);
    // The workflow item itself is untouched by the close-out write (proved
    // above); the receipt distinguishes "closed after terminal failure" from
    // an ordinary stop using `result.closedAfterTerminalFailure`, not by the
    // work item state, which stays exactly what the workflow runtime left it.
    expect(completedStatus.workItems[0]?.state).toBe("failed");

    // Idempotency: repeating `stop` against this now-closed status must give
    // a clear, typed refusal -- not the confusing per-task
    // CCC_CAMPAIGN_CONTEXT_REFUSED, and not an unhandled crash.
    let repeatedStopError: unknown;
    try {
      await applyCccCampaignOperatorControl({
        action: "stop",
        reason: STOP_REASON,
        status: completedStatus,
        store: h.store(),
      });
    } catch (error) {
      repeatedStopError = error;
    }
    expect(repeatedStopError).toBeInstanceOf(CccCampaignOperatorControlError);
    expect((repeatedStopError as CccCampaignOperatorControlError).code).toBe(
      "CCC_CAMPAIGN_OPERATOR_CONTROL_IMPORT_REFUSED",
    );
  });
});
