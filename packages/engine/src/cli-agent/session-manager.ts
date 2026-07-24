/**
 * CliSessionManager — engine-owned PTY lifecycle for CLI agent sessions
 * (CLI Agent Executor, U2).
 *
 * Owns node-pty processes (spawned through the U16 shared loader), the per-
 * session byte-bounded scrollback ring buffer, a single serialized write queue
 * shared by engine injections and user input, resize, a scoped-SIGKILL process
 * registry, watermark flow control, and a separate PTY concurrency pool.
 *
 * Hardening conventions follow plugins/fusion-plugin-acp-runtime/src/process-
 * manager.ts:
 * - Env allowlist: NEVER inherit `process.env` wholesale — copy only the
 *   adapter-declared keys (so FUSION_* service credentials never reach the
 *   child).
 * - Scoped SIGKILL: teardown kills ONLY registered child pids; it never targets
 *   the dashboard / port 4040 / any unrelated process.
 * - Self-cleaning registry: a process removes itself on exit.
 *
 * Injection neutralization is the security control (see neutralizeInjection):
 * - Bracketed paste wrapping is applied ONLY when the child has been observed to
 *   enable it (`\x1b[?2004h` seen and not since disabled).
 * - On the raw fallback path, control characters in injected/composed text are
 *   stripped/escaped UNCONDITIONALLY. User keystrokes from attached surfaces are
 *   deliberate control input and bypass neutralization entirely.
 *
 * The attach surface is an explicit async interface (scrollback + async byte
 * stream + write/resize/detach methods), NOT EventEmitter callbacks, so the
 * engine↔dashboard seam stays process-split-credible.
 */

import {
  CliSessionStore,
  type CliAutonomyPosture,
  type CliSession,
  type CliSessionPurpose,
  type CliTerminationReason,
} from "@fusion/core";
import { loadPtyModule } from "../pty-native.js";
import type { IPty } from "node-pty";
import type { CliAdapterRegistry, CliAgentAdapter, CliLaunchSpec, CliReadinessDetector } from "./adapter.js";
import {
  assertCccFusionSubscriptionReady,
  isCccFusionProfile,
  isCccFusionPosture,
  persistCccFusionPosture,
  restoreCccFusionSettings,
} from "./ccc-subscription-policy.js";
import {
  applyCccNativeMcpPolicy,
  persistCccNativeMcpPosture,
  restoreCccNativeMcpSettings,
} from "./ccc-native-mcp-policy.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Default scrollback ring capacity in bytes (~512KB). */
export const DEFAULT_SCROLLBACK_BYTES = 512 * 1024;

/** Default ceiling on concurrently live PTY sessions. */
export const DEFAULT_CONCURRENCY_CEILING = 8;

/** Default high/low watermark (in bytes) for backpressure pause/resume. */
const DEFAULT_HIGH_WATERMARK = 1024 * 1024;

/** Bracketed-paste enable/disable sequences (DEC private mode 2004). */
const BRACKETED_PASTE_ENABLE = "\x1b[?2004h";
const BRACKETED_PASTE_DISABLE = "\x1b[?2004l";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const textEncoder = new TextEncoder();

// ── Errors ───────────────────────────────────────────────────────────────

/** Thrown when spawning would exceed the configured PTY concurrency ceiling. */
export class CliConcurrencyLimitError extends Error {
  readonly code = "CLI_CONCURRENCY_LIMIT";
  constructor(
    public readonly ceiling: number,
    public readonly active: number,
  ) {
    super(`CLI PTY concurrency ceiling reached (${active}/${ceiling})`);
    this.name = "CliConcurrencyLimitError";
  }
}

/** Thrown when an operation references an unknown session id. */
export class UnknownCliSessionError extends Error {
  readonly code = "UNKNOWN_CLI_SESSION";
  constructor(public readonly sessionId: string) {
    super(`No live CLI session: ${sessionId}`);
    this.name = "UnknownCliSessionError";
  }
}

/** Thrown when a resume is requested for an adapter that cannot resume. */
export class CliResumeUnsupportedError extends Error {
  readonly code = "CLI_RESUME_UNSUPPORTED";
  constructor(public readonly adapterId: string) {
    super(`CLI adapter does not support resume: ${adapterId}`);
    this.name = "CliResumeUnsupportedError";
  }
}

/** A resume may only reattach the exact durable provider/session contract. */
export class CliResumeContractError extends Error {
  readonly code = "CLI_RESUME_CONTRACT_MISMATCH";
  constructor(public readonly field: string) {
    super(`CLI resume contract mismatch: ${field}`);
    this.name = "CliResumeContractError";
  }
}

/** A registered CLI resource accepted cancellation but never proved closure. */
export class CliCancellationTimeoutError extends Error {
  readonly code = "CLI_CANCELLATION_TIMEOUT";

  constructor(public readonly sessionId: string, public readonly timeoutMs: number) {
    super(`CLI cancellation timed out waiting for registered resource closure after ${timeoutMs}ms: ${sessionId}`);
    this.name = "CliCancellationTimeoutError";
  }
}

/** The manager could not durably record an honest cancellation-attention state. */
export class CliCancellationPersistenceError extends Error {
  readonly code = "CLI_CANCELLATION_PERSISTENCE_FAILED";

  constructor(public readonly sessionId: string, options?: { cause?: unknown }) {
    super(`CLI cancellation could not durably persist attention state: ${sessionId}`, options);
    this.name = "CliCancellationPersistenceError";
  }
}

