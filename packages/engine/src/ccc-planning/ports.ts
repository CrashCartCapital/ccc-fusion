import {
  answerCccPlanningDecision,
  assertCccPlanningDescendantsSettled,
  claimCccPlanningRepairChunk,
  closeCccPlanningRepairEpoch,
  completeCccPlanningCancellation,
  createCccPlanningAttemptController,
  getCccPlanningRunForTask,
  inspectCccPlanningRun,
  listCccPlanningArtifacts,
  proveCccPlanningCallNotDispatched,
  publishCccPlanningArtifact,
  readCccPlanningArtifact,
  recordCccPlanningLineageSplit,
  recordCccPlanningReviewEpoch,
  requestCccPlanningControl,
  reserveCccPlanningResearchFetch,
  resolveCccPlanningInputClosure,
  settleCccPlanningCall,
  settleCccPlanningResearchFetch,
  transitionCccPlanningRunState,
  admitCccPlanningDispatch,
  type AsyncDataLayer,
  type CccPlanningArtifactRef,
  type CccPlanningIrStageId,
  type CccPlanningReadSnapshot,
  type CccPlanningRoleId,
  type CccPlanningRouteBinding,
  type CccPlanningRunCustody,
  type CccPlanningStageId,
  type CccPlanningWorkItemFence,
  type CccReviewVerdict,
} from "@fusion/core";

/*
FNXC:CccPlanningHost 2026-10-14-22:17:
The ports a planning stage sees (CONTRACT-v3.4 section 2.16, card H1). The ledger and artifact ports are the L1 and A1
store functions with their AsyncDataLayer argument bound once, so a stage never holds a layer and a test can hand the
controller an in-memory fake with the same shape. Verdicts use K1's CccReviewVerdict from @fusion/core (verify-v2 item
34), never a copy. The descendant registry is how the host cancels everything a stage started before it releases the
lease (D45, PRD section 9).
*/

type BoundLayer<F> = F extends (layer: AsyncDataLayer, ...rest: infer R) => infer T ? (...rest: R) => T : never;

/** The L1 functions of section 2.11, bound to one layer. */
export interface CccPlanningLedgerPort {
  readonly getCccPlanningRunForTask: BoundLayer<typeof getCccPlanningRunForTask>;
  readonly inspectCccPlanningRun: BoundLayer<typeof inspectCccPlanningRun>;
  readonly admitCccPlanningDispatch: BoundLayer<typeof admitCccPlanningDispatch>;
  readonly proveCccPlanningCallNotDispatched: BoundLayer<typeof proveCccPlanningCallNotDispatched>;
  readonly settleCccPlanningCall: BoundLayer<typeof settleCccPlanningCall>;
  readonly recordCccPlanningLineageSplit: BoundLayer<typeof recordCccPlanningLineageSplit>;
  readonly claimCccPlanningRepairChunk: BoundLayer<typeof claimCccPlanningRepairChunk>;
  readonly closeCccPlanningRepairEpoch: BoundLayer<typeof closeCccPlanningRepairEpoch>;
  readonly recordCccPlanningReviewEpoch: BoundLayer<typeof recordCccPlanningReviewEpoch>;
  readonly reserveCccPlanningResearchFetch: BoundLayer<typeof reserveCccPlanningResearchFetch>;
  readonly settleCccPlanningResearchFetch: BoundLayer<typeof settleCccPlanningResearchFetch>;
  readonly requestCccPlanningControl: BoundLayer<typeof requestCccPlanningControl>;
  readonly answerCccPlanningDecision: BoundLayer<typeof answerCccPlanningDecision>;
  readonly completeCccPlanningCancellation: BoundLayer<typeof completeCccPlanningCancellation>;
  readonly transitionCccPlanningRunState: BoundLayer<typeof transitionCccPlanningRunState>;
  readonly assertCccPlanningDescendantsSettled: BoundLayer<typeof assertCccPlanningDescendantsSettled>;
  readonly createCccPlanningAttemptController: (
    i: Omit<Parameters<typeof createCccPlanningAttemptController>[0], "layer">,
  ) => ReturnType<typeof createCccPlanningAttemptController>;
}

/** The A1 functions of section 2.6, bound to one layer. */
export interface CccPlanningArtifactPort {
  readonly publishCccPlanningArtifact: BoundLayer<typeof publishCccPlanningArtifact>;
  readonly readCccPlanningArtifact: BoundLayer<typeof readCccPlanningArtifact>;
  readonly listCccPlanningArtifacts: BoundLayer<typeof listCccPlanningArtifacts>;
  readonly resolveCccPlanningInputClosure: BoundLayer<typeof resolveCccPlanningInputClosure>;
}

