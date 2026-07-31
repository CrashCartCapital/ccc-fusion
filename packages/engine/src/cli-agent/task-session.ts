/**
 * Task ↔ CLI session orchestration (CLI Agent Executor, U7).
 *
 * This module is the bridge between the task execute pipeline and the engine-
 * owned CLI session machinery (U2 CliSessionManager + U3 TelemetryHub /
 * state machine + U17 hook scripts). It takes a task + the resolved workflow-
 * node executor config and runs one CLI agent through the execute step:
 *
 *   1. Spawn a CLI session in the task worktree (CliSessionManager.spawn). A
 *      CliConcurrencyLimitError at the ceiling is propagated as a typed error
 *      (the seam surfaces it as a queued/rejected task state — never a stall).
 *   2. Mint the per-session hook token (TelemetryHub.issueToken) and write the
 *      session-scoped hook scripts (writeSessionHookScripts) into a scratch dir.
 *   3. Build the adapter launch settings (the Claude adapter consumes the written
 *      hook-script paths via its settings flow). NOTE: the launch invocation is
 *      computed by the manager from the settings we pass through `spawn`; this
 *      module assembles those settings BEFORE spawn so the hooks are wired at
 *      launch.
 *   4. Inject the task prompt after readiness (manager.waitForReady → inject).
 *   5. Subscribe to the state machine and resolve on a terminal signal (R20):
 *        - native `done`           → success      (PTY reaped at handoff)
 *        - generic-tier `idle`     → NEVER resolves; `confirmAdvance()` resolves
 *                                    it as success (the operator affordance)
 *        - `needsAttention`        → needs-attention (stall / userExited /
 *                                    authFailed escalation)
 *        - `killed`                → killed       (hard cancel / column exit)
 *
 * Config snapshot: the resolved executor config is captured at launch. A mid-run
 * node-config edit therefore applies to the NEXT run only — this object holds the
 * launch-time snapshot.
 *
 * Re-entry policy (caller-driven):
 *   - A needs-replan / RETHINK re-entry launches a FRESH session: the caller
 *     kills any prior live session for the task first (see
 *     `killLiveTaskSessions`) and calls `launchCliTaskSession` again.
 *   - A follow-up to a done task resumes the recorded native session id when the
 *     adapter supports it (`followUp`); if resume is unsupported or fails the
 *     follow-up falls back to a fresh launch.
 *
 * Pure engine code: no dashboard imports, no HTTP. The hub is the in-process
 * telemetry sink; the dashboard route (U17) forwards validated hook POSTs into it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CliAutonomyPosture,
  CccProviderAttemptScope,
  ResolvedMcpServerDefinition,
  CliSession,
  CliTerminationReason,
} from "@fusion/core";
import type { CliSessionManager } from "./session-manager.js";
import type { TelemetryHub } from "./telemetry-hub.js";
import type { CliAdapterRegistry } from "./adapter.js";
import type { CliMachineState } from "./state-machine.js";
import {
  HOOK_SCRIPT_NAMES,
  writeSessionHookScripts,
  cleanupSessionHookDir,
} from "./hook-scripts.js";
import {
  assertAutonomyApproved,
  type AutonomyApprovalLookup,
  type CliAgentResolveSettings,
  type EffectivePosture,
} from "./autonomy.js";
import { applyCccNativeMcpPolicy } from "./ccc-native-mcp-policy.js";
import {
  type CccNativeCliHeldClosureReceipt,
  type CccNativeCliHeldClosureTrigger,
  type CccNativeCliSessionPolicy,
} from "./ccc-native-cli-binding.js";

// ── Outcome ──────────────────────────────────────────────────────────────────

/**
 * Terminal outcome of a CLI task session, mapped from the authoritative state
 * machine onto the pipeline contract.
 *
 * - `success`        — a positive completion signal arrived (native done, or the
 *                      generic-tier confirm-advance affordance). The pipeline
 *                      advances; the PTY is reaped at the execute→in-review handoff.
 * - `needs-attention`— stall backstop, clean userExit mid-task, or auth failure.
 *                      The task does NOT advance and is NOT a hard failure — it
 *                      needs a human.
 * - `killed`         — hard cancel / column exit SIGKILL'd the PTY. Never resume-
 *                      eligible; the task left in-progress.
 * - `user-exited`    — the child exited cleanly mid-task (no done). Surfaced as
 *                      needs-attention by the caller, but recorded precisely.
 * - `auth-failed`    — credential failure; needs re-authentication.
 */
