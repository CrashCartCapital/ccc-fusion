import { describe, expect, it } from "vitest";
import {
  parseOperatorJsonFlag,
  renderIdempotencyKey,
  renderOperatorPayload,
  renderPreview,
} from "../prd-render.js";

const CLAIM_TOKEN = "claim-token-must-never-render";
const CONTROLLER_TOKEN = "controller-token-must-never-render";
const MERGE_DIGEST = "c".repeat(64);
const PAUSE_DIGEST = "1".repeat(64);
const STOP_DIGEST = "2".repeat(64);

function jsonObjectLines(lines: readonly string[]): string[] {
  return lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("{") && trimmed.endsWith("}");
  });
}

function mergeHoldStatus() {
  return {
    kind: "product-status",
    found: true,
    status: {
      schema: "ccc-prd.product-status.v1",
      projectId: "project-1",
      import: {
        importId: "import-1",
        idempotencyKey: "ccc-product-operator-key",
        targetRepository: "/tmp/product-target",
        targetBase: "d".repeat(40),
        state: "active",
        runnable: true,
        lastError: null,
        campaignId: "campaign-1",
        campaignDeadlineAt: "2026-07-31T02:00:00.000Z",
        requestBudget: {
          scope: "campaign-global",
          maximum: 24,
          used: 7,
          remaining: 17,
          providerTasks: 2,
          deterministicMinimum: 2,
          headroomAboveMinimum: 22,
          completionAdequacy: "unproven",
        },
      },
      tasks: [{
        ordinal: 1,
        semanticTaskId: "TASK-entry",
        nativeTaskId: "FN-entry",
        present: true,
        title: "Add the exact value file",
        description: "Writes src/value.txt",
        route: {
          providerId: "deterministic-fake",
          modelId: "fixture-v2",
          transport: "pi",
          executor: null,
          toolMode: null,
          worktreeMode: "campaign",
          ownedPaths: ["src/value.txt"],
          allowedWriteRoots: ["src"],
          commitPolicy: "campaign",
          cliAdapterId: null,
        },
        worktree: "/tmp/worktrees/entry",
        branch: "ccc-campaign/entry",
        baseCommit: "d".repeat(40),
        mergeCommit: null,
        state: {
          column: "in_progress",
          status: "active",
          paused: false,
          userPaused: false,
          pausedReason: null,
          error: null,
          updatedAt: "2026-07-31T00:30:00.000Z",
        },
      }],
      workItems: [{
        id: "work-item-1",
        runId: "ccc-prd:import-1",
        taskId: "FN-entry",
        nodeId: "node-entry",
        kind: "task",
        state: "manual-required",
        attempt: 2,
        retryAfter: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
        blockedReason: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
        waitReason: null,
        stableWorkflowRunId: "ccc-prd:import-1",
        continuationSequence: null,
        createdAt: "2026-07-31T00:00:00.000Z",
        updatedAt: "2026-07-31T00:30:00.000Z",
      }],
      proofs: [{
        definition: { id: "PROOF-exact", command: ["node", "verify.mjs"] },
        definitionSha256: "9".repeat(64),
        attempts: [{
          attemptKey: `ccc-proof-attempt-${"a".repeat(64)}`,
          state: "committed",
          controllerToken: CONTROLLER_TOKEN,
          result: {
            success: true,
            exitCode: 0,
            durationMs: 1200,
            stdoutTail: "EXACT_VERIFIER_PASS\n",
            stderrTail: null,
            timedOut: false,
            killed: false,
            warnings: null,
          },
        }],
      }],
      orphanProofAttempts: [],
      providerAttempts: [
        {
          attemptKey: `ccc-provider-attempt-${"b".repeat(64)}`,
          taskId: "FN-entry",
          semanticTaskId: "TASK-entry",
          state: "committed",
          attemptOrdinal: 1,
          requestCount: 1,
          effectiveProvider: "deterministic-fake",
          effectiveModel: "fixture-v2",
          usage: { inputTokens: 1200, outputTokens: 340 },
          cost: { amountUsd: 0.1234, source: "provider-api" },
          receiptSource: "provider-api",
          binding: { projectId: "project-1", importId: "import-1" },
        },
        {
          attemptKey: `ccc-provider-attempt-${"e".repeat(64)}`,
          taskId: "FN-second",
          semanticTaskId: "TASK-second",
          state: "committed",
          attemptOrdinal: 1,
          requestCount: 1,
          effectiveProvider: "deterministic-fake",
          effectiveModel: "fixture-v2",
          usage: null,
          cost: { kind: "unknown", reason: "cli transport reported no usage receipt" },
          receiptSource: "none",
          binding: { projectId: "project-1", importId: "import-1" },
        },
      ],
      approvals: [{
        id: "approval-merge-1",
        status: "issued",
        taskId: "FN-terminal",
        campaign: {
          expiresAt: "2026-07-31T01:00:00.000Z",
          claimToken: CLAIM_TOKEN,
        },
      }],
      landing: { intents: [], materializations: [], terminals: [] },
      nextAction: {
        kind: "approve-merge",
        reason: "Executed proof is complete; exact human merge approval is next.",
        approvalRequestId: "approval-merge-1",
        approvalStatus: "issued",
        decisionOwner: "human operator",
        consequence: "Approving lands the campaign commit onto the target branch.",
        safeState: "No Git landing has started; the target branch is unchanged.",
        recoveryOptions: [
          "Inspect the campaign worktree before approving.",
          "Stop the campaign with a fresh status digest to abandon it.",
        ],
        nextSafeAction: "Review the proof receipt, then submit the exact merge approval.",
      },
    },
    operatorControls: [
      {
        action: "pause",
        allowed: true,
        reason: null,
        confirmation: PAUSE_DIGEST,
        approvalExpiresAt: "2026-07-31T01:00:00.000Z",
        consequence: "Parks the unleased workflow at its current safe boundary.",
        recovery: "Use resume with a fresh status confirmation.",
      },
      {
        action: "resume",
        allowed: false,
        reason: "campaign is not paused",
        confirmation: null,
        approvalExpiresAt: "2026-07-31T01:00:00.000Z",
        consequence: "Unpauses imported tasks.",
        recovery: "Pause again at the next unleased safe boundary.",
      },
      {
        action: "stop",
        allowed: true,
        reason: null,
        confirmation: STOP_DIGEST,
        approvalExpiresAt: "2026-07-31T01:00:00.000Z",
        consequence: "Terminally cancels this campaign workflow.",
        recovery: "There is no resume after stop.",
      },
    ],
    mergeApprovalConfirmations: [{
      approvalRequestId: "approval-merge-1",
      confirmation: MERGE_DIGEST,
      expiresAt: "2026-07-31T01:00:00.000Z",
      status: "issued",
    }],
    liveExecutionApprovalConfirmations: [],
  };
}

