import assert from "node:assert/strict";
import test from "node:test";

async function loadPacketBuilder() {
  try {
    return await import("../lib/ccc-gate2-telemetry-packet.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  }
}

const route = (providerId, modelId, terminalRouteMembers) => ({
  providerId,
  modelId,
  transport: "pi",
  receiptAdapterId: "terminal-route-sse-comments.v1",
  terminalRouteMembers,
});

test("PRD:GATE2-01 telemetry packet freezes the six-task peer DAG without verifier leakage", async () => {
  const { buildGate2TelemetryPacketDefinition } = await loadPacketBuilder();
  assert.equal(typeof buildGate2TelemetryPacketDefinition, "function");

  const targetRoot = "/tmp/ccc-gate2-telemetry-target";
  const targetBase = "a".repeat(40);
  const routes = {
    minimax: route("gate2-minimax", "combo/minimax-latest", [
      { provider: "minimax", model: "MiniMax-M3" },
    ]),
    glm: route("gate2-glm", "combo/glm-latest", [
      { provider: "glm", model: "glm-5.3" },
    ]),
    gemini: route("gate2-gemini", "combo/gemini-flash-latest", [
      { provider: "antigravity", model: "gemini-3.7-flash-high" },
      { provider: "gemini", model: "gemini-flash-latest" },
    ]),
  };
  const definition = buildGate2TelemetryPacketDefinition({
    targetRoot,
    targetBase,
    routes,
    maxRequests: 2_304,
    maxDurationMs: 21_600_000,
    maxConcurrency: 3,
  });

  assert.equal(definition.projectName, "gate2-telemetry-service");
  assert.equal(definition.prdFileName, "PRJ-HUM-Gate2TelemetryService-PRD-v1.0.0.md");
  assert.match(definition.prd, /typed HTTP event ingest/i);
  assert.match(definition.prd, /append-only JSONL audit/i);
  assert.match(definition.prd, /server-sent event/i);
  assert.match(definition.prd, /CLI health probe/i);
	  for (const publicContract of [
	    "GET /health",
	    "POST /events",
	    "GET /stream",
	    "--port <port>",
	    "--audit <path>",
	    "health-cli.ts <base-url>",
	    "Discovery commands must stay inside the project root.",
	    "Do not search /, /tmp, /private/tmp, parent directories, home directories, or dependency caches for templates, tsconfig.json, examples, or tooling.",
	    "Do not create tsconfig.json; this project deliberately runs TypeScript directly with Node 24 --experimental-strip-types.",
	    "parseTelemetryEvent(value: unknown)",
	    "handleIngest(value, dependencies)",
	    "AuditStore.open(filePath)",
	    "readAll()",
    "subscribe()",
    "probeHealth(fetchFn, baseUrl)",
    "createApp({ auditPath })",
    "handle(request)",
    "close()",
    "import.meta.url main guard",
    "local source imports must use .ts specifiers",
  ]) {
    assert.match(definition.prd, new RegExp(publicContract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(definition.prd, /write .* by request|do not read the verifier|verifyIntegratedBehavior|semanticByPhase/i);
  for (const spec of definition.proposal.requirements) {
    assert.match(definition.prd, new RegExp(`### Requirement ${spec.id}\\n`));
    assert.doesNotMatch(definition.prd, new RegExp(`### ${spec.id}\\n`));
    for (const clause of spec.acceptanceClauses) {
      assert.ok(definition.prd.includes(`#### Acceptance clauses\n- [${clause.id}] ${clause.text}`));
    }
  }

  const expectedTaskIds = [
    "TASK-TELEMETRY-CONTRACT",
    "TASK-TELEMETRY-INGEST",
    "TASK-TELEMETRY-AUDIT",
    "TASK-TELEMETRY-BROADCAST",
    "TASK-TELEMETRY-CLI",
    "TASK-TELEMETRY-INTEGRATE",
  ];
  assert.deepEqual(definition.proposal.tasks.map(({ id }) => id), expectedTaskIds);
  assert.deepEqual(definition.proposal.tasks.map(({ dependencyTaskIds }) => dependencyTaskIds), [
    [],
    ["TASK-TELEMETRY-CONTRACT"],
    ["TASK-TELEMETRY-CONTRACT"],
    ["TASK-TELEMETRY-CONTRACT"],
    ["TASK-TELEMETRY-INGEST", "TASK-TELEMETRY-AUDIT", "TASK-TELEMETRY-BROADCAST"],
    ["TASK-TELEMETRY-CLI"],
  ]);
	  assert.deepEqual(definition.proposal.tasks.map(({ ownedPaths }) => ownedPaths), [
	    ["src/contract.ts"],
	    ["src/ingest.ts"],
	    ["src/audit.ts"],
	    ["src/broadcast.ts"],
	    ["src/health-cli.ts", "README.md"],
	    ["src/app.ts", "tests/telemetry.test.ts"],
	  ]);
	  for (const task of definition.proposal.tasks) {
	    assert.match(task.description, /Discovery commands must stay inside \.\/ only/i);
	    assert.match(task.description, /Do not search \/.*tsconfig\.json/i);
	  }
	  assert.equal(definition.proposal.edges.length, 7);
  assert.deepEqual(definition.proposal.bounds, {
    maxRequests: 2_304,
    maxDurationMs: 21_600_000,
    maxConcurrency: 3,
  });
  assert.deepEqual(definition.proposal.workflows[0].entryTaskIds, ["TASK-TELEMETRY-CONTRACT"]);
  assert.deepEqual(definition.proposal.workflows[0].terminalTaskIds, ["TASK-TELEMETRY-INTEGRATE"]);

  assert.deepEqual(definition.routes.routes, {
    "TASK-TELEMETRY-AUDIT": routes.glm,
    "TASK-TELEMETRY-BROADCAST": routes.gemini,
    "TASK-TELEMETRY-CLI": routes.gemini,
    "TASK-TELEMETRY-CONTRACT": routes.glm,
    "TASK-TELEMETRY-INGEST": routes.minimax,
    "TASK-TELEMETRY-INTEGRATE": routes.minimax,
  });
  assert.deepEqual(definition.operatorContext.bounds, {
    maxRequests: 2_304,
    maxDurationMs: 21_600_000,
    maxConcurrency: 3,
  });
  assert.equal(definition.proposal.proofs.at(-1).id, "PROOF-TELEMETRY-INTEGRATED");
  assert.equal(definition.proposal.proofs.at(-1).command, "task verify:integrated");
  for (const proof of definition.proposal.proofs) {
    assert.deepEqual(
      proof.verifierClosure.filter(({ role }) => role === "fixture").map(({ path }) => path),
      ["fixtures/events.json"],
    );
    assert.deepEqual(
      proof.verifierClosure.map(({ path }) => path).filter((path) => proof.candidateInputs.includes(path)),
      [],
      `${proof.id} must keep baseline verifier inputs disjoint from worker candidate inputs`,
    );
  }
});
