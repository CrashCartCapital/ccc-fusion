import {
  assertCccRunningRuntimePermitted,
  buildCccPlanningWorkflowIr,
  CCC_PLANNING_IR_STAGES,
  CCC_PLANNING_TERMINAL_STATES,
  CccPlanningRefusal,
  cccPlanningTransitionAllowed,
  cccPlanningWorkflowIrHash,
  type CccPlanningIrStageId,
  type CccPlanningRunCustody,
  type CccPlanningRunState,
  type CccPlanningWorkItemFence,
} from "@fusion/core";
import type { WorkflowNodeHandler, WorkflowNodeResult } from "../workflow-graph-executor.js";
import { CCC_PLANNING_HOLD_CONTEXT_KEY, type CccPlanningHoldContext } from "../workflow-task-runtime.js";
import { CccProviderRouteReceiptError } from "../pi.js";
import {
  CCC_PLANNING_STAGE_HOST_KEY,
  type CccPlanningArtifactPort,
  type CccPlanningDescendantRegistry,
  type CccPlanningHostLedger,
  type CccPlanningLedgerPort,
  type CccPlanningSession,
  type CccPlanningSessionFactory,
  type CccPlanningStageContext,
  type CccPlanningStageFn,
  type CccPlanningStageHost,
  type CccPlanningStageOutcome,
} from "./ports.js";

/*
FNXC:CccPlanningHost 2026-10-14-22:17:
The planning stage host (card H1, CONTRACT-v3.4 section 2.16; D3, D40, D44, D45; verify-v2 item 42). One handler runs
every stage gate of the K1 planning workflow under the processor's single lease. Before each stage, in this order:
(1) the running runtime digest must equal the run's (D44), else blocked_prerequisite / RUNTIME_NOT_PERMITTED;
(2) the work item's stored irHash and the IR actually executing must both equal K1's digest for the run's mode, else
failed / WORKFLOW_IR_DRIFT; (3) any unsettled call parks the run in unknown_effect and nothing is dispatched (D3);
(4) a pending pause or cancel is applied here, the stage boundary being the safe point. Each session attempt runs under
its own 30-minute watchdog (D40), never the stage. A provider route refusal was already settled by L1 in the refusing
call's transaction (blocked_provider), so the host only reads that state back and makes no second transition.
Committed-stage skipping is the stage function's job (it inspects its own artifacts): L1's per-stage "committed" means
"any artifact", which is also true for an intent stage waiting on its decision, so the host never skips a stage itself.
*/

/** D40: one planning or review session attempt. */
export const CCC_PLANNING_SESSION_WATCHDOG_MS = 30 * 60_000;

const CODE_RUNTIME_NOT_PERMITTED = "CCC_PLANNING_RUNTIME_NOT_PERMITTED";
const CODE_WORKFLOW_IR_DRIFT = "CCC_PLANNING_WORKFLOW_IR_DRIFT";
const CODE_UNRECONCILED_DISPATCH = "CCC_PLANNING_UNRECONCILED_DISPATCH";
const CODE_INTERNAL_ERROR = "CCC_PLANNING_INTERNAL_ERROR";
const CODE_PROVIDER_PIN_DRIFT = "CCC_PROVIDER_PIN_DRIFT";
/*
FNXC:CccPlanningHost 2026-10-15-00:04:
W3 repair 2 (E14 item 4): section 2.3 requires this state code for awaiting_intent. L1's STATE_CODE_REQUIRED does not
list awaiting_intent, so L1 would persist a null code; recorded as a defence-in-depth follow-up for the next core card.
*/
const CODE_AWAITING_INTENT = "CCC_PLANNING_AWAITING_INTENT";
const STATE_CODE_PATTERN = /^CCC_[A-Z0-9_]{1,120}$/u;

/** States in which the next stage may start. Every other non-terminal state is a rest the operator or a reconcile ends. */
const STARTABLE_STATES: ReadonlySet<CccPlanningRunState> = new Set(["admitted", "running", "spec_ready", "importing"]);
const TERMINAL_STATES: ReadonlySet<CccPlanningRunState> = new Set(CCC_PLANNING_TERMINAL_STATES);
const IR_STAGES: ReadonlySet<string> = new Set(CCC_PLANNING_IR_STAGES);

