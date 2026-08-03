import { describe, expect, it, vi } from "vitest";
import { runPrdCommand } from "../prd.js";

const CLAIM_TOKEN = "claim-token-must-never-serialize";
const CONTROLLER_TOKEN = "controller-token-must-never-serialize";
const MERGE_CONFIRMATION = "c".repeat(64);

function jsonObjectLines(lines: readonly string[]): string[] {
  return lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("{") && trimmed.endsWith("}");
  });
}

function mergeHoldStatus() {
  return {
    schema: "ccc-prd.product-status.v1",
    projectId: "project-1",
    import: {
      importId: "import-1",
      idempotencyKey: "ccc-product-operator-key",
      targetRepository: "/tmp/product-target",
      targetBase: "d".repeat(40),
      state: "active",
      runnable: true,
    },
    tasks: [],
    workItems: [{
      id: "work-item-1",
      runId: "ccc-prd:import-1",
      taskId: "FN-entry",
      nodeId: "node-entry",
      kind: "task",
      state: "manual-required",
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
      blockedReason: "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED",
      stableWorkflowRunId: "ccc-prd:import-1",
    }],
    proofs: [],
    orphanProofAttempts: [],
    providerAttempts: [],
    approvals: [{
      id: "approval-merge-1",
      status: "issued",
      taskId: "FN-terminal",
      targetAction: {
        resourceType: "ccc-campaign-merge",
        context: { protectedActionKind: "merge" },
      },
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
    },
    controllerToken: CONTROLLER_TOKEN,
  };
}

function statusDependencies(status: unknown = mergeHoldStatus()) {
  const layer = {};
  return {
    resolveProject: vi.fn(async () => ({
      projectId: "project-1",
      projectPath: "/tmp/product-target",
      projectName: "Fixture",
      isRegistered: true,
      store: { getAsyncLayer: () => layer },
    })),
    closeProjectStore: vi.fn(async () => undefined),
    inspectCccPrdProductStatus: vi.fn(async () => status),
    computeCccCampaignMergeApprovalConfirmation: vi.fn(() => MERGE_CONFIRMATION),
  } as never;
}

async function runStatus(args: string[], status?: unknown) {
  const output: string[] = [];
  const exitCode = await runPrdCommand(
    args,
    { write: (line) => output.push(line) },
    statusDependencies(status),
    { projectName: "fixture" },
  );
  return { exitCode, output };
}

describe("prd operator --json flag", () => {
  it("keeps the machine-readable status payload byte for byte behind --json", async () => {
    const { exitCode, output } = await runStatus(["status", "ccc-product-operator-key", "--json"]);

    expect(exitCode).toBe(0);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "product-status",
      found: true,
      status: { nextAction: { kind: "approve-merge" } },
      mergeApprovalConfirmations: [{
        approvalRequestId: "approval-merge-1",
        confirmation: MERGE_CONFIRMATION,
      }],
    });
    expect(output[0]).not.toContain("claimToken");
    expect(output[0]).not.toContain("controllerToken");
    expect(output[0]).not.toContain(CLAIM_TOKEN);
    expect(output[0]).not.toContain(CONTROLLER_TOKEN);
  });

  it("accepts --json before the subcommand", async () => {
    const leading = await runStatus(["--json", "status", "ccc-product-operator-key"]);
    const trailing = await runStatus(["status", "ccc-product-operator-key", "--json"]);

    expect(leading.exitCode).toBe(0);
    expect(leading.output).toEqual(trailing.output);
  });

  it("renders human-readable status by default with no JSON object lines", async () => {
    const { exitCode, output } = await runStatus(["status", "ccc-product-operator-key"]);

    expect(exitCode).toBe(0);
    expect(output.length).toBeGreaterThan(1);
    expect(jsonObjectLines(output)).toEqual([]);
  });

  it("prints the same merge digest as a ready-to-paste command in human mode", async () => {
    const { output } = await runStatus(["status", "ccc-product-operator-key"]);

    expect(output.join("\n")).toContain(
      `fn prd approve-merge ccc-product-operator-key approval-merge-1 --confirm ${MERGE_CONFIRMATION}`,
    );
  });

  it("never leaks operator tokens through the human renderer", async () => {
    const { output } = await runStatus(["status", "ccc-product-operator-key"]);
    const text = output.join("\n");

    expect(text).not.toContain(CLAIM_TOKEN);
    expect(text).not.toContain(CONTROLLER_TOKEN);
    expect(text).not.toContain("claimToken");
    expect(text).not.toContain("controllerToken");
  });

  it("renders a missing campaign in both modes without changing the exit code", async () => {
    const humanRun = await runStatus(["status", "ccc-product-missing"], null);
    const jsonRun = await runStatus(["status", "ccc-product-missing", "--json"], null);

    expect(humanRun.exitCode).toBe(1);
    expect(jsonRun.exitCode).toBe(1);
    expect(jsonRun.output).toHaveLength(1);
    expect(JSON.parse(jsonRun.output[0]!)).toMatchObject({
      kind: "product-status",
      found: false,
      idempotencyKey: "ccc-product-missing",
    });
    expect(jsonObjectLines(humanRun.output)).toEqual([]);
    expect(humanRun.output.join("\n")).toContain("ccc-product-missing");
  });

  it("renders refusals as prose by default and as JSON behind --json", async () => {
    const failing = {
      resolveProject: vi.fn(async () => {
        throw Object.assign(new Error("PostgreSQL AsyncDataLayer unavailable"), {
          code: "CCC_PRD_POSTGRES_UNAVAILABLE",
        });
      }),
      closeProjectStore: vi.fn(async () => undefined),
    } as never;
    const humanOutput: string[] = [];
    const jsonOutput: string[] = [];

    expect(await runPrdCommand(
      ["status", "ccc-product-operator-key"],
      { write: (line) => humanOutput.push(line) },
      failing,
      {},
    )).toBe(1);
    expect(await runPrdCommand(
      ["status", "ccc-product-operator-key", "--json"],
      { write: (line) => jsonOutput.push(line) },
      failing,
      {},
    )).toBe(1);

    expect(jsonOutput).toHaveLength(1);
    expect(JSON.parse(jsonOutput[0]!)).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_POSTGRES_UNAVAILABLE" }],
    });
    expect(jsonObjectLines(humanOutput)).toEqual([]);
    expect(humanOutput.join("\n")).toContain("CCC_PRD_POSTGRES_UNAVAILABLE");
    expect(humanOutput.join("\n")).toContain("PostgreSQL AsyncDataLayer unavailable");
  });
});

