import assert from "node:assert/strict";
import test from "node:test";

async function loadPacketBuilder() {
  try {
    return await import("../lib/ccc-golden-packet.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  }
}

test("PRD:GOLDEN-3A packet definition freezes the three-task Evidence Ledger chain", async () => {
  const { buildEvidenceLedgerPacketDefinition } = await loadPacketBuilder();
  assert.equal(typeof buildEvidenceLedgerPacketDefinition, "function");
  const targetRoot = "/tmp/ccc-golden-ledger-target";
  const targetBase = "a".repeat(40);
  const route = {
    providerId: "openai-compatible-omniroute",
    modelId: "openai-compatible-omniroute/runtime-probed-model",
    transport: "pi",
    receiptAdapterId: "terminal-route-sse-comments.v1",
  };
  const definition = buildEvidenceLedgerPacketDefinition({
    targetRoot,
    targetBase,
    route,
    maxRequests: 9,
    maxDurationMs: 600_000,
  });

  assert.equal(definition.prdFileName, "PRJ-HUM-CCCGoldenEvidenceLedger-PRD-v1.0.0.md");
  assert.equal(definition.supportRelativePath, "support/REF-HUM-EvidenceLedgerVerifier.md");
  assert.match(definition.prd, /# CCC Golden Evidence Ledger/);
  assert.match(definition.support, /baseline-owned verifier/);
  assert.match(definition.prd, /emits all required passing canonical clauses/);
  assert.doesNotMatch(definition.prd, /emits nineteen passing canonical clauses/);

  const { proposal } = definition;
  assert.equal(proposal.schema, "ccc-prd.authoring-proposal.v2");
  assert.deepEqual(proposal.requirements.map(({ id }) => id), [
    "REQ-LEDGER-CONTRACT",
    "REQ-LEDGER-CORE",
    "REQ-LEDGER-CLI",
  ]);
  assert.deepEqual(proposal.tasks.map(({ id }) => id), [
    "TASK-LEDGER-CONTRACT",
    "TASK-LEDGER-CORE",
    "TASK-LEDGER-CLI",
  ]);
  assert.deepEqual(proposal.tasks.map(({ ownedPaths }) => ownedPaths), [
    ["src/record.mjs", "src/validation.mjs"],
    ["src/ledger.mjs", "src/report.mjs"],
    ["README.md", "bin/evidence-ledger.mjs"],
  ]);
  assert.deepEqual(proposal.tasks.map(({ dependencyTaskIds }) => dependencyTaskIds), [
    [],
    ["TASK-LEDGER-CONTRACT"],
    ["TASK-LEDGER-CORE"],
  ]);
  const taskDescriptions = Object.fromEntries(proposal.tasks.map(({ id, description }) => [id, description]));
  assert.match(taskDescriptions["TASK-LEDGER-CORE"], /export buildLedger\(records\)/);
  assert.match(taskDescriptions["TASK-LEDGER-CORE"], /export renderJsonReport\(ledger\) and renderTextReport\(ledger\)/);
  assert.match(taskDescriptions["TASK-LEDGER-CORE"], /write both owned files by request 2/);
  assert.match(taskDescriptions["TASK-LEDGER-CLI"], /node bin\/evidence-ledger\.mjs report <input> --format json\|text/);
  assert.match(taskDescriptions["TASK-LEDGER-CLI"], /write both owned files by request 2/);
  assert.deepEqual(proposal.edges, [
    { id: "EDGE-LEDGER-CORE-CONTRACT", fromTaskId: "TASK-LEDGER-CORE", toTaskId: "TASK-LEDGER-CONTRACT", kind: "depends_on" },
    { id: "EDGE-LEDGER-CLI-CORE", fromTaskId: "TASK-LEDGER-CLI", toTaskId: "TASK-LEDGER-CORE", kind: "depends_on" },
  ]);
  assert.deepEqual(proposal.proofs.map(({ id, phases, command }) => ({ id, phases, command })), [
    { id: "PROOF-LEDGER-CONTRACT", phases: ["task"], command: "task verify:contract" },
    { id: "PROOF-LEDGER-CORE", phases: ["task"], command: "task verify:core" },
    { id: "PROOF-LEDGER-CLI", phases: ["task"], command: "task verify:cli" },
    { id: "PROOF-LEDGER-INTEGRATED", phases: ["final_integrated"], command: "task verify:project" },
  ]);
  const fixturePaths = [
    "fixtures/duplicate-id.ndjson",
    "fixtures/hardcode-control.ndjson",
    "fixtures/invalid-calendar-date.ndjson",
    "fixtures/invalid-confidence.ndjson",
    "fixtures/invalid-json.ndjson",
    "fixtures/invalid-timestamp.ndjson",
    "fixtures/missing-required-field.ndjson",
    "fixtures/unknown-field.ndjson",
    "fixtures/valid-shuffled.ndjson",
    "fixtures/valid.ndjson",
  ];
  const cumulativeCandidateInputs = [
    ["src/record.mjs", "src/validation.mjs"],
    ["src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs"],
    ["src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs", "README.md", "bin/evidence-ledger.mjs"],
    ["README.md", "bin/evidence-ledger.mjs", "src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs"],
  ];
  for (const [index, proof] of proposal.proofs.entries()) {
    assert.deepEqual(
      proof.verifierClosure.filter(({ role }) => role === "fixture").map(({ path }) => path),
      fixturePaths,
      `${proof.id} must materialize every baseline fixture read by the sealed verifier`,
    );
    assert.deepEqual(
      proof.verifierClosure.filter(({ role }) => role === "config").map(({ path }) => path),
      [".gitignore", "package.json"],
      `${proof.id} must materialize the baseline-owned project config used by custody proof`,
    );
    assert.deepEqual(
      proof.verifierClosure.map(({ path }) => path).filter((path) => proof.candidateInputs.includes(path)),
      [],
      `${proof.id} verifier closure and worker-owned candidate inputs must stay disjoint`,
    );
    assert.deepEqual(
      proof.candidateInputs,
      cumulativeCandidateInputs[index],
      `${proof.id} must materialize its exact transitive worker-created read inputs`,
    );
  }
  assert.deepEqual(proposal.workflows, [{
    id: "WORKFLOW-LEDGER",
    title: "CCC Golden Evidence Ledger",
    taskIds: ["TASK-LEDGER-CONTRACT", "TASK-LEDGER-CORE", "TASK-LEDGER-CLI"],
    entryTaskIds: ["TASK-LEDGER-CONTRACT"],
    terminalTaskIds: ["TASK-LEDGER-CLI"],
    sourceRefs: proposal.workflows[0].sourceRefs,
  }]);
  assert.deepEqual(proposal.bounds, { maxRequests: 9, maxDurationMs: 600_000, maxConcurrency: 1 });
  assert.deepEqual(proposal.targetRepository, { path: targetRoot, baseCommit: targetBase });
  assert.deepEqual(proposal.unresolvedDecisions, []);
  assert.deepEqual(proposal.ambiguities, []);
  assert.deepEqual(proposal.exceptions, []);

  assert.equal(definition.routes.schema, "ccc-prd.routes-by-task.v1");
  assert.deepEqual(Object.keys(definition.routes.routes), [
    "TASK-LEDGER-CLI",
    "TASK-LEDGER-CONTRACT",
    "TASK-LEDGER-CORE",
  ]);
  for (const taskRoute of Object.values(definition.routes.routes)) {
    assert.deepEqual(taskRoute, route);
  }
  assert.deepEqual(definition.operatorContext, {
    schema: "ccc-prd.operator-context.v1",
    targetRepository: { path: targetRoot, baseCommit: targetBase },
    taskCustody: {
      ownedPaths: ["src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs", "README.md", "bin/evidence-ledger.mjs"],
      allowedWriteRoots: ["src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs", "README.md", "bin/evidence-ledger.mjs"],
    },
    writeRootPurpose: "disposable golden campaign repository",
    bounds: { maxRequests: 9, maxDurationMs: 600_000, maxConcurrency: 1 },
  });
});
