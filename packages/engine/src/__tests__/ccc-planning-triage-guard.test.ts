/**
 * FNXC:CccPlanningCustody 2026-10-14-13:41 (card G1, D22, challenge 24):
 * Engine half of the request-to-code planning-task guards.
 *
 * The guard-only predicate isCccCustodyGuardedTask covers planning tasks, while isCccCampaignTask stays exactly
 * what it was: widening it would also switch on the campaign durable frontier, permanent-failure handling and
 * executor classification for planning tasks (challenge 24). Triage must ignore a planning task even when its
 * `paused` flag has been cleared by some path the store guards do not know about; the twin task without the
 * planning lineage proves the same fixture is otherwise admitted.
 */
import "./executor-test-helpers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

import { isCccCampaignTask, isCccCustodyGuardedTask } from "../ccc-campaign-routing.js";
import { TriageProcessor } from "../triage.js";

const RUN_ID = "ccc-plan:0123456789abcdef01234567";

function task(overrides: Partial<Task>): Task {
  return {
    id: "FN-G1",
    title: "task",
    description: "request-to-code planning task",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-10-14T12:00:00.000Z",
    updatedAt: "2026-10-14T12:00:00.000Z",
    ...overrides,
  } as Task;
}

const processors: TriageProcessor[] = [];

afterEach(() => {
  for (const processor of processors.splice(0)) processor.stop();
});

function discover(tasks: Task[]): Promise<Task[]> {
  const store = {
    getSettings: vi.fn().mockResolvedValue({ pollIntervalMs: 60_000, maxConcurrent: 1 }),
    listTasks: vi.fn().mockResolvedValue(tasks),
    on: vi.fn(),
    off: vi.fn(),
  };
  const processor = new TriageProcessor(store as never, "/tmp/fn-ccc-planning-g1");
  processors.push(processor);
  const internal = processor as unknown as { discoverReadyPlanningTasks(all: Task[], now: number): Promise<Task[]> };
  return internal.discoverReadyPlanningTasks(tasks, Date.parse("2026-10-14T13:00:00.000Z"));
}

describe("ccc planning custody predicates", () => {
  it("isCccCampaignTask(planningTask) stays false while isCccCustodyGuardedTask(planningTask) is true", () => {
    const planningTask = task({ lineageId: RUN_ID, paused: true, userPaused: false });
    expect(isCccCampaignTask(planningTask)).toBe(false);
    expect(isCccCustodyGuardedTask(planningTask)).toBe(true);
  });

  it("treats an absent userPaused as unpaused and leaves a user-paused or unpaused planning lineage unguarded", () => {
    expect(isCccCustodyGuardedTask(task({ lineageId: RUN_ID, paused: true }))).toBe(true);
    expect(isCccCustodyGuardedTask(task({ lineageId: RUN_ID, paused: true, userPaused: true }))).toBe(false);
    expect(isCccCustodyGuardedTask(task({ lineageId: RUN_ID, paused: false }))).toBe(false);
    expect(isCccCustodyGuardedTask(task({ lineageId: `${RUN_ID}0`, paused: true }))).toBe(false);
  });

  it("keeps guarding imported and profile campaign tasks and leaves an ordinary task unguarded", () => {
    const imported = task({ lineageId: "ccc-prd:0123456789abcdef01234567:TASK-1" });
    const profile = task({ customFields: { cccFusionProfile: "ccc-fusion" } });
    expect(isCccCustodyGuardedTask(imported)).toBe(true);
    expect(isCccCustodyGuardedTask(profile)).toBe(true);
    expect(isCccCampaignTask(imported)).toBe(true);
    expect(isCccCustodyGuardedTask(task({}))).toBe(false);
  });
});

describe("triage excludes ccc planning tasks", () => {
  it("discoverReadyPlanningTasks excludes a triage planning task even with paused cleared; the twin without the lineage is included", async () => {
    const planningTask = task({ id: "FN-G1-PLAN", lineageId: RUN_ID, paused: false });
    const twin = task({ id: "FN-G1-TWIN", paused: false });
    const ready = await discover([planningTask, twin]);
    expect(ready.map((entry) => entry.id)).toEqual(["FN-G1-TWIN"]);
  });

  it("discoverReadyPlanningTasks excludes a needs-replan todo planning task with paused cleared; the twin is included", async () => {
    const planningTask = task({ id: "FN-G1-PLAN-TODO", column: "todo", status: "needs-replan", lineageId: RUN_ID });
    const twin = task({ id: "FN-G1-TWIN-TODO", column: "todo", status: "needs-replan" });
    const ready = await discover([planningTask, twin]);
    expect(ready.map((entry) => entry.id)).toEqual(["FN-G1-TWIN-TODO"]);
  });
});
