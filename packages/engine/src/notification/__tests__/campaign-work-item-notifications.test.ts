/**
 * FNXC:CampaignNotifications 2026-08-11-00:00:
 * Campaign-aware operator pings through the existing notifier plumbing.
 * Operator decision (2026-08-11 top-down audit, Lane A): ping on exactly two
 * campaign events, delivered via the store-level `workitem:transitioned` funnel:
 *   1. campaign-needs-decision — a campaign work item parks manual-required with
 *      a ccc-* machine reason (startup recovery, provider-dispatch permanent
 *      parks, merge-approval waits all produce this transition).
 *   2. campaign-failed — a campaign work item reaches terminal failed/exhausted.
 * Payloads carry machine facts only (identifiers, state, bounded ccc reason
 * code) — never prompt text, receipts content, or arbitrary error strings.
 * Dedupe keys on work item + state so re-parks/replays of the same state never
 * re-ping.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationProvider, Settings, WorkflowWorkItem } from "@fusion/core";
import { NotificationService } from "../notification-service.js";
import {
  classifyCccCampaignWorkItemNotification,
  extractCccCampaignReasonCode,
} from "../campaign-work-item-notifications.js";
import { NtfyNotificationProvider } from "../ntfy-provider.js";

vi.mock("../../logger.js", () => ({
  schedulerLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Listener = (...args: any[]) => void | Promise<void>;

function createStore(settings: Partial<Settings> = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const currentSettings: Settings = {
    ntfyEnabled: true,
    ntfyTopic: "topic",
    ...settings,
  } as Settings;

  const getBucket = (event: string) => listeners.get(event) ?? new Set<Listener>();

  return {
    on(event: string, listener: Listener) {
      const bucket = getBucket(event);
      bucket.add(listener);
      listeners.set(event, bucket);
    },
    off(event: string, listener: Listener) {
      getBucket(event).delete(listener);
    },
    emit(event: string, payload: unknown) {
      for (const listener of getBucket(event)) {
        void listener(payload);
      }
    },
    getSettings: vi.fn(async () => currentSettings),
  };
}

function workItem(overrides: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return {
    id: "wi-1",
    runId: "ccc-prd:import-1",
    taskId: "KB-001",
    nodeId: "node-1",
    kind: "task",
    state: "running",
    attempt: 1,
    retryAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    blockedReason: null,
    stableWorkflowRunId: "ccc-prd:import-1",
    continuationSequence: null,
    waitReason: null,
    sourceColumn: null,
    targetColumn: null,
    irHash: "a".repeat(64),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function setup(settings: Partial<Settings> = {}) {
  // Keep provider fetches hermetic: the real ntfy provider registers when
  // settings enable it, and its delivery path must never leave the test.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
  const store = createStore(settings);
  const sendNotification = vi.fn(async () => ({ success: true, providerId: "sink" }));
  const provider: NotificationProvider = {
    getProviderId: () => "sink",
    isEventSupported: () => true,
    sendNotification,
  };
  const service = new NotificationService(store as any, {});
  service.registerProvider(provider);
  await service.start();
  return { store, service, sendNotification };
}

async function flush(): Promise<void> {
  // Dispatch is fire-and-forget; let the promise chain settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("NotificationService campaign work-item notifications", () => {
  it("manual-required park with a ccc-* reason dispatches campaign-needs-decision with machine facts only", async () => {
    const { store, service, sendNotification } = await setup();
    const reason = "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED";
    store.emit("workitem:transitioned", workItem({
      state: "manual-required",
      lastError: reason,
      blockedReason: reason,
    }));
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith("campaign-needs-decision", expect.objectContaining({
      taskId: "KB-001",
      event: "campaign-needs-decision",
      metadata: expect.objectContaining({
        workItemId: "wi-1",
        runId: "ccc-prd:import-1",
        state: "manual-required",
        attempt: 1,
        reasonCode: reason,
        notificationDedupeKey: "ccc-campaign:wi-1:manual-required",
      }),
    }));
    await service.stop();
  });

  it("re-parking the same work item into the same state does not re-ping", async () => {
    const { store, service, sendNotification } = await setup();
    const reason = "ccc-permanent:CCC_CAMPAIGN_UNCERTAIN_EXTERNAL_EFFECT_REQUIRES_OPERATOR";
    const parked = workItem({ state: "manual-required", lastError: reason, blockedReason: reason });
    store.emit("workitem:transitioned", parked);
    await flush();
    store.emit("workitem:transitioned", parked);
    store.emit("workitem:transitioned", { ...parked, updatedAt: new Date().toISOString() });
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it("terminal exhausted campaign work dispatches campaign-failed with the bounded reason code", async () => {
    const { store, service, sendNotification } = await setup();
    store.emit("workitem:transitioned", workItem({
      state: "exhausted",
      lastError: "ccc-transient-retry-exhausted",
    }));
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith("campaign-failed", expect.objectContaining({
      metadata: expect.objectContaining({
        workItemId: "wi-1",
        state: "exhausted",
        reasonCode: "ccc-transient-retry-exhausted",
        notificationDedupeKey: "ccc-campaign:wi-1:exhausted",
      }),
    }));
    await service.stop();
  });

  it("terminal failure of an imported campaign work item never leaks the arbitrary error string", async () => {
    const { store, service, sendNotification } = await setup();
    const arbitraryError = "workflow-work-item-node-error: ENOTDIR /secret/path exploded";
    store.emit("workitem:transitioned", workItem({
      state: "failed",
      lastError: arbitraryError,
    }));
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [eventName, payload] = sendNotification.mock.calls[0]!;
    expect(eventName).toBe("campaign-failed");
    // Machine facts only: the free-text error must not appear anywhere.
    expect(JSON.stringify(payload)).not.toContain("ENOTDIR");
    expect(JSON.stringify(payload)).not.toContain("/secret/path");
    expect((payload as { metadata?: Record<string, unknown> }).metadata?.reasonCode).toBeUndefined();
    await service.stop();
  });

  it("non-campaign manual-required parks and failures stay silent", async () => {
    const { store, service, sendNotification } = await setup();
    store.emit("workitem:transitioned", workItem({
      // Not an imported campaign shape, no ccc reason.
      runId: "run-1",
      stableWorkflowRunId: null,
      irHash: null,
      state: "manual-required",
      lastError: "manual-required",
    }));
    store.emit("workitem:transitioned", workItem({
      runId: "run-2",
      stableWorkflowRunId: null,
      irHash: null,
      state: "failed",
      lastError: "workflow-work-item-node-error: boom",
    }));
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
    await service.stop();
  });

  it("non-terminal campaign transitions stay silent (exactly two campaign events)", async () => {
    const { store, service, sendNotification } = await setup();
    for (const state of ["runnable", "running", "held", "retrying", "succeeded", "cancelled"] as const) {
      store.emit("workitem:transitioned", workItem({ state, lastError: "ccc-transient:TRANSIENT" }));
    }
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
    await service.stop();
  });
});

describe("classifyCccCampaignWorkItemNotification", () => {
  it("classifies the named park reasons from startup recovery and merge approval", () => {
    for (const reason of [
      "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
      "ccc-permanent:CCC_CAMPAIGN_UNCERTAIN_EXTERNAL_EFFECT_REQUIRES_OPERATOR",
      "ccc-permanent:CCC_CAMPAIGN_PRODUCT_STATUS_REFUSED_REQUIRES_OPERATOR",
    ]) {
      expect(classifyCccCampaignWorkItemNotification(workItem({
        state: "manual-required",
        blockedReason: reason,
        lastError: reason,
      }))).toEqual({ event: "campaign-needs-decision", reasonCode: reason });
    }
  });

  it("keeps only the bounded machine token from a reason with an appended error message", () => {
    // Startup recovery writes `<code>: <error.message>` into lastError.
    const code = "ccc-permanent:CCC_CAMPAIGN_PRODUCT_STATUS_REFUSED_REQUIRES_OPERATOR";
    expect(extractCccCampaignReasonCode(`${code}: missing provider-attempt anchor task FN-99`)).toBe(code);
    expect(extractCccCampaignReasonCode("ccc-transient-retry-exhausted")).toBe("ccc-transient-retry-exhausted");
    expect(extractCccCampaignReasonCode("ccc-transient-retry-exhausted:TIMEOUT")).toBe("ccc-transient-retry-exhausted:TIMEOUT");
    expect(extractCccCampaignReasonCode("workflow-work-item-node-error: boom")).toBeUndefined();
    expect(extractCccCampaignReasonCode(null)).toBeUndefined();
  });

  it("requires campaign evidence for terminal failures", () => {
    // Imported campaign shape with an arbitrary error: campaign-failed, no reason code.
    expect(classifyCccCampaignWorkItemNotification(workItem({
      state: "failed",
      lastError: "workflow-work-item-node-error: boom",
    }))).toEqual({ event: "campaign-failed" });
    // Non-campaign shape, non-ccc error: silent.
    expect(classifyCccCampaignWorkItemNotification(workItem({
      state: "failed",
      runId: "run-1",
      stableWorkflowRunId: null,
      irHash: null,
      lastError: "workflow-work-item-node-error: boom",
    }))).toBeNull();
    // Non-campaign shape but a ccc-* machine reason is campaign evidence.
    expect(classifyCccCampaignWorkItemNotification(workItem({
      state: "exhausted",
      runId: "run-1",
      stableWorkflowRunId: null,
      irHash: null,
      lastError: "ccc-transient-retry-exhausted",
    }))).toEqual({ event: "campaign-failed", reasonCode: "ccc-transient-retry-exhausted" });
  });

  it("manual-required without a ccc-* reason is not a campaign decision", () => {
    expect(classifyCccCampaignWorkItemNotification(workItem({
      state: "manual-required",
      lastError: "manual-required",
    }))).toBeNull();
  });
});

describe("NtfyNotificationProvider campaign events", () => {
  it("delivers campaign-needs-decision with machine facts only under default events", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new NtfyNotificationProvider();
    await provider.initialize?.({ topic: "campaign-topic" });

    const result = await provider.sendNotification("campaign-needs-decision", {
      taskId: "KB-001",
      event: "campaign-needs-decision",
      metadata: {
        workItemId: "wi-1",
        state: "manual-required",
        reasonCode: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
        notificationDedupeKey: "ccc-campaign:wi-1:manual-required",
      },
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const body = String(init.body);
    expect(body).toContain("wi-1");
    expect(body).toContain("manual-required");
    expect(body).toContain("CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED");
  });

  it("delivers campaign-failed under default events", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new NtfyNotificationProvider();
    await provider.initialize?.({ topic: "campaign-topic" });

    const result = await provider.sendNotification("campaign-failed", {
      taskId: "KB-001",
      event: "campaign-failed",
      metadata: { workItemId: "wi-2", state: "exhausted", reasonCode: "ccc-transient-retry-exhausted" },
    });

    expect(result.success).toBe(true);
    expect(String((fetchMock.mock.calls[0]! as unknown as [string, RequestInit])[1].body)).toContain("exhausted");
  });
});