export type CliTaskOutcomeKind =
  | "success"
  | "ccc-native-held-closed"
  | "needs-attention"
  | "killed"
  | "user-exited"
  | "auth-failed";

export interface CliTaskOutcome {
  kind: CliTaskOutcomeKind;
  /** The CLI session id this outcome belongs to. */
  sessionId: string;
  /** Termination reason recorded on the session record, when the session ended. */
  terminationReason: CliTerminationReason | null;
  /** Manager-issued one-shot CCC native CLI closure receipt, when this is a held close. */
  nativeCliHeldClosureReceipt?: CccNativeCliHeldClosureReceipt;
}

// ── Resolved executor config (snapshotted at launch) ───────────────────────────

/**
 * The cli-agent executor config resolved for ONE launch. A snapshot: the caller
 * resolves node config (+ any per-task override) before launch and hands it here;
 * a later edit to the node config does not affect this live session.
 */
export interface ResolvedCliExecutorConfig {
  /** Adapter id to drive the session (resolved against the registry). */
  cliAdapterId: string;
  /** Autonomy posture (drives privileged flags + resume caps). */
  cliAutonomy?: CliAutonomyPosture | null;
  /** Notification settings forwarded to waiting-on-input dispatch (opaque here). */
  cliNotify?: Record<string, unknown> | null;
  /** Adapter launch settings (model, command override, extra args, …). */
  settings?: Record<string, unknown>;
  /**
   * Per-adapter operator launch config (U15), resolved from
   * `GlobalSettings.cliAgents[adapterId]`. Drives elevation detection + the
   * approval gate, and is folded into the adapter launch settings at spawn.
   */
  cliAgentSettings?: CliAgentResolveSettings | null;
}

// ── Launch options ─────────────────────────────────────────────────────────────

export interface LaunchCliTaskSessionOptions {
  /** Owning task id. */
  taskId: string;
  /** Project the task/session belongs to. */
  projectId: string;
  /** The task worktree (PTY cwd). Required — a write-capable CLI must not run at root. */
  worktreePath: string;
  /** The prompt to inject after readiness. */
  prompt: string;
  /** Resolved (snapshotted) executor config. */
  config: ResolvedCliExecutorConfig;
  /** Production-resolved MCP definitions for the effective ccc agent identity. */
  mcpServers?: readonly ResolvedMcpServerDefinition[];
  /** Engine-owned PTY session manager (U2). */
  manager: CliSessionManager;
  /** In-process telemetry hub (U3) — mints the hook token + owns the state machine. */
  hub: TelemetryHub;
  /** Adapter registry (U2) — to read capabilities for the wiring decisions. */
  registry: CliAdapterRegistry;
  /**
   * Absolute URL of the dashboard hook ingestion endpoint the hook scripts POST
   * to (e.g. `http://127.0.0.1:4040/api/cli-agent/hooks`). The engine has no HTTP
   * server; the dashboard serves this route (U17).
   */
  hookEndpointUrl: string;
  /**
   * Test/override seam for the hook scratch dir root. Defaults to the OS temp
   * dir; production callers may scope it under the engine's runtime dir.
   */
  hookDirRoot?: string;
  /**
   * Per-project autonomy-approval lookup (U15). Backs the elevation approval
   * gate: when the resolved effective posture is elevated and this returns false,
   * launch fails with a typed `CliAutonomyNotApprovedError` (never a stall).
   * When omitted, an elevated posture fails closed (treated as unapproved).
   */
  isAutonomyApproved?: AutonomyApprovalLookup;
  /**
   * Optional logger for lifecycle breadcrumbs. Best-effort; never throws.
   */
  log?: (msg: string) => void;
  /** Exact frozen CCC campaign one-shot policy, present only for fenced native CLI dispatch. */
  cccNativeCli?: CccNativeCliSessionPolicy;
}