export interface CccPlanningSessionFactory {
  open(i: Readonly<{ run: CccPlanningRunCustody; stageId: CccPlanningStageId; roleId: CccPlanningRoleId; lineageId: string;
    nodeAttemptOrdinal: 1 | 2 | 3; phase: "planning" | "review_proof"; fence: CccPlanningWorkItemFence;
    inputs: readonly CccPlanningArtifactRef[]; readSnapshot: CccPlanningReadSnapshot; preflight?: boolean;
    signal: AbortSignal }>): Promise<CccPlanningSession>;
}

export interface CccPlanningSession {
  readonly binding: CccPlanningRouteBinding;
  run(prompt: string): Promise<Readonly<{ submitted: readonly CccPlanningArtifactRef[]; verdict: CccReviewVerdict | null }>>;
  dispose(): Promise<void>;
}

export interface CccPlanningDescendantRegistry {
  register(handle: Readonly<{ id: string; cancel(reason: Error): Promise<void> }>): () => void;
  /** Resolves only after every registered handle has settled. */
  cancelAll(reason: Error): Promise<void>;
}

export interface CccPlanningStageContext {
  readonly run: CccPlanningRunCustody;
  readonly stageId: CccPlanningIrStageId;
  readonly fence: CccPlanningWorkItemFence;
  readonly signal: AbortSignal;
  readonly ledger: CccPlanningLedgerPort;
  readonly artifacts: CccPlanningArtifactPort;
  readonly sessions: CccPlanningSessionFactory;
  readonly descendants: CccPlanningDescendantRegistry;
}

export type CccPlanningStageOutcome =
  | Readonly<{ kind: "committed"; artifactKeys: readonly string[] }>
  | Readonly<{ kind: "awaiting-intent"; decisionId: string }>
  | Readonly<{ kind: "blocked"; state: "blocked_prerequisite" | "blocked_provider" | "budget_exhausted"; code: string }>
  | Readonly<{ kind: "unknown-effect"; attemptKeys: readonly string[] }>
  | Readonly<{ kind: "rejected"; code: string }>
  | Readonly<{ kind: "skipped"; reason: "spec-mode" | "no-repair-claimed" }>;

export type CccPlanningStageFn = (ctx: CccPlanningStageContext) => Promise<CccPlanningStageOutcome>;

/**
 * FNXC:CccPlanningHost 2026-10-14-22:17:
 * What the runtime hands the stage handler for one planning workflow run: the planning fence of the leased work item,
 * the processor's descendant registry, the work item's stored irHash and the hash of the IR actually being executed,
 * and the processor's abort signal. It rides on the node context under a symbol key, so it is never serialized into
 * the workflow context or copied into a context patch.
 */
export const CCC_PLANNING_STAGE_HOST_KEY: unique symbol = Symbol.for("ccc-fusion.planning-stage-host.v1");

export type CccPlanningStageHost = Readonly<{
  fence: CccPlanningWorkItemFence;
  descendants: CccPlanningDescendantRegistry;
  workItemIrHash: string | null;
  executedIrHash: string;
  signal: AbortSignal;
}>;

export function createCccPlanningLedgerPort(layer: AsyncDataLayer): CccPlanningLedgerPort {
  const port: CccPlanningLedgerPort = {
    getCccPlanningRunForTask: (taskId) => getCccPlanningRunForTask(layer, taskId),
    inspectCccPlanningRun: (runId, ports) => inspectCccPlanningRun(layer, runId, ports),
    admitCccPlanningDispatch: (request) => admitCccPlanningDispatch(layer, request),
    proveCccPlanningCallNotDispatched: (scope, evidenceDigest) => proveCccPlanningCallNotDispatched(layer, scope, evidenceDigest),
    settleCccPlanningCall: (settlement) => settleCccPlanningCall(layer, settlement),
    recordCccPlanningLineageSplit: (i) => recordCccPlanningLineageSplit(layer, i),
    claimCccPlanningRepairChunk: (i) => claimCccPlanningRepairChunk(layer, i),
    closeCccPlanningRepairEpoch: (i) => closeCccPlanningRepairEpoch(layer, i),
    recordCccPlanningReviewEpoch: (i) => recordCccPlanningReviewEpoch(layer, i),
    reserveCccPlanningResearchFetch: (i) => reserveCccPlanningResearchFetch(layer, i),
    settleCccPlanningResearchFetch: (i) => settleCccPlanningResearchFetch(layer, i),
    requestCccPlanningControl: (i) => requestCccPlanningControl(layer, i),
    answerCccPlanningDecision: (i) => answerCccPlanningDecision(layer, i),
    completeCccPlanningCancellation: (i) => completeCccPlanningCancellation(layer, i),
    transitionCccPlanningRunState: (i) => transitionCccPlanningRunState(layer, i),
    assertCccPlanningDescendantsSettled: (runId) => assertCccPlanningDescendantsSettled(layer, runId),
    createCccPlanningAttemptController: (i) => createCccPlanningAttemptController({ ...i, layer }),
  };
  return Object.freeze(port);
}

