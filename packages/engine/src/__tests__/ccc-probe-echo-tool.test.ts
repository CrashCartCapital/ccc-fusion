import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { CCC_PLANNING_DENIED_NAMES } from "@fusion/core";
import { createCccProbeEchoTool, wrapCccProbedTool } from "../ccc-confinement/probe-echo-tool.js";
import { CCC_CONFINED_TOOL_MARK, createCccConfinedFsOperations } from "../ccc-confinement/confined-fs-tools.js";
import { createCccConfinedSessionTools } from "../ccc-confinement/session-tool-policy.js";
import { createCccVerdictTool } from "../ccc-confinement/verdict-tool.js";

/*
FNXC:CccProbeEchoTool 2026-10-14-21:02:
Card C2 proof for the preflight probe tools (CONTRACT-v3 sections 2.7 and 2.13, D29, verify-v2 item 39). ccc_probe_echo has a strict schema, so an echo with one extra key never reaches execute; its argument hook records exact: false and aborts the turn instead. wrapCccProbedTool keeps a tool's name, parameters and confinement mark, runs the real tool, records one observation and aborts the turn once, and marks the result terminal, so no tool result in a probe session triggers a follow-up model call. Each case has a positive control: the exact echo records exact: true, and the unwrapped tool's result is not terminal.
*/

/*
FNXC:CccProbeEchoTool 2026-10-14-22:40:
Card C2 repair 1. Pi checks a tool's arguments after its prepareArguments hook and before execute, and answers a call that fails the check, or that it prepares under an aborted signal, with an immediate result that never ends the batch, so Pi enters the stream function again. These tests therefore drive Pi 0.81.1's real agent loop (pi-agent-core, resolved beside the engine's pi-coding-agent) with a scripted stream function and count its entries: every probe call, valid or not, must leave exactly one entry.
*/
const piCodingAgentDir = realpathSync(fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent", import.meta.url)));
const { agentLoop } = (await import(pathToFileURL(join(piCodingAgentDir, "..", "pi-agent-core", "dist", "agent-loop.js")).href)) as {
  agentLoop: (...args: unknown[]) => AsyncIterable<unknown>;
};

const MODEL = { id: "m", provider: "p", api: "openai-completions", name: "m" };
const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Runs one prompt through Pi's agent loop. The first model call answers with `toolCalls`; any later entry is a follow-up call. */
async function runPiLoop(tools: unknown[], toolCalls: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }>, signal: AbortSignal) {
  const entries: Array<{ abortedAtEntry: boolean }> = [];
  const streamFn = (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
    entries.push({ abortedAtEntry: options?.signal?.aborted === true });
    const first = entries.length === 1;
    const stopReason = first ? "toolUse" : options?.signal?.aborted ? "aborted" : "stop";
    const content = first
      ? toolCalls.map((call, index) => ({ type: "toolCall", id: `call-${index + 1}`, name: call.name, arguments: call.arguments }))
      : [{ type: "text", text: "follow-up" }];
    const message = { role: "assistant", content, api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage: USAGE, stopReason, timestamp: Date.now() };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push((stopReason === "aborted" ? { type: "error", reason: "aborted", error: message } : { type: "done", reason: stopReason, message }) as never);
      stream.end();
    });
    return stream;
  };
  const events = agentLoop([{ role: "user", content: "probe", timestamp: Date.now() }], { systemPrompt: "", messages: [], tools },
    { model: MODEL, convertToLlm: (messages: unknown[]) => messages }, signal, streamFn);
  for await (const _event of events) {
    // drain
  }
  return entries;
}

const parent = realpathSync(mkdtempSync(join(tmpdir(), "ccc-c2-probe-")));
writeFileSync(join(parent, "a.txt"), "alpha\n");
writeFileSync(join(parent, "b.txt"), "bravo\n");
afterAll(() => {
  rmSync(parent, { recursive: true, force: true });
});

const EXPECTED = Object.freeze({ nonce: "n-123", lineage: "preflight:critic" });

function echoTool() {
  const onObservation = vi.fn();
  const abortTurn = vi.fn();
  const tool = createCccProbeEchoTool({ expected: EXPECTED, onObservation, abortTurn });
  return { tool, onObservation, abortTurn };
}

const execute = (tool: { execute: unknown }, params: unknown) =>
  (tool.execute as (...args: unknown[]) => Promise<unknown>)("probe-call", params, undefined, undefined, undefined);

function confinedEdit() {
  const fs = createCccConfinedFsOperations({ readRoots: [parent], writeRoots: [parent], deniedNames: [...CCC_PLANNING_DENIED_NAMES] });
  const [edit] = createCccConfinedSessionTools({
    names: ["edit"],
    confinement: { bash: null, fs },
    cwd: parent,
    readRoots: [parent],
    deniedNames: [...CCC_PLANNING_DENIED_NAMES],
  });
  return edit!;
}

