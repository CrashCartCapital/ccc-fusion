import { describe, expect, it } from "vitest";
import {
  assessCccBuildFit,
  assessCccPlanningFit,
  assessCccRepairChunkFit,
  cccPlanningCallFloor,
  cccPlanningCriticalPathMs,
  cccPlanningMaxNodes,
  countCccBuildNodes,
  countCccPlanningNodes,
  CCC_PLANNING_BUDGET_POLICY_V1,
} from "../ccc-planning/budget-fit.js";

/*
FNXC:CccPlanningBudgetFit 2026-10-14-08:40:
Card K1 proof for strict N and the fit rule (CONTRACT-v2 sections 2.8 and 4.6). Each expected number is chosen so the tempting wrong implementation gives a different one: counting the preflight as a node or the leaf reviewer unconditionally gives 15 instead of 14, and a parallel-stage time model gives less than 11,400,000 ms.
*/

const STANDARD_PLANNING = CCC_PLANNING_BUDGET_POLICY_V1.profiles["build:standard"].planning;
const ROOMY_DEADLINE_MS = 172_800_000;

describe("strict N counting", () => {
  it("counts 14 planning nodes at L = 0 and 17 at L = 2", () => {
    expect(countCccPlanningNodes({ leaves: 0 })).toBe(14);
    expect(countCccPlanningNodes({ leaves: 1 })).toBe(16);
    expect(countCccPlanningNodes({ leaves: 2 })).toBe(17);
  });

  it("counts build nodes as T writers and T + 1 + P review/proof nodes", () => {
    expect(countCccBuildNodes({ providerTasks: 4, modelProofNodes: 0 })).toEqual({ implementation: 4, reviewProof: 5 });
    expect(countCccBuildNodes({ providerTasks: 1, modelProofNodes: 2 })).toEqual({ implementation: 1, reviewProof: 4 });
  });

  it("refuses negative or fractional counts", () => {
    expect(() => countCccPlanningNodes({ leaves: -1 })).toThrow(RangeError);
    expect(() => countCccPlanningNodes({ leaves: 0.5 })).toThrow(RangeError);
    expect(() => cccPlanningCallFloor(Number.NaN)).toThrow(RangeError);
  });
});

describe("call floor", () => {
  it("is 2 x (30 N + 300)", () => {
    expect(cccPlanningCallFloor(14)).toBe(1_440);
    expect(cccPlanningCallFloor(16)).toBe(1_560);
    expect(cccPlanningCallFloor(17)).toBe(1_620);
    expect(cccPlanningCallFloor(4)).toBe(840);
    expect(cccPlanningCallFloor(5)).toBe(900);
  });

  it("inverts to the largest node count an allocation admits", () => {
    expect(cccPlanningMaxNodes(1_536)).toBe(15);
    expect(cccPlanningMaxNodes(1_440)).toBe(14);
    expect(cccPlanningMaxNodes(1_439)).toBe(13);
    expect(cccPlanningMaxNodes(100)).toBe(0);
    expect(cccPlanningCallFloor(cccPlanningMaxNodes(6_144))).toBeLessThanOrEqual(6_144);
    expect(cccPlanningCallFloor(cccPlanningMaxNodes(6_144) + 1)).toBeGreaterThan(6_144);
  });
});

describe("planning fit", () => {
  it("refuses one leaf on Build Standard with the exact planning-call shortfall", () => {
    expect(assessCccPlanningFit({
      leaves: 1, remainingPlanning: STANDARD_PLANNING, criticalPathMs: 11_400_000, remainingDeadlineMs: ROOMY_DEADLINE_MS,
    })).toEqual({
      ok: false,
      code: "CCC_PLANNING_PLANNING_FIT_INSUFFICIENT",
      shortfalls: [{ dimension: "planning-calls", required: 1_560, remaining: 1_536 }],
    });
  });

  it("admits L = 0 at the 1,440 floor (positive control on the same allocation)", () => {
    expect(assessCccPlanningFit({
      leaves: 0, remainingPlanning: STANDARD_PLANNING, criticalPathMs: 11_400_000, remainingDeadlineMs: ROOMY_DEADLINE_MS,
    })).toEqual({ ok: true, nodes: 14, floor: 1_440 });
  });

  it("refuses when twice the planning critical path exceeds the remaining deadline, and reports both shortfalls", () => {
    expect(assessCccPlanningFit({
      leaves: 0, remainingPlanning: STANDARD_PLANNING, criticalPathMs: 11_400_000, remainingDeadlineMs: 22_799_999,
    })).toEqual({
      ok: false,
      code: "CCC_PLANNING_PLANNING_FIT_INSUFFICIENT",
      shortfalls: [{ dimension: "time", required: 22_800_000, remaining: 22_799_999 }],
    });
    expect(assessCccPlanningFit({
      leaves: 0, remainingPlanning: STANDARD_PLANNING, criticalPathMs: 11_400_000, remainingDeadlineMs: 22_800_000,
    })).toMatchObject({ ok: true });
    expect(assessCccPlanningFit({
      leaves: 2, remainingPlanning: STANDARD_PLANNING, criticalPathMs: 11_400_000, remainingDeadlineMs: 1,
    })).toEqual({
      ok: false,
      code: "CCC_PLANNING_PLANNING_FIT_INSUFFICIENT",
      shortfalls: [
        { dimension: "planning-calls", required: 1_620, remaining: 1_536 },
        { dimension: "time", required: 22_800_000, remaining: 1 },
      ],
    });
  });
});

