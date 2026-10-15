import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { compareCccPrdCodeUnits } from "@fusion/core";

/*
FNXC:CccProbeEchoTool 2026-10-14-21:10:
Card C2 (CONTRACT-v3 sections 2.7 and 2.13, D29, verify-v2 item 39). A preflight probe is one prompt and one model call, so no tool result in a probe session may trigger a follow-up call. ccc_probe_echo has a strict schema: every expected key is a required string and no other key is admitted. Pi validates arguments after its prepareArguments hook and before execute, so an inexact echo is recorded (exact: false) and the turn aborted from the hook, and an exact echo from execute; one observation and one abort per tool. wrapCccProbedTool keeps a tool's name, parameters and confinement mark, runs the real tool (the exact-edit probe needs the real edit), records one observation, aborts the turn once and returns the result as terminal; card C6 wraps every tool of a probe session, so any tool call ends the probe.
*/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function createCccProbeEchoTool(i: Readonly<{ expected: Readonly<Record<string, string>>;
  onObservation: (o: Readonly<{ exact: boolean; received: unknown }>) => void; abortTurn: () => void }>): ToolDefinition {
  if (!isPlainObject(i.expected)) throw new TypeError("ccc_probe_echo expected values must be an object");
  const keys = Object.keys(i.expected).sort(compareCccPrdCodeUnits);
  if (keys.length === 0) throw new TypeError("ccc_probe_echo needs at least one expected key");
  for (const key of keys) {
    if (typeof i.expected[key] !== "string") throw new TypeError(`ccc_probe_echo expected value ${key} must be a string`);
  }
  const expected = Object.freeze({ ...i.expected });
  let observed = false;
  let aborted = false;
  const observe = (exact: boolean, received: unknown) => {
    if (observed) return;
    observed = true;
    i.onObservation(Object.freeze({ exact, received }));
  };
  const abort = () => {
    if (aborted) return;
    aborted = true;
    i.abortTurn();
  };
  const isExact = (value: unknown): boolean => isPlainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key) && value[key] === expected[key]);

  return {
    name: "ccc_probe_echo",
    label: "Probe Echo",
    description: "Call this once with exactly the fields and values the prompt gives, and no other fields.",
    executionMode: "sequential",
    parameters: Type.Object(Object.fromEntries(keys.map((key) => [key, Type.String()])), { additionalProperties: false }),
    prepareArguments: (args: unknown) => {
      if (!isExact(args)) {
        observe(false, args);
        abort();
      }
      return args as never;
    },
    execute: async (_toolCallId, params) => {
      observe(isExact(params), params);
      abort();
      return {
        content: [{ type: "text" as const, text: "Probe echo recorded." }],
        details: undefined,
        terminate: true,
      };
    },
  };
}

function resultText(result: unknown): string {
  const content = isPlainObject(result) && Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((block) => (isPlainObject(block) && typeof block.text === "string" ? block.text : ""))
    .join("\n");
  return text.length > 600 ? `${text.slice(0, 600)}...` : text;
}

export function wrapCccProbedTool(tool: ToolDefinition, i: Readonly<{ probe: string;
  onObservation: (o: Readonly<{ probe: string; toolName: string; params: unknown; result: "ok" | "error"; detail: string }>) => void;
  abortTurn: () => void }>): ToolDefinition {
  let aborted = false;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    i.abortTurn();
  };
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      let result: Awaited<ReturnType<ToolDefinition["execute"]>>;
      let outcome: "ok" | "error";
      try {
        result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
        outcome = (result as { isError?: unknown }).isError === true ? "error" : "ok";
      } catch (error) {
        outcome = "error";
        result = {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: undefined,
          isError: true,
        } as Awaited<ReturnType<ToolDefinition["execute"]>>;
      }
      i.onObservation(Object.freeze({ probe: i.probe, toolName: tool.name, params, result: outcome, detail: resultText(result) }));
      abort();
      return { ...result, terminate: true };
    },
  };
}