// ── CliTaskSession ─────────────────────────────────────────────────────────────

/**
 * A live task-bound CLI session. Holds the launch-time config snapshot, resolves
 * `result()` on a terminal state-machine signal, and exposes `confirmAdvance()`
 * (generic tier), `followUp()` (done-task resume), and `reap()`/`kill()`.
 */
export class CliTaskSession {
  readonly taskId: string;
  readonly sessionId: string;
  readonly config: ResolvedCliExecutorConfig;

  private readonly manager: CliSessionManager;
  private readonly hub: TelemetryHub;
  private readonly registry: CliAdapterRegistry;
  private readonly hookDir: string;
  private readonly hookEndpointUrl: string;
  private readonly log: (msg: string) => void;
  private readonly cccNativeCli: LaunchCliTaskSessionOptions["cccNativeCli"];
  private readonly cccNativeCliReleaseCompletion: Promise<void> | null;
  private resolveCccNativeCliRelease: (() => void) | null = null;

  private settled = false;
  private resolveResult!: (outcome: CliTaskOutcome) => void;
  private resultPromise: Promise<CliTaskOutcome>;
  private unsubscribe: (() => void) | null = null;

  private constructor(args: {
    taskId: string;
    sessionId: string;
    config: ResolvedCliExecutorConfig;
    manager: CliSessionManager;
    hub: TelemetryHub;
    registry: CliAdapterRegistry;
    hookDir: string;
    hookEndpointUrl: string;
    log: (msg: string) => void;
    cccNativeCli: LaunchCliTaskSessionOptions["cccNativeCli"];
  }) {
    this.taskId = args.taskId;
    this.sessionId = args.sessionId;
    this.config = args.config;
    this.manager = args.manager;
    this.hub = args.hub;
    this.registry = args.registry;
    this.hookDir = args.hookDir;
    this.hookEndpointUrl = args.hookEndpointUrl;
    this.log = args.log;
    this.cccNativeCli = args.cccNativeCli;
    this.cccNativeCliReleaseCompletion = this.cccNativeCli
      ? new Promise<void>((resolve) => {
          this.resolveCccNativeCliRelease = resolve;
        })
      : null;
    this.resultPromise = new Promise<CliTaskOutcome>((resolve) => {
      this.resolveResult = resolve;
    });
  }