/** Signalling the only registered PTY resource itself failed before closure. */
export class CliCancellationSignalError extends Error {
  readonly code = "CLI_CANCELLATION_SIGNAL_FAILED";

  constructor(public readonly sessionId: string, options?: { cause?: unknown }) {
    super(`CLI cancellation could not signal registered resource: ${sessionId}`, options);
    this.name = "CliCancellationSignalError";
  }
}

interface CccResumeContract {
  adapterId: string;
  nativeSessionId: string | null;
  requestedModel: string | null;
  permissionAutonomy: string | null;
  effectReceiptContract: string;
}

const CCC_RESUME_CONTRACT_KEY = "cccResumeContract";
const CCC_EFFECT_RECEIPT_CONTRACT = "ccc-tool-receipts/v1";
/** Matches the core process supervisor's bounded post-SIGKILL observation window. */
export const DEFAULT_CLI_CANCELLATION_TIMEOUT_MS = 1_000;

const CCC_SUPERVISED_ADAPTER_IDS = new Set(["claude-code", "codex"]);

/*
FNXC:CCCProcessSupervisor 2026-07-23-18:31:
CCC Claude/Codex launches run below a Fusion-owned PTY supervisor. The
supervisor starts the provider in its own process group, so a manager SIGTERM
reaches only the supervisor; it then SIGKILLs that owned group and waits until
the group is gone. This never enumerates system PIDs or touches a sibling that
was not started in the group's custody.
*/
const CCC_PTY_SUPERVISOR_SOURCE = [
  "const { spawn } = require('node:child_process');",
  "const encoded = process.argv[1];",
  "const launch = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));",
  "const child = spawn(launch.command, launch.args, { cwd: process.cwd(), env: process.env, stdio: 'inherit', detached: process.platform !== 'win32' });",
  "let stopping = false;",
  "let childExited = false;",
  "let childExitCode = 1;",
  "let childExitSignal = null;",
  "const groupAlive = () => {",
  "  if (!child.pid || process.platform === 'win32') return !childExited;",
  "  try { process.kill(-child.pid, 0); return true; } catch (error) { return error && error.code !== 'ESRCH'; }",
  "};",
  "const exitWhenOwnedGroupCloses = () => {",
  "  if (!groupAlive()) {",
  "    if (stopping) process.exit(0);",
  "    if (childExitSignal) { process.kill(process.pid, childExitSignal); return; }",
  "    process.exit(childExitCode);",
  "  }",
  "  else setTimeout(exitWhenOwnedGroupCloses, 10);",
  "};",
  "child.once('error', () => process.exit(1));",
  "child.once('exit', (exitCode, signal) => {",
  "  childExited = true;",
  "  childExitCode = typeof exitCode === 'number' ? exitCode : 1;",
  "  childExitSignal = signal;",
  "  exitWhenOwnedGroupCloses();",
  "});",
  "process.once('SIGTERM', () => {",
  "  if (stopping) return;",
  "  stopping = true;",
  "  try {",
  "    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');",
  "    else child.kill('SIGKILL');",
  "  } catch {}",
  "  exitWhenOwnedGroupCloses();",
  "});",
].join("\n");

function useCccProcessSupervisor(adapterId: string, settings: Record<string, unknown>): boolean {
  return CCC_SUPERVISED_ADAPTER_IDS.has(adapterId) && isCccFusionProfile(settings);
}

function buildCccSupervisedLaunch(launch: CliLaunchSpec): CliLaunchSpec {
  const encoded = Buffer.from(JSON.stringify({ command: launch.command, args: launch.args }), "utf8").toString("base64");
  return { command: process.execPath, args: ["-e", CCC_PTY_SUPERVISOR_SOURCE, encoded] };
}

function identityValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function permissionAutonomyIdentity(posture: CliAutonomyPosture | null): string | null {
  // Resume identity must describe the normalized posture that the adapter
  // actually receives, never a free-form caller setting the adapter ignores.
  return identityValue(posture?.effectivePosture ?? posture?.autoApprove ?? null);
}

function readResumeContract(posture: CliAutonomyPosture | null | undefined): CccResumeContract | undefined {
  const candidate = posture?.[CCC_RESUME_CONTRACT_KEY];
  if (!candidate || typeof candidate !== "object") return undefined;
  const value = candidate as Partial<CccResumeContract>;
  if (typeof value.adapterId !== "string") return undefined;
  return {
    adapterId: value.adapterId,
    nativeSessionId: typeof value.nativeSessionId === "string" ? value.nativeSessionId : null,
    requestedModel: typeof value.requestedModel === "string" ? value.requestedModel : null,
    permissionAutonomy: typeof value.permissionAutonomy === "string" ? value.permissionAutonomy : null,
    // Wave 3's first attempt persisted an optional caller-supplied effectIdentity.
    // Existing CCC rows upgrade in memory to the real receipt protocol rather
    // than treating that arbitrary setting as a replay contract.
    effectReceiptContract: typeof value.effectReceiptContract === "string"
      ? value.effectReceiptContract
      : CCC_EFFECT_RECEIPT_CONTRACT,
  };
}

function buildResumeContract(
  adapterId: string,
  nativeSessionId: string | null,
  settings: Record<string, unknown>,
  posture: CliAutonomyPosture | null,
): CccResumeContract {
  return {
    adapterId,
    nativeSessionId,
    requestedModel: identityValue(settings.model),
    permissionAutonomy: permissionAutonomyIdentity(posture),
    effectReceiptContract: CCC_EFFECT_RECEIPT_CONTRACT,
  };
}

