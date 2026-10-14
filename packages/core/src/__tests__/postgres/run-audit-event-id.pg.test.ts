/**
 * FNXC:CccPlanningAuditEventId 2026-10-14 (card S0, D39):
 * Deterministic run-audit event ids for request-to-code planning. A planning
 * writer derives `ccc-plan-event-<sha256>` from (projectId, runId, mutationType,
 * subject) and passes it as `eventId`. The insert reuses the campaign path's
 * ON CONFLICT DO NOTHING, re-read and compare, and the existing
 * RunAuditEventCollisionError; the planning comparison omits `timestamp`
 * because a replay happens at a later clock. Without `eventId` nothing changes.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  recordRunAuditEvent,
  recordRunAuditEventWithinTransaction,
  RunAuditEventCollisionError,
  type RunAuditEventInput,
} from "../../postgres/data-layer.js";
import type { RunAuditMutationType } from "../../types/run-audit.js";
import { importCccPrdBundle } from "../../index.js";
import { createCccCampaignAuthorityBinding } from "../../ccc-campaign/canonical.js";
import { canonicalCccPrdJson } from "../../ccc-prd/contract.js";
import type { CccCampaignAuthorityBinding, CccCampaignContext } from "../../ccc-campaign/types.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  createCccPrdImportTestBundle,
  createCccPrdImportTestExecutionPolicy,
  rehashCccPrdImportTestBundle,
} from "../../__test-utils__/ccc-prd-import-fixture.js";

const PLANNING_AUDIT_LITERALS = [
  "ccc-planning:call:reserved", "ccc-planning:call:dispatched", "ccc-planning:call:terminal",
  "ccc-planning:lineage:created", "ccc-planning:control", "ccc-planning:decision:answered",
  "ccc-planning:repair-chunk", "ccc-planning:repair-epoch-closed", "ccc-planning:review-epoch",
  "ccc-planning:fetch:reserved", "ccc-planning:fetch:settled", "ccc-planning:artifact-published",
  "ccc-planning:import-intent", "ccc-planning:import-linked", "ccc-planning:live-execution-released",
  "ccc-planning:state", "ccc-planning:writer-refused", "ccc-planning:campaign-unmapped",
  "ccc-planning:build-baseline",
] as const;

const T1 = "2026-10-14T12:00:00.000Z";
const T2 = "2026-10-14T12:05:00.000Z";

/** Mirrors K1's cccPlanningEventId: "ccc-plan-event-" + sha256("ccc-plan-event/v1\0" + canonical(input)). */
function planningEventId(input: { projectId: string; runId: string; mutationType: string; subject: string }): string {
  return `ccc-plan-event-${createHash("sha256")
    .update(`ccc-plan-event/v1\0${canonicalCccPrdJson(input)}`, "utf8")
    .digest("hex")}`;
}

let runOrdinal = 0;
function planningEvent(overrides: Partial<RunAuditEventInput> = {}): RunAuditEventInput & { eventId: string } {
  runOrdinal += 1;
  const runId = `ccc-plan:${createHash("sha256").update(`s0-event-run-${runOrdinal}`).digest("hex").slice(0, 24)}`;
  const subject = `admitted->running@${T1}`;
  return {
    eventId: planningEventId({ projectId: "__legacy_unscoped__", runId, mutationType: "ccc-planning:state", subject }),
    timestamp: T1,
    agentId: "ccc-planning-controller",
    runId,
    domain: "database",
    mutationType: "ccc-planning:state",
    target: subject,
    metadata: { from: "admitted", to: "running", stateCode: null, nested: { ordinal: 1 } },
    ...overrides,
  };
}

type CampaignContextStore = {
  getCccCampaignContextForTask(taskId: string): Promise<CccCampaignContext | null>;
};

