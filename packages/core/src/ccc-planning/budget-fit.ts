import { deepFreezeCccPlanningConstant } from "./types.js";

/*
FNXC:CccPlanningBudgetFit 2026-10-14-09:10:
The budget profiles, strict node counting and fit rule of a request-to-code run (CONTRACT-v2 section 2.8). A run is admitted, a leaf is added, a repair chunk starts and a Build is linked only when the remaining calls cover twice the cost of the remaining nodes and twice the sequential critical path fits the time left, so a run cannot start work it can never finish. A refusal names every short dimension with the exact required and remaining amounts and reserves nothing. Node counts are strict: the preflight lineages are not nodes (their calls sit inside the fixed 300), the leaf reviewer counts only when there is a leaf, and repairs are never in N.
*/

export const CCC_PLANNING_BUDGET_POLICY_V1 = deepFreezeCccPlanningConstant({
  policyVersion: "ccc-planning.budget-policy.v1",
  profiles: {
    "spec:standard":  { total: 1536,  planning: 1536, implementation: 0,     reviewProof: 0,    deadlineMs: 43_200_000 },
    "build:standard": { total: 6144,  planning: 1536, implementation: 3072,  reviewProof: 1536, deadlineMs: 172_800_000 },
    "spec:large":     { total: 6144,  planning: 6144, implementation: 0,     reviewProof: 0,    deadlineMs: 172_800_000 },
    "build:large":    { total: 24576, planning: 6144, implementation: 12288, reviewProof: 6144, deadlineMs: 604_800_000 },
  },
  research: { maxFetchesPerNode: 8, maxFetchesPerRun: 24, maxRawBytesPerFetch: 1_048_576, maxRawBytesPerRun: 16_777_216 },
  floor: { perNodeCalls: 30, fixedCalls: 300, multiplier: 2 },   // the fixed 300 also covers the 9 preflight calls
  watchdogMs: { planningSessionAttempt: 1_800_000, reviewSessionAttempt: 1_800_000, writerAttempt: 3_600_000, heavyCheck: 1_200_000 },
  estimateMs: { preflightLineage: 600_000, planningNode: 600_000, reviewNode: 600_000, writer: 3_600_000, heavyCheck: 1_200_000 },
} as const); // deep-frozen: it feeds cccPlanningPolicyDigest (errata E2-45)
export type CccPlanningBudgetPolicy = typeof CCC_PLANNING_BUDGET_POLICY_V1;

const POLICY = CCC_PLANNING_BUDGET_POLICY_V1;

function requireCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got ${String(value)}`);
  }
}

/** 2 * (30 * nodes + 300). */
export function cccPlanningCallFloor(nodes: number): number {
  requireCount(nodes, "nodes");
  return POLICY.floor.multiplier * (POLICY.floor.perNodeCalls * nodes + POLICY.floor.fixedCalls);
}

/** max(0, floor((allocation / 2 - 300) / 30)): the largest N whose floor the allocation covers. */
export function cccPlanningMaxNodes(allocation: number): number {
  requireCount(allocation, "allocation");
  const perCopy = allocation / POLICY.floor.multiplier - POLICY.floor.fixedCalls;
  return Math.max(0, Math.floor(perCopy / POLICY.floor.perNodeCalls));
}

/** 14 + L + (L > 0 ? 1 : 0): the 14 fixed planning roles, one node per leaf, one batched leaf reviewer. */
export function countCccPlanningNodes(i: Readonly<{ leaves: number }>): number {
  requireCount(i.leaves, "leaves");
  return 14 + i.leaves + (i.leaves > 0 ? 1 : 0);
}

/** { T, T + 1 + P }: one writer per provider task; one review per task, the final judge, and P proof nodes. */
export function countCccBuildNodes(i: Readonly<{ providerTasks: number; modelProofNodes: number }>):
  Readonly<{ implementation: number; reviewProof: number }> {
  requireCount(i.providerTasks, "providerTasks");
  requireCount(i.modelProofNodes, "modelProofNodes");
  return { implementation: i.providerTasks, reviewProof: i.providerTasks + 1 + i.modelProofNodes };
}

export type CccFitShortfall = Readonly<{ dimension: "planning-calls" | "implementation-calls" | "review-proof-calls" | "time";
  required: number; remaining: number }>;

function callShortfall(dimension: CccFitShortfall["dimension"], nodes: number, remaining: number): CccFitShortfall | null {
  requireCount(remaining, `remaining ${dimension}`);
  const required = cccPlanningCallFloor(nodes);
  return remaining >= required ? null : { dimension, required, remaining };
}

/*
FNXC:CccPlanningBudgetFit 2026-10-14-09:21:
Remaining time is `deadline - db_now` (or a duration clamped to it), which is zero or negative once the deadline has passed. That is a time shortfall the caller acts on (IB2 moves the run `importing -> budget_exhausted`, v3 item 49), never a crash (errata E1-9). Any finite value is accepted and floored toward the shortfall; zero or less is always short, even against an empty critical path. Only a non-finite time is a programming error. The critical path itself stays a non-negative integer.
*/
function remainingTimeMs(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number of milliseconds, got ${String(value)}`);
  }
  return Math.floor(value) + 0; // + 0 turns -0 into 0
}

