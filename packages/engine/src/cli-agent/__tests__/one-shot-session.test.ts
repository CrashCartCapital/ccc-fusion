/**
 * Parity/pinning tests for one-shot-session.ts's output parsing (extractJsonObjects,
 * parseOneShotOutput). Before this file, no test in the repo exercised these
 * functions directly — cli-agent-validator.test.ts only imports the OneShotResult
 * TYPE and drives runCliAgentValidation through the ACP seam, never through the
 * one-shot PTY parsing path. This file pins the pre-existing behavior (unchanged
 * by the jsonl-line-scan.ts extraction refactor in this same change) so a future
 * edit to this parsing has a real regression check.
 */
import { describe, it, expect } from "vitest";
import { extractJsonObjects, parseOneShotOutput } from "../one-shot-session.js";

describe("extractJsonObjects — line-delimited scan over noisy PTY output", () => {
  it("keeps only the decodable JSON lines: ignores banner prose, a malformed line, and tolerates CRLF", () => {
    const output = [
      "Codex CLI v0.147.0 starting up...",
      '{"type":"turn.started"}',
      "not json at all",
      "{bad json",
      '{"type":"turn.completed","usage":{"input_tokens":10}}',
    ].join("\r\n");

    const objects = extractJsonObjects(output);

    expect(objects).toEqual([
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 10 } },
    ]);
  });
});

describe("parseOneShotOutput — per-adapter final-object pick", () => {
  it("picks the LAST decodable JSON object on the stream, not the first", () => {
    const output = [
      '{"type":"agent_message","text":"thinking..."}',
      '{"type":"agent_message","text":"final answer"}',
    ].join("\n");

    const result = parseOneShotOutput("codex", output);

    expect(result).not.toBeNull();
    expect(result?.parsed).toEqual({ type: "agent_message", text: "final answer" });
    expect(result?.text).toBe("final answer");
  });

  it("returns null when nothing on the stream decodes as JSON", () => {
    const result = parseOneShotOutput("codex", "just prose, no braces to be found here");
    expect(result).toBeNull();
  });
});
