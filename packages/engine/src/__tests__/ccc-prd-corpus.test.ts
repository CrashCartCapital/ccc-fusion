import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as engine from "@fusion/engine";
const ccc = engine as typeof engine & { compileCccPrdPacket(input: { rootDir: string; manifestPath: string }): { kind: string; requirements?: Array<{ id: string; span: { path: string; line: number } }>; sources?: Array<{ path: string }>; protectedActions?: Array<{ kind: string; operatorDecision: string }> } };
const fixture = new URL("./fixtures/ccc-prd-canaries/", import.meta.url).pathname;
const hash = (value: string) => createHash("sha256").update(value).digest("hex"); const temps: string[] = []; afterEach(() => temps.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
describe("ccc-prd admitted corpus", () => {
  it("preserves all SRU FR-1 through FR-14 with source spans and promotion intent", () => { const root = mkdtempSync(join(tmpdir(), "ccc-sru-")); temps.push(root); const content = readFileSync(join(fixture, "sru-prd-v0.4.0.md"), "utf8"); writeFileSync(join(root, "sru.md"), content); writeFileSync(join(root, "manifest.json"), JSON.stringify({ schema: "ccc-prd.packet.v1", source_version: "v0.4.0", entries: [{ relative_path: "sru.md", role: "root", authoritative: true, sha256: hash(content) }] })); const result = ccc.compileCccPrdPacket({ rootDir: root, manifestPath: join(root, "manifest.json") }); expect(result.requirements?.map((item) => item.id)).toEqual(Array.from({ length: 14 }, (_, index) => `FR-${index + 1}`)); expect(result.requirements?.every((item) => item.span.path === "sru.md" && item.span.line >= 561)).toBe(true); expect(result.protectedActions).toContainEqual({ kind: "promotion", target: "sru.md", operatorDecision: "approve_promotion", requiresOperatorDecision: true }); });
  it("keeps ccc-lab-super r2 manifest edges, source spans, and live/delete intents", () => { const root = join(fixture, "ccc-lab-super-r2"); const result = ccc.compileCccPrdPacket({ rootDir: root, manifestPath: join(root, "manifest.json") }); expect(result.kind).toBe("bundle"); expect(result.sources).toHaveLength(18); expect(result.sources?.every((source) => source.path.endsWith(".md"))).toBe(true); expect(result.protectedActions?.map((action) => action.kind)).toEqual(expect.arrayContaining(["live_execution", "deletion"])); });
});
