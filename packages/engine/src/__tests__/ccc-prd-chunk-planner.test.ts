import { describe, expect, it } from "vitest";
import { CccPrdCustodyError } from "../ccc-prd/custody.js";
import {
  DEFAULT_CCC_PRD_CHUNK_POLICY,
  planCccPrdChunks,
  type CccPrdChunkPlan,
  type CccPrdChunkSlice,
} from "../ccc-prd/chunk-planner.js";

function unionCoversWholeFile(chunks: CccPrdChunkSlice[], totalBytes: number): boolean {
  const ranges = [...chunks]
    .map((chunk) => [chunk.sliceByteStart, chunk.sliceByteEnd] as const)
    .sort((left, right) => left[0] - right[0]);
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) return false;
    cursor = Math.max(cursor, end);
  }
  return cursor >= totalBytes;
}

function filler(byteLength: number, marker = "x"): string {
  return marker.repeat(byteLength);
}

describe("planCccPrdChunks", () => {
  it("test 11: union of a file's slices equals [0, byteLength) -- the byte-partition invariant", () => {
    const text = [
      "# Heading One",
      filler(60),
      "# Heading Two",
      filler(60),
    ].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    const plan = planCccPrdChunks({
      packetHash: "hash-11",
      sources: [{ path: "doc.md", bytes }],
      policy: { sliceTargetBytes: 40, maxSliceBytes: 80, overlapBytes: 5 },
    });

    expect(unionCoversWholeFile(plan.chunks, bytes.byteLength)).toBe(true);
    for (const chunk of plan.chunks) {
      expect(chunk.sliceByteStart).toBeGreaterThanOrEqual(0);
      expect(chunk.sliceByteEnd).toBeLessThanOrEqual(bytes.byteLength);
    }
  });

  it("test 12: covers bytes before the first heading", () => {
    const text = [
      "Preamble line one.",
      "Preamble line two.",
      "# First Heading",
      "- REQ-1: body text here.",
    ].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    const plan = planCccPrdChunks({
      packetHash: "hash-12",
      sources: [{ path: "doc.md", bytes }],
    });

    expect(unionCoversWholeFile(plan.chunks, bytes.byteLength)).toBe(true);
    expect(plan.chunks.some((chunk) => chunk.sliceByteStart === 0)).toBe(true);
  });

  it("test 13: covers a setext-only source (no ATX headings)", () => {
    const text = [
      "Setext Title",
      "============",
      "",
      "Some body prose that is not an ATX heading at all.",
      "- REQ-1: keep this dispositioned somewhere.",
    ].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    const plan = planCccPrdChunks({
      packetHash: "hash-13",
      sources: [{ path: "doc.md", bytes }],
    });

    expect(unionCoversWholeFile(plan.chunks, bytes.byteLength)).toBe(true);
  });

  it("test 14: covers a zero-heading source", () => {
    const text = [
      "Just plain paragraphs.",
      "No headings anywhere in this file.",
      "- REQ-1: still dispositionable somewhere.",
    ].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    const plan = planCccPrdChunks({
      packetHash: "hash-14",
      sources: [{ path: "doc.md", bytes }],
    });

    expect(unionCoversWholeFile(plan.chunks, bytes.byteLength)).toBe(true);
    expect(plan.chunks.length).toBeGreaterThan(0);
  });

  it("test 15: refuses a whole-packet empty inventory", () => {
    const text = [
      "Just plain paragraphs.",
      "No headings, no requirement tokens, nothing dispositionable.",
    ].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");

    let thrown: unknown;
    try {
      planCccPrdChunks({ packetHash: "hash-15", sources: [{ path: "doc.md", bytes }] });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CccPrdCustodyError);
    expect((thrown as CccPrdCustodyError).code).toBe("CCC_PRD_CHUNK_PLAN_NO_INVENTORY");
  });

  it("test 16: assigns every inventory item to exactly one chunk by heading-line offset", () => {
    const text = [
      "# One",
      "- REQ-1: " + filler(30),
      "# Two",
      "- REQ-2: " + filler(30),
      "# Three",
      "- REQ-3: " + filler(30),
    ].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    const plan = planCccPrdChunks({
      packetHash: "hash-16",
      sources: [{ path: "doc.md", bytes }],
      policy: { sliceTargetBytes: 20, maxSliceBytes: 40, overlapBytes: 5 },
    });

    const allIds = plan.chunks.flatMap((chunk) => chunk.materialItemIds);
    const uniqueIds = new Set(allIds);
    expect(allIds.length).toBe(uniqueIds.size);
    // Three headings + three requirement rows = six material items, each owned once.
    expect(uniqueIds.size).toBe(6);
  });

  it("test 17: cuts at the shallowest interior heading level that fits, descending only as needed", () => {
    const smallDoc = [
      "# Top A",
      "## Sub A1",
      "- REQ-1: small.",
      "## Sub A2",
      "- REQ-2: small.",
      "# Top B",
      "- REQ-3: small.",
    ].join("\n") + "\n";
    const smallBytes = Buffer.from(smallDoc, "utf8");
    const generousPlan = planCccPrdChunks({
      packetHash: "hash-17a",
      sources: [{ path: "doc.md", bytes: smallBytes }],
      policy: { sliceTargetBytes: 10_000, maxSliceBytes: 20_000, overlapBytes: 100 },
    });
    // Both top-level pieces fit easily: no descent into "## Sub" headings should occur.
    expect(generousPlan.chunks.length).toBe(2);

    const bigDoc = [
      "# Top A",
      "## Sub A1",
      "- REQ-1: " + filler(80),
      "## Sub A2",
      "- REQ-2: " + filler(80),
      "# Top B",
      "- REQ-3: " + filler(10),
    ].join("\n") + "\n";
    const bigBytes = Buffer.from(bigDoc, "utf8");
    const tightPlan = planCccPrdChunks({
      packetHash: "hash-17b",
      sources: [{ path: "doc.md", bytes: bigBytes }],
      policy: { sliceTargetBytes: 60, maxSliceBytes: 120, overlapBytes: 5 },
    });
    // Top A's piece is oversized and must descend to its "## Sub" children;
    // Top B stays whole because it already fits.
    const topBChunk = tightPlan.chunks.find((chunk) => (
      bigBytes.subarray(chunk.sliceByteStart, chunk.sliceByteEnd).toString("utf8").includes("Top B")
    ));
    expect(topBChunk).toBeDefined();
    expect(tightPlan.chunks.length).toBeGreaterThan(2);
  });

  it("test 18: a top-level heading with no peer (range = rest of file) does not break planning", () => {
    const text = [
      "# Only Heading",
      "- REQ-1: " + filler(20),
    ].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    const plan = planCccPrdChunks({
      packetHash: "hash-18",
      sources: [{ path: "doc.md", bytes }],
    });

    expect(unionCoversWholeFile(plan.chunks, bytes.byteLength)).toBe(true);
    expect(plan.chunks.length).toBe(1);
  });

  it("test 19: never spans two source files in one chunk", () => {
    const bytesA = Buffer.from("# A\n- REQ-1: alpha.\n", "utf8");
    const bytesB = Buffer.from("# B\n- REQ-2: beta.\n", "utf8");
    const plan = planCccPrdChunks({
      packetHash: "hash-19",
      sources: [
        { path: "a.md", bytes: bytesA },
        { path: "b.md", bytes: bytesB },
      ],
    });

    const paths = new Set(plan.chunks.map((chunk) => chunk.sourcePath));
    expect(paths).toEqual(new Set(["a.md", "b.md"]));
    expect(unionCoversWholeFile(plan.chunks.filter((c) => c.sourcePath === "a.md"), bytesA.byteLength)).toBe(true);
    expect(unionCoversWholeFile(plan.chunks.filter((c) => c.sourcePath === "b.md"), bytesB.byteLength)).toBe(true);
  });

  it("test 20: falls back to line-boundary split with declared overlap when a piece has no interior heading", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `Body line ${index}: ${filler(10)}`);
    const text = ["# Heading", "- REQ-1: anchor.", ...lines].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    const plan = planCccPrdChunks({
      packetHash: "hash-20",
      sources: [{ path: "doc.md", bytes }],
      policy: { sliceTargetBytes: 60, maxSliceBytes: 500, overlapBytes: 8 },
    });

    const partial = plan.chunks.filter((chunk) => chunk.partialSection);
    expect(partial.length).toBeGreaterThan(1);
    expect(unionCoversWholeFile(plan.chunks, bytes.byteLength)).toBe(true);

    const sorted = [...partial].sort((left, right) => left.sliceByteStart - right.sliceByteStart);
    for (let index = 0; index < sorted.length - 1; index += 1) {
      // Adjacent fallback chunks must actually overlap (forward margin into the neighbor).
      expect(sorted[index]!.sliceByteEnd).toBeGreaterThan(sorted[index + 1]!.sliceByteStart);
    }
  });

  it("test 21: stable chunkPlanHash for the same packet and policy; changes with sliceTargetBytes", () => {
    const text = ["# Heading", "- REQ-1: " + filler(20)].join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    const buildPlan = (sliceTargetBytes: number): CccPrdChunkPlan => planCccPrdChunks({
      packetHash: "hash-21",
      sources: [{ path: "doc.md", bytes }],
      policy: { sliceTargetBytes },
    });

    const first = buildPlan(1000);
    const second = buildPlan(1000);
    const third = buildPlan(2000);

    expect(first.chunkPlanHash).toBe(second.chunkPlanHash);
    expect(first.chunkPlanHash).not.toBe(third.chunkPlanHash);
  });

  it("test 22: refuses when the smallest indivisible unit exceeds budget", () => {
    const text = "- REQ-1: short line.\n" + filler(300) + "\n";
    const bytes = Buffer.from(text, "utf8");

    let thrown: unknown;
    try {
      planCccPrdChunks({
        packetHash: "hash-22",
        sources: [{ path: "doc.md", bytes }],
        policy: { sliceTargetBytes: 50, maxSliceBytes: 100, overlapBytes: 5 },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CccPrdCustodyError);
    expect((thrown as CccPrdCustodyError).code).toBe("CCC_PRD_CHUNK_PLAN_INVALID");
  });

  it("uses the documented default chunk policy constants when none are supplied", () => {
    expect(DEFAULT_CCC_PRD_CHUNK_POLICY.sliceTargetBytes).toBe(24 * 1024);
    expect(DEFAULT_CCC_PRD_CHUNK_POLICY.maxSliceBytes).toBe(48 * 1024);
    expect(DEFAULT_CCC_PRD_CHUNK_POLICY.overlapBytes).toBe(2 * 1024);
  });
});