describe("operator --json flag parsing", () => {
  it("reports json mode and removes every --json token", () => {
    expect(parseOperatorJsonFlag(["status", "key-1", "--json"]))
      .toEqual({ args: ["status", "key-1"], json: true });
    expect(parseOperatorJsonFlag(["--json", "status", "key-1"]))
      .toEqual({ args: ["status", "key-1"], json: true });
    expect(parseOperatorJsonFlag(["status", "--json", "key-1", "--json"]))
      .toEqual({ args: ["status", "key-1"], json: true });
  });

  it("leaves arguments untouched when --json is absent", () => {
    expect(parseOperatorJsonFlag(["status", "key-1"]))
      .toEqual({ args: ["status", "key-1"], json: false });
  });

  it("never strips a flag value that is literally --json", () => {
    expect(parseOperatorJsonFlag([
      "stop",
      "key-1",
      "--reason",
      "--json",
      "--confirm",
      "f".repeat(64),
    ])).toEqual({
      args: ["stop", "key-1", "--reason", "--json", "--confirm", "f".repeat(64)],
      json: false,
    });
  });

  it("strips a trailing --json while protecting the preceding flag value", () => {
    expect(parseOperatorJsonFlag([
      "stop",
      "key-1",
      "--reason",
      "--json",
      "--confirm",
      "f".repeat(64),
      "--json",
    ])).toEqual({
      args: ["stop", "key-1", "--reason", "--json", "--confirm", "f".repeat(64)],
      json: true,
    });
  });
});

