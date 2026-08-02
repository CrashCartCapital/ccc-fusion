// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@fusion/core";
import { request } from "../../test-request.js";
import { registerApprovalRoutes } from "../register-approval-routes.js";

const core = vi.hoisted(() => ({
  AgentStore: vi.fn(),
  ApprovalRequestStore: vi.fn(),
  extractSandboxProvisioningRequest: vi.fn(),
}));

vi.mock("@fusion/core", () => core);

const engine = vi.hoisted(() => ({
  assertNoSecretPlaintext: vi.fn(),
  executeApprovedAgentProvisioning: vi.fn(),
  executeApprovedWorktrunkInstall: vi.fn(),
}));

vi.mock("@fusion/engine", () => engine);

const approvalStore = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  decide: vi.fn(),
  getAuditHistory: vi.fn(),
}));

function makeApproval(overrides: {
  id: string;
  status?: ApprovalRequest["status"];
  targetAction: ApprovalRequest["targetAction"];
  taskId?: string;
}): ApprovalRequest {
  return {
    id: overrides.id,
    status: overrides.status ?? "pending",
    requester: { actorId: "agent-1", actorType: "agent", actorName: "Agent One" },
    targetAction: overrides.targetAction,
    taskId: overrides.taskId,
    runId: undefined,
    requestedAt: "2026-08-01T00:00:00.000Z",
    decidedAt: undefined,
    completedAt: undefined,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  } as ApprovalRequest;
}

function createApp() {
  const store = {
    getAsyncLayer: vi.fn(() => ({ projectId: "project-1" })),
    getFusionDir: vi.fn(() => "/project/.fusion"),
    getSettings: vi.fn().mockResolvedValue({}),
    getTask: vi.fn().mockResolvedValue(null),
    recordRunAuditEvent: vi.fn(),
  };
  const router = express.Router();
  registerApprovalRoutes({
    router,
    store: store as never,
    runtimeLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
    planningLogger: {} as never,
    chatLogger: {} as never,
    getProjectIdFromRequest: vi.fn(() => "project-1"),
    getScopedStore: vi.fn(),
    getProjectContext: vi.fn(async () => ({ store, engine: undefined, projectId: "project-1" })),
    getProjectPluginLoader: vi.fn(),
    prioritizeProjectsForCurrentDirectory: vi.fn(),
    emitRemoteRouteDiagnostic: vi.fn(),
    emitAuthSyncAuditLog: vi.fn(),
    parseScopeParam: vi.fn(),
    resolveAutomationStore: vi.fn(),
    resolveRoutineStore: vi.fn(),
    resolveRoutineRunner: vi.fn(),
    registerDispose: vi.fn(),
    dispose: vi.fn(),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never);
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message });
  });
  return app;
}