export class CccPlanningSessionWatchdogError extends Error {
  public constructor(public readonly limitMs: number) {
    super(`ccc planning session attempt exceeded its ${limitMs} ms watchdog`);
    this.name = "CccPlanningSessionWatchdogError";
  }
}

/** The registry the processor hands each planning run; cancelAll settles every registered handle (D45). */
export function createCccPlanningDescendantRegistry(): CccPlanningDescendantRegistry {
  const handles = new Map<symbol, Readonly<{ id: string; cancel(reason: Error): Promise<void> }>>();
  return Object.freeze({
    register(handle: Readonly<{ id: string; cancel(reason: Error): Promise<void> }>): () => void {
      const key = Symbol(handle.id);
      handles.set(key, handle);
      return () => {
        handles.delete(key);
      };
    },
    async cancelAll(reason: Error): Promise<void> {
      // A handle registered while others are being cancelled is cancelled too; the loop ends only when none is left.
      while (handles.size > 0) {
        const batch = [...handles.entries()];
        for (const [key] of batch) handles.delete(key);
        await Promise.allSettled(batch.map(([, handle]) => Promise.resolve().then(() => handle.cancel(reason))));
      }
    },
  });
}

/**
 * D45 and PRD section 9: cancel registered descendants, flush state, release ownership, then let L1 complete a
 * pending cancellation. Strictly in that order; a step runs only after every earlier step succeeded.
 */
export async function settleCccPlanningRun(i: Readonly<{ descendants: CccPlanningDescendantRegistry;
  flush: () => Promise<void>; release: () => Promise<void>; completeCancellation: () => Promise<void>; reason: Error }>): Promise<void> {
  await i.descendants.cancelAll(i.reason);
  await i.flush();
  await i.release();
  await i.completeCancellation();
}

function isRouteRefusal(error: unknown): boolean {
  return error instanceof CccProviderRouteReceiptError;
}

function refusalCode(error: unknown): string | null {
  return error instanceof CccPlanningRefusal ? error.code : null;
}

function readHost(context: unknown): CccPlanningStageHost | null {
  if (!context || typeof context !== "object") return null;
  const host = (context as Record<symbol, unknown>)[CCC_PLANNING_STAGE_HOST_KEY];
  return host && typeof host === "object" ? host as CccPlanningStageHost : null;
}

function holdResult(hold: CccPlanningHoldContext): WorkflowNodeResult {
  return {
    outcome: "failure",
    value: `ccc-planning-${hold.disposition}:${hold.runState}`,
    contextPatch: { [CCC_PLANNING_HOLD_CONTEXT_KEY]: Object.freeze({ ...hold }) },
  };
}

function failureResult(value: string): WorkflowNodeResult {
  return { outcome: "failure", value };
}

/**
 * Where one host move left the run: resting with the work item held (or cancelling, or the lease lost), moved to
 * `failed` by this host, or already terminal.
 */
type HostVerdict =
  | Readonly<{ kind: "hold"; hold: CccPlanningHoldContext }>
  | Readonly<{ kind: "failed"; code: string }>
  | Readonly<{ kind: "terminal"; state: CccPlanningRunState }>;

type HostMove = { moved: true; custody: CccPlanningRunCustody } | { moved: false; verdict: HostVerdict };

/**
 * `normal`: a refusal re-reads the run and may apply a pending control. `control`: the move applies a control, so a
 * refusal never applies controls again. `last`: the run was already sent to `failed` once, so a run still startable
 * after a refusal is an error the processor resolves by releasing the item, never a hold.
 */
type MoveMode = "normal" | "control" | "last";

function verdictResult(verdict: HostVerdict): WorkflowNodeResult {
  if (verdict.kind === "hold") return holdResult(verdict.hold);
  if (verdict.kind === "failed") return failureResult(`ccc-planning-failed:${verdict.code}`);
  return failureResult(`ccc-planning-run-terminal:${verdict.state}`);
}

