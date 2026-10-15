import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CCC_PLANNING_DENIED_NAMES } from "@fusion/core";
import { createCccProbeEchoTool, wrapCccProbedTool } from "../ccc-confinement/probe-echo-tool.js";
import { CCC_CONFINED_TOOL_MARK, createCccConfinedFsOperations } from "../ccc-confinement/confined-fs-tools.js";
import { createCccConfinedSessionTools } from "../ccc-confinement/session-tool-policy.js";
import { createCccVerdictTool } from "../ccc-confinement/verdict-tool.js";

/*
FNXC:CccProbeEchoTool 2026-10-14-21:02:
Card C2 proof for the preflight probe tools (CONTRACT-v3 sections 2.7 and 2.13, D29, verify-v2 item 39). ccc_probe_echo has a strict schema, so an echo with one extra key never reaches execute; its argument hook records exact: false and aborts the turn instead. wrapCccProbedTool keeps a tool's name, parameters and confinement mark, runs the real tool, records one observation and aborts the turn once, and marks the result terminal, so no tool result in a probe session triggers a follow-up model call. Each case has a positive control: the exact echo records exact: true, and the unwrapped tool's result is not terminal.
*/

const parent = realpathSync(mkdtempSync(join(tmpdir(), "ccc-c2-probe-")));
writeFileSync(join(parent, "a.txt"), "alpha\n");
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
  it("ccc_probe_echo with one extra key records exact: false and aborts the turn", () => {
    const { tool, onObservation, abortTurn } = echoTool();
    const schema = tool.parameters as unknown as { additionalProperties?: boolean; required?: string[] };
    expect(tool.name).toBe("ccc_probe_echo");
    expect(schema.additionalProperties).toBe(false);
    expect([...(schema.required ?? [])].sort()).toEqual(["lineage", "nonce"]);

    const received = { ...EXPECTED, extra: "x" };
    tool.prepareArguments!(received);
    expect(onObservation).toHaveBeenCalledTimes(1);
    expect(onObservation).toHaveBeenCalledWith({ exact: false, received });
    expect(abortTurn).toHaveBeenCalledTimes(1);
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