describe("register-approval-routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    core.ApprovalRequestStore.mockImplementation(function () {
      return approvalStore;
    });
    core.AgentStore.mockImplementation(function () {
      return {
        init: vi.fn().mockResolvedValue(undefined),
        getAgent: vi.fn().mockResolvedValue(null),
      };
    });
    approvalStore.getAuditHistory.mockResolvedValue([]);
  });

  describe("POST /api/approvals/:id/decision — CCC campaign guard (G6)", () => {
    it("refuses a ccc-campaign-merge approval and never calls decide()", async () => {
      const approval = makeApproval({
        id: "appr_merge_1",
        targetAction: {
          category: "git_write",
          action: "merge",
          summary: "CCC merge protected action",
          resourceType: "ccc-campaign-merge",
          resourceId: "campaign-target",
          context: { protectedActionKind: "merge" },
        },
      });
      approvalStore.get.mockResolvedValue(approval);
      approvalStore.decide.mockResolvedValue({ ...approval, status: "approved" });

      const app = createApp();
      const res = await request(
        app,
        "POST",
        "/api/approvals/appr_merge_1/decision",
        JSON.stringify({ decision: "approve" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(409);
      expect(String((res.body as { error: string }).error)).toContain("cannot be approved or denied from the dashboard");
      expect(String((res.body as { error: string }).error)).toContain("fn prd approve-merge");
      expect(String((res.body as { error: string }).error)).toContain("fn prd status");
      expect(approvalStore.decide).not.toHaveBeenCalled();
    });

    it("refuses a ccc-campaign-live_execution approval and never calls decide()", async () => {
      const approval = makeApproval({
        id: "appr_live_1",
        targetAction: {
          category: "command_execution",
          action: "live_execution",
          summary: "CCC live-execution protected action",
          resourceType: "ccc-campaign-live_execution",
          resourceId: "campaign-target",
          context: { protectedActionKind: "live_execution" },
        },
      });
      approvalStore.get.mockResolvedValue(approval);
      approvalStore.decide.mockResolvedValue({ ...approval, status: "denied" });

      const app = createApp();
      const res = await request(
        app,
        "POST",
        "/api/approvals/appr_live_1/decision",
        JSON.stringify({ decision: "deny" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(409);
      expect(String((res.body as { error: string }).error)).toContain("fn prd approve-execution");
      expect(approvalStore.decide).not.toHaveBeenCalled();
    });

    it("refuses any future ccc-campaign-* protected kind by resourceType prefix", async () => {
      const approval = makeApproval({
        id: "appr_other_1",
        targetAction: {
          category: "file_write_delete",
          action: "other",
          summary: "CCC hypothetical protected action",
          resourceType: "ccc-campaign-other",
          resourceId: "campaign-target",
          context: { protectedActionKind: "other" },
        },
      });
      approvalStore.get.mockResolvedValue(approval);
      approvalStore.decide.mockResolvedValue({ ...approval, status: "approved" });

      const app = createApp();
      const res = await request(
        app,
        "POST",
        "/api/approvals/appr_other_1/decision",
        JSON.stringify({ decision: "approve" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(409);
      expect(approvalStore.decide).not.toHaveBeenCalled();
    });

    it("still decides ordinary non-CCC approvals normally (no overreach)", async () => {
      const approval = makeApproval({
        id: "appr_normal_1",
        targetAction: {
          category: "agent_provisioning",
          action: "create",
          summary: "Provision agent",
          resourceType: "agent",
          resourceId: "agent-1",
        },
      });
      approvalStore.get.mockResolvedValue(approval);
      approvalStore.decide.mockResolvedValue({ ...approval, status: "denied" });

      const app = createApp();
      const res = await request(
        app,
        "POST",
        "/api/approvals/appr_normal_1/decision",
        JSON.stringify({ decision: "deny" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(approvalStore.decide).toHaveBeenCalledWith("appr_normal_1", "denied", expect.any(Object));
    });
  });

  describe("GET /api/approvals — CCC campaign exclusion (G6)", () => {
    it("excludes ccc-campaign-* approvals from the summaries, total, and pendingCount", async () => {
      const cccApproval = makeApproval({
        id: "appr_merge_2",
        status: "pending",
        targetAction: {
          category: "git_write",
          action: "merge",
          summary: "CCC merge protected action",
          resourceType: "ccc-campaign-merge",
          resourceId: "campaign-target",
          context: { protectedActionKind: "merge" },
        },
      });
      const normalApproval = makeApproval({
        id: "appr_normal_2",
        status: "pending",
        targetAction: {
          category: "agent_provisioning",
          action: "create",
          summary: "Provision agent",
          resourceType: "agent",
          resourceId: "agent-1",
        },
      });
      approvalStore.list.mockResolvedValue([cccApproval, normalApproval]);

      const app = createApp();
      const res = await request(app, "GET", "/api/approvals");

      expect(res.status).toBe(200);
      const body = res.body as { requests: Array<{ id: string }>; total: number; pendingCount: number };
      expect(body.requests.map((entry) => entry.id)).toEqual(["appr_normal_2"]);
      expect(body.total).toBe(1);
      expect(body.pendingCount).toBe(1);
    });
  });
});
