import { describe, expect, it } from "vitest";

import {
  computeCodexExecAttemptUsage,
  CodexExecUsageObserver,
} from "../codex-exec-usage.js";

/**
 * Usage capture for `codex exec --json` PTY streams (usage-lane).
 *
 * Verified live (codex-cli 0.147.0): `turn.completed.usage` carries the
 * THREAD's running cumulative total (input_tokens/output_tokens), never a
 * per-turn delta — confirmed by observing a `codex exec resume` turn report
 * turn-one-total + turn-two-total. `reasoning_output_tokens` is already
 * folded into `output_tokens` and `cached_input_tokens` into `input_tokens`,
 * so the mapping is direct: input_tokens -> inputTokens, output_tokens ->
 * outputTokens.
 */

describe("CodexExecUsageObserver", () => {
  it("RED-U1-1: captures usage from a single turn.completed event delivered whole", () => {
    const observer = new CodexExecUsageObserver();
    observer.observe(
      '{"type":"thread.started","thread_id":"t-1"}\n'
      + '{"type":"turn.started"}\n'
      + '{"type":"item.completed","item":{"type":"agent_message"}}\n'
      + '{"type":"turn.completed","usage":{"input_tokens":24327,"cached_input_tokens":6528,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}\n',
    );

    expect(observer.usage).toEqual({ inputTokens: 24327, outputTokens: 5 });
  });

  it("RED-U1-2: reassembles a turn.completed line split across chunk boundaries", () => {
    const observer = new CodexExecUsageObserver();
    const full = '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":7}}\n';
    const splitAt = full.indexOf('"usage"');
    observer.observe(full.slice(0, splitAt));
    expect(observer.usage).toBeNull(); // partial line: nothing decodable yet
    observer.observe(full.slice(splitAt));

    expect(observer.usage).toEqual({ inputTokens: 100, outputTokens: 7 });
  });

  it("RED-U1-3: tolerates CRLF line endings (the PTY turns \\n into \\r\\n)", () => {
    const observer = new CodexExecUsageObserver();
    observer.observe(
      '{"type":"thread.started","thread_id":"t-1"}\r\n'
      + '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":2}}\r\n',
    );

    expect(observer.usage).toEqual({ inputTokens: 11, outputTokens: 2 });
  });

  it("RED-U1-4: skips non-JSON lines interleaved on the merged stderr/stdout stream", () => {
    const observer = new CodexExecUsageObserver();
    observer.observe(
      "warning: some stderr banner text\n"
      + "not json at all { unbalanced\n"
      + '{"type":"turn.completed","usage":{"input_tokens":9,"output_tokens":1}}\n'
      + "trailing non-json noise\n",
    );

    expect(observer.usage).toEqual({ inputTokens: 9, outputTokens: 1 });
  });

  it("RED-U1-5: turn.failed never updates usage", () => {
    const observer = new CodexExecUsageObserver();
    observer.observe(
      '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}\n'
      + '{"type":"turn.failed","error":"boom"}\n',
    );

    // The last turn.completed total stands; turn.failed carries no usage field
    // to overwrite it with.
    expect(observer.usage).toEqual({ inputTokens: 5, outputTokens: 1 });
  });

  it("RED-U1-6: no turn.completed at all yields null", () => {
    const observer = new CodexExecUsageObserver();
    observer.observe(
      '{"type":"thread.started","thread_id":"t-1"}\n'
      + '{"type":"turn.started"}\n'
      + '{"type":"turn.failed","error":"boom"}\n',
    );

    expect(observer.usage).toBeNull();
  });

  it("RED-U1-7: an empty stream yields null", () => {
    const observer = new CodexExecUsageObserver();
    expect(observer.usage).toBeNull();
  });

  it("RED-U1-8: keeps the LAST turn.completed total when more than one arrives on one stream", () => {
    const observer = new CodexExecUsageObserver();
    observer.observe(
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":1}}\n'
      + '{"type":"turn.completed","usage":{"input_tokens":25,"output_tokens":3}}\n',
    );

    expect(observer.usage).toEqual({ inputTokens: 25, outputTokens: 3 });
  });

  it("RED-U1-9: flush() decodes a trailing turn.completed line with no terminator", () => {
    const observer = new CodexExecUsageObserver();
    observer.observe('{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":1}}');
    expect(observer.usage).toBeNull(); // no newline yet, still buffered

    observer.flush();

    expect(observer.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
  });

  it("RED-U1-10: a malformed usage object (missing output_tokens) does not update usage", () => {
    const observer = new CodexExecUsageObserver();
    observer.observe('{"type":"turn.completed","usage":{"input_tokens":3}}\n');

    expect(observer.usage).toBeNull();
  });

  it("RED-B-1: a pathological unterminated line past the 512KB cap is dropped, not carried forward to poison the next real line", () => {
    const observer = new CodexExecUsageObserver();
    // No trailing newline: without a cap this keeps growing the trailing-line
    // buffer forever, and once a real newline-terminated line eventually
    // arrives it gets appended AFTER this garbage with no separating "\n" of
    // its own -- the whole merged blob then fails to decode as JSON, silently
    // losing the real event. 600KB comfortably exceeds the 512KB cap.
    observer.observe("x".repeat(600_000));
    observer.observe('{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}\n');

    expect(observer.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });
});

describe("computeCodexExecAttemptUsage (U3 per-attempt honesty)", () => {
  it("RED-U3-1: a fresh thread's cumulative total IS the attempt's usage", () => {
    const result = computeCodexExecAttemptUsage({
      observed: { inputTokens: 100, outputTokens: 10 },
      isResumedThread: false,
      priorCumulativeUsageForThread: null,
    });

    expect(result).toEqual({ inputTokens: 100, outputTokens: 10 });
  });

  it("RED-U3-2: no observed usage at all yields null regardless of resume state", () => {
    const result = computeCodexExecAttemptUsage({
      observed: null,
      isResumedThread: false,
      priorCumulativeUsageForThread: null,
    });

    expect(result).toBeNull();
  });

  it("RED-U3-3: a resumed thread with a reachable baseline subtracts the prior cumulative total", () => {
    const result = computeCodexExecAttemptUsage({
      observed: { inputTokens: 49797, outputTokens: 10 },
      isResumedThread: true,
      priorCumulativeUsageForThread: { inputTokens: 24327, outputTokens: 5 },
    });

    expect(result).toEqual({ inputTokens: 25470, outputTokens: 5 });
  });

  it("RED-U3-4: a resumed thread with NO reachable baseline yields null — never records the thread total as a per-attempt total", () => {
    const result = computeCodexExecAttemptUsage({
      observed: { inputTokens: 49797, outputTokens: 10 },
      isResumedThread: true,
      priorCumulativeUsageForThread: null,
    });

    expect(result).toBeNull();
  });

  it("RED-U3-5: a resumed thread whose baseline exceeds the observed total (corrupt data) yields null rather than a negative count", () => {
    const result = computeCodexExecAttemptUsage({
      observed: { inputTokens: 10, outputTokens: 1 },
      isResumedThread: true,
      priorCumulativeUsageForThread: { inputTokens: 100, outputTokens: 5 },
    });

    expect(result).toBeNull();
  });
});