  /**
   * Launch a fresh CLI session for the task. Spawns in the worktree, writes the
   * hook scripts + issues the hub token, injects the prompt after readiness, and
   * subscribes to the state machine. Throws `CliConcurrencyLimitError` at the
   * pool ceiling (the caller surfaces it as a queued/rejected task state).
   */
  static async launch(opts: LaunchCliTaskSessionOptions): Promise<CliTaskSession> {
    const log = opts.log ?? (() => {});
    const adapter = opts.registry.get(opts.config.cliAdapterId);

    // 0. Assemble and validate the complete launch settings before posture
    // evaluation or any scratch/session/PTY side effect. The production-resolved
    // MCP set is authoritative when supplied by the executor. Non-ccc profiles
    // retain their pre-Wave behavior and do not receive native MCP settings.
    const cliAgentSettings = opts.config.cliAgentSettings ?? null;
    const operatorEnvAdditions = (cliAgentSettings?.envAdditions ?? []).filter(
      (key) => !/^FUSION_/i.test(key),
    );
    const priorAllowlist = Array.isArray(
      (opts.config.settings as Record<string, unknown> | undefined)?.envAllowlist,
    )
      ? ((opts.config.settings as Record<string, unknown>).envAllowlist as string[])
      : [];
    const expandedSettings = applyCccNativeMcpPolicy({
      ...(opts.config.settings ?? {}),
      ...(opts.mcpServers !== undefined
        ? { mcpServers: [...opts.mcpServers] }
        : {}),
      ...(cliAgentSettings?.commandOverride
        ? { command: cliAgentSettings.commandOverride }
        : {}),
      ...(cliAgentSettings?.extraArgs && cliAgentSettings.extraArgs.length > 0
        ? { extraArgs: [...cliAgentSettings.extraArgs] }
        : {}),
      envAllowlist: [...new Set([...priorAllowlist, ...operatorEnvAdditions])],
    });

    // 1. Autonomy approval gate (U15). Resolve the EFFECTIVE posture from the
    // exact validated launch settings + env additions and enforce the per-project
    // approval for any elevation. A missing lookup fails closed.
    const effectivePosture: EffectivePosture = await assertAutonomyApproved({
      adapter,
      settings: opts.config.cliAgentSettings ?? null,
      launchSettings: expandedSettings,
      nodeConfig: { cliAutonomy: opts.config.cliAutonomy ?? null },
      projectId: opts.projectId,
      isApproved: opts.isAutonomyApproved ?? (() => false),
    });

    // 2. Scratch dir for the session-scoped hook scripts + settings.
    const root = opts.hookDirRoot ?? tmpdir();
    const hookDir = await mkdtemp(join(root, "fusion-cli-hooks-"));

    // We cannot write the hook scripts until we have a session id (the scripts
    // embed it), and we cannot get a session id without spawning. So: spawn FIRST
    // with a settings shape that points at the (deterministic) script paths, then
    // write the scripts before readiness (the agent only invokes a hook once it is
    // up — readiness gates the first prompt injection, and the SessionStart hook
    // fires around the same time). To avoid a race we write the scripts as part of
    // launch, immediately after spawn, before injecting.
    const hookScriptPath = join(hookDir, HOOK_SCRIPT_NAMES.hook);
    const notifyScriptPath = join(hookDir, HOOK_SCRIPT_NAMES.notify);
    const settingsPath = join(hookDir, "settings.json");

    // Build adapter launch settings carrying the hook-script refs. Claude's
    // settings flow reads `hookScripts` + `settingsPath`; Codex reads the
    // deterministic `notifyProgram` path and emits it as a session-scoped
    // `-c notify=[...]` override. The scripts are written immediately after
    // spawn, before the first prompt is injected.
    const settings: Record<string, unknown> = {
      ...expandedSettings,
      notifyProgram: notifyScriptPath,
      hookScripts: {
        stopScript: hookScriptPath,
        notificationScript: hookScriptPath,
        permissionScript: hookScriptPath,
        sessionStartScript: hookScriptPath,
        toolActivityScript: hookScriptPath,
      },
      settingsPath,
    };

    // 3. Spawn (reserves the concurrency slot; throws CliConcurrencyLimitError at
    // the ceiling). The record is created with state "starting".
    let record: CliSession;
    try {
      record = await opts.manager.spawn({
        adapterId: opts.config.cliAdapterId,
        projectId: opts.projectId,
        purpose: "execute",
        taskId: opts.taskId,
        worktreePath: opts.worktreePath,
        // Denormalize the EFFECTIVE posture (derived from resolved argv+env) onto
        // the session record so the posture chip reflects the real launch
        // posture, not the autonomy field alone. The autonomy intent fields are
        // preserved (buildLaunch still reads `autoApprove`).
        posture: {
          ...(opts.config.cliAutonomy ?? {}),
          // `autonomyMode: "elevated"` is an alternate channel to the field; map
          // it onto `autoApprove` so the adapter's buildLaunch emits the
          // privileged flags (it keys off `posture.autoApprove`).
          ...(cliAgentSettings?.autonomyMode === "elevated"
            ? { autoApprove: true }
            : {}),
          effectivePosture: {
            mode: effectivePosture.mode,
            elevated: effectivePosture.elevated,
            flags: effectivePosture.flags,
          },
        },
        settings,
        ...(opts.cccNativeCli ? { cccNativeCliPolicy: opts.cccNativeCli } : {}),
      });
    } catch (err) {
      // Clean up the scratch dir we created before re-throwing (ceiling / spawn).
      await cleanupSessionHookDir(hookDir).catch(() => {});
      throw err;
    }

    // 4. Mint the per-session hook token + write the hook scripts.
    const token = opts.hub.issueToken(record.id);
    await writeSessionHookScripts({
      sessionId: record.id,
      token,
      endpointUrl: opts.hookEndpointUrl,
      dir: hookDir,
    });

    const session = new CliTaskSession({
      taskId: opts.taskId,
      sessionId: record.id,
      config: opts.config,
      manager: opts.manager,
      hub: opts.hub,
      registry: opts.registry,
      hookDir,
      hookEndpointUrl: opts.hookEndpointUrl,
      log,
      cccNativeCli: opts.cccNativeCli,
    });

    // 5. Subscribe to the authoritative state machine BEFORE injecting so a fast
    // done is never missed.
    session.subscribe();
    if (opts.cccNativeCli) void session.waitForCccNativeCliHeldClosure();

    // 6. Inject the prompt after readiness (fire-and-forget; readiness gates it).
    void session.injectAfterReady(opts.prompt, adapter.capabilities.nativeDone);

    log(`cli-task-session ${record.id}: launched for task ${opts.taskId} (adapter ${opts.config.cliAdapterId})`);
    return session;
  }

