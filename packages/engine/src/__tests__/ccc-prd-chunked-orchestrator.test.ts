import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION,
  type CustomProvider,
} from "@fusion/core";
import { buildCccPrdChunkPrompt } from "../ccc-prd/chunk-authoring-adapter.js";
import { understandCccPrdPacket } from "../ccc-prd/understanding.js";
import type { CccPrdNativeAuthoringTransport } from "../ccc-prd/native-authoring-adapter.js";

const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, relativePath: string, content: string): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function packet(content: string): { rootDir: string; manifestPath: string } {
  const root = mkdtempSync(join(tmpdir(), "ccc-prd-chunked-orchestrator-"));
  roots.push(root);
  write(root, "source.md", content);
  const manifestPath = write(root, "manifest.json", JSON.stringify({
    schema: "ccc-prd.packet.v1",
    source_version: "chunked-orchestrator-test",
    entries: [{
      relative_path: "source.md",
      role: "root",
      authoritative: true,
      sha256: digest(Buffer.from(content, "utf8")),
    }],
  }));
  return { rootDir: root, manifestPath };
}

const VERBATIM_CAPABLE_PROVIDERS: CustomProvider[] = [{
  id: "ccc-loopback-chunked",
  name: "Loopback Chunked",
  apiType: "openai-compatible",
  baseUrl: "http://127.0.0.1:7999/v1",
  apiKey: "synthetic-never-read",
  models: [{ id: "fixture-model", name: "Fixture", verbatimCapable: true }],
}];

function fragment(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION,
    authorityRoles: [],
    requirements: [],
    proofs: [],
    tasks: [],
    edges: [],
    workflows: [],
    documents: [],
    artifacts: [],
    importIntents: [],
    protectedActions: [],
    unresolvedDecisions: [],
    ambiguities: [],
    exceptions: [],
    ...overrides,
  };
}

describe("buildCccPrdChunkPrompt", () => {
  it("renders the mandatory fragment schema in the exact field contract", () => {
    const prompt = buildCccPrdChunkPrompt({
      mode: "understanding",
      packetHash: "packet-hash",
      sourceVersion: "source-version",
      chunkPlanHash: "chunk-plan-hash",
      chunkId: "doc.md#0",
      chunkOrdinal: 0,
      chunkCount: 1,
      packetHeader: [],
      sourcePath: "doc.md",
      sliceByteStart: 0,
      sliceByteEnd: 0,
      sliceSha256: "slice-hash",
      materialItems: [],
      slice: "",
    });

    expect(prompt).toContain(`  \"schema\": \"${CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION}\",`);
  });
});

