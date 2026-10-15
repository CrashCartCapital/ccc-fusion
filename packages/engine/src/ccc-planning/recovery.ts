import {
  completeCccPlanningCancellation,
  drizzleSql,
  inspectCccPlanningRun,
  transitionCccPlanningRunState,
  type AsyncDataLayer,
  type CccPlanningLinkedOutcomePorts,
  type TaskStore,
} from "@fusion/core";

/*
FNXC:CccPlanningHost 2026-10-14-22:17:
Engine-start recovery for request-to-code planning runs (card H1, D3, D45, verify-v2 item 35). It only finishes what a
dead engine left behind and never moves a work item: an expired planning lease is reclaimed by the existing acquire path
(workflow-workitems-ops-2.ts), which already re-claims lease-expired `running` items, so this module has no queue
writes of its own. Per non-terminal run of the store's project:
- linked (import_id set): the campaign outcome is reconciled through the optional port (BF owns the real function and
  WR wires it; H1 never imports BF); without the port the run reports "none";
- cancelling: L1's completeCccPlanningCancellation, which itself refuses while a lease is live or a call is unsettled;
- running with an unsettled call and no live planning lease: unknown_effect / UNRECONCILED_DISPATCH (D3).
*/

export type CccPlanningRecoveryOutcome = "cancellation-completed" | "unknown-effect" | "campaign-reconciled" | "none";

type RecoverableRun = { run_id: string; state: string; import_id: string | null; planning_task_id: string };

async function listRecoverableRuns(layer: AsyncDataLayer): Promise<RecoverableRun[]> {
  const projectId = layer.projectId?.trim();
  return (await layer.db.execute(drizzleSql`
    SELECT run_id, state, import_id, planning_task_id FROM project.ccc_planning_runs
     WHERE state NOT IN ('cancelled', 'delivered', 'failed')
       ${projectId ? drizzleSql`AND project_id = ${projectId}` : drizzleSql``}
     ORDER BY run_id
  `)) as unknown as RecoverableRun[];
}

/** A planning item of this run still running under a lease that has not expired by the database clock. */
async function hasLivePlanningLease(layer: AsyncDataLayer, run: RecoverableRun): Promise<boolean> {
  const projectId = layer.projectId?.trim();
  const live = (await layer.db.execute(drizzleSql`
    SELECT id FROM project.workflow_work_items
     WHERE task_id = ${run.planning_task_id} AND run_id = ${run.run_id} AND state = 'running'
       AND lease_expires_at IS NOT NULL AND lease_expires_at::timestamptz > clock_timestamp()
       ${projectId ? drizzleSql`AND project_id = ${projectId}` : drizzleSql``}
     LIMIT 1
  `)) as unknown as unknown[];
  return live.length > 0;
}

/** One run's engine-start recovery; a refusal or ledger error is the caller's to isolate. */
async function recoverRun(layer: AsyncDataLayer, run: RecoverableRun,
  i: Readonly<{ now?: string; ports?: CccPlanningLinkedOutcomePorts }>): Promise<CccPlanningRecoveryOutcome> {
  if (run.import_id !== null) {
    if (!i.ports?.reconcileLinkedOutcome) return "none";
    await i.ports.reconcileLinkedOutcome(layer, run.run_id);
    return "campaign-reconciled";
  }
  if (run.state === "cancelling") {
    const completion = await completeCccPlanningCancellation(layer, {
      runId: run.run_id, ...(i.now !== undefined ? { now: i.now } : {}),
    });
    return completion.completed ? "cancellation-completed" : "none";
  }
  if (run.state === "running") {
    const status = await inspectCccPlanningRun(layer, run.run_id);
    if (status.state === "running" && status.unreconciled.length > 0 && !(await hasLivePlanningLease(layer, run))) {
      await transitionCccPlanningRunState(layer, {
        runId: run.run_id, from: "running", to: "unknown_effect", stateCode: "CCC_PLANNING_UNRECONCILED_DISPATCH", fence: null,
      });
      return "unknown-effect";
    }
  }
  return "none";
}

/*
FNXC:CccPlanningHost 2026-10-14-23:24:
W3 repair 1 (review finding 1, D45): each run is recovered on its own. A run whose recovery is refused (for example
running -> unknown_effect refused CONTROL_PENDING while an operator pause waits for the next stage start) or whose ledger
call fails is reported "none" and the loop goes on, so one run that refuses the same way on every restart can never
keep later runs (sorted by run id) from completing their cancellation. After the loop one AggregateError names every
failed run, so the engine still logs it; it carries the per-run results as `results`.
*/
export async function recoverCccPlanningRuns(i: Readonly<{ store: TaskStore; now?: string; ports?: CccPlanningLinkedOutcomePorts }>):
  Promise<ReadonlyArray<Readonly<{ runId: string; outcome: CccPlanningRecoveryOutcome }>>> {
  const layer = i.store.getAsyncLayer();
  if (!layer) return [];
  const results: Array<Readonly<{ runId: string; outcome: CccPlanningRecoveryOutcome }>> = [];
  const failures: Array<Readonly<{ runId: string; error: unknown }>> = [];
  for (const run of await listRecoverableRuns(layer)) {
    let outcome: CccPlanningRecoveryOutcome = "none";
    try {
      outcome = await recoverRun(layer, run, i);
    } catch (error) {
      failures.push({ runId: run.run_id, error });
    }
    results.push(Object.freeze({ runId: run.run_id, outcome }));
  }
  if (failures.length > 0) {
    const named = failures.map((failure) => `${failure.runId} (${failure.error instanceof Error ? failure.error.message : String(failure.error)})`);
    throw Object.assign(
      new AggregateError(failures.map((failure) => failure.error),
        `ccc planning engine-start recovery failed for ${failures.length} run(s): ${named.join(", ")}`),
      { results: Object.freeze([...results]) },
    );
  }
  return results;
}