/*
FNXC:CccPlanningHost 2026-10-14-23:24:
W3 repair 1 (review findings 2 and 4). The host never leaves a run in a startable state (admitted, running, spec_ready,
importing) behind a held or failed work item: nothing moves such a run again, L1 only records a cancel for the host to
apply, and resume is refused. So a park the host may not take from a startable state, or a refused move that leaves
the run startable, fails the run with CCC_PLANNING_INTERNAL_ERROR (allowed from every startable state). A pending
control still wins: L1 refuses `-> failed` with CONTROL_PENDING while a pause or cancel is pending, and the refusal
applies that control (pause -> paused, cancel -> cancelling, then the D45 settlement). Every path is bounded: a run
still startable after a second refused move throws, and the processor then releases the item to `runnable` so the next
stage start runs its checks again.
*/
function createHostMoves(ledger: CccPlanningHostLedger, fence: CccPlanningWorkItemFence) {
  const held = (runState: CccPlanningRunState, code: string | null, decisionId?: string): HostVerdict => ({
    kind: "hold",
    hold: Object.freeze({ disposition: "held", runState, code, ...(decisionId ? { decisionId } : {}) }),
  });
  const cancelling: HostVerdict = { kind: "hold", hold: Object.freeze({ disposition: "cancel", runState: "cancelling", code: null }) };

  const move = async (from: CccPlanningRunState, to: CccPlanningRunState, stateCode: string | null, mode: MoveMode,
    failCode: string = CODE_INTERNAL_ERROR): Promise<HostMove> => {
    try {
      const custody = await ledger.transitionCccPlanningRunState({ runId: fence.runId, from, to, stateCode, fence });
      return { moved: true, custody };
    } catch (error) {
      const code = refusalCode(error);
      if (code === "CCC_PLANNING_FENCE_STALE") {
        return { moved: false, verdict: { kind: "hold", hold: Object.freeze({ disposition: "lease-lost", runState: from, code }) } };
      }
      if (code === "CCC_PLANNING_CONTROL_PENDING" || code === "CCC_PLANNING_STATE_TRANSITION_REFUSED") {
        return { moved: false, verdict: await restAt({ allowControl: mode !== "control", last: mode !== "normal", failCode }) };
      }
      throw error;
    }
  };

  /** Move the run to `failed` with a code; a resting run is held instead, a refusal goes back to where the run stands. */
  const fail = async (from: CccPlanningRunState, code: string, last = false): Promise<HostVerdict> => {
    const safeCode = STATE_CODE_PATTERN.test(code) ? code : CODE_INTERNAL_ERROR;
    if (from === "failed") return { kind: "failed", code: safeCode };
    if (!cccPlanningTransitionAllowed(from, "failed")) return restAt({ last, failCode: safeCode });
    const outcome = await move(from, "failed", safeCode, last ? "last" : "normal", safeCode);
    return outcome.moved ? { kind: "failed", code: safeCode } : outcome.verdict;
  };

  /** Apply a pending pause or cancel at this safe point. */
  const applyControl = async (from: CccPlanningRunState, request: "pause" | "cancel" | "resume"): Promise<HostVerdict | null> => {
    if (request === "pause" && cccPlanningTransitionAllowed(from, "paused")) {
      const outcome = await move(from, "paused", null, "control");
      return outcome.moved ? held("paused", null) : outcome.verdict;
    }
    if (request === "cancel" && cccPlanningTransitionAllowed(from, "cancelling")) {
      const outcome = await move(from, "cancelling", null, "control");
      return outcome.moved ? cancelling : outcome.verdict;
    }
    return null;
  };

  /** Where the run stands now, when the stage cannot start, a host move was refused, or a failure is concluded. */
  const restAt = async (i: Readonly<{ allowControl?: boolean; last?: boolean; failCode?: string }> = {}): Promise<HostVerdict> => {
    const status = await ledger.inspectCccPlanningRun(fence.runId);
    if ((i.allowControl ?? true) && status.pendingControl) {
      const applied = await applyControl(status.state, status.pendingControl.request);
      if (applied) return applied;
    }
    if (status.state === "cancelling") return cancelling;
    if (TERMINAL_STATES.has(status.state)) return { kind: "terminal", state: status.state };
    if (STARTABLE_STATES.has(status.state)) {
      if (i.last) {
        throw new Error(`ccc planning host could not move run ${fence.runId} out of startable state ${status.state}`);
      }
      return fail(status.state, i.failCode ?? CODE_INTERNAL_ERROR, true);
    }
    return held(status.state, status.stateCode, status.awaitingDecision?.decisionId);
  };

  /** Park the run in a resting state; a pair the host may not take fails a startable run and holds a resting one. */
  const park = async (from: CccPlanningRunState, to: CccPlanningRunState, code: string | null,
    decisionId?: string): Promise<HostVerdict> => {
    if (from === to) return held(from, code, decisionId);
    if (!cccPlanningTransitionAllowed(from, to)) {
      return STARTABLE_STATES.has(from) ? fail(from, CODE_INTERNAL_ERROR) : held(from, code, decisionId);
    }
    const outcome = await move(from, to, code, "normal");
    return outcome.moved ? held(to, code, decisionId) : outcome.verdict;
  };

  return Object.freeze({ move, fail, applyControl, restAt, park });
}

