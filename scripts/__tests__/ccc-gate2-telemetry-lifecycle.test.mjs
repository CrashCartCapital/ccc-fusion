import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function loadLifecycle() {
  try {
    return await import("../lib/ccc-gate2-telemetry-lifecycle.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  }
}

const route = (providerId, modelId) => ({
  providerId,
  modelId,
  transport: "pi",
  receiptAdapterId: "terminal-route-sse-comments.v1",
  terminalRouteMembers: [{ provider: providerId, model: modelId }],
});

test("PRD:GATE2-04 telemetry lifecycle freezes authors validates compiles and policies the packet", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-gate2-lifecycle-red-"));
  try {
    const { prepareGate2TelemetryPacketLifecycle } = await loadLifecycle();
    assert.equal(typeof prepareGate2TelemetryPacketLifecycle, "function");
    const lifecycle = await prepareGate2TelemetryPacketLifecycle({
      root,
      routes: {
        minimax: route("minimax", "combo/minimax-latest"),
        glm: route("glm", "combo/glm-latest"),
        gemini: route("gemini", "combo/gemini-flash-latest"),
      },
      maxRequests: 2_304,
      maxDurationMs: 21_600_000,
      maxConcurrency: 3,
    });
    assert.match(lifecycle.baseCommit, /^[a-f0-9]{40}$/);
    assert.equal(lifecycle.receipts.freeze.manifestPath, lifecycle.manifestPath);
    assert.equal(lifecycle.receipts.author.kind, "candidate");
    assert.equal(lifecycle.receipts.validate.valid, true);
    assert.equal(lifecycle.receipts.compile.kind, "bundle");
    assert.equal(lifecycle.receipts.policy.kind, "execution-plan");
    assert.equal(lifecycle.receipts.policy.routeCount, 6);
    const plan = JSON.parse(await readFile(lifecycle.executionPlanPath, "utf8"));
    assert.deepEqual(plan.policy.routes.map(({ taskId }) => taskId), [
      "TASK-TELEMETRY-AUDIT",
      "TASK-TELEMETRY-BROADCAST",
      "TASK-TELEMETRY-CLI",
      "TASK-TELEMETRY-CONTRACT",
      "TASK-TELEMETRY-INGEST",
      "TASK-TELEMETRY-INTEGRATE",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GATE2-07 telemetry lifecycle can execute through an installed fn binary", async () => {
  const { buildGate2LifecycleCliInvocation } = await loadLifecycle();
  assert.equal(typeof buildGate2LifecycleCliInvocation, "function");
  assert.deepEqual(
    buildGate2LifecycleCliInvocation("/opt/gate2/bin/fn", ["prd", "status", "key", "--json"]),
    { command: "/opt/gate2/bin/fn", args: ["prd", "status", "key", "--json"] },
  );
});
