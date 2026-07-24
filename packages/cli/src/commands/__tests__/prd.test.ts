import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPrdCommand } from "../prd.js";
const roots: string[] = []; afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
describe("prd compile and validate commands", () => {
  it("compile and validate are zero-store commands", () => { const root = mkdtempSync(join(tmpdir(), "ccc-prd-cli-")); roots.push(root); const content = "| FR-1 | requirement | proof |\n"; writeFileSync(join(root, "root.md"), content); writeFileSync(join(root, "manifest.json"), JSON.stringify({ schema: "ccc-prd.packet.v1", source_version: "test", entries: [{ relative_path: "root.md", role: "root", authoritative: true, sha256: createHash("sha256").update(content).digest("hex") }] })); const output: string[] = []; expect(runPrdCommand(["compile", root, join(root, "manifest.json")], { write: (line) => output.push(line) })).toBe(0); expect(runPrdCommand(["validate", root, join(root, "manifest.json")], { write: (line) => output.push(line) })).toBe(0); expect(output).toHaveLength(2); expect(existsSync(join(root, ".fusion"))).toBe(false); });
});
