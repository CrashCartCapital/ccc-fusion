import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as core from "@fusion/core";

type SidecarContract = {
  CCC_PRD_SIDECAR_SCHEMA_VERSION: string;
  CCC_PRD_BUNDLE_SCHEMA_VERSION: string;
  compareCccPrdCodeUnits(left: string, right: string): number;
  canonicalCccPrdJson(value: unknown): string;
  createCccPrdSpanFromBytes(sourcePath: string, source: Buffer, byteStart: number, byteEnd: number): {
    path: string;
    byteStart: number;
    byteEnd: number;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    sha256: string;
  };
};

const ccc = core as typeof core & SidecarContract;

describe("ccc-prd sidecar public contract", () => {
  it("publishes distinct sidecar and compiled-bundle schema versions", () => {
    expect(ccc.CCC_PRD_SIDECAR_SCHEMA_VERSION).toBe("ccc-prd.sidecar.v1");
    expect(ccc.CCC_PRD_BUNDLE_SCHEMA_VERSION).toBe("ccc-prd.bundle.v1");
  });

  it("compares strings by JavaScript code units", () => {
    for (const [left, right] of [["a", "b"], ["ä", "z"], ["same", "same"]] as const) {
      expect(Math.sign(ccc.compareCccPrdCodeUnits(left, right))).toBe(left < right ? -1 : left > right ? 1 : 0);
    }
  });

  it("canonicalizes nested plain objects without reordering arrays", () => {
    expect(ccc.canonicalCccPrdJson({ z: { b: 1, a: 2 }, a: [{ z: 1, a: 2 }, 3] })).toBe('{"a":[{"a":2,"z":1},3],"z":{"a":2,"b":1}}');
  });

  it("rejects non-finite numbers, cycles, and non-plain objects", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(typeof ccc.canonicalCccPrdJson).toBe("function");
    expect(() => ccc.canonicalCccPrdJson({ value: Number.NaN })).toThrow();
    expect(() => ccc.canonicalCccPrdJson(cyclic)).toThrow();
    expect(() => ccc.canonicalCccPrdJson({ when: new Date("2026-07-24T00:00:00Z") })).toThrow();
  });

  it("creates byte-custody spans without UTF-8 or UTF-16 column drift", () => {
    const source = Buffer.from("a “🙂”\nnext", "utf8");
    const byteStart = Buffer.byteLength("a “", "utf8");
    const byteEnd = byteStart + Buffer.byteLength("🙂", "utf8");
    expect(ccc.createCccPrdSpanFromBytes("packet.md", source, byteStart, byteEnd)).toEqual({
      path: "packet.md",
      byteStart,
      byteEnd,
      line: 1,
      column: 4,
      endLine: 1,
      endColumn: 5,
      sha256: createHash("sha256").update(source).digest("hex"),
    });
  });
});