/** What the processor does with its planning work item after concluding a failure (see concludeCccPlanningRunFailure). */
export type CccPlanningFailureConclusion =
  | Readonly<{ kind: "ended"; runState: CccPlanningRunState; code: string | null }>
  | Readonly<{ kind: "hold"; hold: CccPlanningHoldContext }>;

/**
 * FNXC:CccPlanningHost 2026-10-14-23:24:
 * W3 repair 1: a planning workflow that failed without a hold (a host error, a stage handler that threw, a runtime
 * rejection) is concluded here, under the processor's still-live fence, before the work item moves. A startable run
 * goes to `failed` with `code` (or applies its pending control); a run that already rests or ended is reported as it
 * is. `ended` lets the processor fail the item; `hold` maps to held, the D45 settlement, or a lost lease. A ledger
 * error propagates: the processor then releases the item to `runnable` instead of failing it.
 */
export async function concludeCccPlanningRunFailure(i: Readonly<{ ledger: CccPlanningHostLedger;
  fence: CccPlanningWorkItemFence; code: string }>): Promise<CccPlanningFailureConclusion> {
  const verdict = await createHostMoves(i.ledger, i.fence).restAt({ failCode: i.code });
  if (verdict.kind === "hold") return verdict;
  if (verdict.kind === "failed") return { kind: "ended", runState: "failed", code: verdict.code };
  return { kind: "ended", runState: verdict.state, code: null };
}

type SessionWatch = { routeRefused: boolean };

/**
 * D40: each open/run/dispose attempt gets its own controller, linked to the stage signal, and its own timer. When the
 * timer fires the attempt is aborted with CccPlanningSessionWatchdogError, and a pending open() or run() rejects, even
 * if the session ignores its signal. The stage keeps going: a stage of many short sessions is never killed for its length.
 */
