import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  drizzleSql,
  importCccPrdBundle,
  inspectCccPrdProductStatus,
  type CccProviderAttemptRequest,
  type CccProviderAttemptScope,
} from "@fusion/core";
import {
  admitCccPrdImportTestProductBundle,
  createAdmittedCccPrdImportTestProductFixture,
  createCccPrdImportTestProductBundle,
  createCccPrdImportTestProductExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../../../core/src/__test-utils__/ccc-prd-import-fixture.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import type { TaskStore } from "../../../core/src/store.js";
import {
  applyCccCampaignOperatorControl,
  CccCampaignOperatorControlError,
} from "../ccc-campaign-operator-control.js";

type ProviderAttemptStore = TaskStore & {
  reserveCccProviderAttempt(input: CccProviderAttemptRequest): Promise<CccProviderAttemptScope>;
};
const api = (store: TaskStore): ProviderAttemptStore => store as ProviderAttemptStore;

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
   * Same admitted fixture as `importedCampaign`, but with real launch
   * headroom: the base fixture's `maxDurationMs` is 1000ms, which
   * `reserveCccProviderAttempt` always refuses (its 30s minimum launch
   * headroom, `CCC_PROVIDER_ATTEMPT_MIN_LAUNCH_HEADROOM_MS`, can never fit in
   * a 1s campaign). Only tests that need to seed a real provider attempt use
   * this widened bundle; the deadline is still computed from real import
   * time, so this does not change what `stop` closes or how.
   */
  async function importedCampaignWithHeadroom(key: string) {
    const legacy = createCccPrdImportTestProductBundle(h.rootDir(), key);
    const withHeadroom = rehashCccPrdImportTestBundle({
      ...legacy,
      bounds: { ...legacy.bounds, maxDurationMs: 300_000 },
    });
    const { bundle, semanticProofToolchainPaths } =
      await admitCccPrdImportTestProductBundle(withHeadroom, key);
    await importCccPrdBundle({
      bundle,
      executionPolicy: createCccPrdImportTestProductExecutionPolicy(bundle),
      semanticProofToolchainPaths,
      idempotencyKey: key,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
  }

  function providerAttemptRequest(
    taskId: string,
    workItem: { id: string; runId: string; attempt: number },
  ): CccProviderAttemptRequest {
    return {
      taskId,
      actionId: taskId,
      actionTarget: h.rootDir(),
      turnKey: "turn-closeout-seed",
      dispatchKey: "dispatch-closeout-seed",
      providerId: "deterministic-fake",
      modelId: "fixture-v2",
      transport: "pi",
      workItemFence: {
        workItemId: workItem.id,
        runId: workItem.runId,
        // A fresh work item's own `attempt` is 0 before its first dispatch;
        // the provider-attempt fence requires a positive integer, so this
        // records the attempt this reservation belongs to (its first).
        attempt: Math.max(1, workItem.attempt),
      },
    };
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
   *
   * Review correction (Gemini adversarial review of PR #75): an earlier fix
   * shape made `inspectCccPrdProductStatus` skip the provider-attempt-history
   * fetch entirely once the import row was non-active. That silently emptied
   * `status.providerAttempts` for every stopped campaign -- the close-out
   * receipt and every later `fn prd status` would lose the attempt ledger,
   * and `fn prd resolve-provider` could no longer resolve a dispatched_unknown
   * attempt on a stopped campaign. This test seeds one real provider attempt
   * before closing the campaign and asserts it is still there afterward, so a
   * fix that merely stops throwing (by returning nothing) fails it exactly
   * the way the wrong fix did.
   */
  it("a status read after the close-out write does not refuse, still lists the campaign's provider-attempt history, and reports the campaign closed -- not merely the workflow item", async () => {
    const key = "operator-control-closeout-status-after-write";
    await importedCampaignWithHeadroom(key);

    const preCloseStatus = await inspectCccPrdProductStatus({
      idempotencyKey: key,
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    if (!preCloseStatus) throw new Error("missing product status for closeout fixture");
    const anchorTask = preCloseStatus.tasks[0];
    if (!anchorTask) throw new Error("closeout fixture has no anchor task");
    const workItem = preCloseStatus.workItems[0];
    if (!workItem) throw new Error("closeout fixture has no workflow work item");

    // Seed one real provider attempt while the campaign is still active --
    // exactly what a real campaign has by the time its work item fails.
    const seeded = await api(h.store()).reserveCccProviderAttempt(
      providerAttemptRequest(anchorTask.nativeTaskId, workItem),
    );
    expect(seeded.state).toBe("reserved");

    const originalFailure = "ccc-permanent:CCC_CAMPAIGN_PROOF_DISPATCH_UNKNOWN";
    await forceWorkItemFailed(key, originalFailure);

    const status = await inspectCccPrdProductStatus({
      idempotencyKey: key,
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    if (!status) throw new Error("missing product status for closeout fixture");
    expect(status.providerAttempts).toHaveLength(1);

    const result = await applyCccCampaignOperatorControl({
      action: "stop",
      reason: STOP_REASON,
      status,
      store: h.store(),
    });
    // The receipt kind `runCampaignLifecycleCommand` renders is picked by
    // this flag (prd.ts: `result.closedAfterTerminalFailure ?
    // "campaign-closed-after-terminal-failure" : "campaign-stopped"`).
    expect(result.closedAfterTerminalFailure).toBe(true);

    // This is the exact step `runCampaignLifecycleCommand` takes to build the
    // receipt's `completedStatus` right after the write above. Before the
    // first fix this threw CccCampaignContextError("... belongs to a
    // non-runnable CCC campaign import") because the import row it just wrote
    // is no longer active/runnable, and `withPrdProject` converts that thrown
    // error into a refusal payload instead of ever reaching the
    // receipt-writing code. A fix that instead skips the fetch and returns
    // silently would pass that check but fail the assertion below.
    const completedStatus = await inspectCccPrdProductStatus({
      idempotencyKey: key,
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    if (!completedStatus) throw new Error("product status disappeared after close-out");
    expect(completedStatus.import.state).toBe("stopped");
    expect(completedStatus.import.runnable).toBe(false);
    // The provider-attempt audit trail is untouched by `markCccPrdImportStopped`
    // (it only ever writes the import row's state/runnable/lastError columns),
    // so a status read of a closed campaign must still list it honestly.
    expect(completedStatus.providerAttempts).toHaveLength(1);
    expect(completedStatus.providerAttempts[0]?.attemptKey).toBe(seeded.attemptKey);
    expect(completedStatus.providerAttempts[0]?.state).toBe("reserved");
    // A degraded read (the internal `providerAttemptHistoryConsistent` flag
    // set false) would have returned an empty list instead -- the non-empty,
    // exact-match list above is itself the proof the history read succeeded
    // honestly rather than being silently skipped.
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