describe("human product status rendering", () => {
  it("renders the campaign headline, next action prose, tasks, and work items", () => {
    const lines = renderOperatorPayload(mergeHoldStatus());
    const text = lines.join("\n");

    expect(text).toContain("ccc-product-operator-key");
    expect(text).toContain("active");
    expect(text).toContain("approve-merge");
    expect(text).toContain(
      "Executed proof is complete; exact human merge approval is next.",
    );
    expect(text).toContain("human operator");
    expect(text).toContain(
      "Approving lands the campaign commit onto the target branch.",
    );
    expect(text).toContain(
      "Review the proof receipt, then submit the exact merge approval.",
    );
    expect(text).toContain("Stop the campaign with a fresh status digest to abandon it.");
    expect(text).toContain("TASK-entry");
    expect(text).toContain("Add the exact value file");
    expect(text).toContain("deterministic-fake");
    expect(text).toContain("fixture-v2");
    expect(text).toContain("pi");
    expect(text).toContain("work-item-1");
    expect(text).toContain("manual-required");
    expect(text).toContain("ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED");
  });

  it("prints the ready-to-paste approve-merge command beside the merge digest", () => {
    const lines = renderOperatorPayload(mergeHoldStatus());

    expect(lines).toContainEqual(expect.stringContaining(
      `fn prd approve-merge ccc-product-operator-key approval-merge-1 --confirm ${MERGE_DIGEST}`,
    ));
  });

  it("prints lifecycle commands only for allowed operator controls", () => {
    const text = renderOperatorPayload(mergeHoldStatus()).join("\n");

    expect(text).toContain(
      `fn prd pause ccc-product-operator-key --confirm ${PAUSE_DIGEST}`,
    );
    expect(text).toContain(
      `fn prd stop ccc-product-operator-key --reason`,
    );
    expect(text).toContain(STOP_DIGEST);
    expect(text).not.toContain("fn prd resume ccc-product-operator-key --confirm");
    expect(text).toContain("campaign is not paused");
  });

  it("reports an unknown provider cost honestly instead of a zero dollar amount", () => {
    const text = renderOperatorPayload(mergeHoldStatus()).join("\n");

    expect(text).toContain("cost unknown: cli transport reported no usage receipt");
    expect(text).not.toContain("$0.00");
    expect(text).toContain("$0.1234");
    expect(text).toContain("provider-api");
    expect(text).toContain("1200");
    expect(text).toContain("340");
  });

  it("renders the campaign-global request budget as reservation-slot accounting without implying per-task quotas", () => {
    const text = renderOperatorPayload(mergeHoldStatus()).join("\n");

    expect(text).toContain("Request budget (campaign-global)");
    expect(text).toContain("maximum reservation slots: 24");
    expect(text).toContain("used reservation slots: 7");
    expect(text).toContain("remaining reservation slots: 17");
    expect(text).toContain("provider tasks: 2");
    expect(text).toContain("static admission floor: 2");
    expect(text).toContain("headroom above floor: 22");
    expect(text).toContain("completion adequacy: unproven");
    expect(text).toContain(
      "Reservation-slot accounting: each first-time provider-attempt reservation spends one slot; exact idempotent replay is free, while proved-not-dispatched and unknown attempts remain spent.",
    );
    expect(text).toContain(
      "Slots are campaign-global and are not reserved per task; earlier tasks may exhaust the cap.",
    );
  });

  it("never renders a claim token or controller token", () => {
    const text = renderOperatorPayload(mergeHoldStatus()).join("\n");

    expect(text).not.toContain(CLAIM_TOKEN);
    expect(text).not.toContain(CONTROLLER_TOKEN);
    expect(text).not.toContain("claimToken");
    expect(text).not.toContain("controllerToken");
  });

  it("emits no JSON object lines", () => {
    expect(jsonObjectLines(renderOperatorPayload(mergeHoldStatus()))).toEqual([]);
  });

  it("renders a missing campaign without inventing state", () => {
    const lines = renderOperatorPayload({
      kind: "product-status",
      found: false,
      idempotencyKey: "ccc-product-missing",
    });

    expect(lines.join("\n")).toContain("ccc-product-missing");
    expect(lines.join("\n")).toMatch(/no|not found/i);
    expect(jsonObjectLines(lines)).toEqual([]);
  });
});

