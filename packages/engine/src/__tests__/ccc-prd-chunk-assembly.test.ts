import { describe, expect, it } from "vitest";
import { canonicalCccPrdJson, type CccPrdSourceSpan } from "@fusion/core";
import { resolveCccPrdAnchor } from "../ccc-prd/anchor-resolver.js";
import {
  assembleCccPrdChunkedUnderstanding,
  type CccPrdAssembledUnderstanding,
} from "../ccc-prd/chunk-assembly.js";
import type { CccPrdResolvedChunkFragment } from "../ccc-prd/chunk-verification.js";

const SOURCE_PATH = "doc.md";

function emptyResolved(): CccPrdResolvedChunkFragment {
  return {
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
  };
}

function spanFor(bytes: Buffer, sourcePath: string, quote: string): CccPrdSourceSpan {
  return resolveCccPrdAnchor({
    sourcePath,
    source: bytes,
    quote,
    entityId: "test-fixture",
    policy: "select",
    sliceBounds: { byteStart: 0, byteEnd: bytes.byteLength },
  }).span;
}

function requirementRow(id: string, spans: CccPrdSourceSpan[], overrides: Record<string, unknown> = {}) {
  return {
    id,
    statement: `${id} statement`,
    acceptance: `${id} acceptance`,
    accountableProducer: "team-a",
    dependencies: [] as string[],
    proofIds: [] as string[],
    confidence: "high" as const,
    spans,
    ...overrides,
  };
}

function taskRow(id: string, spans: CccPrdSourceSpan[], overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `${id} title`,
    description: `${id} description`,
    accountableProducer: "team-a",
    requirementIds: [] as string[],
    dependencyTaskIds: [] as string[],
    proofIds: [] as string[],
    workflowId: "",
    documentIds: [] as string[],
    artifactIds: [] as string[],
    protectedActionIds: [] as string[],
    ownedPaths: [`${id.toLowerCase()}.ts`],
    allowedWriteRoots: [`${id.toLowerCase()}.ts`],
    spans,
    ...overrides,
  };
}

