import { hashBoundedToolArgs } from "./ccc-golden-experiment-receipt.mjs";

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const DIRECT_MUTATION_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch", "patch"]);
const EFFECT_PROOF_TOOLS = new Set(["bash", "shell"]);

function assertSha256(value, name) {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new Error(`${name} must be a 64-char sha256 hex string`);
  }
}

function parseLines(rawOutput) {
  const events = [];
  const startupWarnings = [];

  for (const [index, line] of String(rawOutput ?? "").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      events.push(normalizeEnvelope(record, index + 1));
    } catch (error) {
      if (!line.trimStart().startsWith("{")) {
        startupWarnings.push(line);
        continue;
      }
      if (error.message?.startsWith("malformed OpenCode JSON envelope")) throw error;
      throw new Error(`malformed OpenCode JSON at line ${index + 1}: ${error.message}`);
    }
  }

  return { events, startupWarnings };
}

function normalizeEnvelope(record, lineNumber) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`malformed OpenCode JSON envelope at line ${lineNumber}: expected object`);
  }
  if (typeof record.type !== "string" || record.type.length === 0) {
    throw new Error(`malformed OpenCode JSON envelope at line ${lineNumber}: missing string type`);
  }
  if (record.type === "sync" && record.syncEvent?.type === "message.part.updated.1") {
    return {
      type: "message.part.updated",
      id: record.id,
      data: record.syncEvent.data,
    };
  }
  if (
    ["step_start", "step_finish", "tool_use", "text", "reasoning"].includes(record.type)
    && record.part && typeof record.part === "object" && !Array.isArray(record.part)
  ) {
    return {
      type: "message.part.updated",
      id: record.part.id ?? record.part.callID,
      data: {
        sessionID: record.sessionID,
        part: record.part,
        time: record.timestamp,
      },
    };
  }
  return record;
}

function partFrom(event) {
  if (event.type !== "message.part.updated") return null;
  return event.data?.part && typeof event.data.part === "object" ? event.data.part : null;
}

function tokenUsage(tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  return {
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    reasoningTokens: tokens.reasoning ?? 0,
    cacheReadTokens: tokens.cache?.read ?? 0,
    cacheWriteTokens: tokens.cache?.write ?? 0,
  };
}

function normalizeError(event) {
  const error = event.data?.error ?? event.error ?? {};
  if (error.name && error.data?.message) {
    return { message: error.data.message, code: error.name };
  }
  return {
    message: error.message ?? "OpenCode error event",
    ...(error.code ? { code: error.code } : {}),
  };
}

function isDirectMutation(toolName) {
  return DIRECT_MUTATION_TOOLS.has(String(toolName ?? "").toLowerCase());
}

function needsEffectProof(toolName) {
  return EFFECT_PROOF_TOOLS.has(String(toolName ?? "").toLowerCase());
}

function completedTool(part, ordinal) {
  const state = part.state && typeof part.state === "object" ? part.state : {};
  const name = part.tool ?? "unknown";
  const tool = {
    ordinal,
    completionOrdinal: state.status === "completed" || state.status === "error" ? ordinal : null,
    id: part.callID ?? part.id,
    partId: part.id,
    name,
    inputEvidence: hashBoundedToolArgs(`${name}:input`, state.input ?? null),
    resultEvidence: hashBoundedToolArgs(`${name}:result`, state.output ?? state.error ?? null),
    directMutationCandidate: isDirectMutation(name),
    effectVerificationRequired: needsEffectProof(name),
  };
  if (tool.effectVerificationRequired) {
    tool.effectProof = "SHELL_EFFECT_NEEDS_INDEPENDENT_GIT_OR_EFFECT_PROOF";
  }
  return tool;
}

function buildReceipt(rawOutput, options) {
  const { events, startupWarnings } = parseLines(rawOutput);
  const steps = [];
  const text = [];
  const reasoning = [];
  const toolUses = [];
  const errors = [];
  let currentStep = null;
  let firstMutationCandidate = null;

  events.forEach((event, index) => {
    const ordinal = index + 1;
    const part = partFrom(event);

    if (part?.type === "step-start") {
      currentStep = {
        ordinal,
        id: part.id,
        sessionId: part.sessionID,
        messageId: part.messageID,
        finished: false,
        finishOrdinal: null,
        reason: null,
        usage: null,
        cost: null,
      };
      steps.push(currentStep);
      return;
    }

    if (part?.type === "step-finish") {
      const step = currentStep ?? steps.at(-1);
      if (step) {
        step.finished = true;
        step.finishOrdinal = ordinal;
        step.reason = part.reason ?? null;
        step.usage = tokenUsage(part.tokens);
        step.cost = part.cost ?? null;
      }
      return;
    }

    if (part?.type === "text") {
      text.push({ ordinal, id: part.id, text: part.text ?? "" });
      return;
    }

    if (part?.type === "reasoning") {
      reasoning.push({ ordinal, id: part.id, text: part.text ?? "" });
      return;
    }

    if (part?.type === "tool") {
      const tool = completedTool(part, ordinal);
      toolUses.push(tool);
      if (tool.directMutationCandidate && firstMutationCandidate === null) {
        firstMutationCandidate = {
          ordinal,
          id: tool.id,
          name: tool.name,
          proof: "MUTATION_CANDIDATE_NEEDS_INDEPENDENT_GIT_PROOF",
        };
      }
      return;
    }

    if (event.type === "session.error" || event.type === "error") {
      errors.push({ ordinal, ...normalizeError(event) });
    }
  });

  for (const step of steps) {
    if (step.finishOrdinal === null) delete step.finishOrdinal;
    if (step.reason === null) delete step.reason;
  }

  return {
    schema: "ccc.opencode.run.events.v1",
    promptSha256: options.promptSha256,
    argvHash: options.argvHash,
    upstreamRouteProof: options.upstreamReceipt
      ? "EFFECTIVE_UPSTREAM_ROUTE_PROVEN_BY_RECEIPT"
      : "EFFECTIVE_UPSTREAM_ROUTE_UNPROVEN",
    completionStatus: steps.length > 0 && steps.every((step) => step.finished)
      ? "COMPLETE"
      : "PARTIAL_STREAM_NEEDS_EXPORT_OR_DB_FALLBACK",
    startupWarnings,
    steps,
    text,
    reasoning,
    toolUses,
    firstMutationCandidate,
    errors,
  };
}

/**
 * Normalize offline `opencode run --format json` NDJSON into a stable receipt.
 *
 * The receipt proves only emitted event semantics. Direct write/edit-looking
 * calls and shell effects both require independent proof before claiming a
 * worktree mutation.
 *
 * @param {string} rawOutput
 * @param {{ promptSha256: string, argvHash: string, upstreamReceipt?: object }} options
 * @returns {object}
 */
export function normalizeOpenCodeRunEvents(rawOutput, options = {}) {
  assertSha256(options.promptSha256, "promptSha256");
  assertSha256(options.argvHash, "argvHash");
  return buildReceipt(rawOutput, options);
}