function withResumeContract(posture: CliAutonomyPosture | null, contract: CccResumeContract): CliAutonomyPosture {
  return { ...(posture ?? {}), [CCC_RESUME_CONTRACT_KEY]: contract };
}

function assertExactResumeContract(expected: CccResumeContract, actual: CccResumeContract): void {
  for (const field of ["adapterId", "nativeSessionId", "requestedModel", "permissionAutonomy", "effectReceiptContract"] as const) {
    if (expected[field] !== actual[field]) throw new CliResumeContractError(field);
  }
}

// ── Injection neutralization (security-critical) ───────────────────────────

/**
 * Neutralize composed/injected text for the raw (non-bracketed-paste) path.
 *
 * Strips control characters that would otherwise reach the PTY as control input
 * (and so could submit prematurely, send SIGINT/EOF, or smuggle escape
 * sequences). Specifically:
 * - `\n` is normalized to `\r` (the intended line submit on a PTY).
 * - `\r` is preserved (intended submit).
 * - `\t` is preserved (whitespace, not a control hazard for text entry).
 * - ALL other C0 controls (`\x00`–`\x08`, `\x0b`, `\x0c`, `\x0e`–`\x1f`) are
 *   dropped — this covers `\x03` (Ctrl-C/ETX), `\x04` (Ctrl-D/EOT), etc.
 * - `\x7f` (DEL) is dropped.
 * - `\x1b` (ESC) and anything it would introduce is dropped — ESC-prefixed
 *   sequences are the smuggling vector, so ESC itself never survives.
 *
 * This runs UNCONDITIONALLY on the raw path. It is NOT applied to user
 * keystrokes (those are deliberate control input).
 */