describe("human refusal rendering", () => {
  const refusal = {
    kind: "refusal",
    diagnostics: [{
      code: "CCC_PRD_PROJECT_OPERATION_FAILED",
      message: "PostgreSQL AsyncDataLayer unavailable for /tmp/product-target",
    }],
    safeState: "Fusion did not report this operation complete.",
    decisionOwner: "human operator",
    consequence: "The requested transition is not complete.",
    approvalExpiresAt: null,
    recoveryOptions: [
      "Run fn prd status <idempotency-key> to inspect durable work.",
      "Correct the cited input and request a fresh confirmation.",
    ],
    nextSafeAction: "Run fn prd status <idempotency-key> and follow its fresh operator controls.",
  };

  it("transcribes every refusal field the operator needs", () => {
    const text = renderOperatorPayload(refusal).join("\n");

    expect(text).toContain("CCC_PRD_PROJECT_OPERATION_FAILED");
    expect(text).toContain(
      "PostgreSQL AsyncDataLayer unavailable for /tmp/product-target",
    );
    expect(text).toContain("Fusion did not report this operation complete.");
    expect(text).toContain("human operator");
    expect(text).toContain("The requested transition is not complete.");
    expect(text).toContain("Run fn prd status <idempotency-key> to inspect durable work.");
    expect(text).toContain(
      "Run fn prd status <idempotency-key> and follow its fresh operator controls.",
    );
  });

  it("emits no JSON object lines for a refusal", () => {
    expect(jsonObjectLines(renderOperatorPayload(refusal))).toEqual([]);
  });
});

describe("human preview rendering", () => {
  const preview = {
    kind: "preview",
    schema: "ccc-prd.product-preview.v1",
    projectId: "project-1",
    projectPath: "/tmp/product-target",
    targetRepository: "/tmp/product-target",
    targetBase: "d".repeat(40),
    targetHead: "d".repeat(40),
    bundleHash: "a".repeat(64),
    packetHash: "b".repeat(64),
    sidecarHash: "c".repeat(64),
    confirmationDigest: "f".repeat(64),
    tasks: [{ id: "TASK-entry", title: "Add the exact value file" }],
    proofs: [{ id: "PROOF-exact" }],
    requirements: [{ id: "REQ-1" }],
    admittedWriteRoots: ["src"],
    requestBudget: {
      scope: "campaign-global",
      maximum: 7,
      providerTasks: 2,
      deterministicMinimum: 2,
      headroomAboveMinimum: 5,
      completionAdequacy: "unproven",
      explanation:
        "One first-time provider-attempt reservation slot per provider task is only a static admission floor: it creates no per-task quota or reservation, earlier tasks may exhaust the global cap, and completion adequacy remains unproven.",
    },
    verifierConfinement: { ready: true, backend: "bwrap", message: "confinement ready" },
  };

  it("prints one ready-to-paste import command carrying the candidate key and digest", () => {
    const lines = renderPreview(preview, {
      packetArgs: [
        "/tmp/packet",
        "/tmp/packet/manifest.json",
        "/tmp/packet/sidecar.json",
        "/tmp/packet/execution-plan.json",
        "/tmp/product-target",
        "d".repeat(40),
      ],
      candidateIdempotencyKey: "ccc-prd-11111111-2222-3333-4444-555555555555",
    });

    expect(lines).toContainEqual(expect.stringContaining(
      `fn prd import /tmp/packet /tmp/packet/manifest.json /tmp/packet/sidecar.json /tmp/packet/execution-plan.json /tmp/product-target ${"d".repeat(40)} ccc-prd-11111111-2222-3333-4444-555555555555 --confirm ${"f".repeat(64)}`,
    ));
    expect(lines.join("\n")).toContain("confinement ready");
    expect(lines.join("\n")).toContain("Request budget (campaign-global)");
    expect(lines.join("\n")).toContain("maximum reservation slots: 7");
    expect(lines.join("\n")).toContain("provider tasks: 2");
    expect(lines.join("\n")).toContain("static admission floor: 2");
    expect(lines.join("\n")).toContain("headroom above floor: 5");
    expect(lines.join("\n")).toContain("completion adequacy: unproven");
    expect(lines.join("\n")).toContain(
      "One first-time provider-attempt reservation slot per provider task is only a static admission floor: it creates no per-task quota or reservation, earlier tasks may exhaust the global cap, and completion adequacy remains unproven.",
    );
    expect(jsonObjectLines(lines)).toEqual([]);
  });

  it("quotes packet paths that would break a pasted shell command", () => {
    const lines = renderPreview(preview, {
      packetArgs: ["/tmp/packet root", "m.json", "s.json", "p.json", "/tmp/t", "d".repeat(40)],
      candidateIdempotencyKey: "ccc-prd-key",
    });

    expect(lines.join("\n")).toContain("'/tmp/packet root'");
  });
});