describe("ccc_probe_echo and wrapCccProbedTool (card C2)", () => {
  it("ccc_probe_echo with one extra key records exact: false and aborts the turn", async () => {
    const controller = new AbortController();
    const onObservation = vi.fn();
    const abortTurn = vi.fn(() => controller.abort());
    const tool = createCccProbeEchoTool({ expected: EXPECTED, onObservation, abortTurn });
    const schema = tool.parameters as unknown as { additionalProperties?: boolean; required?: string[] };
    expect(tool.name).toBe("ccc_probe_echo");
    expect(schema.additionalProperties).toBe(false);
    expect([...(schema.required ?? [])].sort()).toEqual(["lineage", "nonce"]);

    const received = { ...EXPECTED, extra: "x" };
    const entries = await runPiLoop([tool], [{ name: "ccc_probe_echo", arguments: received }], controller.signal);
    expect(onObservation).toHaveBeenCalledTimes(1);
    expect(onObservation).toHaveBeenCalledWith({ exact: false, received });
    expect(abortTurn).toHaveBeenCalledTimes(1);
    // The batch ends: Pi never enters the stream function again, not even with the aborted signal.
    expect(entries).toEqual([{ abortedAtEntry: false }]);
  });

  it("positive control: the exact echo records exact: true once, aborts the turn once and ends the turn", async () => {
    const { tool, onObservation, abortTurn } = echoTool();
    const prepared = tool.prepareArguments!({ ...EXPECTED });
    expect(onObservation).not.toHaveBeenCalled();
    const result = await execute(tool, prepared) as { terminate?: boolean };
    expect(onObservation).toHaveBeenCalledTimes(1);
    expect(onObservation).toHaveBeenCalledWith({ exact: true, received: { ...EXPECTED } });
    expect(abortTurn).toHaveBeenCalledTimes(1);
    expect(result.terminate).toBe(true);
  });

  it("records a wrong value as exact: false and never records a second observation", async () => {
    const { tool, onObservation, abortTurn } = echoTool();
    await execute(tool, { ...EXPECTED, nonce: "n-999" });
    await execute(tool, { ...EXPECTED });
    expect(onObservation).toHaveBeenCalledTimes(1);
    expect(onObservation).toHaveBeenCalledWith({ exact: false, received: { ...EXPECTED, nonce: "n-999" } });
    expect(abortTurn).toHaveBeenCalledTimes(1);
  });

  it("wrapCccProbedTool(edit) keeps the name, parameters and CCC_CONFINED_TOOL_MARK, runs the real confined edit, records exact-edit ok and aborts the turn exactly once", async () => {
    const edit = confinedEdit();
    const onObservation = vi.fn();
    const abortTurn = vi.fn();
    const wrapped = wrapCccProbedTool(edit, { probe: "exact-edit", onObservation, abortTurn });

    expect(wrapped.name).toBe("edit");
    expect(wrapped.parameters).toBe(edit.parameters);
    expect((edit as unknown as Record<PropertyKey, unknown>)[CCC_CONFINED_TOOL_MARK]).toBe(true);
    expect((wrapped as unknown as Record<PropertyKey, unknown>)[CCC_CONFINED_TOOL_MARK]).toBe(true);

    const params = { path: "a.txt", edits: [{ oldText: "alpha", newText: "beta" }] };
    const result = await execute(wrapped, params) as { terminate?: boolean };
    expect(readFileSync(join(parent, "a.txt"), "utf8")).toBe("beta\n");
    expect(onObservation).toHaveBeenCalledTimes(1);
    expect(onObservation).toHaveBeenCalledWith(expect.objectContaining({ probe: "exact-edit", toolName: "edit", params, result: "ok" }));
    expect(abortTurn).toHaveBeenCalledTimes(1);
    expect(result.terminate).toBe(true);

    // Positive control: the unwrapped edit's result does not end the turn by itself.
    const plain = await execute(edit, { path: "a.txt", edits: [{ oldText: "beta", newText: "gamma" }] }) as { terminate?: boolean };
    expect(plain.terminate).toBeUndefined();
  });

  it("wrapCccProbedTool records a failing tool as error, still aborts the turn once and ends the turn", async () => {
    const onObservation = vi.fn();
    const abortTurn = vi.fn();
    const wrapped = wrapCccProbedTool(confinedEdit(), { probe: "exact-edit", onObservation, abortTurn });

    const result = await execute(wrapped, { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] }) as { terminate?: boolean; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.terminate).toBe(true);
    expect(onObservation).toHaveBeenCalledWith(expect.objectContaining({ probe: "exact-edit", toolName: "edit", result: "error" }));
    expect(abortTurn).toHaveBeenCalledTimes(1);
  });

  it("a wrapped ccc_submit_verdict or edit called with schema-invalid arguments through Pi's agent loop records one error observation, aborts the turn once, never runs the tool and makes no follow-up model call; positive control: a schema-valid call records ok in one model call", async () => {
    const run = async (tool: "verdict" | "edit", toolCalls: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }>) => {
      const controller = new AbortController();
      const onObservation = vi.fn();
      const abortTurn = vi.fn(() => controller.abort());
      const onVerdict = vi.fn(async () => ({ artifactKey: "cccplan-r001-preflight-verdict-v01", digest: "f".repeat(64) }));
      const inner = tool === "verdict"
        ? createCccVerdictTool({ requirementIds: null, artifactKeys: [], reviewedPaths: null, onVerdict })
        : confinedEdit();
      const wrapped = wrapCccProbedTool(inner, { probe: tool === "verdict" ? "verdict-shape" : "exact-edit", onObservation, abortTurn });
      const entries = await runPiLoop([wrapped], toolCalls, controller.signal);
      return { entries: entries.length, observations: onObservation.mock.calls.map(([o]) => o), aborts: abortTurn.mock.calls.length, verdicts: onVerdict.mock.calls.length };
    };

    const unknownKey = { verdict: "accept", findings: [], mood: "x" };
    const refused = await run("verdict", [{ name: "ccc_submit_verdict", arguments: unknownKey }]);
    expect(refused).toMatchObject({ entries: 1, aborts: 1, verdicts: 0 });
    expect(refused.observations).toEqual([expect.objectContaining({
      probe: "verdict-shape", toolName: "ccc_submit_verdict", params: unknownKey, result: "error", detail: expect.stringContaining("Validation failed"),
    })]);
    expect(refused.observations[0].detail.length).toBeLessThanOrEqual(603);

    const malformedEdit = { file: "b.txt", edits: "bravo->charlie" };
    const edit = await run("edit", [{ name: "edit", arguments: malformedEdit }]);
    expect(edit).toMatchObject({ entries: 1, aborts: 1 });
    expect(edit.observations).toEqual([expect.objectContaining({ probe: "exact-edit", toolName: "edit", params: malformedEdit, result: "error" })]);
    expect(readFileSync(join(parent, "b.txt"), "utf8")).toBe("bravo\n");

    // An invalid call before a valid one in the same message still yields one observation, and the valid one never runs.
    const batch = await run("verdict", [
      { name: "ccc_submit_verdict", arguments: { verdict: "approve", findings: [] } },
      { name: "ccc_submit_verdict", arguments: { verdict: "accept", findings: [] } },
    ]);
    expect(batch).toMatchObject({ entries: 1, aborts: 1, verdicts: 0 });
    expect(batch.observations).toEqual([expect.objectContaining({ result: "error" })]);

    // Positive control: the same wrapped tool with schema-valid arguments runs, records ok and ends in one model call.
    const valid = await run("verdict", [{ name: "ccc_submit_verdict", arguments: { verdict: "accept", findings: [] } }]);
    expect(valid).toMatchObject({ entries: 1, aborts: 1, verdicts: 1 });
    expect(valid.observations).toEqual([expect.objectContaining({ probe: "verdict-shape", result: "ok" })]);
  });

  it("a wrapped ccc_submit_verdict records verdict-shape ok and aborts the turn exactly once", async () => {
    const onVerdict = vi.fn(async () => ({ artifactKey: "cccplan-r001-preflight-verdict-v01", digest: "f".repeat(64) }));
    const verdict = createCccVerdictTool({ requirementIds: null, artifactKeys: [], reviewedPaths: null, onVerdict });
    const onObservation = vi.fn();
    const abortTurn = vi.fn();
    const wrapped = wrapCccProbedTool(verdict, { probe: "verdict-shape", onObservation, abortTurn });

    expect(wrapped.name).toBe("ccc_submit_verdict");
    expect(wrapped.parameters).toBe(verdict.parameters);
    const result = await execute(wrapped, { verdict: "accept", findings: [] }) as { terminate?: boolean };
    expect(onVerdict).toHaveBeenCalledTimes(1);
    expect(onObservation).toHaveBeenCalledTimes(1);
    expect(onObservation).toHaveBeenCalledWith(expect.objectContaining({ probe: "verdict-shape", toolName: "ccc_submit_verdict", result: "ok" }));
    expect(abortTurn).toHaveBeenCalledTimes(1);
    expect(result.terminate).toBe(true);
  });
});
