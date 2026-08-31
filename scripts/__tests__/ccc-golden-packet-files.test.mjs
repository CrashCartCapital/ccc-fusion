import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildEvidenceLedgerPacketDefinition } from "../lib/ccc-golden-packet.mjs";

async function loadPacketFiles() {
  try {
    return await import("../lib/ccc-golden-packet-files.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  }
}

async function loadPacketLifecycle() {
  try {
    return await import("../lib/ccc-golden-packet-lifecycle.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  }
}

const packetInput = () => ({
  targetRoot: "/tmp/ccc-golden-ledger-target",
  targetBase: "a".repeat(40),
  route: {
    providerId: "openai-compatible-omniroute",
    modelId: "openai-compatible-omniroute/runtime-probed-model",
    transport: "pi",
    receiptAdapterId: "terminal-route-sse-comments.v1",
  },
  maxRequests: 9,
  maxDurationMs: 600_000,
});

test("PRD:GOLDEN-3A packet source writer emits only deterministic PRD and support files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ccc-golden-packet-files-red-"));
  try {
    const { writeEvidenceLedgerPacketSources } = await loadPacketFiles();
    assert.equal(typeof writeEvidenceLedgerPacketSources, "function");
    const definition = buildEvidenceLedgerPacketDefinition(packetInput());
    const receipt = await writeEvidenceLedgerPacketSources(root, definition);

    assert.deepEqual(receipt, {
      prdPath: path.join(root, definition.projectName, definition.prdFileName),
      supportPath: path.join(root, definition.projectName, definition.supportRelativePath),
      fileCount: 2,
    });
    assert.deepEqual(await readdir(root), [definition.projectName]);
    assert.equal(await readFile(receipt.prdPath, "utf8"), definition.prd);
    assert.equal(await readFile(receipt.supportPath, "utf8"), definition.support);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-3A packet source writer rejects path traversal without outside residue", async () => {
  const { writeEvidenceLedgerPacketSources } = await loadPacketFiles();
  assert.equal(typeof writeEvidenceLedgerPacketSources, "function");
  const definition = buildEvidenceLedgerPacketDefinition(packetInput());
  const traversalCases = [
    ["projectName", ".."],
    ["prdFileName", "../../escaped-prd.md"],
    ["supportRelativePath", "../../escaped-support.md"],
  ];

  for (const [field, value] of traversalCases) {
    const parent = await mkdtemp(path.join(tmpdir(), `ccc-golden-packet-${field}-red-`));
    const root = path.join(parent, "packet-root");
    try {
      const error = await writeEvidenceLedgerPacketSources(root, {
        ...definition,
        [field]: value,
      }).then(
        () => null,
        (caught) => caught,
      );
      assert.deepEqual(
        {
          rejected: error instanceof Error,
          message: error?.message,
          parentEntries: (await readdir(parent)).sort(),
        },
        {
          rejected: true,
          message: `${field} must be a safe relative path`,
          parentEntries: [],
        },
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }
});

test("PRD:GOLDEN-3A packet passes freeze author validate compile and per-task policy through the built CLI", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "ccc-golden-packet-lifecycle-red-"));
  try {
    const { prepareEvidenceLedgerPacketLifecycle } = await loadPacketLifecycle();
    assert.equal(typeof prepareEvidenceLedgerPacketLifecycle, "function");
    const lifecycle = await prepareEvidenceLedgerPacketLifecycle({ root: parent, ...packetInput() });
    assert.match(lifecycle.baseCommit, /^[a-f0-9]{40}$/);
    assert.equal(lifecycle.receipts.freeze.manifestPath, lifecycle.manifestPath);
    assert.equal(lifecycle.receipts.author.kind, "candidate");
    assert.equal(lifecycle.receipts.validate.valid, true);
    assert.equal(lifecycle.receipts.compile.kind, "bundle");
    assert.equal(lifecycle.receipts.policy.kind, "execution-plan");
    assert.equal(lifecycle.receipts.policy.routeCount, 3);
    const plan = JSON.parse(await readFile(lifecycle.executionPlanPath, "utf8"));
    assert.deepEqual(plan.policy.routes.map(({ taskId }) => taskId), [
      "TASK-LEDGER-CLI",
      "TASK-LEDGER-CONTRACT",
      "TASK-LEDGER-CORE",
    ]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
