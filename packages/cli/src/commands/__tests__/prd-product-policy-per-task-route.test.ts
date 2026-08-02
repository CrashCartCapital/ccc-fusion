import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CccPrdSemanticBundle, CccPrdSourceSpan } from "@fusion/core";
import * as engine from "@fusion/engine";
import { runPrdCommand } from "../prd.js";
import { cleanupPacketRoots, createPacketRoot } from "./prd-built-cli-fixture.js";

// The packet compiler (packages/engine) currently refuses any product bundle
// with more than one declared task whenever requireMaterialCoverage is set
// (CCC_PRD_PRODUCT_GRAPH_UNSUPPORTED), and `fn prd policy` always sets it.
// That is a separate, pre-existing engine constraint unrelated to per-task
// route selection. These tests stub the two compiler entry points the CLI
// calls (compileCccPrdPacket, validateCccPrdPacketImplementationFactProvenance)
// so the CLI's own --routes-file parsing and wiring to
// createCccPrdProductExecutionPlan (the real, un-mocked @fusion/core function)
// can be proven against a hand-built multi-task bundle.
vi.mock("@fusion/engine", async (importActual) => {
  const actual = await importActual<typeof import("@fusion/engine")>();
  return {
    ...actual,
    compileCccPrdPacket: vi.fn(),
    validateCccPrdPacketImplementationFactProvenance: vi.fn(() => []),
  };
});

afterEach(() => {
  cleanupPacketRoots();
  vi.mocked(engine.compileCccPrdPacket).mockReset();
  vi.mocked(engine.validateCccPrdPacketImplementationFactProvenance).mockReset()
    .mockReturnValue([]);
});

function span(): CccPrdSourceSpan {
  return {
    path: "packet.md",
    byteStart: 0,
    byteEnd: 1,
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 2,
    sha256: "a".repeat(64),
    excerptSha256: "a".repeat(64),
  };
}

const TASK_A_ID = "TASK-per-task-a";
const TASK_B_ID = "TASK-per-task-b";

function twoTaskBundle(target: string, base: string): CccPrdSemanticBundle {
  const requirementId = "REQ-per-task-route";
  const proofId = "PROOF-per-task-route";
  const workflowId = "WF-per-task-route";
  return {
    kind: "bundle",
    schema: "ccc-prd.bundle.v1",
    sourceHash: "a".repeat(64),
    sidecarHash: "b".repeat(64),
    bundleHash: "c".repeat(64),
    sourceVersion: "per-task-route-fixture",
    orderedSources: [{
      path: "packet.md",
      role: "root",
      authoritative: true,
      sha256: "a".repeat(64),
      byteLength: 1,
    }],
    provenance: {
      authoringAdapterId: "fixture",
      proposalHash: "d".repeat(64),
      packetHash: "a".repeat(64),
    },
    authorityRoles: [{
      id: "AUTH-root",
      role: "root",
      sourcePaths: ["packet.md"],
      accountableProducer: "fixture",
    }],
    requirements: [{
      id: requirementId,
      statement: "Route each task independently.",
      acceptance: "Each task carries its own provider and model.",
      accountableProducer: "fixture",
      dependencies: [],
      proofIds: [proofId],
      spans: [span()],
      confidence: "high",
    }],
    proofs: [{
      id: proofId,
      requirementIds: [requirementId],
      command: "pnpm test",
      positiveOracle: "exit 0",
      negativeControls: ["missing route refuses"],
      spans: [span()],
      confidence: "high",
    }],
    tasks: [
      {
        id: TASK_A_ID,
        title: "Task A",
        description: "First independent task.",
        accountableProducer: "fixture",
        requirementIds: [requirementId],
        dependencyTaskIds: [],
        proofIds: [proofId],
        workflowId,
        documentIds: [],
        artifactIds: [],
        protectedActionIds: [],
        ownedPaths: ["src/task-a"],
        allowedWriteRoots: ["src/task-a"],
        spans: [span()],
      },
      {
        id: TASK_B_ID,
        title: "Task B",
        description: "Second independent task.",
        accountableProducer: "fixture",
        requirementIds: [requirementId],
        dependencyTaskIds: [],
        proofIds: [proofId],
        workflowId,
        documentIds: [],
        artifactIds: [],
        protectedActionIds: [],
        ownedPaths: ["src/task-b"],
        allowedWriteRoots: ["src/task-b"],
        spans: [span()],
      },
    ],
    edges: [],
    workflows: [{
      id: workflowId,
      title: "Per-task workflow",
      taskIds: [TASK_A_ID, TASK_B_ID],
      entryTaskIds: [TASK_A_ID, TASK_B_ID],
      terminalTaskIds: [TASK_A_ID, TASK_B_ID],
      spans: [span()],
    }],
    documents: [],
    artifacts: [],
    importIntents: [],
    protectedActions: [],
    bounds: { maxRequests: 1, maxDurationMs: 30_000, maxConcurrency: 2 },
    admittedWriteRoots: [{ path: resolve(target, "src"), purpose: "fixture projection" }],
    targetRepository: { path: target, baseCommit: base },
    nonGoals: ["live provider call"],
    confidence: "high",
  };
}