function timeShortfall(criticalPathMs: number, remaining: number): CccFitShortfall | null {
  requireCount(criticalPathMs, "criticalPathMs");
  const required = 2 * criticalPathMs;
  return remaining > 0 && remaining >= required ? null : { dimension: "time", required, remaining };
}

/** G0 and leaf admission: planning calls, then 2 * planning critical path against the time left. */
export function assessCccPlanningFit(i: Readonly<{ leaves: number; remainingPlanning: number;
  criticalPathMs: number; remainingDeadlineMs: number }>):
  Readonly<{ ok: true; nodes: number; floor: number }> | Readonly<{ ok: false; code: "CCC_PLANNING_PLANNING_FIT_INSUFFICIENT"; shortfalls: readonly CccFitShortfall[] }> {
  const nodes = countCccPlanningNodes({ leaves: i.leaves });
  const shortfalls = [
    callShortfall("planning-calls", nodes, i.remainingPlanning),
    timeShortfall(i.criticalPathMs, remainingTimeMs(i.remainingDeadlineMs, "remainingDeadlineMs")),
  ].filter((entry): entry is CccFitShortfall => entry !== null);
  return shortfalls.length === 0
    ? { ok: true, nodes, floor: cccPlanningCallFloor(nodes) }
    : { ok: false, code: "CCC_PLANNING_PLANNING_FIT_INSUFFICIENT", shortfalls };
}

/** G6: implementation calls, review/proof calls, then 2 * campaign critical path against min(time left, maxDurationMs). */
export function assessCccBuildFit(i: Readonly<{ providerTasks: number; modelProofNodes: number; campaignCriticalPathMs: number;
  remainingImplementation: number; remainingReviewProof: number; remainingDeadlineMs: number; maxDurationMs: number }>):
  Readonly<{ ok: true }> | Readonly<{ ok: false; code: "CCC_PLANNING_BUILD_FIT_INSUFFICIENT"; shortfalls: readonly CccFitShortfall[] }> {
  const nodes = countCccBuildNodes(i);
  const remainingDeadlineMs = remainingTimeMs(i.remainingDeadlineMs, "remainingDeadlineMs");
  const maxDurationMs = remainingTimeMs(i.maxDurationMs, "maxDurationMs");
  const shortfalls = [
    callShortfall("implementation-calls", nodes.implementation, i.remainingImplementation),
    callShortfall("review-proof-calls", nodes.reviewProof, i.remainingReviewProof),
    timeShortfall(i.campaignCriticalPathMs, Math.min(remainingDeadlineMs, maxDurationMs)),
  ].filter((entry): entry is CccFitShortfall => entry !== null);
  return shortfalls.length === 0 ? { ok: true } : { ok: false, code: "CCC_PLANNING_BUILD_FIT_INSUFFICIENT", shortfalls };
}

/** Before every repair chunk: remaining >= 2 * 30 * repairNodes; the fixed 300 is never charged again. */
export function assessCccRepairChunkFit(i: Readonly<{ phase: "planning" | "review_proof"; repairNodes: number; remaining: number }>): boolean {
  requireCount(i.repairNodes, "repairNodes");
  requireCount(i.remaining, "remaining");
  return i.remaining >= POLICY.floor.multiplier * POLICY.floor.perNodeCalls * i.repairNodes;
}

/** Sequential model at maxConcurrency 1 (I2): no two sessions overlap, including "parallel" reviewers in one stage. */
export function cccPlanningCriticalPathMs(i: Readonly<{ mode: "spec" | "build"; providerTasks: number; maxConcurrency: 1 }>):
  Readonly<{ planningMs: number; campaignMs: number; totalMs: number }> {
  requireCount(i.providerTasks, "providerTasks");
  if (i.maxConcurrency !== 1) throw new RangeError(`only maxConcurrency 1 is modelled, got ${String(i.maxConcurrency)}`);
  const e = POLICY.estimateMs;
  // 3 preflight lineages, 14 planning nodes, one heavy check (the G5 oracle run).
  const planningMs = 3 * e.preflightLineage + 14 * e.planningNode + e.heavyCheck;
  if (i.mode === "spec") return { planningMs, campaignMs: 0, totalMs: planningMs };
  // Per task: writer, heavy check, task review; then the integration check and the final judge (G8).
  const campaignMs = i.providerTasks * (e.writer + e.heavyCheck + e.reviewNode) + e.heavyCheck + e.reviewNode;
  // Build also runs one heavy check for the baseline, preflight and import before the campaign.
  return { planningMs, campaignMs, totalMs: planningMs + e.heavyCheck + campaignMs };
}
