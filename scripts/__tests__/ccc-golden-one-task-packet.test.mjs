import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildEvidenceLedgerPacketDefinition } from "../lib/ccc-golden-packet.mjs";
import { prepareEvidenceLedgerPacketLifecycle } from "../lib/ccc-golden-packet-lifecycle.mjs";

const route = {
  providerId: "golden-omniroute-minimax-latest",
  modelId: "combo/minimax-latest",
  transport: "pi",
  receiptAdapterId: "terminal-route-sse-comments.v1",
  terminalRouteMembers: [{ provider: "minimax", model: "MiniMax-M3" }],
};

test("PRD:GOLDEN-4 one-task packet isolates the contract mutation and final proof", () => {
  const definition = buildEvidenceLedgerPacketDefinition({
    targetRoot: "/tmp/ccc-golden-one-task-target",
    targetBase: "a".repeat(40),
    route,
    maxRequests: 3,
    maxDurationMs: 180_000,
    taskCount: 1,
  });
  const { proposal } = definition;

  assert.deepEqual(proposal.tasks.map(({ id }) => id), ["TASK-LEDGER-CONTRACT"]);
  const description = proposal.tasks[0].description;
  assert.match(description, /parseEvidenceLine\(line, lineNumber\)/);
  assert.match(description, /validateEvidenceRecords\(records\)/);
  assert.match(description, /id, subject, claim, observedAt, source, confidence/);
  assert.match(description, /do not use new Date, Date\.now, randomUUID/);
  assert.match(description, /write both owned files by request 2/);
  assert.match(description, /Do not read the verifier unless the first proof fails/);
  assert.deepEqual(proposal.edges, []);
  assert.deepEqual(proposal.workflows[0], {
    ...proposal.workflows[0],
    taskIds: ["TASK-LEDGER-CONTRACT"],
    entryTaskIds: ["TASK-LEDGER-CONTRACT"],
    terminalTaskIds: ["TASK-LEDGER-CONTRACT"],
  });
  assert.deepEqual(proposal.requirements.map(({ id }) => id), ["REQ-LEDGER-CONTRACT"]);
  assert.deepEqual(proposal.proofs.map(({ id, phases, clauseIds, candidateInputs }) => ({
    id, phases, clauseIds, candidateInputs,
  })), [
    {
      id: "PROOF-LEDGER-CONTRACT",
      phases: ["task", "final_integrated"],
      clauseIds: ["AC-REQ-LEDGER-CONTRACT-001"],
      candidateInputs: ["src/record.mjs", "src/validation.mjs"],
    },
  ]);
  assert.deepEqual(proposal.protectedActions.map(({ id }) => id), [
    "ACTION-LEDGER-CONTRACT-LIVE",
    "ACTION-LEDGER-MERGE",
  ]);
  assert.deepEqual(Object.keys(definition.routes.routes), ["TASK-LEDGER-CONTRACT"]);
  assert.deepEqual(definition.operatorContext.taskCustody, {
    ownedPaths: ["src/record.mjs", "src/validation.mjs"],
    allowedWriteRoots: ["src/record.mjs", "src/validation.mjs"],
  });
  assert.equal(definition.prd.includes("REQ-LEDGER-CORE"), false);
  assert.equal(definition.prd.includes("REQ-LEDGER-CLI"), false);
});

test("PRD:GOLDEN-4 lifecycle forwards the one-task experiment boundary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-one-task-lifecycle-"));
  try {
    const lifecycle = await prepareEvidenceLedgerPacketLifecycle({
      root,
      route,
      maxRequests: 3,
      maxDurationMs: 180_000,
      taskCount: 1,
    });
    assert.deepEqual(lifecycle.definition.proposal.tasks.map(({ id }) => id), [
      "TASK-LEDGER-CONTRACT",
    ]);
    assert.deepEqual(Object.keys(lifecycle.definition.routes.routes), [
      "TASK-LEDGER-CONTRACT",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
