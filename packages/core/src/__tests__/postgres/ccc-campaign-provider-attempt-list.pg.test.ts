import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  CccCampaignContextError,
  importCccPrdBundle,
  listCccProviderAttemptsForCampaign,
} from "../../index.js";
import {
  createCccPrdImportTestBundle,
  createCccPrdImportTestExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../../__test-utils__/ccc-prd-import-fixture.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { TaskStore } from "../../store.js";
import type {
  CccProviderAttemptRequest,
  CccProviderAttemptScope,
  CccProviderAttemptTransition,
} from "../../ccc-campaign/index.js";

type ProviderAttemptStore = TaskStore & {
  reserveCccProviderAttempt(input: CccProviderAttemptRequest): Promise<CccProviderAttemptScope>;
  beginCccProviderAttemptDispatch(input: CccProviderAttemptTransition): Promise<
    | Readonly<{ kind: "dispatch-permit"; scope: CccProviderAttemptScope }>
    | Readonly<{ kind: "dispatched-unknown" | "terminal"; scope: CccProviderAttemptScope }>
  >;
  reconcileCccProviderAttempt(input: CccProviderAttemptTransition & {
    outcome: "committed" | "proved_failed";
    evidenceDigest: string;
    observerId: string;
  }): Promise<CccProviderAttemptScope>;
};

const api = (store: TaskStore): ProviderAttemptStore => store as ProviderAttemptStore;

pgDescribe("CCC campaign provider-attempt listing (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_ccc_provider_attempt_list" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function nativeTaskIdForImport(importId: string, semanticTaskId: string): Promise<string> {
    const rows = await h.layer().db.execute(sql`
      SELECT native_id
      FROM project.ccc_prd_import_entities
      WHERE import_id = ${importId}
        AND entity_type = 'task'
        AND entity_id = ${semanticTaskId}
    `) as unknown as Array<{ native_id: string }>;
    expect(rows).toHaveLength(1);
    return rows[0]!.native_id;
  }

  async function context(suffix: string) {
    const initial = createCccPrdImportTestBundle(h.rootDir(), suffix);
    const source = rehashCccPrdImportTestBundle({
      ...initial,
      bounds: { maxRequests: 4, maxDurationMs: 60_000, maxConcurrency: 4 },
    });
    const imported = await importCccPrdBundle({
      bundle: source,
      idempotencyKey: `provider-attempt-list-${suffix}`,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
      executionPolicy: createCccPrdImportTestExecutionPolicy(source),
    });
    const semanticTaskId = `TASK-${suffix}`;
    const taskId = await nativeTaskIdForImport(imported.importId, semanticTaskId);
    return { taskId, semanticTaskId };
  }

  function request(taskId: string, turnKey: string): CccProviderAttemptRequest {
    return {
      taskId,
      actionId: taskId,
      actionTarget: h.rootDir(),
      turnKey,
      dispatchKey: `dispatch-${turnKey}`,
      providerId: "deterministic-fake",
      modelId: "fixture-v1",
      transport: "pi",
      workItemFence: {
        workItemId: `work-item-${turnKey}`,
        runId: `run-${turnKey}`,
        attempt: 1,
      },
    };
  }

  async function providerAttemptAuditCount(): Promise<number> {
    const rows = await h.layer().db.execute(sql`
      SELECT count(*)::int AS count
      FROM project.run_audit_events
      WHERE mutation_type LIKE 'ccc-campaign:provider-attempt:%'
    `) as unknown as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  }

  /**
   * Mirrors exactly what `markCccPrdImportStopped` writes (state, runnable,
   * updated_at as an ISO string) without going through the operator-control
   * layer -- this file unit-tests `listCccProviderAttemptsForCampaign` in
   * isolation, the same way its sibling tests exercise it directly.
   */
  async function closeImportRow(taskId: string): Promise<void> {
    await h.layer().db.execute(sql`
      UPDATE project.ccc_prd_imports
      SET state = 'stopped', runnable = 0, updated_at = ${new Date().toISOString()}
      WHERE import_id = (
        SELECT import_id FROM project.ccc_prd_import_entities
        WHERE entity_type = 'task' AND native_id = ${taskId}
      )
    `);
  }

  it("returns an immutable empty list without writes when the campaign context is missing", async () => {
    const before = await providerAttemptAuditCount();

    const attempts = await listCccProviderAttemptsForCampaign({
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId: "TASK-missing-provider-list",
    });

    expect(attempts).toEqual([]);
    expect(Object.isFrozen(attempts)).toBe(true);
    expect(await providerAttemptAuditCount()).toBe(before);
  });

  it("lists reserved, dispatched_unknown, and terminal attempts in request order after restart", async () => {
    const { taskId, semanticTaskId } = await context("states");
    const store = api(h.store());
    const reserved = await store.reserveCccProviderAttempt(request(taskId, "turn-reserved"));
    const dispatched = await store.reserveCccProviderAttempt(request(taskId, "turn-dispatched"));
    const terminal = await store.reserveCccProviderAttempt(request(taskId, "turn-terminal"));
    await store.beginCccProviderAttemptDispatch({
      taskId,
      attemptKey: dispatched.attemptKey,
      controllerToken: dispatched.controllerToken,
    });
    await store.beginCccProviderAttemptDispatch({
      taskId,
      attemptKey: terminal.attemptKey,
      controllerToken: terminal.controllerToken,
    });
    await store.reconcileCccProviderAttempt({
      taskId,
      attemptKey: terminal.attemptKey,
      controllerToken: terminal.controllerToken,
      outcome: "committed",
      evidenceDigest: "a".repeat(64),
      observerId: "provider-list-observer",
    });

    const restarted = await listCccProviderAttemptsForCampaign({
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId,
    });

    expect(restarted.map((attempt) => ({
      attemptKey: attempt.attemptKey,
      requestCount: attempt.requestCount,
      state: attempt.state,
      semanticTaskId: attempt.semanticTaskId,
      workItemFence: attempt.workItemFence,
    }))).toEqual([
      {
        attemptKey: reserved.attemptKey,
        requestCount: 1,
        state: "reserved",
        semanticTaskId,
        workItemFence: { workItemId: "work-item-turn-reserved", runId: "run-turn-reserved", attempt: 1 },
      },
      {
        attemptKey: dispatched.attemptKey,
        requestCount: 2,
        state: "dispatched_unknown",
        semanticTaskId,
        workItemFence: { workItemId: "work-item-turn-dispatched", runId: "run-turn-dispatched", attempt: 1 },
      },
      {
        attemptKey: terminal.attemptKey,
        requestCount: 3,
        state: "committed",
        semanticTaskId,
        workItemFence: { workItemId: "work-item-turn-terminal", runId: "run-turn-terminal", attempt: 1 },
      },
    ]);
    expect(restarted[2]?.terminal).toEqual({
      kind: "reconciled",
      state: "committed",
      evidenceDigest: "a".repeat(64),
      observerId: "provider-list-observer",
    });
  });

  it("returns frozen scopes and leaves persisted provider-attempt history unchanged", async () => {
    const { taskId } = await context("readonly");
    const store = api(h.store());
    await store.reserveCccProviderAttempt(request(taskId, "turn-readonly"));
    const before = await providerAttemptAuditCount();

    const attempts = await listCccProviderAttemptsForCampaign({
      layer: h.layer(),
      rootDir: h.rootDir(),
      taskId,
    });

    expect(attempts).toHaveLength(1);
    expect(Object.isFrozen(attempts)).toBe(true);
    expect(Object.isFrozen(attempts[0])).toBe(true);
    expect(Object.isFrozen(attempts[0]?.binding)).toBe(true);
    expect(Object.isFrozen(attempts[0]?.workItemFence)).toBe(true);
    expect(() => {
      (attempts as CccProviderAttemptScope[]).push(attempts[0]!);
    }).toThrow(TypeError);
    expect(await providerAttemptAuditCount()).toBe(before);
  });

  it(
    "still lists a closed import's provider-attempt history (read-only tolerance) while a write-path call against the same closed import keeps refusing",
    async () => {
      const { taskId } = await context("closed-readonly");
      const store = api(h.store());
      const seeded = await store.reserveCccProviderAttempt(request(taskId, "turn-before-close"));

      await closeImportRow(taskId);

      // The read-only listing path (`listCccProviderAttemptsForCampaign` ->
      // `loadCccCampaignContextForTask(..., allowNonRunnable: true)`) must
      // still surface the attempt recorded while the campaign was active --
      // closing an import does not erase its provider-attempt audit rows, and
      // a status read of a closed campaign must not have to pretend they are
      // gone.
      const attemptsAfterClose = await listCccProviderAttemptsForCampaign({
        layer: h.layer(),
        rootDir: h.rootDir(),
        taskId,
      });
      expect(attemptsAfterClose).toHaveLength(1);
      expect(attemptsAfterClose[0]?.attemptKey).toBe(seeded.attemptKey);
      expect(attemptsAfterClose[0]?.state).toBe("reserved");

      // The read-only tolerance must never reach a write/leasing path: a
      // second reservation attempt against the same now-closed import must
      // still refuse exactly as it did before this change.
      let writeError: unknown;
      try {
        await store.reserveCccProviderAttempt(request(taskId, "turn-after-close"));
      } catch (error) {
        writeError = error;
      }
      expect(writeError).toBeInstanceOf(CccCampaignContextError);
      expect((writeError as CccCampaignContextError).message).toContain(
        "belongs to a non-runnable CCC campaign import",
      );
    },
  );
});