function watchedSessions(factory: CccPlanningSessionFactory, stageSignal: AbortSignal, watch: SessionWatch,
  limitMs: number): CccPlanningSessionFactory {
  return Object.freeze({
    async open(input: Parameters<CccPlanningSessionFactory["open"]>[0]): Promise<CccPlanningSession> {
      const attempt = new AbortController();
      const linked = [...new Set([stageSignal, input.signal])];
      const forwards = linked.map((source) => {
        const forward = () => attempt.abort(source.reason);
        if (source.aborted) forward();
        else source.addEventListener("abort", forward, { once: true });
        return () => source.removeEventListener("abort", forward);
      });
      const watchdog = new CccPlanningSessionWatchdogError(limitMs);
      let rejectRun: ((error: Error) => void) | undefined;
      let rejectOpen: ((error: Error) => void) | undefined;
      const openDeadline = new Promise<never>((_resolve, reject) => { rejectOpen = reject; });
      const timer = setTimeout(() => {
        attempt.abort(watchdog);
        rejectOpen?.(watchdog);
        rejectRun?.(watchdog);
      }, limitMs);
      const release = () => {
        clearTimeout(timer);
        for (const remove of forwards) remove();
      };
      /*
      FNXC:CccPlanningHost 2026-10-14-23:24:
      W3 repair 1 (review finding 6, D40): the open is raced against the same watchdog as run(). An open that ignores
      its signal is ended at the limit, and a session the factory hands back after the deadline is disposed in the
      background (its dispose is never awaited by the stage), so a late session is never used and never leaks.
      */
      const opening = factory.open({ ...input, signal: attempt.signal });
      let session: CccPlanningSession;
      try {
        session = await Promise.race([opening, openDeadline]);
      } catch (error) {
        release();
        if (isRouteRefusal(error)) watch.routeRefused = true;
        if (attempt.signal.reason === watchdog) {
          void opening.then((late) => late.dispose(), () => undefined).catch(() => undefined);
          throw watchdog;
        }
        throw error;
      }
      if (attempt.signal.reason === watchdog) {
        release();
        await session.dispose();
        throw watchdog;
      }
      return Object.freeze({
        binding: session.binding,
        run(prompt: string) {
          if (attempt.signal.reason === watchdog) return Promise.reject(watchdog);
          return new Promise<Awaited<ReturnType<CccPlanningSession["run"]>>>((resolve, reject) => {
            rejectRun = reject;
            session.run(prompt).then(resolve, (error: unknown) => {
              if (isRouteRefusal(error)) watch.routeRefused = true;
              reject(error);
            });
          });
        },
        async dispose() {
          release();
          await session.dispose();
        },
      });
    },
  });
}

/**
 * Runs the planning stage named by `node.config.cccPlanningStage` under the host the runtime attached to the context.
 * Every outcome that stops the run is reported under CCC_PLANNING_HOLD_CONTEXT_KEY; a failed or rejected stage is a
 * node failure after the run moved to `failed`.
 */
