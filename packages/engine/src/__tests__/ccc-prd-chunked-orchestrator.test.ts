import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION,
  type CustomProvider,
} from "@fusion/core";
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