describe("run-audit planning literals", () => {
  it("RunAuditMutationType names exactly the 19 ccc-planning audit literals", () => {
    const source = readFileSync(fileURLToPath(new URL("../../types/run-audit.ts", import.meta.url)), "utf8");
    const union = /export type RunAuditMutationType =([\s\S]*?);/.exec(source)?.[1] ?? "";
    const named = [...union.matchAll(/"(ccc-planning:[^"]+)"/g)].map((match) => match[1]);
    expect(named).toEqual([...PLANNING_AUDIT_LITERALS]);
    expect(new Set(named).size).toBe(19);
    // The union keeps its open `string & {}` member, so planning literals stay assignable.
    const sample: RunAuditMutationType = PLANNING_AUDIT_LITERALS[0];
    expect(sample).toBe("ccc-planning:call:reserved");
  });
});

pgDescribe("run-audit deterministic planning event ids (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_run_audit_event_id" });
  let custodyOrdinal = 0;

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function auditRows(runId: string): Promise<Array<Record<string, unknown>>> {
    return (await h.layer().db.execute(sql`
      SELECT id, project_id, timestamp, agent_id, target, metadata
        FROM project.run_audit_events WHERE run_id = ${runId} ORDER BY id
    `)) as unknown as Array<Record<string, unknown>>;
  }

  /** An admitted campaign binding, as in data-layer.test.ts, so the campaign path runs unchanged. */
  async function admittedBinding(actionId = "s0-audit-action"): Promise<CccCampaignAuthorityBinding> {
    const suffix = `s0-event-id-${custodyOrdinal++}`;
    const actionTarget = `audit-target:${actionId}`;
    const base = createCccPrdImportTestBundle(h.rootDir(), suffix);
    const source = rehashCccPrdImportTestBundle({
      ...base,
      tasks: base.tasks.map((task, index) => index === 0 ? { ...task, protectedActionIds: [actionId] } : task),
      protectedActions: [{
        id: actionId,
        kind: "merge",
        target: actionTarget,
        operatorDecision: "approve_merge",
        requiresOperatorDecision: true,
        spans: [base.tasks[0]!.spans[0]!],
      }],
    });
    const imported = await importCccPrdBundle({
      bundle: source,
      executionPolicy: createCccPrdImportTestExecutionPolicy(source),
      idempotencyKey: `s0-event-id-custody-${suffix}`,
      store: h.store(),
      layer: h.layer(),
      rootDir: h.rootDir(),
    });
    const [taskEntity] = (await h.layer().db.execute(sql`
      SELECT native_id FROM project.ccc_prd_import_entities
       WHERE import_id = ${imported.importId} AND entity_type = 'task' AND entity_id = ${`TASK-${suffix}`}
    `)) as unknown as Array<{ native_id: string }>;
    expect(taskEntity).toBeDefined();
    const context = await (h.store() as unknown as CampaignContextStore).getCccCampaignContextForTask(taskEntity!.native_id);
    expect(context).not.toBeNull();
    return createCccCampaignAuthorityBinding(context!, { actionId, actionTarget, requireProtected: true });
  }

  it("replays one eventId at a later timestamp as one row and returns the first persisted event", async () => {
    const first = planningEvent();
    const recorded = await recordRunAuditEvent(h.layer(), first);
    expect(recorded.id).toBe(first.eventId);
    expect(recorded.timestamp).toBe(T1);

    const replayed = await recordRunAuditEvent(h.layer(), { ...first, timestamp: T2 });
    expect(replayed).toEqual(recorded);
    expect(replayed.timestamp).toBe(T1);
    expect(await auditRows(first.runId)).toEqual([
      expect.objectContaining({ id: first.eventId, project_id: "__legacy_unscoped__", timestamp: T1 }),
    ]);
  });

  it.each([
    ["metadata", { metadata: { from: "admitted", to: "running", stateCode: null, nested: { ordinal: 2 } } }],
    ["agentId", { agentId: "operator:someone-else" }],
    ["target", { target: `admitted->running@${T2}` }],
  ] as const)(
    "throws RunAuditEventCollisionError when the same eventId carries a different %s, and keeps the first row",
    async (_field, change) => {
      const first = planningEvent();
      const recorded = await recordRunAuditEvent(h.layer(), first);
      // Control: the identical payload under the same id replays.
      await expect(recordRunAuditEvent(h.layer(), first)).resolves.toEqual(recorded);

      const collision = recordRunAuditEvent(h.layer(), { ...first, ...change });
      await expect(collision).rejects.toBeInstanceOf(RunAuditEventCollisionError);
      await expect(collision).rejects.toMatchObject({ code: "CCC_RUN_AUDIT_EVENT_COLLISION" });
      const rows = await auditRows(first.runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: first.eventId, agent_id: first.agentId, target: first.target });
      expect(rows[0]!.metadata).toEqual(first.metadata);
    },
  );

  it("replays inside one caller transaction under an explicit projectId and re-reads that project's row", async () => {
    const projectId = "r2c-s0-explicit-project";
    const base = planningEvent();
    const event = {
      ...base,
      eventId: planningEventId({ projectId, runId: base.runId, mutationType: base.mutationType, subject: base.target }),
    };
    const [first, second] = await h.layer().transactionImmediate(async (tx) => [
      await recordRunAuditEventWithinTransaction(tx, event, projectId),
      await recordRunAuditEventWithinTransaction(tx, { ...event, timestamp: T2 }, projectId),
    ]);
    expect(second).toEqual(first);
    expect(first.id).toBe(event.eventId);
    expect(await auditRows(event.runId)).toEqual([
      expect.objectContaining({ id: event.eventId, project_id: projectId, timestamp: T1 }),
    ]);
  });

  it("refuses a malformed eventId before writing anything; the well-formed id is admitted", async () => {
    const valid = planningEvent();
    const hex = valid.eventId.slice("ccc-plan-event-".length);
    for (const eventId of [
      `ccc-plan-event-${hex.toUpperCase()}`,
      `ccc-plan-event-${hex.slice(1)}`,
      `ccc-audit-${hex}`,
      "",
    ]) {
      await expect(recordRunAuditEvent(h.layer(), { ...valid, eventId })).rejects.toBeInstanceOf(TypeError);
    }
    expect(await auditRows(valid.runId)).toEqual([]);

    await recordRunAuditEvent(h.layer(), valid);
    expect(await auditRows(valid.runId)).toEqual([expect.objectContaining({ id: valid.eventId })]);
  });

  it("refuses an eventId combined with a campaign event key; the campaign path alone is unchanged and still compares timestamps", async () => {
    const binding = await admittedBinding();
    const campaignEvent: RunAuditEventInput = {
      timestamp: T1,
      taskId: binding.taskId,
      agentId: "ccc-audit-agent",
      runId: "s0-campaign-audit-run",
      domain: "database",
      mutationType: "ccc-campaign:audit",
      target: binding.actionTarget,
      metadata: { result: "accepted" },
      campaign: { eventKey: "s0-campaign-event-key", binding },
    };

    await expect(recordRunAuditEvent(h.layer(), { ...campaignEvent, eventId: planningEvent().eventId }))
      .rejects.toBeInstanceOf(TypeError);
    expect(await auditRows(campaignEvent.runId)).toEqual([]);

    const recorded = await recordRunAuditEvent(h.layer(), campaignEvent);
    expect(recorded.id).toMatch(/^ccc-audit-[0-9a-f]{64}$/);
    await expect(recordRunAuditEvent(h.layer(), campaignEvent)).resolves.toEqual(recorded);
    await expect(recordRunAuditEvent(h.layer(), { ...campaignEvent, timestamp: T2 }))
      .rejects.toBeInstanceOf(RunAuditEventCollisionError);
    expect(await auditRows(campaignEvent.runId)).toEqual([expect.objectContaining({ id: recorded.id, timestamp: T1 })]);
  });

  it("without an eventId the legacy path is unchanged: each call writes its own random id", async () => {
    const { eventId: _eventId, ...legacy } = planningEvent();
    const first = await recordRunAuditEvent(h.layer(), legacy);
    const second = await recordRunAuditEvent(h.layer(), legacy);
    expect(first.id).not.toBe(second.id);
    expect(first.id).not.toMatch(/^ccc-plan-event-/);
    expect(await auditRows(legacy.runId)).toHaveLength(2);
  });
});
