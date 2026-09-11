/**
 * Token usage capture for `codex exec --json` PTY streams (usage-lane).
 *
 * Verified live (codex-cli 0.147.0): each exec process emits ordered JSONL —
 * `thread.started`, `turn.started`, `item.completed`, then exactly one
 * `turn.completed` carrying `usage: {input_tokens, cached_input_tokens,
 * cache_write_input_tokens, output_tokens, reasoning_output_tokens}` — on the
 * merged PTY stream (a real PTY turns `\n` into `\r\n`; stderr text lines can
 * interleave with the JSON). `turn.completed.usage` is the codex THREAD's
 * RUNNING CUMULATIVE TOTAL, not the latest turn alone: after `codex exec
 * resume <id>` the reported total was turn-one-total + turn-two-total.
 * `reasoning_output_tokens` is already folded into `output_tokens`, and
 * `cached_input_tokens` into `input_tokens` — so the mapping is direct:
 * input_tokens -> inputTokens, output_tokens -> outputTokens. No event
 * carries model identity, so cost stays unknown (see executor.ts).
 */

import { decodeJsonObjectLine } from "./jsonl-line-scan.js";

/** A decoded, honest token count pair — matches CccProviderAttemptUsage's shape. */
export interface CodexExecTurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Cap on the trailing (not-yet-newline-terminated) line buffer, matching the
 * order of magnitude of the PTY scrollback ring's own cap (session-manager.ts
 * DEFAULT_SCROLLBACK_BYTES = 512 * 1024). Not just a memory bound: without a
 * cap, a pathological unterminated chunk would keep growing the buffer
 * forever, and the NEXT real newline-terminated line would get appended after
 * it with no separating "\n" of its own -- the merged blob then fails to
 * decode as JSON at all, silently losing the real turn.completed event.
 * Measured in UTF-16 code units (this module never sees raw bytes — node-pty
 * decodes to JS strings), a close-enough proxy for the byte-oriented cap it
 * mirrors.
 */
const MAX_TRAILING_LINE_BUFFER_CHARS = 512 * 1024;

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Decode a `turn.completed` event's usage field, or null when absent/malformed. */
function decodeTurnCompletedUsage(obj: Record<string, unknown>): CodexExecTurnUsage | null {
  if (obj.type !== "turn.completed") return null;
  const usage = obj.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const raw = usage as Record<string, unknown>;
  const inputTokens = raw.input_tokens;
  const outputTokens = raw.output_tokens;
  if (!isSafeNonNegativeInteger(inputTokens) || !isSafeNonNegativeInteger(outputTokens)) return null;
  return Object.freeze({ inputTokens, outputTokens });
}

/**
 * Streaming observer for `codex exec --json` PTY output. Feed raw PTY chunks
 * (arrival order) via {@link observe}; {@link usage} always reflects the
 * usage carried by the LAST `turn.completed` event observed so far (the
 * thread's running cumulative total), or null when none has arrived yet.
 *
 * Pure/stateless per chunk boundary: only a bounded trailing partial-line
 * buffer is retained between calls, never the whole stream. Never throws —
 * malformed or partial input simply fails to update `usage`.
 */
export class CodexExecUsageObserver {
  private buffer = "";
  private lastUsage: CodexExecTurnUsage | null = null;

  /** Observe one raw PTY chunk. Tolerates CRLF and lines split across chunks. */
  observe(chunk: string): void {
    if (chunk.length === 0) return;
    this.buffer += chunk;
    // The PTY turns `\n` into `\r\n`; normalize before splitting so a line
    // split exactly at the `\r`/`\n` boundary across two chunks still joins.
    const normalized = this.buffer.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.observeLine(line);
    if (this.buffer.length > MAX_TRAILING_LINE_BUFFER_CHARS) {
      // Past the cap with no terminator in sight: it can never validly decode
      // as a bounded JSON usage event anyway. Drop it and keep scanning fresh
      // lines from here, rather than carrying it forward to poison whatever
      // real line eventually does arrive.
      this.buffer = "";
    }
  }

  /** Decode a trailing line with no terminator yet (e.g. the process exited mid-line). */
  flush(): void {
    if (this.buffer.length === 0) return;
    this.observeLine(this.buffer);
    this.buffer = "";
  }

  private observeLine(line: string): void {
    const obj = decodeJsonObjectLine(line);
    if (!obj || Array.isArray(obj)) return;
    const usage = decodeTurnCompletedUsage(obj);
    if (usage) this.lastUsage = usage;
  }

  get usage(): CodexExecTurnUsage | null {
    return this.lastUsage;
  }
}

/**
 * U3: per-attempt usage honesty.
 *
 * `turn.completed.usage` is the codex THREAD's running cumulative total,
 * never a per-turn delta. A fresh `codex exec` thread's cumulative total IS
 * its (only) attempt's usage. A resumed thread's per-attempt usage is the new
 * cumulative total minus the prior attempt's recorded cumulative total for
 * that same native thread — but only when that baseline is actually
 * reachable and no smaller than the new total; otherwise usage must be null
 * rather than silently recording the thread total as if it were this
 * attempt's alone.
 */
export function computeCodexExecAttemptUsage(input: Readonly<{
  observed: CodexExecTurnUsage | null;
  isResumedThread: boolean;
  priorCumulativeUsageForThread: CodexExecTurnUsage | null;
}>): CodexExecTurnUsage | null {
  const { observed, isResumedThread, priorCumulativeUsageForThread } = input;
  if (!observed) return null;
  if (!isResumedThread) return observed;
  if (!priorCumulativeUsageForThread) return null;
  const inputTokens = observed.inputTokens - priorCumulativeUsageForThread.inputTokens;
  const outputTokens = observed.outputTokens - priorCumulativeUsageForThread.outputTokens;
  if (inputTokens < 0 || outputTokens < 0) return null;
  return Object.freeze({ inputTokens, outputTokens });
}