describe("human import rendering", () => {
  const imported = {
    kind: "imported",
    confirmationDigest: "f".repeat(64),
    result: {
      importId: "import-1",
      idempotencyKey: "ccc-prd-11111111-2222-3333-4444-555555555555",
      state: "active",
      runnable: true,
      replayed: false,
      targetRepository: "/tmp/product-target",
      targetBase: "d".repeat(40),
      stagingRelativePath: ".fusion/ccc-prd/import-1",
      directCounts: { campaigns: 1, tasks: 2, workItems: 1 },
    },
  };

  it("lifts the idempotency key into the headline and pre-fills the follow-up commands", () => {
    const lines = renderOperatorPayload(imported);
    const text = lines.join("\n");

    expect(text).toContain("ccc-prd-11111111-2222-3333-4444-555555555555");
    expect(text).toContain(
      "fn prd status ccc-prd-11111111-2222-3333-4444-555555555555",
    );
    expect(text).toContain(
      "fn prd pause ccc-prd-11111111-2222-3333-4444-555555555555 --confirm",
    );
    expect(text).toContain(
      "fn prd stop ccc-prd-11111111-2222-3333-4444-555555555555 --reason",
    );
    expect(jsonObjectLines(lines)).toEqual([]);
  });
});

describe("idempotency key rendering", () => {
  it("prints the key first and one usage line", () => {
    const lines = renderIdempotencyKey("ccc-prd-11111111-2222-3333-4444-555555555555");

    expect(lines[0]).toBe("ccc-prd-11111111-2222-3333-4444-555555555555");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("fn prd import");
  });
});

describe("rendering resilience", () => {
  it("never throws and never emits a JSON object line for an unexpected payload", () => {
    const surprising = {
      kind: "not-a-known-operator-kind",
      nested: { deep: { value: 7, token: "fine" } },
      list: [1, "two", null],
      campaign: { claimToken: CLAIM_TOKEN },
    };

    const lines = renderOperatorPayload(surprising);

    expect(jsonObjectLines(lines)).toEqual([]);
    expect(lines.join("\n")).not.toContain(CLAIM_TOKEN);
    expect(lines.join("\n")).not.toContain("claimToken");
    expect(lines.join("\n")).toContain("not-a-known-operator-kind");
  });

  it("tolerates null and non-object payloads", () => {
    expect(() => renderOperatorPayload(null)).not.toThrow();
    expect(() => renderOperatorPayload("plain")).not.toThrow();
  });
});