function stubTwoTaskBundle(target: string, base: string): void {
  vi.mocked(engine.compileCccPrdPacket).mockReturnValue(twoTaskBundle(target, base));
}

describe("fn prd policy --routes-file (per-task route selection)", () => {
  it("wires distinct per-task provider/model/transport routes from a routes file into the execution plan", async () => {
    const packet = createPacketRoot();
    writeFileSync(packet.sidecar, "{}");
    stubTwoTaskBundle(packet.target, packet.base);
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, JSON.stringify({
      schema: "ccc-prd.routes-by-task.v1",
      routes: {
        [TASK_A_ID]: { providerId: "provider-x", modelId: "model-x", transport: "pi" },
        [TASK_B_ID]: {
          providerId: "provider-y",
          modelId: "model-y",
          transport: "cli",
          cliAdapterId: "adapter-y",
        },
      },
    }));
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy",
      packet.root,
      packet.manifest,
      packet.sidecar,
      packet.target,
      packet.base,
      outputPath,
      "--routes-file",
      routesPath,
    ], { write: (line) => output.push(line) });

    expect(exit, output.join("\n")).toBe(0);
    expect(existsSync(outputPath)).toBe(true);
    const plan = JSON.parse(readFileSync(outputPath, "utf8")) as {
      policy: { routes: Array<{
        taskId: string;
        providerId: string;
        modelId: string;
        transport: string;
        cliAdapterId?: string;
      }> };
    };
    const routeA = plan.policy.routes.find((route) => route.taskId === TASK_A_ID);
    const routeB = plan.policy.routes.find((route) => route.taskId === TASK_B_ID);
    expect(routeA).toMatchObject({ providerId: "provider-x", modelId: "model-x", transport: "pi" });
    expect(routeB).toMatchObject({
      providerId: "provider-y",
      modelId: "model-y",
      transport: "cli",
      cliAdapterId: "adapter-y",
    });
    expect(routeA!.providerId).not.toBe(routeB!.providerId);
    expect(routeA!.modelId).not.toBe(routeB!.modelId);
    expect(JSON.parse(output[0]!)).toMatchObject({ kind: "execution-plan", routeCount: 2 });
  });

  it("refuses when the routes file omits a declared task, surfacing the core missing/extra message", async () => {
    const packet = createPacketRoot();
    writeFileSync(packet.sidecar, "{}");
    stubTwoTaskBundle(packet.target, packet.base);
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, JSON.stringify({
      schema: "ccc-prd.routes-by-task.v1",
      routes: {
        [TASK_A_ID]: { providerId: "provider-x", modelId: "model-x", transport: "pi" },
      },
    }));
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy",
      packet.root,
      packet.manifest,
      packet.sidecar,
      packet.target,
      packet.base,
      outputPath,
      "--routes-file",
      routesPath,
    ], { write: (line) => output.push(line) });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    const refusal = JSON.parse(output[0]!) as { kind: string; diagnostics: Array<{ code: string; message: string }> };
    expect(refusal.kind).toBe("refusal");
    expect(refusal.diagnostics[0]!.message).toMatch(/routesByTaskId must bind every task exactly once/);
    expect(refusal.diagnostics[0]!.message).toContain(TASK_B_ID);
  });

  it("refuses when both --routes-file and --provider are given", async () => {
    const packet = createPacketRoot();
    writeFileSync(packet.sidecar, "{}");
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, JSON.stringify({
      schema: "ccc-prd.routes-by-task.v1",
      routes: { [TASK_A_ID]: { providerId: "provider-x", modelId: "model-x", transport: "pi" } },
    }));
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy",
      packet.root,
      packet.manifest,
      packet.sidecar,
      packet.target,
      packet.base,
      outputPath,
      "--routes-file",
      routesPath,
      "--provider",
      "deterministic-fake",
    ], { write: (line) => output.push(line) });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    expect(engine.compileCccPrdPacket).not.toHaveBeenCalled();
    const refusal = JSON.parse(output[0]!) as { kind: string; diagnostics: Array<{ code: string; message: string }> };
    expect(refusal.kind).toBe("refusal");
    expect(refusal.diagnostics[0]!.message).toContain("--routes-file");
    expect(refusal.diagnostics[0]!.message).toContain("--provider");
  });

  it("refuses when neither --routes-file nor --provider/--model/--transport is given", async () => {
    const packet = createPacketRoot();
    writeFileSync(packet.sidecar, "{}");
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy",
      packet.root,
      packet.manifest,
      packet.sidecar,
      packet.target,
      packet.base,
      outputPath,
    ], { write: (line) => output.push(line) });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    expect(engine.compileCccPrdPacket).not.toHaveBeenCalled();
    const refusal = JSON.parse(output[0]!) as { kind: string; diagnostics: Array<{ code: string; message: string }> };
    expect(refusal.kind).toBe("refusal");
    expect(refusal.diagnostics[0]!.message).toContain("--routes-file");
    expect(refusal.diagnostics[0]!.message).toContain("--provider");
  });

  it("refuses malformed JSON in the routes file, naming the path, and writes no plan file", async () => {
    const packet = createPacketRoot();
    writeFileSync(packet.sidecar, "{}");
    stubTwoTaskBundle(packet.target, packet.base);
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, "{");
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy",
      packet.root,
      packet.manifest,
      packet.sidecar,
      packet.target,
      packet.base,
      outputPath,
      "--routes-file",
      routesPath,
    ], { write: (line) => output.push(line) });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    const refusal = JSON.parse(output[0]!) as { kind: string; diagnostics: Array<{ code: string; message: string }> };
    expect(refusal.kind).toBe("refusal");
    expect(refusal.diagnostics[0]!.message).toContain(routesPath);
    expect(refusal.diagnostics[0]!.message).toMatch(/not valid JSON/);
  });

  it("refuses a routes file with the wrong schema", async () => {
    const packet = createPacketRoot();
    writeFileSync(packet.sidecar, "{}");
    stubTwoTaskBundle(packet.target, packet.base);
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, JSON.stringify({
      schema: "ccc-prd.routes-by-task.v0",
      routes: { [TASK_A_ID]: { providerId: "x", modelId: "y", transport: "pi" } },
    }));
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy", packet.root, packet.manifest, packet.sidecar, packet.target, packet.base,
      outputPath, "--routes-file", routesPath,
    ], { write: (line) => output.push(line) });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    const refusal = JSON.parse(output[0]!) as { diagnostics: Array<{ message: string }> };
    expect(refusal.diagnostics[0]!.message).toContain(routesPath);
    expect(refusal.diagnostics[0]!.message).toContain("ccc-prd.routes-by-task.v1");
  });

  it("refuses a routes file whose routes field is not an object", async () => {
    const packet = createPacketRoot();
    writeFileSync(packet.sidecar, "{}");
    stubTwoTaskBundle(packet.target, packet.base);
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, JSON.stringify({ schema: "ccc-prd.routes-by-task.v1", routes: [] }));
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy", packet.root, packet.manifest, packet.sidecar, packet.target, packet.base,
      outputPath, "--routes-file", routesPath,
    ], { write: (line) => output.push(line) });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    const refusal = JSON.parse(output[0]!) as { diagnostics: Array<{ message: string }> };
    expect(refusal.diagnostics[0]!.message).toContain(routesPath);
    expect(refusal.diagnostics[0]!.message).toMatch(/routes field must be an object/);
  });

  it("refuses a routes file with an empty routes object", async () => {
    const packet = createPacketRoot();
    writeFileSync(packet.sidecar, "{}");
    stubTwoTaskBundle(packet.target, packet.base);
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, JSON.stringify({ schema: "ccc-prd.routes-by-task.v1", routes: {} }));
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy", packet.root, packet.manifest, packet.sidecar, packet.target, packet.base,
      outputPath, "--routes-file", routesPath,
    ], { write: (line) => output.push(line) });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    const refusal = JSON.parse(output[0]!) as { diagnostics: Array<{ message: string }> };
    expect(refusal.diagnostics[0]!.message).toContain(routesPath);
    expect(refusal.diagnostics[0]!.message).toMatch(/at least one task route/);
  });

  it("refuses a route entry with an unknown field", async () => {
    const packet = createPacketRoot();
    writeFileSync(packet.sidecar, "{}");
    stubTwoTaskBundle(packet.target, packet.base);
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, JSON.stringify({
      schema: "ccc-prd.routes-by-task.v1",
      routes: {
        [TASK_A_ID]: { providerId: "x", modelId: "y", transport: "pi" },
        [TASK_B_ID]: { providerId: "x", modelId: "y", transport: "pi", surprise: true },
      },
    }));
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy", packet.root, packet.manifest, packet.sidecar, packet.target, packet.base,
      outputPath, "--routes-file", routesPath,
    ], { write: (line) => output.push(line) });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    const refusal = JSON.parse(output[0]!) as { diagnostics: Array<{ message: string }> };
    expect(refusal.diagnostics[0]!.message).toContain(routesPath);
    expect(refusal.diagnostics[0]!.message).toContain(TASK_B_ID);
    expect(refusal.diagnostics[0]!.message).toMatch(/unknown fields/);
  });

  it("refuses a cli-transport route entry that omits cliAdapterId", async () => {
    const packet = createPacketRoot();
    writeFileSync(packet.sidecar, "{}");
    stubTwoTaskBundle(packet.target, packet.base);
    const routesPath = join(packet.root, "routes.json");
    writeFileSync(routesPath, JSON.stringify({
      schema: "ccc-prd.routes-by-task.v1",
      routes: {
        [TASK_A_ID]: { providerId: "x", modelId: "y", transport: "pi" },
        [TASK_B_ID]: { providerId: "x", modelId: "y", transport: "cli" },
      },
    }));
    const outputPath = join(packet.root, "execution-plan.json");
    const output: string[] = [];

    const exit = await runPrdCommand([
      "policy", packet.root, packet.manifest, packet.sidecar, packet.target, packet.base,
      outputPath, "--routes-file", routesPath,
    ], { write: (line) => output.push(line) });

    expect(exit).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    const refusal = JSON.parse(output[0]!) as { diagnostics: Array<{ message: string }> };
    expect(refusal.diagnostics[0]!.message).toContain(routesPath);
    expect(refusal.diagnostics[0]!.message).toContain(TASK_B_ID);
  });
});
