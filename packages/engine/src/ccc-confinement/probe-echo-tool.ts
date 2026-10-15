import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { compareCccPrdCodeUnits } from "@fusion/core";
import { Value } from "typebox/value";

/*
FNXC:CccProbeEchoTool 2026-10-14-21:10:
Card C2 (CONTRACT-v3 sections 2.7 and 2.13, D29, verify-v2 item 39). A preflight probe is one prompt and one model call, so no tool result in a probe session may trigger a follow-up call. ccc_probe_echo has a strict schema: every expected key is a required string and no other key is admitted. Pi validates arguments after its prepareArguments hook and before execute, so an inexact echo is recorded (exact: false) in the hook and an exact echo in execute, and execute aborts the turn in both cases (repair 1, below); one observation and one abort per tool. wrapCccProbedTool keeps a tool's name, parameters and confinement mark, runs the real tool (the exact-edit probe needs the real edit), records one observation, aborts the turn once and returns the result as terminal; card C6 wraps every tool of a probe session, so any tool call ends the probe.
*/

/*
FNXC:CccProbeEchoTool 2026-10-14-22:44:
Card C2 repair 1 (verify-v2 item 39: any tool call ends the probe and no tool result triggers a follow-up call). Pi 0.81.1 checks a call's arguments after the tool's prepareArguments hook and before execute, and answers a call that fails the check, or that it prepares while the turn signal is already aborted, with an immediate result that is never terminal; Pi then enters the stream function again, and in planning scope that second entry reserves a provider dispatch. So a probe tool records a refused call in prepareArguments but does not abort there: it hands Pi schema-valid placeholder arguments (for ccc_probe_echo, the expected values) and execute, which never runs the real tool for such a call, aborts the turn once and returns a terminal result. wrapCccProbedTool checks the arguments the way Pi does (the inner tool's prepareArguments, then pi-ai's validateToolArguments); its observation is latched, the first call claims it, and every later call in the batch returns a terminal result without running the tool. If no placeholder passes the tool's schema, the refusal aborts the turn at once, which ends the turn but not the batch.
*/

const DETAIL_LIMIT = 600;

function bounded(text: string): string {
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}...` : text;
}

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
      if (isExact(args)) return args as never;
      // Recorded here, aborted in execute: the expected values pass the strict schema, so Pi reaches execute and the batch ends.
      observe(false, args);
      return { ...expected } as never;
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
  return bounded(text);
}

/** Pi's own argument check: the tool's prepareArguments (called once), then pi-ai's validateToolArguments. */
function checkArguments(tool: ToolDefinition, args: unknown): Readonly<{ prepared: unknown; problem: string | null }> {
  let prepared: unknown = args;
  try {
    prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
    validateToolArguments(tool as never, { type: "toolCall", id: "ccc-probe", name: tool.name, arguments: prepared as never });
    return { prepared, problem: null };
  } catch (error) {
    return { prepared, problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Arguments that pass `tool`'s schema, so Pi reaches execute after a refused call; null when none can be built. Checked
 * without the tool's own prepareArguments, which Pi does not call on what the wrapper's hook returns (and which may record).
 */
function placeholderArguments(tool: ToolDefinition): unknown {
  try {
    const created: unknown = Value.Create(tool.parameters as never);
    validateToolArguments(tool as never, { type: "toolCall", id: "ccc-probe-placeholder", name: tool.name, arguments: structuredClone(created) as never });
    return created;
  } catch {
    return null;
  }
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
  const placeholder = placeholderArguments(tool);
  let claimed = false;
  let refusal: string | null = null;
  return {
    ...tool,
    prepareArguments: (args: unknown) => {
      const { prepared, problem } = checkArguments(tool, args);
      if (problem === null) return prepared as never;
      if (!claimed) {
        claimed = true;
        refusal = bounded(problem);
        i.onObservation(Object.freeze({ probe: i.probe, toolName: tool.name, params: args, result: "error" as const, detail: refusal }));
      }
      if (placeholder === null) {
        abort();
        return args as never;
      }
      return structuredClone(placeholder) as never;
    },
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      if (claimed) {
        // A refused call (placeholder arguments) or a later call in the same batch: never run the tool, end the batch.
        abort();
        return {
          content: [{ type: "text", text: refusal ?? "Probe already recorded; this call was not run." }],
          details: undefined,
          isError: true,
          terminate: true,
        } as Awaited<ReturnType<ToolDefinition["execute"]>>;
      }
      claimed = true;
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
