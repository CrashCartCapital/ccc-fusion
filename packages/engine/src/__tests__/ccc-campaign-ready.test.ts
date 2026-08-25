import { describe, expect, it, vi } from "vitest";
import * as readyModule from "../ccc-campaign-ready.js";

const { createCccCampaignReadyTool } = readyModule;

async function execute(tool: ReturnType<typeof createCccCampaignReadyTool>) {
  return tool.execute("call-ready", {}, undefined, () => undefined) as Promise<any>;
}

describe("CCC campaign readiness intent", () => {
  it("resolves one bounded verifier timeout policy for tool and commit gates", () => {
    const resolveTimeout = (readyModule as any).resolveCccCampaignReadyTimeoutMs;

    expect(resolveTimeout(undefined)).toBe(900_000);
    expect(resolveTimeout(-1)).toBe(900_000);
    expect(resolveTimeout(120_000)).toBe(120_000);
    expect(resolveTimeout(3_600_000)).toBe(1_800_000);
  });

  it("terminates the settled tool batch only after controller verification passes", async () => {
    const verifyCandidate = vi.fn().mockResolvedValue({
      ready: true,
      summary: "sealed verifier passed in isolated candidate",
    });
    const tool = createCccCampaignReadyTool({
      assertCandidateCommittable: vi.fn().mockResolvedValue(undefined),
      verifyCandidate,
    } as any);

    const result = await execute(tool);

    expect(verifyCandidate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isError: false,
      terminate: true,
      details: { ready: true },
    });
  });

  it("returns exact repair feedback and keeps the session open when verification fails", async () => {
    const tool = createCccCampaignReadyTool({
      assertCandidateCommittable: vi.fn().mockResolvedValue(undefined),
      verifyCandidate: vi.fn().mockResolvedValue({
        ready: false,
        summary: "verifier exit 1: AC-002 failed",
      }),
    } as any);

    const result = await execute(tool);

    expect(result).toMatchObject({
      isError: true,
      terminate: false,
      details: { ready: false },
    });
    expect(result.content[0].text).toContain("AC-002 failed");
  });

  it("fails closed without terminating when controller verification throws", async () => {
    const tool = createCccCampaignReadyTool({
      assertCandidateCommittable: vi.fn().mockResolvedValue(undefined),
      verifyCandidate: vi.fn().mockRejectedValue(new Error("scratch verifier unavailable")),
    } as any);

    const result = await execute(tool);

    expect(result).toMatchObject({
      isError: true,
      terminate: false,
      details: { ready: false, reason: "controller-verification-error" },
    });
    expect(result.content[0].text).toContain("scratch verifier unavailable");
  });

  it("refuses termination before proof execution when the candidate is not committable", async () => {
    const verifyCandidate = vi.fn().mockResolvedValue({
      ready: true,
      summary: "sealed verifier passed",
    });
    const tool = createCccCampaignReadyTool({
      assertCandidateCommittable: vi.fn().mockRejectedValue(
        new Error("persisted branch does not match HEAD"),
      ),
      verifyCandidate,
    } as any);

    const result = await execute(tool);

    expect(verifyCandidate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      terminate: false,
      details: { ready: false, reason: "controller-verification-error" },
    });
    expect(result.content[0].text).toContain("persisted branch does not match HEAD");
  });
});
