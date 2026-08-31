import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  expect,
  it,
} from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../../../core/src/__test-utils__/pg-test-harness.js";
import { drizzleSql as sql } from "../../../../core/src/index.js";
import type { ProjectContext } from "../../project-context.js";
import { runPrdCommand } from "../prd.js";

type PreparedLifecycle = {
  targetRoot: string;
  baseCommit: string;
  frozenRoot: string;
  manifestPath: string;
  sidecarPath: string;
  executionPlanPath: string;
};

type CommandJson = {
  kind?: string;
  confirmationDigest?: string;
  diagnostics?: Array<{ code?: string; message?: string }>;
  result?: unknown;
  status?: unknown;
};

async function prepareLifecycle(root: string): Promise<PreparedLifecycle> {
  const module = await import("../../../../../scripts/lib/ccc-golden-packet-lifecycle.mjs") as {
    prepareEvidenceLedgerPacketLifecycle(input: Record<string, unknown>): Promise<PreparedLifecycle>;
  };
  return module.prepareEvidenceLedgerPacketLifecycle({
    root,
    route: {
      providerId: "openai-compatible-omniroute",
      modelId: "openai-compatible-omniroute/runtime-probed-model",
      transport: "pi",
      receiptAdapterId: "terminal-route-sse-comments.v1",
    },
    maxRequests: 9,
    maxDurationMs: 600_000,
  });
}

