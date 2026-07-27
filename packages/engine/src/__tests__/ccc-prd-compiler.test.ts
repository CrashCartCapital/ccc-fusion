import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as engine from "@fusion/engine";

const ccc = engine as typeof engine & {
  compileCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    sidecarPath?: string;
  }): { kind: string; diagnostics?: Array<{ code: string }> };
  validateNeoCandidate(candidate: unknown): {
    valid: boolean;
    dispatch: { kind: string; diagnostics: Array<{ code: string }> };
  };
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ccc-prd structural compiler boundary", () => {
  it("refuses direct Markdown compilation without the generated structural sidecar", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-prd-sidecar-required-"));
    roots.push(root);
    const source = "| FR-1 | legacy table row | prove it |\nwhile true status: DEFERRED delete publish";
    writeFileSync(join(root, "source.md"), source);
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      schema: "ccc-prd.packet.v1",
      source_version: "legacy-negative-control",
      entries: [{
        relative_path: "source.md",
        role: "root",
        authoritative: true,
        sha256: createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex"),
      }],
    }));
    expect(ccc.compileCccPrdPacket({
      rootDir: root,
      manifestPath: join(root, "manifest.json"),
    })).toEqual({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_SIDECAR_REQUIRED",
        message: "compile and validate require a generated sidecar",
      }],
    });
  });

  it("validates the admitted Neo cold-review candidate but always refuses dispatch", () => {
    const candidate = JSON.parse(readFileSync(
      new URL("./fixtures/ccc-prd-canaries/neo-autonomous-builder-handoff-candidate.v1.json", import.meta.url),
      "utf8",
    ));
    expect(ccc.validateNeoCandidate(candidate)).toMatchObject({
      valid: true,
      dispatch: {
        kind: "refusal",
        diagnostics: [{ code: "CCC_PRD_DISPATCH_REFUSED" }],
      },
    });
  });
});
