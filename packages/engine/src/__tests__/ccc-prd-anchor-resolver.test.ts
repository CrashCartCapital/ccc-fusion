import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CccPrdCustodyError } from "../ccc-prd/custody.js";
import {
  DEFAULT_CCC_PRD_ANCHOR_LIMITS,
  resolveCccPrdAnchor,
} from "../ccc-prd/anchor-resolver.js";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function wholeFileSlice(source: Buffer): { byteStart: number; byteEnd: number } {
  return { byteStart: 0, byteEnd: source.byteLength };
}

describe("resolveCccPrdAnchor", () => {
  it("test 1: anchors a unique quote without attempting extension", () => {
    const source = Buffer.from("Alpha unique line one.\nBeta line two.\n", "utf8");
    const result = resolveCccPrdAnchor({
      sourcePath: "a.md",
      source,
      quote: "Alpha unique line one.",
      entityId: "REQ-1",
      policy: "select",
      sliceBounds: wholeFileSlice(source),
    });

    expect(result.receipt.extensionAttempted).toBe(false);
    expect(result.receipt.fileWideOccurrenceCount).toBe(1);
    expect(result.receipt.inSliceCandidateCount).toBe(1);
    expect(result.span.byteStart).toBe(0);
    expect(result.span.byteEnd).toBe(Buffer.byteLength("Alpha unique line one."));
  });

  it("test 2: emitted span equals the model's quote exactly, never the extended window", () => {
    const lines = [
      "Boilerplate line X.",
      "Same phrase.",
      "Boilerplate line Y.",
      "Unique preface line.",
      "Same phrase.",
      "Unique closing line.",
      "Boilerplate line X.",
      "Same phrase.",
      "Boilerplate line Y.",
    ];
    const source = Buffer.from(lines.join("\n") + "\n", "utf8");
    // Slice covers only the first six lines (the trapped duplicate at line 2
    // plus the file-unique occurrence at line 5); the third copy at line 8
    // stays out of slice but is what keeps the trapped candidate from ever
    // resolving, since uniqueness is always counted file-wide.
    const sliceEnd = Buffer.byteLength(lines.slice(0, 6).join("\n") + "\n");
    const quote = "Same phrase.";

    const result = resolveCccPrdAnchor({
      sourcePath: "a.md",
      source,
      quote,
      entityId: "REQ-2",
      policy: "select",
      sliceBounds: { byteStart: 0, byteEnd: sliceEnd },
      limits: { maxAnchorExtensionLines: 2, maxAnchorExtensionBytes: 1000 },
    });

    expect(result.receipt.extensionAttempted).toBe(true);
    expect(result.receipt.inSliceCandidateCount).toBe(2);
    expect(result.receipt.survivingCandidateByteStarts).toHaveLength(1);

    const winningLineStart = Buffer.byteLength(lines.slice(0, 4).join("\n") + "\n");
    const expectedByteStart = winningLineStart;
    expect(result.span.byteStart).toBe(expectedByteStart);
    expect(result.span.byteEnd).toBe(expectedByteStart + Buffer.byteLength(quote));
    expect(source.subarray(result.span.byteStart, result.span.byteEnd).toString("utf8")).toBe(quote);
    expect(result.span.excerptSha256).toBe(sha256(Buffer.from(quote, "utf8")));
  });

  it("test 3: selects the correct occurrence when only one duplicate is inside the slice", () => {
    const lines = ["Header.", "Duplicate value.", "Middle.", "Duplicate value.", "Footer."];
    const source = Buffer.from(lines.join("\n") + "\n", "utf8");
    const sliceEnd = Buffer.byteLength(lines.slice(0, 3).join("\n") + "\n");
    const quote = "Duplicate value.";

    const result = resolveCccPrdAnchor({
      sourcePath: "a.md",
      source,
      quote,
      entityId: "REQ-3",
      policy: "select",
      sliceBounds: { byteStart: 0, byteEnd: sliceEnd },
    });

    expect(result.receipt.extensionAttempted).toBe(false);
    expect(result.receipt.fileWideOccurrenceCount).toBe(2);
    expect(result.receipt.inSliceCandidateCount).toBe(1);
    const expectedStart = Buffer.byteLength(lines.slice(0, 1).join("\n") + "\n");
    expect(result.span.byteStart).toBe(expectedStart);
  });

  it("test 4: refuses when both duplicates are inside one slice, naming both lines", () => {
    const lines = ["## Section A", "Same sentence.", "## Section B", "Same sentence."];
    const source = Buffer.from(lines.join("\n") + "\n", "utf8");

    let thrown: unknown;
    try {
      resolveCccPrdAnchor({
        sourcePath: "a.md",
        source,
        quote: "Same sentence.",
        entityId: "REQ-4",
        policy: "select",
        sliceBounds: wholeFileSlice(source),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CccPrdCustodyError);
    const error = thrown as CccPrdCustodyError;
    expect(error.code).toBe("CCC_PRD_ANCHOR_AMBIGUOUS_INTENT");
    expect(error.message).toContain("2");
    expect(error.message).toContain("4");
  });

  it("test 5: refuses a repeated bare identifier and lists colliding lines", () => {
    const lines = [
      "Task alpha references t-phase-1.",
      "id: t-phase-1",
      "Task beta references t-phase-1.",
    ];
    const source = Buffer.from(lines.join("\n") + "\n", "utf8");

    let thrown: unknown;
    try {
      resolveCccPrdAnchor({
        sourcePath: "a.md",
        source,
        quote: "t-phase-1",
        entityId: "REQ-5",
        policy: "select",
        sliceBounds: wholeFileSlice(source),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CccPrdCustodyError);
    const error = thrown as CccPrdCustodyError;
    expect(error.code).toBe("CCC_PRD_ANCHOR_AMBIGUOUS_INTENT");
    expect(error.message).toContain("1");
    expect(error.message).toContain("2");
    expect(error.message).toContain("3");
  });

  it("test 6: resolves that identifier once the quote is the whole defining line", () => {
    const lines = [
      "Task alpha references t-phase-1.",
      "id: t-phase-1",
      "Task beta references t-phase-1.",
    ];
    const source = Buffer.from(lines.join("\n") + "\n", "utf8");

    const result = resolveCccPrdAnchor({
      sourcePath: "a.md",
      source,
      quote: "id: t-phase-1",
      entityId: "REQ-6",
      policy: "select",
      sliceBounds: wholeFileSlice(source),
    });

    expect(result.receipt.extensionAttempted).toBe(false);
    expect(result.receipt.fileWideOccurrenceCount).toBe(1);
    const expectedStart = Buffer.byteLength(lines.slice(0, 1).join("\n") + "\n");
    expect(result.span.byteStart).toBe(expectedStart);
  });

  it("test 7: deterministic across runs and across mirrored candidate order", () => {
    const lines = [
      "Boilerplate line X.",
      "Same phrase.",
      "Boilerplate line Y.",
      "Unique preface line.",
      "Same phrase.",
      "Unique closing line.",
      "Boilerplate line X.",
      "Same phrase.",
      "Boilerplate line Y.",
    ];
    const source = Buffer.from(lines.join("\n") + "\n", "utf8");
    const sliceEnd = Buffer.byteLength(lines.slice(0, 6).join("\n") + "\n");
    const request = {
      sourcePath: "a.md",
      source,
      quote: "Same phrase.",
      entityId: "REQ-7",
      policy: "select" as const,
      sliceBounds: { byteStart: 0, byteEnd: sliceEnd },
      limits: { maxAnchorExtensionLines: 2, maxAnchorExtensionBytes: 1000 },
    };

    const results = Array.from({ length: 5 }, () => resolveCccPrdAnchor(request));
    for (const result of results) {
      expect(result).toEqual(results[0]);
    }

    // Mirror: put the file-unique occurrence first and the trapped duplicate
    // pair second. Buffer.indexOf discovers candidates in a different order,
    // but the winner must still be selected by content, not discovery order.
    const mirroredLines = [
      "Unique preface line.",
      "Same phrase.",
      "Unique closing line.",
      "Boilerplate line X.",
      "Same phrase.",
      "Boilerplate line Y.",
      "Boilerplate line X.",
      "Same phrase.",
      "Boilerplate line Y.",
    ];
    const mirroredSource = Buffer.from(mirroredLines.join("\n") + "\n", "utf8");
    const mirroredSliceEnd = Buffer.byteLength(mirroredLines.slice(0, 6).join("\n") + "\n");
    const mirroredResult = resolveCccPrdAnchor({
      ...request,
      source: mirroredSource,
      sliceBounds: { byteStart: 0, byteEnd: mirroredSliceEnd },
    });
    const expectedWinnerStart = Buffer.byteLength(mirroredLines.slice(0, 1).join("\n") + "\n");
    expect(mirroredResult.span.byteStart).toBe(expectedWinnerStart);
  });

  it("test 8: refuses when extension exceeds the byte or line limit", () => {
    const lines = ["## Section", "Same sentence.", "## Section", "Same sentence.", "## Section"];
    const source = Buffer.from(lines.join("\n") + "\n", "utf8");

    let thrown: unknown;
    try {
      resolveCccPrdAnchor({
        sourcePath: "a.md",
        source,
        quote: "Same sentence.",
        entityId: "REQ-8",
        policy: "select",
        sliceBounds: wholeFileSlice(source),
        limits: { maxAnchorExtensionLines: 1, maxAnchorExtensionBytes: 1000 },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CccPrdCustodyError);
    expect((thrown as CccPrdCustodyError).code).toBe("CCC_PRD_ANCHOR_UNRESOLVABLE");
  });

  it("test 9: the emitted span's bytes equal the proposed quote byte-for-byte", () => {
    const fixtures: Array<{ source: Buffer; quote: string; sliceBounds: { byteStart: number; byteEnd: number } }> = [
      (() => {
        const source = Buffer.from("Alpha unique line one.\nBeta line two.\n", "utf8");
        return { source, quote: "Alpha unique line one.", sliceBounds: wholeFileSlice(source) };
      })(),
      (() => {
        const lines = ["Header.", "Duplicate value.", "Middle.", "Duplicate value.", "Footer."];
        const source = Buffer.from(lines.join("\n") + "\n", "utf8");
        const sliceEnd = Buffer.byteLength(lines.slice(0, 3).join("\n") + "\n");
        return { source, quote: "Duplicate value.", sliceBounds: { byteStart: 0, byteEnd: sliceEnd } };
      })(),
      (() => {
        const lines = [
          "Task alpha references t-phase-1.",
          "id: t-phase-1",
          "Task beta references t-phase-1.",
        ];
        const source = Buffer.from(lines.join("\n") + "\n", "utf8");
        return { source, quote: "id: t-phase-1", sliceBounds: wholeFileSlice(source) };
      })(),
    ];

    for (const fixture of fixtures) {
      const result = resolveCccPrdAnchor({
        sourcePath: "a.md",
        source: fixture.source,
        quote: fixture.quote,
        entityId: "REQ-9",
        policy: "select",
        sliceBounds: fixture.sliceBounds,
      });
      const quoteBytes = Buffer.from(fixture.quote, "utf8");
      expect(
        fixture.source.subarray(result.span.byteStart, result.span.byteEnd).equals(quoteBytes),
      ).toBe(true);
      expect(result.span.excerptSha256).toBe(sha256(quoteBytes));
    }
  });

  it("test 10: execution lane keeps anchorPolicy strict and still refuses a duplicate", () => {
    const lines = ["Header.", "Duplicate value.", "Middle.", "Duplicate value.", "Footer."];
    const source = Buffer.from(lines.join("\n") + "\n", "utf8");

    let thrown: unknown;
    try {
      resolveCccPrdAnchor({
        sourcePath: "a.md",
        source,
        quote: "Duplicate value.",
        entityId: "REQ-10",
        policy: "strict",
        sliceBounds: { byteStart: 0, byteEnd: Buffer.byteLength(lines.slice(0, 3).join("\n") + "\n") },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CccPrdCustodyError);
    expect((thrown as CccPrdCustodyError).code).toBe("CCC_PRD_SOURCE_QUOTE_AMBIGUOUS");
  });

  it("uses the documented default extension limits when none are supplied", () => {
    expect(DEFAULT_CCC_PRD_ANCHOR_LIMITS.maxAnchorExtensionLines).toBe(40);
    expect(DEFAULT_CCC_PRD_ANCHOR_LIMITS.maxAnchorExtensionBytes).toBe(8192);
  });
});
