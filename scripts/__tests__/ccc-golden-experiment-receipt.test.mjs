import test from "node:test";
import assert from "node:assert/strict";

async function loadReceiptLib() {
  try {
    return await import("../lib/ccc-golden-experiment-receipt.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  }
}

const hash = (fill) => fill.repeat(64);

const validReceipt = () => ({
  schema: "ccc-golden.experiment-receipt.v1",
  targetHashes: {
    repository: hash("a"),
    taskPacket: hash("b"),
    workspace: hash("c"),
  },
  harness: {
    id: "ccc-golden-harness",
    version: "1.0.0",
    promptHash: hash("d"),
    argvHash: hash("e"),
    configHash: hash("f"),
    agentHash: hash("1"),
    toolSchemaHash: hash("2"),
  },
  budget: {
    promptTokens: 1200,
    completionTokens: 300,
    toolCallCount: 4,
    mutationCount: 1,
    elapsedMs: 2500,
  },
  route: {
    requested: "gpt-5.6-sol",
    configured: "omniroute/default",
    selected: "gpt-5.6-sol",
    effective: "ROUTE_UNKNOWN",
  },
  routeProof: {
    state: "ROUTE_UNKNOWN",
    evidenceHash: hash("3"),
  },
  firstMutation: {
    observed: true,
    at: "2026-08-29T12:00:00Z",
    path: "packages/core/src/example.ts",
    contentHashBefore: hash("4"),
    contentHashAfter: hash("5"),
  },
  proof: {
    state: "PASS",
    commandHash: hash("6"),
    evidenceHash: hash("7"),
  },
  terminalOutcome: "PASS",
  changedPaths: ["packages/core/src/example.ts"],
  residue: {
    untrackedPaths: [],
    dirtyPaths: ["packages/core/src/example.ts"],
    notes: [],
  },
  toolArgs: [
    {
      tool: "shell",
      argsHash: hash("8"),
      byteLength: 42,
      truncated: false,
    },
  ],
});

test("PRD:GOLDEN-RECEIPT-v1 serializes canonical stable receipt JSON", async () => {
  const { serializeExperimentReceipt, parseExperimentReceipt } = await loadReceiptLib();
  assert.equal(typeof serializeExperimentReceipt, "function");
  assert.equal(typeof parseExperimentReceipt, "function");

  const receipt = validReceipt();
  const shuffled = {
    residue: receipt.residue,
    changedPaths: receipt.changedPaths,
    terminalOutcome: receipt.terminalOutcome,
    proof: receipt.proof,
    firstMutation: receipt.firstMutation,
    routeProof: receipt.routeProof,
    route: receipt.route,
    budget: receipt.budget,
    harness: receipt.harness,
    targetHashes: receipt.targetHashes,
    toolArgs: receipt.toolArgs,
    schema: receipt.schema,
  };

  const serialized = serializeExperimentReceipt(shuffled);
  assert.equal(serialized, serializeExperimentReceipt(receipt));
  assert.deepEqual(parseExperimentReceipt(serialized), receipt);
});

test("PRD:GOLDEN-RECEIPT-v1 rejects missing and unknown receipt fields", async () => {
  const { validateExperimentReceipt } = await loadReceiptLib();
  assert.equal(typeof validateExperimentReceipt, "function");

  const missingTarget = validReceipt();
  delete missingTarget.targetHashes.workspace;
  assert.throws(
    () => validateExperimentReceipt(missingTarget),
    /targetHashes\.workspace is required/,
  );

  const unknownField = validReceipt();
  unknownField.rawPrompt = "do not persist me";
  assert.throws(
    () => validateExperimentReceipt(unknownField),
    /unknown field: rawPrompt/,
  );
});

test("PRD:GOLDEN-RECEIPT-v1 requires route proof and preserves unknown routes explicitly", async () => {
  const { validateExperimentReceipt } = await loadReceiptLib();
  const receipt = validReceipt();
  assert.deepEqual(validateExperimentReceipt(receipt).routeProof, {
    state: "ROUTE_UNKNOWN",
    evidenceHash: hash("3"),
  });

  delete receipt.routeProof;
  assert.throws(() => validateExperimentReceipt(receipt), /routeProof is required/);
});

test("PRD:GOLDEN-RECEIPT-v1 refuses route proof that contradicts an unknown effective route", async () => {
  const { validateExperimentReceipt } = await loadReceiptLib();
  const receipt = validReceipt();
  receipt.routeProof.state = "ROUTE_PROVEN";
  assert.throws(
    () => validateExperimentReceipt(receipt),
    /ROUTE_PROVEN requires a known effective route/,
  );
  receipt.route.effective = "gpt-5.6-sol";
  assert.equal(validateExperimentReceipt(receipt).routeProof.state, "ROUTE_PROVEN");
});

test("PRD:GOLDEN-RECEIPT-v1 rejects impossible UTC calendar timestamps", async () => {
  const { validateExperimentReceipt } = await loadReceiptLib();
  const receipt = validReceipt();
  receipt.firstMutation.at = "2026-02-30T12:00:00Z";
  assert.throws(
    () => validateExperimentReceipt(receipt),
    /firstMutation\.at must be a real UTC timestamp/,
  );
});

test("PRD:GOLDEN-RECEIPT-v1 uses a strict serializable no-mutation shape", async () => {
  const { canonicalJson, serializeExperimentReceipt, validateExperimentReceipt } = await loadReceiptLib();
  const receipt = validReceipt();
  receipt.firstMutation = { observed: false };
  assert.equal(validateExperimentReceipt(receipt).firstMutation.observed, false);
  assert.deepEqual(JSON.parse(serializeExperimentReceipt(receipt)).firstMutation, { observed: false });

  receipt.firstMutation = { observed: false, at: undefined };
  assert.throws(() => validateExperimentReceipt(receipt), /unknown field: firstMutation\.at/);
  assert.throws(() => canonicalJson({ invalid: undefined }), /undefined is not canonical JSON/);
});

test("PRD:GOLDEN-RECEIPT-v1 hashes bounded tool args without raw prompt or secret text", async () => {
  const { hashBoundedToolArgs } = await loadReceiptLib();
  assert.equal(typeof hashBoundedToolArgs, "function");

  const raw = {
    prompt: "summarize this private prompt",
    apiKey: "sk-secret-value",
    nested: { password: "not-for-receipts" },
  };
  const evidence = hashBoundedToolArgs("tool-call", raw, { maxBytes: 64 });
  assert.deepEqual(Object.keys(evidence), ["argsHash", "byteLength", "truncated"]);
  assert.match(evidence.argsHash, /^[0-9a-f]{64}$/);
  assert.equal(evidence.truncated, true);
  assert.equal(JSON.stringify(evidence).includes("private prompt"), false);
  assert.equal(JSON.stringify(evidence).includes("secret"), false);
});

test("PRD:GOLDEN-RECEIPT-v1 tool argument identity hashes distinguish equal-length shared prefixes", async () => {
  const { hashBoundedToolArgs } = await loadReceiptLib();
  const left = hashBoundedToolArgs("shell", { command: `shared-prefix-${"a".repeat(64)}-left` }, { maxBytes: 16 });
  const right = hashBoundedToolArgs("shell", { command: `shared-prefix-${"a".repeat(64)}-rght` }, { maxBytes: 16 });
  assert.equal(left.byteLength, right.byteLength);
  assert.equal(left.truncated, true);
  assert.equal(right.truncated, true);
  assert.notEqual(left.argsHash, right.argsHash);
});

test("PRD:GOLDEN-RECEIPT-v1 residue notes are bounded codes rather than raw free text", async () => {
  const { serializeExperimentReceipt, validateExperimentReceipt } = await loadReceiptLib();
  const receipt = validReceipt();
  receipt.residue.notes = ["ROUTE_UNAVAILABLE"];
  assert.equal(validateExperimentReceipt(receipt).residue.notes[0], "ROUTE_UNAVAILABLE");
  receipt.residue.notes = ["synthetic api token sk-test-secret leaked here"];
  assert.throws(() => serializeExperimentReceipt(receipt), /residue\.notes must contain bounded codes/);
});
