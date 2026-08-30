import assert from "node:assert/strict";
import test from "node:test";

const promptSha256 = "a".repeat(64);
const argvHash = "b".repeat(64);
const sessionID = "ses_1";
const messageID = "msg_1";

async function loadNormalizer() {
  try {
    return await import("../lib/ccc-opencode-events.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  }
}

function ndjson(records) {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

function partUpdated(part, time = 1700000000000) {
  return {
    id: `evt-${part.id}`,
    type: "message.part.updated",
    data: { sessionID, part, time },
  };
}

function stepStart(id = "part-step-start") {
  return partUpdated({ id, sessionID, messageID, type: "step-start", snapshot: "snap-before" });
}

function stepFinish(id = "part-step-finish") {
  return partUpdated({
    id,
    sessionID,
    messageID,
    type: "step-finish",
    reason: "end_turn",
    snapshot: "snap-after",
    cost: 0.004,
    tokens: { input: 12, output: 8, reasoning: 2, cache: { read: 3, write: 0 } },
  });
}

function textPart(text) {
  return partUpdated({ id: "part-text", sessionID, messageID, type: "text", text });
}

function reasoningPart(text) {
  return partUpdated({ id: "part-reasoning", sessionID, messageID, type: "reasoning", text });
}

function toolPart(callID, tool, input, output = "ok") {
  return partUpdated({
    id: `part-${callID}`,
    sessionID,
    messageID,
    type: "tool",
    callID,
    tool,
    state: {
      status: "completed",
      input,
      output,
      title: `${tool} completed`,
      metadata: {},
      time: { start: 1700000000100, end: 1700000000200 },
    },
  });
}

test("PRD:OC-EVENTS normalizes nested OpenCode message part events", async () => {
  const { normalizeOpenCodeRunEvents } = await loadNormalizer();
  assert.equal(typeof normalizeOpenCodeRunEvents, "function", "normalizeOpenCodeRunEvents export must exist");

  const output = [
    "[gateway-contract] 3/17 opencode.json model aliases have no OmniRoute match",
    ndjson([
      stepStart(),
      textPart("hello "),
      reasoningPart("thinking"),
      toolPart("tool_edit", "edit", { filePath: "src/a.ts", oldString: "old", newString: "new" }),
      toolPart("tool_bash", "bash", { command: "node --test scripts/__tests__/x.test.mjs" }, "tests passed"),
      toolPart("tool_shell", "shell", { command: "echo SECRET_TOKEN=must-not-persist" }, "SECRET_TOKEN=must-not-persist"),
      stepFinish(),
      { id: "evt-error", type: "session.error", data: { sessionID, error: { name: "UnknownError", data: { message: "late warning" } } } },
    ]),
  ].join("\n");

  const receipt = normalizeOpenCodeRunEvents(output, { promptSha256, argvHash });

  assert.equal(receipt.schema, "ccc.opencode.run.events.v1");
  assert.equal(receipt.promptSha256, promptSha256);
  assert.equal(receipt.argvHash, argvHash);
  assert.equal(receipt.completionStatus, "COMPLETE");
  assert.equal(receipt.upstreamRouteProof, "EFFECTIVE_UPSTREAM_ROUTE_UNPROVEN");
  assert.deepEqual(receipt.startupWarnings, [
    "[gateway-contract] 3/17 opencode.json model aliases have no OmniRoute match",
  ]);
  assert.deepEqual(receipt.steps, [
    {
      ordinal: 1,
      id: "part-step-start",
      sessionId: sessionID,
      messageId: messageID,
      finished: true,
      finishOrdinal: 7,
      reason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 8, reasoningTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 },
      cost: 0.004,
    },
  ]);
  assert.deepEqual(receipt.text, [{ ordinal: 2, id: "part-text", text: "hello " }]);
  assert.deepEqual(receipt.reasoning, [{ ordinal: 3, id: "part-reasoning", text: "thinking" }]);
  const safeToolUses = receipt.toolUses.map(({ inputEvidence, resultEvidence, ...metadata }) => metadata);
  assert.deepEqual(safeToolUses, [
    {
      ordinal: 4,
      completionOrdinal: 4,
      id: "tool_edit",
      partId: "part-tool_edit",
      name: "edit",
      directMutationCandidate: true,
      effectVerificationRequired: false,
    },
    {
      ordinal: 5,
      completionOrdinal: 5,
      id: "tool_bash",
      partId: "part-tool_bash",
      name: "bash",
      directMutationCandidate: false,
      effectVerificationRequired: true,
      effectProof: "SHELL_EFFECT_NEEDS_INDEPENDENT_GIT_OR_EFFECT_PROOF",
    },
    {
      ordinal: 6,
      completionOrdinal: 6,
      id: "tool_shell",
      partId: "part-tool_shell",
      name: "shell",
      directMutationCandidate: false,
      effectVerificationRequired: true,
      effectProof: "SHELL_EFFECT_NEEDS_INDEPENDENT_GIT_OR_EFFECT_PROOF",
    },
  ]);
  for (const tool of receipt.toolUses) {
    assert.equal("input" in tool, false);
    assert.equal("result" in tool, false);
    assert.match(tool.inputEvidence.argsHash, /^[a-f0-9]{64}$/);
    assert.match(tool.resultEvidence.argsHash, /^[a-f0-9]{64}$/);
    assert.equal(Number.isSafeInteger(tool.inputEvidence.byteLength), true);
    assert.equal(Number.isSafeInteger(tool.resultEvidence.byteLength), true);
  }
  assert.equal(JSON.stringify(receipt).includes("SECRET_TOKEN"), false);
  assert.equal(JSON.stringify(receipt).includes("must-not-persist"), false);
  assert.deepEqual(receipt.firstMutationCandidate, {
    ordinal: 4,
    id: "tool_edit",
    name: "edit",
    proof: "MUTATION_CANDIDATE_NEEDS_INDEPENDENT_GIT_PROOF",
  });
  assert.deepEqual(receipt.errors, [{ ordinal: 8, message: "late warning", code: "UnknownError" }]);
});

test("PRD:OC-EVENTS normalizes OpenCode 1.18 flat run events", async () => {
  const { normalizeOpenCodeRunEvents } = await loadNormalizer();
  const flat = (type, part) => ({
    type,
    timestamp: 1700000000000,
    sessionID,
    part: { sessionID, messageID, ...part },
  });
  const receipt = normalizeOpenCodeRunEvents(ndjson([
    flat("step_start", { id: "flat-start", type: "step-start" }),
    flat("tool_use", {
      type: "tool",
      tool: "apply_patch",
      callID: "flat-edit",
      state: { status: "completed", input: { patchText: "*** Begin Patch" }, output: "Done" },
    }),
    flat("text", { id: "flat-text", type: "text", text: "implemented" }),
    flat("step_finish", {
      id: "flat-finish",
      type: "step-finish",
      reason: "stop",
      tokens: { input: 20, output: 5, reasoning: 1, cache: { read: 4, write: 0 } },
      cost: 0,
    }),
  ]), { promptSha256, argvHash });

  assert.equal(receipt.completionStatus, "COMPLETE");
  assert.deepEqual(receipt.text, [{ ordinal: 3, id: "flat-text", text: "implemented" }]);
  assert.equal(receipt.toolUses[0].name, "apply_patch");
  assert.equal(receipt.firstMutationCandidate.name, "apply_patch");
  assert.deepEqual(receipt.steps[0].usage, {
    inputTokens: 20,
    outputTokens: 5,
    reasoningTokens: 1,
    cacheReadTokens: 4,
    cacheWriteTokens: 0,
  });
});

test("PRD:OC-EVENTS preserves non-JSON diagnostics interspersed with valid events", async () => {
  const { normalizeOpenCodeRunEvents } = await loadNormalizer();
  const receipt = normalizeOpenCodeRunEvents([
    JSON.stringify(stepStart()),
    "[plugin-warning] diagnostic after stream start",
    JSON.stringify(stepFinish()),
  ].join("\n"), { promptSha256, argvHash });

  assert.equal(receipt.completionStatus, "COMPLETE");
  assert.deepEqual(receipt.startupWarnings, ["[plugin-warning] diagnostic after stream start"]);
});

test("PRD:OC-EVENTS marks streams without step-finish as partial fallback candidates", async () => {
  const { normalizeOpenCodeRunEvents } = await loadNormalizer();
  assert.equal(typeof normalizeOpenCodeRunEvents, "function", "normalizeOpenCodeRunEvents export must exist");

  const receipt = normalizeOpenCodeRunEvents(ndjson([
    stepStart(),
    textPart("still running"),
  ]), { promptSha256, argvHash });

  assert.equal(receipt.completionStatus, "PARTIAL_STREAM_NEEDS_EXPORT_OR_DB_FALLBACK");
  assert.equal(receipt.steps[0].finished, false);
});

test("PRD:OC-EVENTS requires externally bound prompt and argv hashes", async () => {
  const { normalizeOpenCodeRunEvents } = await loadNormalizer();
  assert.equal(typeof normalizeOpenCodeRunEvents, "function", "normalizeOpenCodeRunEvents export must exist");

  assert.throws(
    () => normalizeOpenCodeRunEvents("{}", { promptSha256 }),
    /argvHash must be a 64-char sha256 hex string/,
  );
  assert.throws(
    () => normalizeOpenCodeRunEvents("{}", { argvHash }),
    /promptSha256 must be a 64-char sha256 hex string/,
  );
});

test("PRD:OC-EVENTS rejects malformed JSON event envelopes explicitly", async () => {
  const { normalizeOpenCodeRunEvents } = await loadNormalizer();
  assert.equal(typeof normalizeOpenCodeRunEvents, "function", "normalizeOpenCodeRunEvents export must exist");

  assert.throws(
    () => normalizeOpenCodeRunEvents(ndjson([{ data: { part: { type: "text", text: "missing outer type" } } }]), {
      promptSha256,
      argvHash,
    }),
    /malformed OpenCode JSON envelope at line 1: missing string type/,
  );
  assert.throws(
    () => normalizeOpenCodeRunEvents("{bad-json", { promptSha256, argvHash }),
    /malformed OpenCode JSON at line 1/,
  );
});