export function createCccPlanningStageHandler(i: Readonly<{ stages: Readonly<Record<CccPlanningIrStageId, CccPlanningStageFn>>;
  ledger: CccPlanningLedgerPort; artifacts: CccPlanningArtifactPort; sessions: CccPlanningSessionFactory;
  now?: () => number }>): WorkflowNodeHandler {
  const { ledger } = i;
  return async (node, context) => {
    const host = readHost(context);
    const stageId = node.config?.cccPlanningStage;
    if (node.kind !== "gate" || typeof stageId !== "string" || !IR_STAGES.has(stageId)) {
      return failureResult(`ccc-planning-stage-unknown:${String(stageId)}`);
    }
    if (!host) return failureResult("ccc-planning-stage-host-missing");
    const { fence, signal } = host;
    if (signal.aborted) return failureResult("aborted");
    const moves = createHostMoves(ledger, fence);
    const park = async (from: CccPlanningRunState, to: CccPlanningRunState, code: string | null, decisionId?: string) =>
      verdictResult(await moves.park(from, to, code, decisionId));
    const fail = async (from: CccPlanningRunState, code: string) => verdictResult(await moves.fail(from, code));
    const restAt = async () => verdictResult(await moves.restAt());

    let custody = await ledger.getCccPlanningRunForTask(fence.originTaskId);
    if (!custody || custody.runId !== fence.runId) return failureResult("ccc-planning-custody-missing");
    const status = await ledger.inspectCccPlanningRun(fence.runId);
    const state = status.state;
    if (!STARTABLE_STATES.has(state)) return restAt();

    // (1) D44: the runtime that runs this stage must be the one the run was admitted under.
    try {
      assertCccRunningRuntimePermitted(custody);
    } catch (error) {
      if (refusalCode(error) !== CODE_RUNTIME_NOT_PERMITTED) throw error;
      return park(state, "blocked_prerequisite", CODE_RUNTIME_NOT_PERMITTED);
    }
    // (2) The stored work item IR and the executing IR are both K1's, never edited (E2-14).
    const expectedIrHash = cccPlanningWorkflowIrHash(buildCccPlanningWorkflowIr(status.mode));
    if (host.workItemIrHash !== expectedIrHash || host.executedIrHash !== expectedIrHash) {
      return fail(state, CODE_WORKFLOW_IR_DRIFT);
    }
    // (3) D3: an unsettled call is an unknown effect; the run parks and no stage dispatches anything.
    if (status.unreconciled.length > 0) return park(state, "unknown_effect", CODE_UNRECONCILED_DISPATCH);
    // (4) The stage boundary is the safe point for a pending pause or cancel.
    if (status.pendingControl) {
      const applied = await moves.applyControl(state, status.pendingControl.request);
      if (applied) return verdictResult(applied);
    }
    if (state === "admitted") {
      const outcome = await moves.move("admitted", "running", null, "normal");
      if (!outcome.moved) return verdictResult(outcome.verdict);
      custody = outcome.custody;
    }

    const watch: SessionWatch = { routeRefused: false };
    const ctx: CccPlanningStageContext = Object.freeze({
      run: custody,
      stageId: stageId as CccPlanningIrStageId,
      fence,
      signal,
      ledger,
      artifacts: i.artifacts,
      sessions: watchedSessions(i.sessions, signal, watch, CCC_PLANNING_SESSION_WATCHDOG_MS),
      descendants: host.descendants,
    });
    let outcome: CccPlanningStageOutcome | undefined;
    let thrown: unknown;
    let threw = false;
    try {
      outcome = await i.stages[stageId as CccPlanningIrStageId](ctx);
    } catch (error) {
      threw = true;
      thrown = error;
    }
    // The processor owns an aborted run (D45 settlement); nothing is written here.
    if (signal.aborted) return failureResult("aborted");

    const after = await ledger.inspectCccPlanningRun(fence.runId);
    if (watch.routeRefused || (threw && isRouteRefusal(thrown))) {
      // verify-v2 item 42: L1 already moved the run in the refusing call's transaction; read it back.
      if (after.state === "blocked_provider") {
        return holdResult({ disposition: "held", runState: "blocked_provider", code: CODE_PROVIDER_PIN_DRIFT });
      }
      // Only when L1 did not settle the refusal does the host make the one transition itself.
      if (cccPlanningTransitionAllowed(after.state, "blocked_provider")) {
        return park(after.state, "blocked_provider", CODE_PROVIDER_PIN_DRIFT);
      }
      return restAt();
    }
    if (threw && refusalCode(thrown) === "CCC_PLANNING_FENCE_STALE") {
      return holdResult({ disposition: "lease-lost", runState: after.state, code: "CCC_PLANNING_FENCE_STALE" });
    }
    if (threw && refusalCode(thrown) === "CCC_PLANNING_CONTROL_PENDING") return restAt();
    if (threw || !outcome) {
      return after.unreconciled.length > 0
        ? park(after.state, "unknown_effect", CODE_UNRECONCILED_DISPATCH)
        : fail(after.state, CODE_INTERNAL_ERROR);
    }
    switch (outcome.kind) {
      case "committed":
      case "skipped":
        return { outcome: "success", value: outcome.kind };
      case "awaiting-intent":
        return park(after.state, "awaiting_intent", CODE_AWAITING_INTENT, outcome.decisionId);
      case "blocked":
        return park(after.state, outcome.state, STATE_CODE_PATTERN.test(outcome.code) ? outcome.code : CODE_INTERNAL_ERROR);
      case "unknown-effect":
        return park(after.state, "unknown_effect", CODE_UNRECONCILED_DISPATCH);
      case "rejected":
        return fail(after.state, outcome.code);
      default:
        return fail(after.state, CODE_INTERNAL_ERROR);
    }
  };
}