pgDescribe.sequential("CCC golden Evidence Ledger import (PostgreSQL)", () => {
  const h = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ccc_golden_evidence_ledger",
  });
  let lifecycleRoot = "";
  let lifecycle: PreparedLifecycle;
  let packetArgs: string[];
  let preview: Awaited<ReturnType<typeof runCommand>>;
  const corruptManifestRunId = "ccc-golden-evidence-ledger-corrupt-manifest-v1";
  const corruptDependencyRunId = "ccc-golden-evidence-ledger-corrupt-dependency-v1";
  const idempotencyKey = "ccc-golden-evidence-ledger-import-v1";
  const invalidBaseIdempotencyKey = "ccc-golden-evidence-ledger-invalid-base-v1";

  beforeAll(async () => {
    await h.beforeAll();
    await h.beforeEach();
    lifecycleRoot = await mkdtemp(join(tmpdir(), "ccc-golden-import-"));
    lifecycle = await prepareLifecycle(lifecycleRoot);
    packetArgs = [
      lifecycle.frozenRoot,
      lifecycle.manifestPath,
      lifecycle.sidecarPath,
      lifecycle.executionPlanPath,
      lifecycle.targetRoot,
      lifecycle.baseCommit,
    ];
  });
  afterAll(async () => {
    await rm(lifecycleRoot, { recursive: true, force: true });
    await h.afterEach();
    await h.afterAll();
  });

  function commandDependencies() {
    const project = {
      projectId: h.layer().projectId || "__legacy_unscoped__",
      projectPath: lifecycle.targetRoot,
      projectName: "CCC Golden Evidence Ledger",
      isRegistered: true,
      store: h.store(),
    } satisfies ProjectContext;
    return {
      resolveProject: async () => project,
      closeProjectStore: async () => undefined,
      readTargetHead: async () => lifecycle.baseCommit,
      inspectVerifierConfinementReadiness: async () => ({
        ready: true as const,
        backend: "sandbox-exec" as const,
        code: "VERIFIER_CONFINEMENT_READY",
        message: "disposable PostgreSQL import fixture confinement ready",
        trustedPaths: ["/usr/bin/sandbox-exec"] as const,
      }),
    };
  }

  async function runCommand(args: string[]) {
    const output: string[] = [];
    const exitCode = await runPrdCommand(
      [...args, "--json"],
      { write: (line) => output.push(line) },
      commandDependencies(),
      { projectName: "ccc-golden-evidence-ledger" },
    );
    return {
      exitCode,
      output,
      json: output[0] ? JSON.parse(output[0]) as CommandJson : null,
    };
  }

  async function expectDatabaseEmpty() {
    const rows = (await h.layer().db.execute(sql.raw(`
      SELECT 'ccc_prd_import_entities' AS table_name, count(*)::int AS row_count FROM project.ccc_prd_import_entities
      UNION ALL SELECT 'ccc_prd_import_sources', count(*)::int FROM project.ccc_prd_import_sources
      UNION ALL SELECT 'ccc_prd_imports', count(*)::int FROM project.ccc_prd_imports
      UNION ALL SELECT 'missions', count(*)::int FROM project.missions
      UNION ALL SELECT 'run_audit_events', count(*)::int FROM project.run_audit_events
      UNION ALL SELECT 'tasks', count(*)::int FROM project.tasks
      UNION ALL SELECT 'workflow_work_items', count(*)::int FROM project.workflow_work_items
      UNION ALL SELECT 'workflows', count(*)::int FROM project.workflows
    `))) as unknown as Array<{ table_name: string; row_count: number }>;
    expect([...rows].sort((left, right) => left.table_name.localeCompare(right.table_name))).toEqual([
      { table_name: "ccc_prd_import_entities", row_count: 0 },
      { table_name: "ccc_prd_import_sources", row_count: 0 },
      { table_name: "ccc_prd_imports", row_count: 0 },
      { table_name: "missions", row_count: 0 },
      { table_name: "run_audit_events", row_count: 0 },
      { table_name: "tasks", row_count: 0 },
      { table_name: "workflow_work_items", row_count: 0 },
      { table_name: "workflows", row_count: 0 },
    ]);
  }

  it("refuses an invalid packet base and leaves zero rows for its import key", async () => {
    const invalidBaseArgs = [...packetArgs];
    invalidBaseArgs[5] = "0".repeat(40);
    const refused = await runCommand([
      "import",
      ...invalidBaseArgs,
      invalidBaseIdempotencyKey,
      "--confirm",
      "0".repeat(64),
    ]);
    expect(refused.exitCode, refused.output.join("\n")).toBe(1);
    expect(refused.json).toMatchObject({
      kind: "refusal",
      diagnostics: [expect.objectContaining({ code: "CCC_PRD_FOREIGN_BASE" })],
    });

    await expectDatabaseEmpty();
  });

  it("refuses a corrupt manifest digest with zero project effects", async () => {
    const manifest = JSON.parse(await readFile(lifecycle.manifestPath, "utf8")) as {
      entries: Array<{ sha256: string }>;
    };
    manifest.entries[0]!.sha256 = "0".repeat(64);
    const corruptManifestPath = join(lifecycle.frozenRoot, "manifest.corrupt.json");
    await writeFile(corruptManifestPath, `${JSON.stringify(manifest)}\n`);
    const corruptArgs = [...packetArgs];
    corruptArgs[1] = corruptManifestPath;
    const refused = await runCommand([
      "import", ...corruptArgs, corruptManifestRunId, "--confirm", "0".repeat(64),
    ]);
    expect(refused.exitCode, refused.output.join("\n")).toBe(1);
    expect(refused.json).toMatchObject({
      kind: "refusal",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "CCC_PRD_SOURCE_HASH_MISMATCH" }),
      ]),
    });
    await expectDatabaseEmpty();
  });

  it("refuses a corrupt dependency graph with zero project effects", async () => {
    const sidecar = JSON.parse(await readFile(lifecycle.sidecarPath, "utf8")) as {
      tasks: Array<{ id: string; dependencyTaskIds: string[] }>;
    };
    const core = sidecar.tasks.find(({ id }) => id === "TASK-LEDGER-CORE");
    if (!core) throw new Error("fixture sidecar omitted TASK-LEDGER-CORE");
    core.dependencyTaskIds = ["TASK-NOT-DECLARED"];
    const corruptSidecarPath = join(lifecycle.frozenRoot, "candidate.corrupt.sidecar.json");
    await writeFile(corruptSidecarPath, `${JSON.stringify(sidecar)}\n`);
    const corruptArgs = [...packetArgs];
    corruptArgs[2] = corruptSidecarPath;
    const refused = await runCommand([
      "import", ...corruptArgs, corruptDependencyRunId, "--confirm", "0".repeat(64),
    ]);
    expect(refused.exitCode, refused.output.join("\n")).toBe(1);
    expect(refused.json).toMatchObject({
      kind: "refusal",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "CCC_PRD_REFERENCE_FOREIGN" }),
      ]),
    });
    await expectDatabaseEmpty();
  });

  it("previews the exact packet and emits a confirmation digest", async () => {
    preview = await runCommand(["preview", ...packetArgs]);
    expect(preview.exitCode, preview.output.join("\n")).toBe(0);
    expect(preview.json).toMatchObject({
      kind: "preview",
      confirmationDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

  });

  it("transactionally imports the three-task campaign", async () => {
    const imported = await runCommand([
      "import",
      ...packetArgs,
      idempotencyKey,
      "--confirm",
      preview.json!.confirmationDigest,
    ]);
    expect(imported.exitCode, imported.output.join("\n")).toBe(0);
    expect(imported.json).toMatchObject({
      kind: "imported",
      result: {
        replayed: false,
        state: "active",
        runnable: true,
        directCounts: { campaigns: 1, tasks: 3, dependencyEdges: 2, workflows: 1, workItems: 1, runAudits: 1 },
      },
    });
  });

  it("idempotently replays without duplicate provider effects", async () => {
    const replay = await runCommand([
      "import",
      ...packetArgs,
      idempotencyKey,
      "--confirm",
      preview.json!.confirmationDigest,
    ]);
    expect(replay.exitCode, replay.output.join("\n")).toBe(0);
    expect(replay.json).toMatchObject({ kind: "imported", result: { replayed: true } });
  });

  it("reports all three tasks with zero provider attempts", async () => {
    const status = await runCommand(["status", idempotencyKey]);
    expect(status.exitCode, status.output.join("\n")).toBe(0);
    expect(status.json).toMatchObject({
      kind: "product-status",
      status: {
        tasks: expect.arrayContaining([
          expect.objectContaining({ semanticTaskId: "TASK-LEDGER-CONTRACT" }),
          expect.objectContaining({ semanticTaskId: "TASK-LEDGER-CORE" }),
          expect.objectContaining({ semanticTaskId: "TASK-LEDGER-CLI" }),
        ]),
        providerAttempts: [],
      },
    });
  });
});