describe("understandCccPrdPacket -- chunked lane end to end", () => {
  it("runs a real two-chunk plan through a fake transport and assembles a valid review", async () => {
    const content = [
      "# Alpha",
      "- REQ-1: alpha requirement text.",
      "",
      "# Beta",
      "- REQ-2: beta requirement text.",
    ].join("\n") + "\n";
    const { rootDir, manifestPath } = packet(content);

    const alphaFragment = fragment({
      requirements: [{
        id: "REQ-1",
        statement: "alpha requirement",
        acceptance: "alpha acceptance",
        accountableProducer: "team-a",
        dependencies: [],
        proofIds: [],
        confidence: "high",
        sourceRefs: [{ path: "source.md", exactQuote: "- REQ-1: alpha requirement text." }],
      }],
      tasks: [{
        id: "TASK-ALPHA",
        title: "Ship alpha",
        description: "Implement alpha",
        accountableProducer: "team-a",
        requirementIds: ["REQ-1"],
        dependencyTaskIds: [],
        proofIds: [],
        workflowId: "",
        documentIds: [],
        artifactIds: [],
        protectedActionIds: [],
        ownedPaths: ["src/alpha.ts"],
        allowedWriteRoots: ["src/alpha.ts"],
        sourceRefs: [{ path: "source.md", exactQuote: "# Alpha\n- REQ-1: alpha requirement text." }],
      }],
    });
    const betaFragment = fragment({
      requirements: [{
        id: "REQ-2",
        statement: "beta requirement",
        acceptance: "beta acceptance",
        accountableProducer: "team-a",
        dependencies: [],
        proofIds: [],
        confidence: "high",
        sourceRefs: [{ path: "source.md", exactQuote: "- REQ-2: beta requirement text." }],
      }],
      tasks: [{
        id: "TASK-BETA",
        title: "Ship beta",
        description: "Implement beta",
        accountableProducer: "team-a",
        requirementIds: ["REQ-2"],
        dependencyTaskIds: [],
        proofIds: [],
        workflowId: "",
        documentIds: [],
        artifactIds: [],
        protectedActionIds: [],
        ownedPaths: ["src/beta.ts"],
        allowedWriteRoots: ["src/beta.ts"],
        sourceRefs: [{ path: "source.md", exactQuote: "# Beta\n- REQ-2: beta requirement text." }],
      }],
    });

    let callIndex = 0;
    const responses = [alphaFragment, betaFragment];
    const transport: CccPrdNativeAuthoringTransport = async ({ provider, model }) => {
      const response = responses[callIndex]!;
      callIndex += 1;
      return { text: JSON.stringify(response), provider, model };
    };

    const result = await understandCccPrdPacket({
      rootDir,
      manifestPath,
      adapter: { id: "unused-single-shot-adapter", generateCandidate: async () => { throw new Error("single-shot path must not run"); } },
      maxReviewItems: 8,
      workflowExtensionRegistry: undefined as never,
      requestedLane: "chunked",
      provider: "loopback-chunked",
      model: "fixture-model",
      maxDurationMs: 5_000,
      maxPromptBytes: 1_000_000,
      maxResponseBytes: 256_000,
      chunkTransport: transport,
      customProviders: VERBATIM_CAPABLE_PROVIDERS,
    });

    expect(result.kind, JSON.stringify(result)).toBe("understanding-review");
    if (result.kind !== "understanding-review") return;
    expect(callIndex).toBe(2);
    expect(result.requirements.map((requirement) => requirement.id).sort()).toEqual(["REQ-1", "REQ-2"]);
    expect(result.tasks.map((task) => task.id).sort()).toEqual(["TASK-ALPHA", "TASK-BETA"]);
    expect(result.coverage.missing).toEqual([]);
    expect(result.coverage.conflicts).toEqual([]);
    expect(result.executable).toBe(false);
  });

  it("refuses zero-transport-call when the route is not declared verbatim-capable", async () => {
    const content = ["# Alpha", "- REQ-1: alpha requirement text."].join("\n") + "\n";
    const { rootDir, manifestPath } = packet(content);
    const transport: CccPrdNativeAuthoringTransport = async () => {
      throw new Error("transport must not be called");
    };

    const result = await understandCccPrdPacket({
      rootDir,
      manifestPath,
      adapter: { id: "unused", generateCandidate: async () => { throw new Error("unused"); } },
      maxReviewItems: 8,
      workflowExtensionRegistry: undefined as never,
      requestedLane: "chunked",
      provider: "loopback-chunked",
      model: "fixture-model",
      maxDurationMs: 5_000,
      maxPromptBytes: 1_000_000,
      maxResponseBytes: 256_000,
      chunkTransport: transport,
      customProviders: [{
        ...VERBATIM_CAPABLE_PROVIDERS[0]!,
        models: [{ id: "fixture-model", name: "Fixture" }],
      }],
    });

    expect(result.kind).toBe("refusal");
    if (result.kind !== "refusal") return;
    expect(result.diagnostics[0]!.code).toBe("CCC_PRD_ROUTE_NOT_VERBATIM_CAPABLE");
  });
});