  /** The terminal outcome promise (R20 gating). */
  result(): Promise<CliTaskOutcome> {
    return this.resultPromise;
  }

  /** Whether the session has reached a terminal outcome. */
  get isSettled(): boolean {
    return this.settled;
  }

  /**
   * Operator confirm-advance for the generic heuristic tier (origin R20). The
   * generic tier NEVER auto-advances on idle — this is the ONLY positive
   * completion path for an adapter without a native done signal. Resolves the
   * result as success (so the caller advances the pipeline). A no-op once settled.
   */
  confirmAdvance(): void {
    if (this.settled) return;
    this.log(`cli-task-session ${this.sessionId}: confirm-advance (generic tier)`);
    this.finish({ kind: "success", sessionId: this.sessionId, terminationReason: "completed" });
  }

  /**
   * Follow up a DONE task by resuming the recorded native session id (when the
   * adapter supports resume). Returns true when a resume was driven; false when
   * resume is unsupported / no native id / the session is not live — the caller
   * should then launch a fresh session.
   *
   * This injects the follow-up prompt; it does NOT relaunch the PTY. When the PTY
   * has been reaped, resume is the caller's job (relaunch via the manager with the
   * adapter's buildResume); here we only handle the still-live case + report
   * resume capability.
   */
  async followUp(prompt: string): Promise<boolean> {
    if (this.cccNativeCli) return false;
    const adapter = this.registry.get(this.config.cliAdapterId);
    if (!adapter.capabilities.supportsResume) return false;
    if (!this.manager.isLive(this.sessionId)) return false;
    // The native-MCP proxy owns durable effect turns. Advance it before changing
    // task state or injecting so a failed close/open cannot leak a follow-up
    // prompt onto the prior turn.
    await this.manager.beginFollowUpTurn(this.sessionId);
    // Live + resumable: a follow-up is just another injection on the live PTY.
    // Re-arm the result promise so the next done resolves it again.
    if (this.settled) this.rearm();
    this.subscribe();
    // Drive the authoritative state machine done→busy BEFORE injecting. If we
    // leave it parked in `done`, the next native done is idempotent (no state
    // change emitted), so onMachineState("done") never fires and the re-armed
    // result promise never resolves. The hub swallows signalBusy-from-done, so
    // we transition via the machine's followUp()/injectPrompt directly.
    const machine = this.hub.getStateMachine(this.sessionId);
    if (machine) {
      try {
        if (machine.getState() === "done") machine.followUp();
        else if (machine.getState() === "ready" || machine.getState() === "resuming") {
          machine.injectPrompt();
        }
      } catch {
        // best-effort transition
      }
    }
    await this.manager.inject(this.sessionId, prompt);
    this.log(`cli-task-session ${this.sessionId}: follow-up injected (live resume)`);
    return true;
  }