describe("assembleCccPrdChunkedUnderstanding", () => {
  it("test 33: emitted requirement IDs are unprefixed, so requirement.id === item.title still dispositions", () => {
    const text = ["# Alpha", "- REQ-1: alpha requirement text."].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    const packetSourceBytes = new Map([[SOURCE_PATH, bytes]]);

    const fragment: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      requirements: [requirementRow("REQ-1", [spanFor(bytes, SOURCE_PATH, "- REQ-1: alpha requirement text.")])],
      tasks: [taskRow("TASK-1", [spanFor(bytes, SOURCE_PATH, text.trimEnd())], { requirementIds: ["REQ-1"] })],
    };

    const assembled = assembleCccPrdChunkedUnderstanding({
      packetSourceBytes,
      fragments: [{ chunkOrdinal: 0, resolved: fragment }],
    });

    expect(assembled.requirements).toHaveLength(1);
    expect(assembled.requirements[0]!.id).toBe("REQ-1");
  });

  it("test 34: same raw ID with equal payload merges and unions sourceRefs", () => {
    const text = ["# Alpha", "- REQ-1: alpha requirement text.", "More detail on the same line elsewhere."].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    const spanA = spanFor(bytes, SOURCE_PATH, "- REQ-1: alpha requirement text.");
    const spanB = spanFor(bytes, SOURCE_PATH, "More detail on the same line elsewhere.");

    const fragmentA: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      tasks: [taskRow("TASK-1", [spanA])],
    };
    const fragmentB: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      tasks: [taskRow("TASK-1", [spanB])],
    };

    const assembled = assembleCccPrdChunkedUnderstanding({
      packetSourceBytes: new Map([[SOURCE_PATH, bytes]]),
      fragments: [
        { chunkOrdinal: 0, resolved: fragmentA },
        { chunkOrdinal: 1, resolved: fragmentB },
      ],
    });

    expect(assembled.tasks).toHaveLength(1);
    expect(assembled.tasks[0]!.spans).toHaveLength(2);
  });

  it("test 35: same raw ID with contradictory payload refuses CCC_PRD_ASSEMBLY_ID_COLLISION", () => {
    const text = ["# Alpha", "- REQ-1: alpha requirement text."].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    const span = spanFor(bytes, SOURCE_PATH, "- REQ-1: alpha requirement text.");

    const fragmentA: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      tasks: [taskRow("TASK-1", [span], { title: "Original title" })],
    };
    const fragmentB: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      tasks: [taskRow("TASK-1", [span], { title: "Contradictory title" })],
    };

    expect(() => assembleCccPrdChunkedUnderstanding({
      packetSourceBytes: new Map([[SOURCE_PATH, bytes]]),
      fragments: [
        { chunkOrdinal: 0, resolved: fragmentA },
        { chunkOrdinal: 1, resolved: fragmentB },
      ],
    })).toThrowError(expect.objectContaining({ code: "CCC_PRD_ASSEMBLY_ID_COLLISION" }));
  });

  it("test 36: dedupe emits a loser->winner map applied before the dangling check", () => {
    const text = ["# Alpha", "- REQ-1: alpha requirement text."].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    const span = spanFor(bytes, SOURCE_PATH, "- REQ-1: alpha requirement text.");

    const fragment0: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      tasks: [taskRow("TASK-1", [span])],
    };
    const fragment1: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      // TASK-1 duplicated verbatim across two chunks (the normal case for a
      // requirement token cited in two sections) AND a new edge that
      // references it -- the dangling check must see the POST-merge
      // registry, not either fragment's own partial view.
      tasks: [taskRow("TASK-1", [span])],
      edges: [{ id: "EDGE-1", fromTaskId: "TASK-1", toTaskId: "TASK-2", kind: "depends_on" }],
    };
    const fragment2: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      tasks: [taskRow("TASK-2", [span])],
    };

    const assembled = assembleCccPrdChunkedUnderstanding({
      packetSourceBytes: new Map([[SOURCE_PATH, bytes]]),
      fragments: [
        { chunkOrdinal: 0, resolved: fragment0 },
        { chunkOrdinal: 1, resolved: fragment1 },
        { chunkOrdinal: 2, resolved: fragment2 },
      ],
    });

    expect(assembled.tasks.map((task) => task.id)).toEqual(["TASK-1", "TASK-2"]);
    expect(assembled.edges).toHaveLength(1);
  });

  it("test 36b: a dangling reference to a row that never survives refuses", () => {
    const text = ["# Alpha", "- REQ-1: alpha requirement text."].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    const span = spanFor(bytes, SOURCE_PATH, "- REQ-1: alpha requirement text.");

    const fragment: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      tasks: [taskRow("TASK-1", [span])],
      edges: [{ id: "EDGE-1", fromTaskId: "TASK-1", toTaskId: "TASK-NEVER-EMITTED", kind: "depends_on" }],
    };

    expect(() => assembleCccPrdChunkedUnderstanding({
      packetSourceBytes: new Map([[SOURCE_PATH, bytes]]),
      fragments: [{ chunkOrdinal: 0, resolved: fragment }],
    })).toThrowError(expect.objectContaining({ code: "CCC_PRD_ASSEMBLY_DANGLING_REFERENCE" }));
  });

  it("test 37: co-located citations from overlap margins do not refuse", () => {
    const text = ["# Alpha", "- REQ-1: shared line of text.", "- REQ-2: shared line of text."].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    const sharedSpan = spanFor(bytes, SOURCE_PATH, "- REQ-1: shared line of text.");

    const fragment: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      // Two different IDs citing an identical/overlapping span (the shape
      // overlap-margin duplication produces) with genuinely different
      // content must never be treated as a conflict.
      requirements: [
        requirementRow("REQ-1", [sharedSpan], { statement: "first fact" }),
        requirementRow("REQ-2", [sharedSpan], { statement: "second, different fact" }),
      ],
      tasks: [taskRow("TASK-1", [sharedSpan], { requirementIds: ["REQ-1", "REQ-2"] })],
    };

    expect(() => assembleCccPrdChunkedUnderstanding({
      packetSourceBytes: new Map([[SOURCE_PATH, bytes]]),
      fragments: [{ chunkOrdinal: 0, resolved: fragment }],
    })).not.toThrow();
  });

  it("test 38: order-independent -- shuffled arrival yields byte-identical canonical JSON", () => {
    const text = ["# Alpha", "- REQ-1: alpha text.", "# Beta", "- REQ-2: beta text."].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    const packetSourceBytes = new Map([[SOURCE_PATH, bytes]]);

    const fragmentA: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      requirements: [requirementRow("REQ-1", [spanFor(bytes, SOURCE_PATH, "- REQ-1: alpha text.")])],
      tasks: [taskRow("TASK-1", [spanFor(bytes, SOURCE_PATH, "# Alpha\n- REQ-1: alpha text.")], { requirementIds: ["REQ-1"] })],
    };
    const fragmentB: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      requirements: [requirementRow("REQ-2", [spanFor(bytes, SOURCE_PATH, "- REQ-2: beta text.")])],
      tasks: [taskRow("TASK-2", [spanFor(bytes, SOURCE_PATH, "# Beta\n- REQ-2: beta text.")], { requirementIds: ["REQ-2"] })],
    };

    const forward = assembleCccPrdChunkedUnderstanding({
      packetSourceBytes,
      fragments: [
        { chunkOrdinal: 0, resolved: fragmentA },
        { chunkOrdinal: 1, resolved: fragmentB },
      ],
    });
    const shuffled = assembleCccPrdChunkedUnderstanding({
      packetSourceBytes,
      fragments: [
        { chunkOrdinal: 1, resolved: fragmentB },
        { chunkOrdinal: 0, resolved: fragmentA },
      ],
    });

    expect(canonicalCccPrdJson(forward)).toBe(canonicalCccPrdJson(shuffled));
  });

  it("test 38a: a slice-disambiguated non-unique quote survives assembly", () => {
    const text = [
      "# Section A",
      "Same duplicated sentence appears here.",
      "# Section B",
      "Same duplicated sentence appears here.",
    ].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    const sectionAEnd = Buffer.byteLength("# Section A\nSame duplicated sentence appears here.\n");
    const quote = "Same duplicated sentence appears here.";

    // The quote occurs twice file-wide; the strict single-shot resolver
    // would refuse CCC_PRD_SOURCE_QUOTE_AMBIGUOUS on this quote. Each chunk's
    // OWN slice narrows it to exactly one candidate, so the selection
    // resolver anchors each occurrence independently and with confidence.
    const spanInA = resolveCccPrdAnchor({
      sourcePath: SOURCE_PATH,
      source: bytes,
      quote,
      entityId: "REQ-A",
      policy: "select",
      sliceBounds: { byteStart: 0, byteEnd: sectionAEnd },
    }).span;
    const spanInB = resolveCccPrdAnchor({
      sourcePath: SOURCE_PATH,
      source: bytes,
      quote,
      entityId: "REQ-B",
      policy: "select",
      sliceBounds: { byteStart: sectionAEnd, byteEnd: bytes.byteLength },
    }).span;
    expect(spanInA.byteStart).not.toBe(spanInB.byteStart);

    const fragmentA: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      requirements: [requirementRow("REQ-A", [spanInA])],
      tasks: [taskRow("TASK-A", [spanFor(bytes, SOURCE_PATH, "# Section A")], { requirementIds: ["REQ-A"] })],
    };
    const fragmentB: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      requirements: [requirementRow("REQ-B", [spanInB])],
      tasks: [taskRow("TASK-B", [spanFor(bytes, SOURCE_PATH, "# Section B")], { requirementIds: ["REQ-B"] })],
    };

    let thrown: unknown;
    let assembled: CccPrdAssembledUnderstanding | undefined;
    try {
      assembled = assembleCccPrdChunkedUnderstanding({
        packetSourceBytes: new Map([[SOURCE_PATH, bytes]]),
        fragments: [
          { chunkOrdinal: 0, resolved: fragmentA },
          { chunkOrdinal: 1, resolved: fragmentB },
        ],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(assembled!.requirements.map((r) => r.id).sort()).toEqual(["REQ-A", "REQ-B"]);
    const assembledA = assembled!.requirements.find((r) => r.id === "REQ-A")!;
    const assembledB = assembled!.requirements.find((r) => r.id === "REQ-B")!;
    expect(assembledA.spans[0]!.byteStart).toBe(spanInA.byteStart);
    expect(assembledB.spans[0]!.byteStart).toBe(spanInB.byteStart);
  });

  it("test 39: assembled missing is empty on the multi-file fixture", () => {
    const textA = ["# Alpha", "- REQ-1: alpha text."].join("\n") + "\n";
    const textB = ["# Beta", "- REQ-2: beta text."].join("\n") + "\n";
    const bytesA = Buffer.from(textA, "utf8");
    const bytesB = Buffer.from(textB, "utf8");

    const fragmentA: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      requirements: [requirementRow("REQ-1", [spanFor(bytesA, "a.md", "- REQ-1: alpha text.")])],
      tasks: [taskRow("TASK-1", [spanFor(bytesA, "a.md", "# Alpha\n- REQ-1: alpha text.")], { requirementIds: ["REQ-1"] })],
    };
    const fragmentB: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      requirements: [requirementRow("REQ-2", [spanFor(bytesB, "b.md", "- REQ-2: beta text.")])],
      tasks: [taskRow("TASK-2", [spanFor(bytesB, "b.md", "# Beta\n- REQ-2: beta text.")], { requirementIds: ["REQ-2"] })],
    };

    const assembled = assembleCccPrdChunkedUnderstanding({
      packetSourceBytes: new Map([["a.md", bytesA], ["b.md", bytesB]]),
      fragments: [
        { chunkOrdinal: 0, resolved: fragmentA },
        { chunkOrdinal: 1, resolved: fragmentB },
      ],
    });

    expect(assembled.materialCoverage.length).toBeGreaterThan(0);
  });

  it("test 40: assembled conflicts non-empty refuses", () => {
    const text = ["# Deferred Alpha", "This work is deferred to a later phase."].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");

    const fragment: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      tasks: [taskRow("TASK-1", [spanFor(bytes, SOURCE_PATH, text.trimEnd())])],
    };

    expect(() => assembleCccPrdChunkedUnderstanding({
      packetSourceBytes: new Map([[SOURCE_PATH, bytes]]),
      fragments: [{ chunkOrdinal: 0, resolved: fragment }],
    })).toThrowError(expect.objectContaining({ code: "CCC_PRD_UNDERSTANDING_COVERAGE_CONFLICTED" }));
  });

  it("test 41: assembled materialCoverage canonically equals a fresh analyzer run", async () => {
    const text = ["# Alpha", "- REQ-1: alpha text."].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    const requirement = requirementRow("REQ-1", [spanFor(bytes, SOURCE_PATH, "- REQ-1: alpha text.")]);
    const task = taskRow("TASK-1", [spanFor(bytes, SOURCE_PATH, "# Alpha\n- REQ-1: alpha text.")], { requirementIds: ["REQ-1"] });

    const fragment: CccPrdResolvedChunkFragment = {
      ...emptyResolved(),
      requirements: [requirement],
      tasks: [task],
    };

    const assembled = assembleCccPrdChunkedUnderstanding({
      packetSourceBytes: new Map([[SOURCE_PATH, bytes]]),
      fragments: [{ chunkOrdinal: 0, resolved: fragment }],
    });

    const { analyzeCccPrdMaterialCoverage } = await import("../ccc-prd/material-coverage.js");
    const fresh = analyzeCccPrdMaterialCoverage({
      sourceBytes: new Map([[SOURCE_PATH, bytes]]),
      requirements: assembled.requirements,
      tasks: assembled.tasks,
      unresolvedDecisions: assembled.unresolvedDecisions,
    });

    expect(canonicalCccPrdJson(assembled.materialCoverage)).toBe(canonicalCccPrdJson(fresh.coverage));
  });
});