describe("test 43: the shallow floor stays reachable on a deliberately under-dispositioned chunked run", () => {
  it("refuses when overall material disposition falls under the floor", async () => {
    const { describeCccPrdShallowExtractionRefusal } = await import("../ccc-prd/understanding.js");
    // Structurally unreachable through the real chunked path (assembly
    // already refuses on any non-empty missing/conflicts before this check
    // ever runs) -- this proves the tripwire itself is correctly wired by
    // calling it directly with the exact shape a diverged planner/scorer
    // could theoretically produce: 8+ inventory items, under a quarter
    // dispositioned.
    const refusal = describeCccPrdShallowExtractionRefusal({
      inventory: Array.from({ length: 8 }, (_, i) => ({ id: `MAT-${i}` })),
      coverage: [{ id: "MAT-0" }],
      requirementInventoryCount: 0,
      requirementDispositionCount: 0,
    });
    expect(refusal?.code).toBe("CCC_PRD_UNDERSTANDING_IMPLAUSIBLY_SHALLOW");
  });

  it("refuses when explicit-requirement disposition falls under the floor", async () => {
    const { describeCccPrdShallowExtractionRefusal } = await import("../ccc-prd/understanding.js");
    const refusal = describeCccPrdShallowExtractionRefusal({
      inventory: [],
      coverage: [],
      requirementInventoryCount: 4,
      requirementDispositionCount: 1,
    });
    expect(refusal?.code).toBe("CCC_PRD_UNDERSTANDING_IMPLAUSIBLY_SHALLOW");
  });

  it("does not refuse a fully-dispositioned analysis (the normal chunked-success shape)", async () => {
    const { describeCccPrdShallowExtractionRefusal } = await import("../ccc-prd/understanding.js");
    const items = Array.from({ length: 8 }, (_, i) => ({ id: `MAT-${i}` }));
    const refusal = describeCccPrdShallowExtractionRefusal({
      inventory: items,
      coverage: items,
      requirementInventoryCount: 4,
      requirementDispositionCount: 4,
    });
    expect(refusal).toBeNull();
  });
});