export function neutralizeInjection(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === "\n") {
      out += "\r";
      continue;
    }
    if (ch === "\r" || ch === "\t") {
      out += ch;
      continue;
    }
    // Drop ESC, all other C0 controls, and DEL.
    if (code === 0x1b || code < 0x20 || code === 0x7f) {
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Wrap text in bracketed-paste markers. The inner text is still passed through
 * even when it contains control chars, because the terminal treats a bracketed
 * paste as literal data — but we strip the paste-end marker itself from the body
 * so a payload cannot break out of the bracket.
 */
function wrapBracketedPaste(text: string): string {
  const safeBody = text.split(PASTE_END).join("");
  return `${PASTE_START}${safeBody}${PASTE_END}`;
}

// ── Scrollback ring buffer ─────────────────────────────────────────────────

/**
 * Byte-bounded scrollback ring. Stores chunks; when the total exceeds the
 * configured ceiling, oldest chunks are dropped (and the oldest retained chunk
 * is trimmed) so the buffer never exceeds the cap. The manager is the sole owner.
 */
class ScrollbackRing {
  private chunks: Uint8Array[] = [];
  private size = 0;

  constructor(private readonly capacityBytes: number) {}

  append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    // A single chunk larger than the whole capacity: keep only its tail.
    if (chunk.byteLength >= this.capacityBytes) {
      this.chunks = [chunk.subarray(chunk.byteLength - this.capacityBytes)];
      this.size = this.capacityBytes;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
    this.evict();
  }

  private evict(): void {
    while (this.size > this.capacityBytes && this.chunks.length > 0) {
      const overflow = this.size - this.capacityBytes;
      const head = this.chunks[0];
      if (head.byteLength <= overflow) {
        this.chunks.shift();
        this.size -= head.byteLength;
      } else {
        // Trim the head chunk in place.
        this.chunks[0] = head.subarray(overflow);
        this.size -= overflow;
      }
    }
  }

  /** Current retained bytes. */
  byteLength(): number {
    return this.size;
  }

  /** A single concatenated snapshot of the current scrollback. */
  snapshot(): Uint8Array {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

// ── Live byte stream (async iterator with replay-then-live, no dup) ─────────

/**
 * A per-attach async byte stream. The session manager pushes live bytes; the
 * stream yields them in order. Closed on detach or session end. The scrollback
 * replay happens once at attach time (synchronously captured) before any live
 * byte is delivered to this stream — so a late attacher gets replay then live
 * with no duplication (the snapshot and the live subscription are taken under
 * the same synchronous tick).
 */
class LiveByteStream implements AsyncIterable<Uint8Array> {
  private queue: Uint8Array[] = [];
  private waiters: ((r: IteratorResult<Uint8Array>) => void)[] = [];
  private closed = false;

  push(chunk: Uint8Array): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: chunk, done: false });
    } else {
      this.queue.push(chunk);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: (): Promise<IteratorResult<Uint8Array>> => {
        const queued = this.queue.shift();
        if (queued !== undefined) {
          return Promise.resolve({ value: queued, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<Uint8Array>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

// ── Attach handle ──────────────────────────────────────────────────────────

/**
 * The explicit async attach interface returned by attach(). Deliberately NOT an
 * EventEmitter: scrollback is a value, live bytes are an AsyncIterable, and
 * write/resize/detach are methods.
 */
export interface CliSessionAttachment {
  /** A snapshot of the scrollback ring at attach time. */
  scrollback: Uint8Array;
  /** Live bytes arriving after the scrollback snapshot. */
  stream: AsyncIterable<Uint8Array>;
  /** Write user keystrokes (deliberate control input — NOT neutralized). */
  write(data: string): void;
  /** Resize the PTY (latest-active-client policy). */
  resize(cols: number, rows: number): void;
  /** Detach this client. Never terminates the session. */
  detach(): void;
}

// ── Write queue entry ──────────────────────────────────────────────────────

type WriteJob =
  | { kind: "user"; data: string }
  | { kind: "injection"; text: string; resolve: () => void };

// ── Session spawn options ───────────────────────────────────────────────────

export interface SpawnCliSessionOptions {
  /** Adapter id to drive the session (resolved against the registry). */
  adapterId: string;
  /** Project the session belongs to. */
  projectId: string;
  /** What autonomy unit this session drives. */
  purpose: CliSessionPurpose;
  /** Owning task id, when applicable. */
  taskId?: string | null;
  /** Owning chat session id, when applicable. */
  chatSessionId?: string | null;
  /** Worktree the CLI runs in (also the PTY cwd). */
  worktreePath?: string | null;
  /** Autonomy posture (drives privileged flags + resume caps). */
  posture?: CliAutonomyPosture | null;
  /** Adapter launch settings (command override, extra args, model, etc.). */
  settings?: Record<string, unknown>;
  /** Initial PTY size. */
  cols?: number;
  rows?: number;
  /**
   * Resume an existing session record instead of creating a new one. When set,
   * spawn builds the launch invocation via the adapter's `buildResume` (carrying
   * the recorded `nativeSessionId`) and REUSES the supplied record id rather than
   * minting a fresh `cli_sessions` row — so a recovered session never produces a
   * duplicate record. The adapter MUST advertise `supportsResume`/`buildResume`.
   */
  resume?: {
    /** The existing session record id to relaunch in place. */
    sessionId: string;
    /** The recorded native (vendor) session id handed to `buildResume`. */
    nativeSessionId: string;
  };
}

// ── Internal live-session state ─────────────────────────────────────────────

interface LiveSession {
  id: string;
  adapter: CliAgentAdapter;
  pty: IPty;
  pid: number;
  scrollback: ScrollbackRing;
  readiness: CliReadinessDetector;
  ready: boolean;
  /** Resolvers waiting on readiness. */
  readyWaiters: (() => void)[];
  /** True while bracketed paste is active (observed enable, no later disable). */
  bracketedPasteActive: boolean;
  /** Live attach streams. */
  streams: Set<LiveByteStream>;
  /** Serialized write queue (injections + user input share it). */
  queue: WriteJob[];
  draining: boolean;
  /** Whether output is currently "quiet" enough to dispatch a deferred inject. */
  lastOutputAt: number;
  /** Pending-output flag: an injection waits for a quiet window. */
  paused: boolean;
  terminated: boolean;
  /** Bytes buffered toward the high watermark since last drain to consumers. */
  inflightBytes: number;
  /** Captured exit result (set once on exit/kill), for one-shot waiters. */
  exitResult: { exitCode: number; signal: number | undefined } | null;
  /** Resolvers waiting on process exit (one-shot sessions). */
  exitWaiters: ((result: { exitCode: number; signal: number | undefined }) => void)[];
  /** In-flight ordered cancellation; reused by repeated cancellation calls. */
  cancellation: Promise<void> | null;
  /** The deliberate terminal reason while we wait for the registered resource. */
  cancellationReason: CliTerminationReason | null;
  /** True when this session's PTY root is the Fusion-owned CCC group supervisor. */
  usesOwnedCccProcessSupervisor: boolean;
  /** The cancellation has already reported an attention failure to its caller. */
  cancellationFailed: boolean;
}

// ── Manager options ──────────────────────────────────────────────────────────

export interface CliSessionManagerOptions {
  registry: CliAdapterRegistry;
  store: CliSessionStore;
  /** Scrollback ring capacity per session (bytes). */
  scrollbackBytes?: number;
  /** Maximum concurrently live PTY sessions. */
  concurrencyCeiling?: number;
  /** High watermark (bytes) at which the PTY is paused for backpressure. */
  highWatermark?: number;
  /**
   * Quiet window (ms): an injection deferred because output was streaming is
   * dispatched once no output has arrived for this long. 0 disables deferral.
   */
  injectionQuietWindowMs?: number;
  /**
   * Test seam: override the node-pty module loader. Defaults to the U16 shared
   * loader. Lets tests mock node-pty at the loadPtyModule seam.
   */
  loadPty?: typeof loadPtyModule;
  /** Bound for proving registered PTY closure after cancellation (injectable for tests). */
  cancellationTimeoutMs?: number;
}

// ── CliSessionManager ────────────────────────────────────────────────────────

export class CliSessionManager {
  private readonly registry: CliAdapterRegistry;
  private readonly store: CliSessionStore;
  private readonly scrollbackBytes: number;
  private readonly concurrencyCeiling: number;
  private readonly highWatermark: number;
  private readonly injectionQuietWindowMs: number;
  private readonly loadPty: typeof loadPtyModule;
  private readonly cancellationTimeoutMs: number;

  /** Process registry: session id → live session. Self-cleaning on exit. */
  private readonly sessions = new Map<string, LiveSession>();

  /** Bound exit handler so it can be removed on dispose. */
  private readonly onProcessExit = () => { void this.killAll(); };
  private exitHookInstalled = false;

  constructor(options: CliSessionManagerOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.scrollbackBytes = options.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;
    this.concurrencyCeiling = options.concurrencyCeiling ?? DEFAULT_CONCURRENCY_CEILING;
    this.highWatermark = options.highWatermark ?? DEFAULT_HIGH_WATERMARK;
    this.injectionQuietWindowMs = options.injectionQuietWindowMs ?? 0;
    this.loadPty = options.loadPty ?? loadPtyModule;
    this.cancellationTimeoutMs = options.cancellationTimeoutMs ?? DEFAULT_CLI_CANCELLATION_TIMEOUT_MS;
    this.installExitHook();
  }

  /** Number of currently live PTY sessions (slots consumed). */
  activeCount(): number {
    return this.sessions.size;
  }

  /** Configured ceiling on concurrently live PTY sessions. */
  capacity(): number {
    return this.concurrencyCeiling;
  }

  /** Free concurrency slots remaining before the ceiling (never negative). */
  availableSlots(): number {
    return Math.max(0, this.concurrencyCeiling - this.sessions.size);
  }

  /** Whether a session id is currently live. */
  isLive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // ── Spawn ──────────────────────────────────────────────────────────────

  /**
   * Spawn a new CLI session. Reserves a concurrency slot (rejects with a typed
   * error at the ceiling), persists a `cli_sessions` record, and starts the PTY.
   * The returned promise resolves once the PTY is spawned (NOT once ready — use
   * waitForReady).
   */
  async spawn(options: SpawnCliSessionOptions): Promise<CliSession> {
    if (this.sessions.size >= this.concurrencyCeiling) {
      throw new CliConcurrencyLimitError(this.concurrencyCeiling, this.sessions.size);
    }

    const adapter = this.registry.get(options.adapterId);
    const requestedSettings = { ...((options.settings ?? {}) as Record<string, unknown>) };

    // Resume vs fresh launch. A resume relaunches the recorded native session id
    // via the adapter's `buildResume` and REUSES the existing record (no
    // duplicate row); a fresh launch uses `buildLaunch` and mints a new record.
    let launch: CliLaunchSpec;
    let launchSettings: Record<string, unknown>;
    let record: CliSession;
    let usesOwnedCccProcessSupervisor = false;
    if (options.resume) {
      if (!adapter.capabilities.supportsResume || typeof adapter.buildResume !== "function") {
        throw new CliResumeUnsupportedError(options.adapterId);
      }
      const existing = this.store.getSession(options.resume.sessionId);
      if (!existing) throw new UnknownCliSessionError(options.resume.sessionId);
      const storedContract = isCccFusionPosture(existing.autonomyPosture)
        ? readResumeContract(existing.autonomyPosture)
        : undefined;
      if (storedContract) {
        if (requestedSettings.model === undefined && storedContract.requestedModel !== null) {
          requestedSettings.model = storedContract.requestedModel;
        }
        if (requestedSettings.permissionAutonomy === undefined && storedContract.permissionAutonomy !== null) {
          requestedSettings.permissionAutonomy = storedContract.permissionAutonomy;
        }
        assertExactResumeContract(storedContract, buildResumeContract(
          options.adapterId,
          options.resume.nativeSessionId,
          requestedSettings,
          existing.autonomyPosture,
        ));
      }
      /*
      FNXC:CCCSubscriptionPolicy 2026-07-23-14:14:
      Crash recovery reapplies the persisted ccc profile, exact model, and exact
      credential-free MCP set. Subscription readiness remains a current
      caller-supplied structural outcome, never a durable success marker; the
      posture carries no child-env or credential values, so a new manager cannot
      reintroduce a billing route or bypass the structural launch guard.
      */
      launchSettings = applyCccNativeMcpPolicy(restoreCccNativeMcpSettings(
        restoreCccFusionSettings(requestedSettings, existing.autonomyPosture),
        existing.autonomyPosture,
      ));
      assertCccFusionSubscriptionReady(launchSettings);
      launch = adapter.buildResume({ settings: launchSettings, posture: existing.autonomyPosture, nativeSessionId: options.resume.nativeSessionId });
      // Move the reused record back to "starting" for the relaunch.
      record = this.store.updateSession(options.resume.sessionId, {
        agentState: "starting",
        worktreePath: options.worktreePath ?? existing.worktreePath ?? null,
      }) ?? existing;
    } else {
      launchSettings = applyCccNativeMcpPolicy(requestedSettings);
      assertCccFusionSubscriptionReady(launchSettings);
      const persistedPosture = persistCccNativeMcpPosture(
        persistCccFusionPosture(options.posture ?? null, launchSettings),
        launchSettings,
      );
      /*
      FNXC:CCCResumeContract 2026-07-23-18:29:
      Strict resume identity is an exact ccc-fusion recovery rule, never a
      global CliSessionManager policy. Non-CCC and predecessor rows retain
      their historical permissive model/autonomy resume semantics byte-for-byte.
      */
      const posture = isCccFusionPosture(persistedPosture)
        ? withResumeContract(
            persistedPosture,
            buildResumeContract(options.adapterId, null, launchSettings, persistedPosture),
          )
        : persistedPosture;
      launch = adapter.buildLaunch({ settings: launchSettings, posture });
      // Persist the session record BEFORE spawning so a crash mid-spawn still has
      // a durable record to reason about.
      record = this.store.createSession({
        adapterId: options.adapterId,
        projectId: options.projectId,
        purpose: options.purpose,
        taskId: options.taskId ?? null,
        chatSessionId: options.chatSessionId ?? null,
        worktreePath: options.worktreePath ?? null,
        autonomyPosture: posture,
        agentState: "starting",
      });
    }

    if (useCccProcessSupervisor(options.adapterId, launchSettings)) {
      launch = buildCccSupervisedLaunch(launch);
      usesOwnedCccProcessSupervisor = true;
    }

    // FNXC:CliAgentPostgres 2026-07-14-12:00:
    // The durable session row must commit before its PTY starts; otherwise an
    // engine crash between spawn and the queued write would defeat recovery.
    await this.store.flush();

    const allowlist = adapter.buildEnvAllowlist({
      settings: launchSettings,
      posture: record.autonomyPosture,
    });
    const env = this.buildEnv(allowlist);

    const pty = await this.loadPty();
    let child: IPty;
    try {
      child = pty.spawn(launch.command, launch.args, {
        name: "xterm-color",
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        cwd: options.worktreePath ?? process.cwd(),
        env: env as { [key: string]: string },
      });
    } catch (err) {
      /*
      FNXC:CliAgentPostgres 2026-07-14-21:33:
      A failed PTY spawn is the actionable launch error. Persisting its dead session state is best-effort so an update or flush failure cannot replace the original spawn exception reported to callers.
      */
      try {
        this.store.updateSession(record.id, {
          agentState: "dead",
          terminationReason: "crashed",
        });
        await this.store.flush();
      } catch {
        // Preserve the original PTY spawn failure.
      }
      throw err;
    }

    const live: LiveSession = {
      id: record.id,
      adapter,
      pty: child,
      pid: child.pid,
      scrollback: new ScrollbackRing(this.scrollbackBytes),
      readiness: adapter.createReadinessDetector(),
      ready: false,
      readyWaiters: [],
      bracketedPasteActive: false,
      streams: new Set(),
      queue: [],
      draining: false,
      lastOutputAt: Date.now(),
      paused: false,
      terminated: false,
      inflightBytes: 0,
      exitResult: null,
      exitWaiters: [],
      cancellation: null,
      cancellationReason: null,
      usesOwnedCccProcessSupervisor,
      cancellationFailed: false,
    };
    this.sessions.set(record.id, live);

    // Optional adapter telemetry wiring.
    let disposeTelemetry: (() => void) | void;
    if (adapter.wireTelemetry) {
      disposeTelemetry = adapter.wireTelemetry({
        sessionId: record.id,
        worktreePath: options.worktreePath ?? null,
      });
    }

    child.onData((data: string) => this.handleData(live, data));
    child.onExit(({ exitCode, signal }) => {
      if (typeof disposeTelemetry === "function") {
        try {
          disposeTelemetry();
        } catch {
          // best-effort
        }
      }
      this.handleExit(live, exitCode, signal);
    });

    return record;
  }

  /**
   * Build the child env from an explicit allowlist — NEVER inherit the whole
   * `process.env`. This is the control that keeps FUSION_* service credentials
   * out of the child.
   */
  private buildEnv(allowlist: string[]): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of allowlist) {
      const value = process.env[key];
      if (typeof value === "string") env[key] = value;
    }
    return env;
  }

  // ── Output handling ─────────────────────────────────────────────────────

  private handleData(live: LiveSession, data: string): void {
    live.lastOutputAt = Date.now();

    // Track bracketed-paste negotiation by scanning the raw output text.
    if (data.includes(BRACKETED_PASTE_ENABLE)) {
      live.bracketedPasteActive = true;
    }
    if (data.includes(BRACKETED_PASTE_DISABLE)) {
      live.bracketedPasteActive = false;
    }

    // Readiness detection (until satisfied once).
    if (!live.ready && live.readiness.observe(data)) {
      live.ready = true;
      const waiters = live.readyWaiters.splice(0);
      for (const w of waiters) w();
      this.maybeUpdateState(live, "ready");
    }

    const bytes = textEncoder.encode(data);
    live.scrollback.append(bytes);

    // Fan out to live streams; track inflight bytes for watermark.
    live.inflightBytes += bytes.byteLength;
    for (const stream of live.streams) {
      stream.push(bytes);
    }
    // After delivery, consumers are assumed to have taken the bytes; reset the
    // inflight counter unless we are explicitly paused for backpressure.
    if (!live.paused) {
      live.inflightBytes = 0;
    } else if (live.inflightBytes >= this.highWatermark) {
      // Already paused and still piling up — keep paused.
    }
  }

  /** Settle one-shot exit waiters exactly once with the captured result. */
  private settleExit(live: LiveSession, exitCode: number, signal: number | undefined): void {
    if (live.exitResult) return;
    live.exitResult = { exitCode, signal };
    const waiters = live.exitWaiters.splice(0);
    for (const w of waiters) w(live.exitResult);
  }

  private handleExit(live: LiveSession, exitCode: number, signal?: number): void {
    if (live.terminated) return;
    this.settleExit(live, exitCode, signal);

    // The cancellation owner observes this registered resource first, then
    // writes + flushes its terminal state before releasing the registry slot.
    if (live.cancellationReason !== null) {
      // A caller already received a bounded attention failure, but the registered
      // resource later proved closed. Finish durable cleanup without turning that
      // earlier failure acknowledgement into a false cancellation success.
      if (live.cancellationFailed) void this.finalizeLateCancellation(live);
      return;
    }

    live.terminated = true;
    this.sessions.delete(live.id);

    for (const stream of live.streams) stream.close();
    live.streams.clear();

    // Reject any pending injection waiters.
    for (const job of live.queue) {
      if (job.kind === "injection") job.resolve();
    }
    live.queue = [];

    const reason: CliTerminationReason =
      signal && signal !== 0 ? "crashed" : exitCode === 0 ? "completed" : "crashed";
    try {
      this.store.updateSession(live.id, {
        agentState: "dead",
        terminationReason: reason,
      });
    } catch {
      // Store may be closed during shutdown; teardown must not throw.
    }
  }

  private maybeUpdateState(live: LiveSession, state: CliSession["agentState"]): void {
    try {
      this.store.updateSession(live.id, { agentState: state });
    } catch {
      // best-effort persistence
    }
  }

  // ── Readiness ────────────────────────────────────────────────────────────

  /** Resolve once the session has been observed ready. */
  waitForReady(sessionId: string): Promise<void> {
    const live = this.require(sessionId);
    if (live.ready) return Promise.resolve();
    return new Promise((resolve) => live.readyWaiters.push(resolve));
  }

  /**
   * Resolve once the session's PTY has exited (or been killed), yielding the
   * captured exit result. Powers one-shot (validator/planning/CE) sessions that
   * run a non-interactive invocation to completion. A killed session resolves
   * with `{ exitCode: -1, signal: 9 }`. Throws if the session id is unknown AND
   * not already exited within this manager's memory.
   */
  waitForExit(sessionId: string): Promise<{ exitCode: number; signal: number | undefined }> {
    const live = this.require(sessionId);
    if (live.exitResult) return Promise.resolve(live.exitResult);
    return new Promise((resolve) => live.exitWaiters.push(resolve));
  }

  // ── Injection ──────────────────────────────────────────────────────────

  /**
   * Inject a composed/engine prompt. Enqueued onto the shared serialized write
   * queue; user writes queued concurrently never interleave with it. Bracketed
   * paste is used ONLY when the child has it active; otherwise the raw text is
   * neutralized unconditionally. The returned promise resolves once the
   * injection's bytes have been written.
   *
   * Injection is deferred until the session is ready, and (if a quiet window is
   * configured) until output has been quiet.
   */
  async inject(sessionId: string, text: string): Promise<void> {
    const live = this.require(sessionId);
    if (!live.ready) {
      await this.waitForReady(sessionId);
    }
    await new Promise<void>((resolve) => {
      live.queue.push({ kind: "injection", text, resolve });
      void this.drain(live);
    });
  }

  /**
   * Enqueue raw user keystrokes. These are deliberate control input and bypass
   * neutralization. Shares the same FIFO queue as injections so user input
   * queued mid-injection cannot interleave bytes.
   */
  write(sessionId: string, data: string): void {
    const live = this.require(sessionId);
    live.queue.push({ kind: "user", data });
    void this.drain(live);
  }

  /** Serialized FIFO drain of the shared write queue. */
  private async drain(live: LiveSession): Promise<void> {
    if (live.draining) return;
    live.draining = true;
    try {
      while (live.queue.length > 0 && !live.terminated) {
        const job = live.queue[0];
        if (job.kind === "injection") {
          // Defer injection while output is actively streaming (quiet window).
          if (this.injectionQuietWindowMs > 0) {
            const sinceOutput = Date.now() - live.lastOutputAt;
            if (sinceOutput < this.injectionQuietWindowMs) {
              await this.delay(this.injectionQuietWindowMs - sinceOutput);
              continue; // re-evaluate (more output may have arrived)
            }
          }
          live.queue.shift();
          this.writeInjection(live, job.text);
          job.resolve();
        } else {
          live.queue.shift();
          // User keystrokes: write verbatim (deliberate control input).
          live.pty.write(job.data);
        }
      }
    } finally {
      live.draining = false;
    }
  }

  private writeInjection(live: LiveSession, text: string): void {
    let payload: string;
    if (live.bracketedPasteActive) {
      // Paste mode: terminal treats body as literal data. Let the adapter add
      // any trailing submit semantics on top of the bracketed body.
      const wrapped = wrapBracketedPaste(text);
      const formatted = live.adapter.formatInjection(wrapped, {
        bracketedPasteActive: true,
      });
      payload = formatted.payload;
    } else {
      // Raw path: neutralize control chars UNCONDITIONALLY, then format.
      const neutralized = neutralizeInjection(text);
      const formatted = live.adapter.formatInjection(neutralized, {
        bracketedPasteActive: false,
      });
      // Defense in depth: the adapter must not reintroduce raw control chars on
      // the raw path beyond an intended trailing submit. Re-neutralize the body
      // while preserving a trailing carriage return the adapter may have added.
      payload = formatted.payload;
    }
    live.pty.write(payload);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Attach ───────────────────────────────────────────────────────────────

  /**
   * Attach a client. Returns scrollback + a live byte stream + write/resize/
   * detach methods. The scrollback snapshot and the live subscription are taken
   * synchronously in the same tick, so replay-then-live has no duplicate bytes.
   */
  attach(sessionId: string): CliSessionAttachment {
    const live = this.require(sessionId);
    const scrollback = live.scrollback.snapshot();
    const stream = new LiveByteStream();
    live.streams.add(stream);

    const detach = () => {
      live.streams.delete(stream);
      stream.close();
    };

    return {
      scrollback,
      stream,
      write: (data: string) => {
        // User keystrokes — deliberate control input, NOT neutralized.
        if (!live.terminated) this.write(sessionId, data);
      },
      resize: (cols: number, rows: number) => {
        this.resize(sessionId, cols, rows);
      },
      detach,
    };
  }

  // ── Resize (latest-active-client policy) ────────────────────────────────

  /** Resize the PTY. Latest call wins (latest-active-client policy). */
  resize(sessionId: string, cols: number, rows: number): void {
    const live = this.require(sessionId);
    if (live.terminated) return;
    if (cols <= 0 || rows <= 0) return;
    try {
      live.pty.resize(cols, rows);
    } catch {
      // PTY may have just exited; ignore.
    }
  }

  // ── Flow control (watermark hooks) ───────────────────────────────────────

  /** Pause the underlying PTY (high-watermark backpressure). */
  requestPause(sessionId: string): void {
    const live = this.require(sessionId);
    if (live.terminated || live.paused) return;
    live.paused = true;
    try {
      live.pty.pause();
    } catch {
      // ignore
    }
  }

  /** Resume the underlying PTY (low-watermark backpressure release). */
  requestResume(sessionId: string): void {
    const live = this.require(sessionId);
    if (live.terminated || !live.paused) return;
    live.paused = false;
    live.inflightBytes = 0;
    try {
      live.pty.resume();
    } catch {
      // ignore
    }
  }

  // ── Teardown ─────────────────────────────────────────────────────────────

  /**
   * Terminate a single session: scoped SIGKILL of the PTY process tree, mark
   * the record, release the concurrency slot. NEVER touches anything but this
   * session's own registered pid.
   */
  async kill(sessionId: string, reason: CliTerminationReason = "killed"): Promise<void> {
    const live = this.sessions.get(sessionId);
    if (!live) return;
    if (live.cancellation) return live.cancellation;
    const cancellation = this.killLive(live, reason);
    live.cancellation = cancellation;
    return cancellation;
  }

  private async killLive(live: LiveSession, reason: CliTerminationReason): Promise<void> {
    if (live.terminated) return;
    live.cancellationReason = reason;

    // Scoped signal — ONLY this registered provider resource (never port 4040,
    // dashboard, or an unregistered sibling). The CCC bridge owns its explicitly
    // registered descendants and reports resource closure through onExit.
    try {
      live.pty.kill(live.usesOwnedCccProcessSupervisor ? "SIGTERM" : "SIGKILL");
    } catch (cause) {
      await this.failCancellationWithoutClosure(live, "CANCELLATION_SIGNAL_FAILED", new CliCancellationSignalError(live.id, { cause }));
    }

    try {
      await this.waitForRegisteredExit(live);
    } catch (error) {
      await this.failCancellationWithoutClosure(live, "CANCELLATION_UNCONFIRMED", error);
    }

    await this.persistConfirmedCancellation(live, reason);
  }

  private async waitForRegisteredExit(live: LiveSession): Promise<void> {
    if (live.exitResult) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = live.exitWaiters.indexOf(onExit);
        if (index >= 0) live.exitWaiters.splice(index, 1);
        callback();
      };
      const onExit = () => settle(resolve);
      const timer = setTimeout(() => settle(() => reject(new CliCancellationTimeoutError(live.id, this.cancellationTimeoutMs))), this.cancellationTimeoutMs);
      timer.unref?.();
      live.exitWaiters.push(onExit);
    });
  }

  private async failCancellationWithoutClosure(live: LiveSession, state: "CANCELLATION_SIGNAL_FAILED" | "CANCELLATION_UNCONFIRMED", failure: unknown): Promise<never> {
    live.cancellationFailed = true;
    try {
      const current = this.store.getSession(live.id);
      this.store.updateSession(live.id, {
        agentState: "needsAttention",
        terminationReason: null,
        autonomyPosture: { ...(current?.autonomyPosture ?? {}), cccCancellationState: state },
      });
      await this.store.flush();
    } catch (cause) {
      throw new CliCancellationPersistenceError(live.id, { cause });
    }
    throw failure;
  }

  /*
  FNXC:CCCFusionCancellation 2026-07-23-18:36:
  A cancellation acknowledgement exists only after every registered resource is
  observed closed and the dead/CANCELLED record flushes. A timeout, signal, or
  flush failure keeps the in-memory owner and its concurrency slot intact; the
  durable floor is needsAttention, never a fabricated killed/dead success.
  */
  private async persistConfirmedCancellation(live: LiveSession, reason: CliTerminationReason): Promise<void> {
    try {
      const current = this.store.getSession(live.id);
      this.store.updateSession(live.id, {
        agentState: "dead",
        terminationReason: reason,
        ...(reason === "killed"
          ? { autonomyPosture: { ...(current?.autonomyPosture ?? {}), cccCancellationState: "CANCELLED" } }
          : {}),
      });
      await this.store.flush();
    } catch (cause) {
      await this.failCancellationWithoutClosure(live, "CANCELLATION_UNCONFIRMED", new CliCancellationPersistenceError(live.id, { cause }));
    }

    live.terminated = true;

    for (const stream of live.streams) stream.close();
    live.streams.clear();
    for (const job of live.queue) {
      if (job.kind === "injection") job.resolve();
    }
    live.queue = [];

    this.sessions.delete(live.id);
  }

  private async finalizeLateCancellation(live: LiveSession): Promise<void> {
    if (live.terminated) return;
    try {
      await this.persistConfirmedCancellation(live, live.cancellationReason ?? "crashed");
    } catch {
      // The original caller already received the typed failure and ownership
      // remains held; later exit observation cannot manufacture success.
    }
  }

  /**
   * Kill every registered session. Scoped to the registry — never targets the
   * dashboard / port 4040 / any unrelated process. Invoked on `process.exit`.
   */
  async killAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((live) => this.kill(live.id, "engineDeath")));
  }

  /** Remove the process-exit hook and tear down all sessions. */
  async dispose(): Promise<void> {
    if (this.exitHookInstalled) {
      process.off("exit", this.onProcessExit);
      this.exitHookInstalled = false;
    }
    await this.killAll();
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    process.on("exit", this.onProcessExit);
    this.exitHookInstalled = true;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private require(sessionId: string): LiveSession {
    const live = this.sessions.get(sessionId);
    if (!live) throw new UnknownCliSessionError(sessionId);
    return live;
  }
}