describe("build fit", () => {
  const diamond = {
    providerTasks: 4, modelProofNodes: 0, campaignCriticalPathMs: 23_400_000,
    remainingImplementation: 3_072, remainingReviewProof: 1_536, remainingDeadlineMs: 160_000_000, maxDurationMs: 86_400_000,
  };

  it("admits the I2 diamond on Build Standard", () => {
    expect(assessCccBuildFit(diamond)).toEqual({ ok: true });
  });

  it("refuses each dimension with its exact numbers", () => {
    expect(assessCccBuildFit({ ...diamond, remainingImplementation: 839 })).toEqual({
      ok: false, code: "CCC_PLANNING_BUILD_FIT_INSUFFICIENT",
      shortfalls: [{ dimension: "implementation-calls", required: 840, remaining: 839 }],
    });
    expect(assessCccBuildFit({ ...diamond, remainingReviewProof: 899 })).toEqual({
      ok: false, code: "CCC_PLANNING_BUILD_FIT_INSUFFICIENT",
      shortfalls: [{ dimension: "review-proof-calls", required: 900, remaining: 899 }],
    });
    expect(assessCccBuildFit({ ...diamond, maxDurationMs: 46_799_999 })).toEqual({
      ok: false, code: "CCC_PLANNING_BUILD_FIT_INSUFFICIENT",
      shortfalls: [{ dimension: "time", required: 46_800_000, remaining: 46_799_999 }],
    });
    expect(assessCccBuildFit({ ...diamond, remainingDeadlineMs: 40_000_000 })).toEqual({
      ok: false, code: "CCC_PLANNING_BUILD_FIT_INSUFFICIENT",
      shortfalls: [{ dimension: "time", required: 46_800_000, remaining: 40_000_000 }],
    });
  });
});

describe("repair chunk fit", () => {
  it("charges 60 calls per repair node and never the fixed 300 again", () => {
    expect(assessCccRepairChunkFit({ phase: "planning", repairNodes: 3, remaining: 180 })).toBe(true);
    expect(assessCccRepairChunkFit({ phase: "planning", repairNodes: 3, remaining: 179 })).toBe(false);
    expect(assessCccRepairChunkFit({ phase: "review_proof", repairNodes: 1, remaining: 60 })).toBe(true);
    expect(assessCccRepairChunkFit({ phase: "review_proof", repairNodes: 1, remaining: 59 })).toBe(false);
  });
});

describe("sequential critical path", () => {
  it("is 11,400,000 ms for Spec regardless of the planned task count", () => {
    expect(cccPlanningCriticalPathMs({ mode: "spec", providerTasks: 4, maxConcurrency: 1 }))
      .toEqual({ planningMs: 11_400_000, campaignMs: 0, totalMs: 11_400_000 });
    expect(cccPlanningCriticalPathMs({ mode: "spec", providerTasks: 0, maxConcurrency: 1 }).totalMs).toBe(11_400_000);
  });

  it("is 36,000,000 ms for the Build diamond, of which the campaign is 23,400,000 ms", () => {
    expect(cccPlanningCriticalPathMs({ mode: "build", providerTasks: 4, maxConcurrency: 1 }))
      .toEqual({ planningMs: 11_400_000, campaignMs: 23_400_000, totalMs: 36_000_000 });
    expect(cccPlanningCriticalPathMs({ mode: "build", providerTasks: 1, maxConcurrency: 1 }).campaignMs).toBe(7_200_000);
  });

  it("matches the per-session estimates and watchdogs of the budget policy", () => {
    expect(CCC_PLANNING_BUDGET_POLICY_V1.estimateMs).toEqual({
      preflightLineage: 600_000, planningNode: 600_000, reviewNode: 600_000, writer: 3_600_000, heavyCheck: 1_200_000,
    });
    expect(CCC_PLANNING_BUDGET_POLICY_V1.profiles["build:standard"]).toEqual({
      total: 6_144, planning: 1_536, implementation: 3_072, reviewProof: 1_536, deadlineMs: 172_800_000,
    });
  });
});
