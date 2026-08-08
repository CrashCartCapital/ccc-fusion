import { describe, expect, it, vi } from "vitest";
import { CCC_PRD_AUTHORING_PROPOSAL_FRAGMENT_SCHEMA_VERSION } from "@fusion/core";
import { CccPrdCustodyError } from "../ccc-prd/custody.js";
import {
  checkCccPrdChunkReviewBudget,
  runCccPrdChunkAttempt,
  verifyCccPrdChunkFragment,
  type CccPrdChunkAttemptTransport,
} from "../ccc-prd/chunk-verification.js";
import { analyzeCccPrdMaterialCoverage } from "../ccc-prd/material-coverage.js";

const SOURCE_PATH = "doc.md";

function baseFragment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function fixture() {
  const text = [
    "# Alpha",
    "- REQ-1: alpha must ship a health endpoint.",
  ].join("\n") + "\n";
  const fullSourceBytes = Buffer.from(text, "utf8");
  return { fullSourceBytes, sliceBounds: { byteStart: 0, byteEnd: fullSourceBytes.byteLength } };
}

describe("verifyCccPrdChunkFragment", () => {
  it("refuses a malformed fragment shape with CCC_PRD_CHUNK_FRAGMENT_INVALID", () => {
    const { fullSourceBytes, sliceBounds } = fixture();

    const outcome = verifyCccPrdChunkFragment({
      fragment: {},
      sourcePath: SOURCE_PATH,
      fullSourceBytes,
      sliceBounds,
      assignedMaterialItemIds: [],
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("CCC_PRD_CHUNK_FRAGMENT_INVALID");
      expect(outcome.violations.length).toBeGreaterThan(0);
      expect(outcome.retryEligible).toBe(true);
    }
  });

  it("test 23: a fragment emitting only requirements fails chunk coverage (requirements alone never disposition)", () => {
    const { fullSourceBytes, sliceBounds } = fixture();
    const fragment = baseFragment({
      requirements: [{
        id: "REQ-1",
        statement: "alpha must ship a health endpoint",
        acceptance: "GET /health returns 200",
        accountableProducer: "team-a",
        dependencies: [],
        proofIds: [],
        confidence: "high",
        sourceRefs: [{ path: SOURCE_PATH, exactQuote: "- REQ-1: alpha must ship a health endpoint." }],
      }],
    });

    // A requirement-only fragment must never satisfy coverage for the
    // heading's own material item -- assert against the actual inventory
    // id computed from the fixture, since matching requirements alone
    // never disposition anything (material-coverage.ts:216-223).
    const analysis = analyzeCccPrdMaterialCoverage({
      sourceBytes: new Map([[SOURCE_PATH, fullSourceBytes]]),
      requirements: [],
      tasks: [],
      unresolvedDecisions: [],
    });
    const sectionItemId = analysis.inventory.find((item) => item.materialKind === "section")!.id;

    const outcomeWithRealAssignment = verifyCccPrdChunkFragment({
      fragment,
      sourcePath: SOURCE_PATH,
      fullSourceBytes,
      sliceBounds,
      assignedMaterialItemIds: [sectionItemId],
    });

    expect(outcomeWithRealAssignment.ok).toBe(false);
    if (!outcomeWithRealAssignment.ok) {
      expect(outcomeWithRealAssignment.code).toBe("CCC_PRD_CHUNK_MATERIAL_UNDISPOSITIONED");
      expect(outcomeWithRealAssignment.retryEligible).toBe(true);
    }
  });

  it("test 24: a fragment emitting a task for each assigned item passes", () => {
    const { fullSourceBytes, sliceBounds } = fixture();
    const inventory = analyzeCccPrdMaterialCoverage({
      sourceBytes: new Map([[SOURCE_PATH, fullSourceBytes]]),
      requirements: [],
      tasks: [],
      unresolvedDecisions: [],
    }).inventory;
    const sectionItemId = inventory.find((item) => item.materialKind === "section")!.id;
    const requirementItemId = inventory.find((item) => item.materialKind === "requirement")!.id;

    const fragment = baseFragment({
      requirements: [{
        id: "REQ-1",
        statement: "alpha must ship a health endpoint",
        acceptance: "GET /health returns 200",
        accountableProducer: "team-a",
        dependencies: [],
        proofIds: [],
        confidence: "high",
        sourceRefs: [{ path: SOURCE_PATH, exactQuote: "- REQ-1: alpha must ship a health endpoint." }],
      }],
      tasks: [{
        id: "TASK-1",
        title: "Ship health endpoint",
        description: "Implement GET /health",
        accountableProducer: "team-a",
        requirementIds: ["REQ-1"],
        dependencyTaskIds: [],
        proofIds: [],
        workflowId: "",
        documentIds: [],
        artifactIds: [],
        protectedActionIds: [],
        ownedPaths: ["src/health.ts"],
        allowedWriteRoots: ["src/health.ts"],
        sourceRefs: [{ path: SOURCE_PATH, exactQuote: "# Alpha\n- REQ-1: alpha must ship a health endpoint." }],
      }],
    });

    const outcome = verifyCccPrdChunkFragment({
      fragment,
      sourcePath: SOURCE_PATH,
      fullSourceBytes,
      sliceBounds,
      assignedMaterialItemIds: [sectionItemId, requirementItemId],
    });

    expect(outcome.ok).toBe(true);
  });

  it("test 25: a fragment whose unresolved decision covers an item passes", () => {
    const { fullSourceBytes, sliceBounds } = fixture();
    const sectionItemId = analyzeCccPrdMaterialCoverage({
      sourceBytes: new Map([[SOURCE_PATH, fullSourceBytes]]),
      requirements: [],
      tasks: [],
      unresolvedDecisions: [],
    }).inventory.find((item) => item.materialKind === "section")!.id;

    const fragment = baseFragment({
      unresolvedDecisions: [{
        id: "UD-1",
        question: "Alpha",
        state: "unresolved",
        sourceRefs: [{ path: SOURCE_PATH, exactQuote: "# Alpha\n- REQ-1: alpha must ship a health endpoint." }],
      }],
    });

    const outcome = verifyCccPrdChunkFragment({
      fragment,
      sourcePath: SOURCE_PATH,
      fullSourceBytes,
      sliceBounds,
      assignedMaterialItemIds: [sectionItemId],
    });

    expect(outcome.ok).toBe(true);
  });

  it("test 26: an assigned item landing in conflicts refuses at chunk scope", () => {
    // The heading has to DECLARE deferral outright, not merely mention it: only
    // a pure disposition heading disposes its section (material-coverage.ts).
    const text = [
      "# Deferred Work",
      "This work is deferred to a later phase.",
    ].join("\n") + "\n";
    const fullSourceBytes = Buffer.from(text, "utf8");
    const sliceBounds = { byteStart: 0, byteEnd: fullSourceBytes.byteLength };
    const sectionItemId = analyzeCccPrdMaterialCoverage({
      sourceBytes: new Map([[SOURCE_PATH, fullSourceBytes]]),
      requirements: [],
      tasks: [],
      unresolvedDecisions: [],
    }).inventory.find((item) => item.materialKind === "section")!.id;

    const fragment = baseFragment({
      tasks: [{
        id: "TASK-1",
        title: "Ship it anyway",
        description: "Implement it now",
        accountableProducer: "team-a",
        requirementIds: [],
        dependencyTaskIds: [],
        proofIds: [],
        workflowId: "",
        documentIds: [],
        artifactIds: [],
        protectedActionIds: [],
        ownedPaths: ["src/x.ts"],
        allowedWriteRoots: ["src/x.ts"],
        sourceRefs: [{ path: SOURCE_PATH, exactQuote: "# Deferred Work\nThis work is deferred to a later phase." }],
      }],
    });

    const outcome = verifyCccPrdChunkFragment({
      fragment,
      sourcePath: SOURCE_PATH,
      fullSourceBytes,
      sliceBounds,
      assignedMaterialItemIds: [sectionItemId],
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("CCC_PRD_CHUNK_MATERIAL_CONFLICTED");
    }
  });

  it("test 26b: names the offending material item by heading, not just its hash", () => {
    // This violation is fed back to the model as a retry instruction, so it has
    // to name something findable in the source. "MAT-<sha256 prefix>" is not.
    const text = [
      "# Alpha",
      "- REQ-1: alpha must ship a health endpoint.",
    ].join("\n") + "\n";
    const fullSourceBytes = Buffer.from(text, "utf8");
    const sliceBounds = { byteStart: 0, byteEnd: fullSourceBytes.byteLength };
    const sectionItemId = analyzeCccPrdMaterialCoverage({
      sourceBytes: new Map([[SOURCE_PATH, fullSourceBytes]]),
      requirements: [],
      tasks: [],
      unresolvedDecisions: [],
    }).inventory.find((item) => item.materialKind === "section")!.id;

    const outcome = verifyCccPrdChunkFragment({
      fragment: baseFragment({}),
      sourcePath: SOURCE_PATH,
      fullSourceBytes,
      sliceBounds,
      assignedMaterialItemIds: [sectionItemId],
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("CCC_PRD_CHUNK_MATERIAL_UNDISPOSITIONED");
      expect(outcome.violations).toHaveLength(1);
      expect(outcome.violations[0]).toContain("Alpha");
      // The stable id stays as a secondary identifier for machine correlation.
      expect(outcome.violations[0]).toContain(sectionItemId);
    }
  });

  it("test 27: refuses a fragment quoting bytes outside its slice", () => {
    const text = ["# Alpha", "First slice text.", "# Beta", "Second slice text."].join("\n") + "\n";
    const fullSourceBytes = Buffer.from(text, "utf8");
    const firstSliceEnd = Buffer.byteLength("# Alpha\nFirst slice text.\n");
    const sliceBounds = { byteStart: 0, byteEnd: firstSliceEnd };

    const fragment = baseFragment({
      requirements: [{
        id: "REQ-1",
        statement: "x",
        acceptance: "x",
        accountableProducer: "team-a",
        dependencies: [],
        proofIds: [],
        confidence: "high",
        sourceRefs: [{ path: SOURCE_PATH, exactQuote: "Second slice text." }],
      }],
    });

    const outcome = verifyCccPrdChunkFragment({
      fragment,
      sourcePath: SOURCE_PATH,
      fullSourceBytes,
      sliceBounds,
      assignedMaterialItemIds: [],
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("CCC_PRD_CHUNK_QUOTE_OUTSIDE_SLICE");
      expect(outcome.retryEligible).toBe(true);
    }
  });

  /*
  The retry loop feeds these violation strings back into the next attempt's
  prompt. A message that names only the row id tells the model which row
  failed but never which string it got wrong, so every attempt carries
  identical, information-free feedback. The offending quote must be in the
  message.
  */
  it("test 27b: names the offending quote in the outside-slice violation", () => {
    const text = ["# Alpha", "First slice text.", "# Beta", "Second slice text."].join("\n") + "\n";
    const fullSourceBytes = Buffer.from(text, "utf8");
    const firstSliceEnd = Buffer.byteLength("# Alpha\nFirst slice text.\n");
    const sliceBounds = { byteStart: 0, byteEnd: firstSliceEnd };
    const offendingQuote = "Second slice text.";

    const fragment = baseFragment({
      requirements: [{
        id: "REQ-1",
        statement: "x",
        acceptance: "x",
        accountableProducer: "team-a",
        dependencies: [],
        proofIds: [],
        confidence: "high",
        sourceRefs: [{ path: SOURCE_PATH, exactQuote: offendingQuote }],
      }],
    });

    const outcome = verifyCccPrdChunkFragment({
      fragment,
      sourcePath: SOURCE_PATH,
      fullSourceBytes,
      sliceBounds,
      assignedMaterialItemIds: [],
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.violations).toHaveLength(1);
      // JSON.stringify so escapes and invisible characters survive the message.
      expect(outcome.violations[0]).toContain(JSON.stringify(offendingQuote));
      expect(outcome.violations[0]).toContain(
        `${Buffer.byteLength(offendingQuote, "utf8")} bytes`,
      );
    }
  });

  /*
  Violations are concatenated into the retry prompt, which has a hard
  maxPromptBytes ceiling that throws when exceeded. A long quote must be
  truncated in the message while still reporting its untruncated byte length.
  */
  it("test 27c: truncates a long offending quote but reports its full byte length", () => {
    const longQuote = "Z".repeat(500);
    const text = ["# Alpha", "First slice text.", "# Beta", longQuote].join("\n") + "\n";
    const fullSourceBytes = Buffer.from(text, "utf8");
    const firstSliceEnd = Buffer.byteLength("# Alpha\nFirst slice text.\n");
    const sliceBounds = { byteStart: 0, byteEnd: firstSliceEnd };

    const fragment = baseFragment({
      requirements: [{
        id: "REQ-1",
        statement: "x",
        acceptance: "x",
        accountableProducer: "team-a",
        dependencies: [],
        proofIds: [],
        confidence: "high",
        sourceRefs: [{ path: SOURCE_PATH, exactQuote: longQuote }],
      }],
    });

    const outcome = verifyCccPrdChunkFragment({
      fragment,
      sourcePath: SOURCE_PATH,
      fullSourceBytes,
      sliceBounds,
      assignedMaterialItemIds: [],
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const [violation] = outcome.violations;
      expect(violation).toContain("Z".repeat(200));
      expect(violation).not.toContain("Z".repeat(201));
      expect(violation).toContain("500 bytes");
    }
  });

  it("test 28: refuses a fragment citing another source path", () => {
    const { fullSourceBytes, sliceBounds } = fixture();
    const fragment = baseFragment({
      requirements: [{
        id: "REQ-1",
        statement: "x",
        acceptance: "x",
        accountableProducer: "team-a",
        dependencies: [],
        proofIds: [],
        confidence: "high",
        sourceRefs: [{ path: "other-file.md", exactQuote: "- REQ-1: alpha must ship a health endpoint." }],
      }],
    });

    const outcome = verifyCccPrdChunkFragment({
      fragment,
      sourcePath: SOURCE_PATH,
      fullSourceBytes,
      sliceBounds,
      assignedMaterialItemIds: [],
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("CCC_PRD_CHUNK_FOREIGN_SOURCE");
    }
  });
});

describe("runCccPrdChunkAttempt", () => {
  it("test 29: retries a repairable chunk once with an enumerated violation list, then refuses", async () => {
    const { fullSourceBytes, sliceBounds } = fixture();
    const attempts: string[][] = [];
    const transport: CccPrdChunkAttemptTransport = vi.fn(async () => (
      { provider: "local-omlx", model: "dense-27b", text: JSON.stringify(baseFragment()) }
    ));

    let thrown: unknown;
    try {
      await runCccPrdChunkAttempt({
        chunkId: "doc.md#0",
        sourcePath: SOURCE_PATH,
        fullSourceBytes,
        sliceBounds,
        assignedMaterialItemIds: ["MAT-does-not-exist"],
        expectedProvider: "local-omlx",
        expectedModel: "dense-27b",
        transport,
        buildPrompt: (priorViolations) => {
          attempts.push(priorViolations);
          return "prompt";
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(transport).toHaveBeenCalledTimes(2);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual([]);
    expect(attempts[1]!.length).toBeGreaterThan(0);
    expect(thrown).toBeInstanceOf(CccPrdCustodyError);
    expect((thrown as CccPrdCustodyError).code).toBe("CCC_PRD_CHUNK_ATTEMPTS_EXHAUSTED");
  });

  it("test 30: does not retry transport identity drift", async () => {
    const { fullSourceBytes, sliceBounds } = fixture();
    const transport: CccPrdChunkAttemptTransport = vi.fn(async () => (
      { provider: "wrong-provider", model: "wrong-model", text: JSON.stringify(baseFragment()) }
    ));

    let thrown: unknown;
    try {
      await runCccPrdChunkAttempt({
        chunkId: "doc.md#0",
        sourcePath: SOURCE_PATH,
        fullSourceBytes,
        sliceBounds,
        assignedMaterialItemIds: [],
        expectedProvider: "local-omlx",
        expectedModel: "dense-27b",
        transport,
        buildPrompt: () => "prompt",
      });
    } catch (error) {
      thrown = error;
    }

    expect(transport).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("identity drifted");
  });

  it("test 31: a MoE-shaped paraphrase fails on the first quote and never reaches assembly", async () => {
    const { fullSourceBytes, sliceBounds } = fixture();
    const paraphrasedFragment = baseFragment({
      requirements: [{
        id: "REQ-1",
        statement: "x",
        acceptance: "x",
        accountableProducer: "team-a",
        dependencies: [],
        proofIds: [],
        confidence: "high",
        sourceRefs: [{ path: SOURCE_PATH, exactQuote: "alpha will ship a health check endpoint eventually" }],
      }],
    });
    const transport: CccPrdChunkAttemptTransport = vi.fn(async () => (
      { provider: "local-omlx", model: "dense-27b", text: JSON.stringify(paraphrasedFragment) }
    ));

    let thrown: unknown;
    try {
      await runCccPrdChunkAttempt({
        chunkId: "doc.md#0",
        sourcePath: SOURCE_PATH,
        fullSourceBytes,
        sliceBounds,
        assignedMaterialItemIds: [],
        expectedProvider: "local-omlx",
        expectedModel: "dense-27b",
        transport,
        buildPrompt: () => "prompt",
      });
    } catch (error) {
      thrown = error;
    }

    expect(transport).toHaveBeenCalledTimes(2);
    expect(thrown).toBeInstanceOf(CccPrdCustodyError);
    expect((thrown as CccPrdCustodyError).code).toBe("CCC_PRD_CHUNK_ATTEMPTS_EXHAUSTED");
  });
});

describe("checkCccPrdChunkReviewBudget", () => {
  it("test 32: running review-row total refuses mid-run at the offending chunk", () => {
    let thrown: unknown;
    try {
      checkCccPrdChunkReviewBudget({
        chunkOrdinal: 3,
        runningReviewItemCount: 5,
        maxReviewItems: 4,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CccPrdCustodyError);
    expect((thrown as CccPrdCustodyError).code).toBe("CCC_PRD_CHUNK_REVIEW_BUDGET_EXCEEDED");

    expect(() => checkCccPrdChunkReviewBudget({
      chunkOrdinal: 3,
      runningReviewItemCount: 4,
      maxReviewItems: 4,
    })).not.toThrow();
  });
});
