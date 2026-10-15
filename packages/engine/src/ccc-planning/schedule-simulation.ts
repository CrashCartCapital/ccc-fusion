import {
  CCC_PLANNING_I2_MAX_CONCURRENCY,
  type CccPlanningBudgetPolicy,
  type CccPlanningTaskPlanV1,
  type CccPrdDiagnostic,
} from "@fusion/core";

/*
FNXC:CccPlanningSchedule 2026-10-14-18:50:
Card GG (D19, challenge 29, section 4.6). G4 proves the planned graph can actually be run, and G6 needs the length of that run. The simulation is a list scheduler at maxConcurrency 1 (I2): a task starts only when every task it depends on has finished, ready tasks start in plan order, and no two sessions overlap. Each provider task costs one writer attempt, one heavy check (its proof) and one task review (G7), and the campaign ends with one integration check and the final judge (G8), all from the budget policy's estimates. At concurrency 1 the critical path is therefore the sum, so the section 4.1 diamond gives 4 x 5,400,000 + 1,200,000 + 600,000 = 23,400,000 ms, which is K1's `cccPlanningCriticalPathMs` campaign value for four tasks; the simulation still walks the real graph so an unschedulable plan (a cycle, or a dependency on a task the plan does not declare) is refused with the tasks it strands. The stranded tasks still count toward the returned path, which is then an upper bound the caller must not use, because the diagnostics refuse the plan.
*/

export type CccPlanningSchedulePolicy = Pick<CccPlanningBudgetPolicy, "estimateMs">;

export type CccPlanningScheduleSimulation = Readonly<{
  campaignCriticalPathMs: number;
  /** Task ids in the order the simulation starts them; tasks it cannot schedule are absent. */
  order: readonly string[];
  diagnostics: readonly CccPrdDiagnostic[];
}>;

export function simulateCccPlanningSchedule(
  taskPlan: CccPlanningTaskPlanV1,
  policy: CccPlanningSchedulePolicy,
): CccPlanningScheduleSimulation {
  const e = policy.estimateMs;
  const perTaskMs = e.writer + e.heavyCheck + e.reviewNode;
  const tailMs = e.heavyCheck + e.reviewNode;
  const tasks = taskPlan.tasks;
  const finished = new Set<string>();
  const order: string[] = [];
  const running: Array<{ id: string; endsAt: number }> = [];
  let clock = 0;
  let pending = tasks.map((task) => task.id);
  for (;;) {
    // Start ready tasks in plan order while a slot is free.
    while (running.length < CCC_PLANNING_I2_MAX_CONCURRENCY) {
      const next = tasks.find((task) => pending.includes(task.id) && task.dependencyTaskIds.every((dep) => finished.has(dep)));
      if (!next) break;
      pending = pending.filter((id) => id !== next.id);
      order.push(next.id);
      running.push({ id: next.id, endsAt: clock + perTaskMs });
    }
    if (running.length === 0) break;
    running.sort((left, right) => left.endsAt - right.endsAt);
    const done = running.shift()!;
    clock = done.endsAt;
    finished.add(done.id);
  }
  const diagnostics: CccPrdDiagnostic[] = [];
  if (tasks.length === 0) {
    diagnostics.push({ code: "CCC_PLANNING_GRAPH_INADMISSIBLE", message: "schedule simulation: the task plan has no tasks to schedule" });
  }
  if (pending.length > 0) {
    diagnostics.push({
      code: "CCC_PLANNING_GRAPH_INADMISSIBLE",
      message: `schedule simulation: tasks ${pending.join(", ")} can never start at maxConcurrency ${CCC_PLANNING_I2_MAX_CONCURRENCY}`
        + " because they wait on a cycle or on a task the plan does not declare",
    });
  }
  const makespanMs = clock + pending.length * perTaskMs;
  return { campaignCriticalPathMs: makespanMs + tailMs, order, diagnostics };
}