export function createCccPlanningArtifactPort(layer: AsyncDataLayer): CccPlanningArtifactPort {
  const port: CccPlanningArtifactPort = {
    publishCccPlanningArtifact: (input) => publishCccPlanningArtifact(layer, input),
    readCccPlanningArtifact: (planningTaskId, key, options) => readCccPlanningArtifact(layer, planningTaskId, key, options),
    listCccPlanningArtifacts: (planningTaskId) => listCccPlanningArtifacts(layer, planningTaskId),
    resolveCccPlanningInputClosure: (planningTaskId, roots) => resolveCccPlanningInputClosure(layer, planningTaskId, roots),
  };
  return Object.freeze(port);
}

/**
 * FNXC:CccPlanningHost 2026-10-14-22:17:
 * The run lookup the processor and the runtime use (D2). A store that names `getCccPlanningRunForTask` is asked
 * directly (test fakes, wrappers); the PostgreSQL TaskStore has no such method, so its own AsyncDataLayer is bound to
 * L1's lookup. Neither present means planning custody is unwired, and the caller fails closed.
 */
export function cccPlanningRunLookup(store: unknown):
  ((taskId: string) => Promise<CccPlanningRunCustody | null>) | null {
  if (!store || typeof store !== "object") return null;
  const candidate = store as {
    getCccPlanningRunForTask?: (taskId: string) => Promise<CccPlanningRunCustody | null> | CccPlanningRunCustody | null;
    getAsyncLayer?: () => AsyncDataLayer | null | undefined;
  };
  if (typeof candidate.getCccPlanningRunForTask === "function") {
    const lookup = candidate.getCccPlanningRunForTask;
    return async (taskId) => lookup.call(store, taskId);
  }
  if (typeof candidate.getAsyncLayer === "function") {
    const layer = candidate.getAsyncLayer.call(store);
    if (layer) return (taskId) => getCccPlanningRunForTask(layer, taskId);
  }
  return null;
}

/** The two L1 functions the host's own run moves need: read where the run stands, and move it under the fence. */
export type CccPlanningHostLedger = Pick<CccPlanningLedgerPort, "inspectCccPlanningRun" | "transitionCccPlanningRunState">;

/**
 * FNXC:CccPlanningHost 2026-10-14-23:24:
 * W3 repair 1: the processor concludes a planning failure itself (it moves the run before it fails or holds the work
 * item), so it needs L1's read and move with the same binding rule as the run lookup: a store that names both
 * functions is asked directly (test fakes, wrappers), otherwise the store's own AsyncDataLayer is bound. Null means
 * the ledger is unwired, which the processor treats like an unreachable ledger.
 */
export function cccPlanningHostLedger(store: unknown): CccPlanningHostLedger | null {
  if (!store || typeof store !== "object") return null;
  const candidate = store as Partial<CccPlanningHostLedger> & { getAsyncLayer?: () => AsyncDataLayer | null | undefined };
  const inspect = candidate.inspectCccPlanningRun;
  const transition = candidate.transitionCccPlanningRunState;
  if (typeof inspect === "function" && typeof transition === "function") {
    return Object.freeze({
      inspectCccPlanningRun: (runId, ports) => inspect.call(store, runId, ports),
      transitionCccPlanningRunState: (i) => transition.call(store, i),
    });
  }
  if (typeof candidate.getAsyncLayer === "function") {
    const layer = candidate.getAsyncLayer.call(store);
    if (layer) {
      return Object.freeze({
        inspectCccPlanningRun: (runId, ports) => inspectCccPlanningRun(layer, runId, ports),
        transitionCccPlanningRunState: (i) => transitionCccPlanningRunState(layer, i),
      });
    }
  }
  return null;
}

/** The same binding rule for L1's cancellation completion (D45); null when the store carries neither. */
export function cccPlanningCancellationCompleter(store: unknown):
  ((runId: string) => Promise<Readonly<{ completed: boolean }>>) | null {
  if (!store || typeof store !== "object") return null;
  const candidate = store as {
    completeCccPlanningCancellation?: (runId: string) => Promise<Readonly<{ completed: boolean }>>;
    getAsyncLayer?: () => AsyncDataLayer | null | undefined;
  };
  if (typeof candidate.completeCccPlanningCancellation === "function") {
    const complete = candidate.completeCccPlanningCancellation;
    return async (runId) => complete.call(store, runId);
  }
  if (typeof candidate.getAsyncLayer === "function") {
    const layer = candidate.getAsyncLayer.call(store);
    if (layer) return (runId) => completeCccPlanningCancellation(layer, { runId });
  }
  return null;
}