  /**
   * Reap the PTY at the execute→in-review handoff. Graceful first (the manager's
   * kill is a scoped SIGKILL — node-pty has no graceful-then-kill ladder, so this
   * is the single reap), recording `completed` (the task advanced on a positive
   * done). Cleans up the hook dir + invalidates the token.
   */
  async reap(): Promise<void> {
    await this.manager.kill(this.sessionId, "completed");
    await this.teardown();
    this.log(`cli-task-session ${this.sessionId}: reaped at handoff`);
  }

  /**
   * Hard-cancel kill: SIGKILL the PTY and mark `killed` (never resume-eligible).
   * Used by the abort/hard-cancel path. Idempotent. Resolves a pending result as
   * `killed`.
   */
  async kill(reason: CliTerminationReason = "killed"): Promise<void> {
    if (this.cccNativeCli && reason === "killed") {
      await this.manager.closeCccNativeCliSession(this.sessionId, "cancel");
      await this.waitForCccNativeCliHeldClosure();
      await this.cccNativeCliReleaseCompletion;
      return;
    }
    await this.manager.kill(this.sessionId, reason);
    await this.teardown();
    if (!this.settled) {
      this.finish({ kind: "killed", sessionId: this.sessionId, terminationReason: reason });
    }
    this.log(`cli-task-session ${this.sessionId}: killed (${reason})`);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private subscribe(): void {
    // Re-subscribe is safe: drop the prior subscription first.
    this.unsubscribe?.();
    const machine = this.hub.getStateMachine(this.sessionId);
    if (!machine) {
      // No machine (hub never registered the session, e.g. it died pre-token).
      // Fall back to a settled-on-not-live check on the next tick.
      return;
    }
    this.unsubscribe = machine.onStateChange((change) => {
      this.onMachineState(change.state, change.terminationReason);
    });
  }

  private onMachineState(state: CliMachineState, reason: CliTerminationReason | null): void {
    if (this.settled) return;
    switch (state) {
      case "done":
        if (this.cccNativeCli) {
          void this.closeCccNativeCli("done");
          break;
        }
        this.finish({ kind: "success", sessionId: this.sessionId, terminationReason: "completed" });
        break;
      case "needsAttention":
        this.finish({
          kind: reason === "authFailed" ? "auth-failed" : reason === "userExited" ? "user-exited" : "needs-attention",
          sessionId: this.sessionId,
          terminationReason: reason,
        });
        break;
      case "dead":
        // A dead landing carrying a terminal reason that doesn't escalate on its
        // own (killed). authFailed/userExited transition on through
        // escalateToNeedsAttention; killed is terminal here.
        if (reason === "killed") {
          this.finish({ kind: "killed", sessionId: this.sessionId, terminationReason: reason });
        } else if (reason === "authFailed") {
          this.finish({ kind: "auth-failed", sessionId: this.sessionId, terminationReason: reason });
        } else if (reason === "userExited") {
          this.finish({ kind: "user-exited", sessionId: this.sessionId, terminationReason: reason });
        }
        // crashed/engineDeath land as `resuming` (not `dead`) — left for U8.
        break;
      // `idle` (generic tier) NEVER resolves — confirmAdvance() is the only path.
      // busy / ready / waitingOnInput / resuming are non-terminal: keep waiting.
      default:
        break;
    }
  }

  private async injectAfterReady(prompt: string, _nativeDone: boolean): Promise<void> {
    try {
      await this.manager.waitForReady(this.sessionId);
    } catch {
      // Session may have died before readiness — the state machine / exit handler
      // resolves the result; nothing to inject.
      return;
    }
    if (this.settled) return;
    // Arm the authoritative machine before exposing prompt bytes to the child.
    // A fast native adapter can emit `done` from inside manager.inject(); if the
    // machine is still `starting` or `ready`, that valid completion is rejected
    // as an invalid transition and the campaign waits until its deadline.
    const machine = this.hub.getStateMachine(this.sessionId);
    if (machine) {
      try {
        if (machine.getState() === "starting") machine.markReady();
        if (machine.getState() === "ready") machine.injectPrompt();
      } catch {
        // best-effort transition
      }
    }
    try {
      await this.manager.inject(this.sessionId, prompt);
      // HTD: "ready → busy: prompt injected". The task-session is the component
      // that injects, so it drives the ready→busy transition on the authoritative
      // machine. The manager's PTY-output readiness is the fallback readiness
      // signal (per the adapter contract); when the native SessionStart hook has
      // not yet landed the machine may still be `starting`, so the transition is
      // pre-armed above. Native adapters that also emit `busy` telemetry are
      // idempotent here (signalBusy from busy re-arms the watchdog).
      this.log(`cli-task-session ${this.sessionId}: prompt injected after readiness`);
    } catch {
      // Inject can fail if the session died mid-readiness — the terminal handler
      // resolves the outcome.
    }
  }

  private finish(outcome: CliTaskOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.resolveResult(outcome);
  }

  private async closeCccNativeCli(trigger: CccNativeCliHeldClosureTrigger): Promise<void> {
    try {
      await this.manager.closeCccNativeCliSession(this.sessionId, trigger);
    } catch {
      if (!this.settled) {
        this.finish({ kind: "needs-attention", sessionId: this.sessionId, terminationReason: null });
      }
    }
  }

  /** Return the one manager-issued held outcome; this never initiates closure. */
  async waitForCccNativeCliHeldClosure(): Promise<CliTaskOutcome> {
    if (!this.cccNativeCli) return this.result();
    try {
      const receipt = await this.manager.waitForCccNativeCliHeldClosure(this.sessionId);
      const outcome: CliTaskOutcome = {
        kind: "ccc-native-held-closed",
        sessionId: this.sessionId,
        terminationReason: null,
        nativeCliHeldClosureReceipt: receipt,
      };
      this.finish(outcome);
      return outcome;
    } catch {
      const outcome: CliTaskOutcome = { kind: "needs-attention", sessionId: this.sessionId, terminationReason: null };
      this.finish(outcome);
      return outcome;
    }
  }

  async releaseCccNativeCli(receipt: CccNativeCliHeldClosureReceipt, terminalScope: CccProviderAttemptScope): Promise<void> {
    await this.manager.releaseCccNativeCliSession(receipt, terminalScope);
    await this.teardown();
    this.resolveCccNativeCliRelease?.();
    this.log(`cli-task-session ${this.sessionId}: released CCC native CLI held slot`);
  }

  /** Re-open the result promise for a follow-up turn. */
  private rearm(): void {
    this.settled = false;
    // A new promise so a fresh `result()` call awaits the next turn.
    this.resultPromise = new Promise<CliTaskOutcome>((resolve) => {
      this.resolveResult = resolve;
    });
  }

  private async teardown(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    try {
      this.hub.flush(this.sessionId);
    } catch {
      // best-effort
    }
    this.hub.invalidate(this.sessionId);
    await cleanupSessionHookDir(this.hookDir).catch(() => {});
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Launch a fresh CLI task session (thin wrapper over the static factory). */
export function launchCliTaskSession(
  opts: LaunchCliTaskSessionOptions,
): Promise<CliTaskSession> {
  return CliTaskSession.launch(opts);
}

/**
 * Kill any prior LIVE CLI session(s) for a task before a fresh re-entry launch
 * (needs-replan / RETHINK context reset). Marks them `killed` (never resume-
 * eligible). Best-effort: a dead/missing session is a no-op. Returns the count
 * of sessions killed.
 */
export async function killLiveTaskSessions(
  taskId: string,
  manager: CliSessionManager,
  store: { listByTask(taskId: string): CliSession[] },
): Promise<number> {
  let killed = 0;
  for (const record of store.listByTask(taskId)) {
    if (manager.isLive(record.id)) {
      await manager.kill(record.id, "killed");
      killed += 1;
    }
  }
  return killed;
}

/** Clean up a hook scratch dir (re-exported for callers managing dirs directly). */
export async function cleanupCliHookDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