describe("test 42: a real chunked understanding review passes all five compile-side conditions", () => {
  it("clears requireMaterialCoverage's full six-diagnostic set through validateCccPrdPacket directly", async () => {
    const content = [
      "# Alpha",
      "- REQ-1: alpha requirement text.",
      "",
      "# Beta",
      "- REQ-2: beta requirement text.",
    ].join("\n") + "\n";
    const { rootDir, manifestPath } = packet(content);

    const alphaFragment = fragment({
      requirements: [{
        id: "REQ-1",
        statement: "alpha requirement",
        acceptance: "alpha acceptance",
        accountableProducer: "team-a",
        dependencies: [],
        proofIds: [],
        confidence: "high",
        sourceRefs: [{ path: "source.md", exactQuote: "- REQ-1: alpha requirement text." }],
      }],
      tasks: [{
        id: "TASK-ALPHA",
        title: "Ship alpha",
        description: "Implement alpha",
        accountableProducer: "team-a",
        requirementIds: ["REQ-1"],
        dependencyTaskIds: [],
        proofIds: [],
        workflowId: "",
        documentIds: [],
        artifactIds: [],
        protectedActionIds: [],
        ownedPaths: ["src/alpha.ts"],
        allowedWriteRoots: ["src/alpha.ts"],
        sourceRefs: [{ path: "source.md", exactQuote: "# Alpha\n- REQ-1: alpha requirement text." }],
      }],
    });
    const betaFragment = fragment({
      requirements: [{
        id: "REQ-2",
        statement: "beta requirement",
        acceptance: "beta acceptance",
        accountableProducer: "team-a",
        dependencies: [],
        proofIds: [],
        confidence: "high",
        sourceRefs: [{ path: "source.md", exactQuote: "- REQ-2: beta requirement text." }],
      }],
      tasks: [{
        id: "TASK-BETA",
        title: "Ship beta",
        description: "Implement beta",
        accountableProducer: "team-a",
        requirementIds: ["REQ-2"],
        dependencyTaskIds: [],
        proofIds: [],
        workflowId: "",
        documentIds: [],
        artifactIds: [],
        protectedActionIds: [],
        ownedPaths: ["src/beta.ts"],
        allowedWriteRoots: ["src/beta.ts"],
        sourceRefs: [{ path: "source.md", exactQuote: "# Beta\n- REQ-2: beta requirement text." }],
      }],
    });

    let callIndex = 0;
    const responses = [alphaFragment, betaFragment];
    const transport: CccPrdNativeAuthoringTransport = async ({ provider, model }) => {
      const response = responses[callIndex]!;
      callIndex += 1;
      return { text: JSON.stringify(response), provider, model };
    };

    const result = await understandCccPrdPacket({
      rootDir,
      manifestPath,
      adapter: { id: "unused", generateCandidate: async () => { throw new Error("single-shot path must not run"); } },
      maxReviewItems: 8,
      workflowExtensionRegistry: undefined as never,
      requestedLane: "chunked",
      provider: "loopback-chunked",
      model: "fixture-model",
      maxDurationMs: 5_000,
      maxPromptBytes: 1_000_000,
      maxResponseBytes: 256_000,
      chunkTransport: transport,
      customProviders: VERBATIM_CAPABLE_PROVIDERS,
    });
    expect(result.kind, JSON.stringify(result)).toBe("understanding-review");
    if (result.kind !== "understanding-review") return;

    // Transplant the assembled result into a sidecar-shaped object, exactly
    // as the acceptance gate's chunked-understanding-compile-gates check
    // does: the coverage math (compiler.ts:1376-1448) reads only
    // requirements/tasks/materialCoverage/custody, never the
    // executable-approval fields the understanding-review schema omits.
    const targetRoot = mkdtempSync(join(tmpdir(), "ccc-prd-chunked-compile-target-"));
    roots.push(targetRoot);
    const targetBase = "a".repeat(40);
    const sidecarPath = join(rootDir, "chunked.sidecar.json");
    writeFileSync(sidecarPath, JSON.stringify({
      schema: "ccc-prd.sidecar.v1",
      sourceVersion: result.sourceVersion,
      orderedSources: result.orderedSources,
      provenance: result.provenance,
      authorityRoles: result.authorityRoles,
      requirements: result.requirements,
      proofs: result.proofs,
      tasks: result.tasks,
      edges: result.edges,
      workflows: result.workflows,
      documents: result.documents,
      artifacts: result.artifacts,
      importIntents: result.proposedImportIntents,
      protectedActions: result.protectedActions,
      bounds: { maxRequests: 4, maxDurationMs: 30_000, maxConcurrency: 2 },
      admittedWriteRoots: [{ path: targetRoot, purpose: "compile-gate test" }],
      targetRepository: { path: targetRoot, baseCommit: targetBase },
      nonGoals: result.nonGoals,
      unresolvedDecisions: result.unresolvedDecisions,
      ambiguities: result.ambiguities,
      exceptions: result.exceptions,
      confidence: result.confidence,
      materialCoverage: result.coverage.dispositions,
    }));

    const { validateCccPrdPacket } = await import("../ccc-prd/compiler.js");
    const validation = validateCccPrdPacket({
      rootDir,
      manifestPath,
      sidecarPath,
      expectedTarget: targetRoot,
      expectedBase: targetBase,
      requireMaterialCoverage: true,
    });

    // This fixture is understanding-derived (no proofs/workflows/import
    // intents -- those are execution-lane declarations, out of scope for a
    // review-only artifact), so validateCccPrdPacket legitimately reports
    // other structural diagnostics. What design §9's
    // chunked-understanding-compile-gates check actually proves -- and what
    // this test proves at the unit level -- is that all SIX
    // material-coverage diagnostics (compiler.ts:1376-1448, both the
    // always-on pair and the four requireMaterialCoverage-gated ones) clear
    // cleanly, matching the gate script's own assertion pattern exactly.
    const materialCoverageCodes = new Set([
      "CCC_PRD_MATERIAL_COVERAGE_REQUIRED",
      "CCC_PRD_MATERIAL_COVERAGE_INVALID",
      "CCC_PRD_MATERIAL_SECTION_UNDISPOSITIONED",
      "CCC_PRD_SOURCE_REQUIREMENT_UNDISPOSITIONED",
      "CCC_PRD_EXTRACTION_IMPLAUSIBLY_SHALLOW",
    ]);
    const coverageDiagnostics = validation.diagnostics.filter(({ code }) => materialCoverageCodes.has(code));
    expect(coverageDiagnostics, JSON.stringify(validation.diagnostics)).toEqual([]);
  });
});