describe("prd new-key", () => {
  it("prints one fresh import idempotency key in human mode", async () => {
    const output: string[] = [];

    expect(await runPrdCommand(
      ["new-key"],
      { write: (line) => output.push(line) },
    )).toBe(0);

    expect(output[0]).toMatch(
      /^ccc-prd-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(output.join("\n")).toContain("fn prd import");
    expect(jsonObjectLines(output)).toEqual([]);
  });

  it("prints a machine-readable key behind --json", async () => {
    const output: string[] = [];

    expect(await runPrdCommand(
      ["new-key", "--json"],
      { write: (line) => output.push(line) },
    )).toBe(0);

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "idempotency-key",
      idempotencyKey: expect.stringMatching(/^ccc-prd-[0-9a-f-]{36}$/),
    });
  });

  it("returns two fresh keys on two calls", async () => {
    const first: string[] = [];
    const second: string[] = [];

    await runPrdCommand(["new-key"], { write: (line) => first.push(line) });
    await runPrdCommand(["new-key"], { write: (line) => second.push(line) });

    expect(first[0]).not.toBe(second[0]);
  });

  it("refuses extra arguments with the usage contract", async () => {
    const output: string[] = [];

    expect(await runPrdCommand(
      ["new-key", "extra"],
      { write: (line) => output.push(line) },
    )).toBe(2);
    expect(output[0]).toContain("usage: fn prd");
  });
});
