import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as engine from "@fusion/engine";
import {
  WorkflowExtensionRegistry,
  deriveWorkflowExtensionHostProvenance,
  type CccPrdAuthoringProposal,
} from "@fusion/core";
import {
  CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
} from "../ccc-campaign-proof-admission.js";

const ccc = engine as typeof engine & {
  authorCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    adapter: { id: string; model: string; generateCandidate(): Promise<CccPrdAuthoringProposal> };
    workflowExtensionRegistry: WorkflowExtensionRegistry;
  }): Promise<{ kind: string; sidecar: Record<string, unknown> }>;
  compileCccPrdPacket(input: { rootDir: string; manifestPath: string; sidecarPath: string }): Record<string, unknown>;
  validateCccPrdPacket(input: { rootDir: string; manifestPath: string; sidecarPath: string }): Record<string, unknown>;
};

const fixture = new URL("./fixtures/ccc-prd-canaries/ccc-lab-super-r2/", import.meta.url);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function authoredPacket() {
  const rootDir = mkdtempSync(join(tmpdir(), "ccc-prd-proof-admission-"));
  roots.push(rootDir);
  cpSync(fixture, rootDir, { recursive: true });
  const manifestPath = join(rootDir, "manifest.json");
  const proposal = JSON.parse(readFileSync(join(rootDir, "authoring-response.fixture.json"), "utf8")) as CccPrdAuthoringProposal;
  const registry = new WorkflowExtensionRegistry();
  registry.register(
    CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
    CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION,
    await deriveWorkflowExtensionHostProvenance({
      pluginId: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
      pluginVersion: "1.0.0",
      trustedRootPath: rootDir,
      entryRelativePath: "authoring-response.fixture.json",
      manifestRelativePath: "manifest.json",
    }),
  );
  const authored = await ccc.authorCccPrdPacket({
    rootDir,
    manifestPath,
    adapter: { id: "local-deterministic-fixture", model: "fixture-v1", generateCandidate: async () => proposal },
    workflowExtensionRegistry: registry,
  });
  expect(authored.kind).toBe("candidate");
  const sidecarPath = join(rootDir, "candidate.sidecar.json");
  writeFileSync(sidecarPath, JSON.stringify(authored.sidecar));
  return { rootDir, manifestPath, sidecarPath, sidecar: authored.sidecar };
}

describe("ccc-prd proof-admission compiler", () => {
  it.each([
    ["wrong schema", (admission: Record<string, unknown>) => { admission.schema = "ccc-prd.proof-admission.v0"; }, "CCC_PRD_PROOF_ADMISSION_INVALID"],
    ["blank fixed identity", (admission: Record<string, unknown>) => { admission.pluginId = ""; }, "CCC_PRD_PROOF_ADMISSION_INVALID"],
    ["malformed source hash", (admission: Record<string, unknown>) => { admission.extensionSourceSha256 = "not-a-hash"; }, "CCC_PRD_PROOF_ADMISSION_INVALID"],
    ["parent-relative source path", (admission: Record<string, unknown>) => { admission.extensionRootRelativeSource = "../foreign.js"; }, "CCC_PRD_PROOF_ADMISSION_INVALID"],
    ["absolute source path", (admission: Record<string, unknown>) => { admission.extensionRootRelativeSource = "/tmp/foreign.js"; }, "CCC_PRD_PROOF_ADMISSION_INVALID"],
    ["backslash traversal source path", (admission: Record<string, unknown>) => { admission.extensionRootRelativeSource = "..\\foreign.js"; }, "CCC_PRD_PROOF_ADMISSION_INVALID"],
    ["file URL source path", (admission: Record<string, unknown>) => { admission.extensionRootRelativeSource = "file:///tmp/foreign.js"; }, "CCC_PRD_PROOF_ADMISSION_INVALID"],
    ["uppercase file URL source path", (admission: Record<string, unknown>) => { admission.extensionRootRelativeSource = "FiLe:foreign.js"; }, "CCC_PRD_PROOF_ADMISSION_INVALID"],
    ["stale definition hash", (admission: Record<string, unknown>) => { admission.definitionSha256 = "0".repeat(64); }, "CCC_PRD_PROOF_ADMISSION_STALE"],
  ] as const)("refuses a proof admission with %s", async (_label, mutate, expectedCode) => {
    const packet = await authoredPacket();
    const sidecar = structuredClone(packet.sidecar) as { proofs: Array<{ admission: Record<string, unknown> }> };
    mutate(sidecar.proofs[0]!.admission);
    writeFileSync(packet.sidecarPath, JSON.stringify(sidecar));
    const validation = ccc.validateCccPrdPacket(packet) as { valid: boolean; diagnostics: Array<{ code: string }> };
    const compiled = ccc.compileCccPrdPacket(packet) as { kind: string; diagnostics: Array<{ code: string }> };
    expect(validation.valid).toBe(false);
    expect(validation.diagnostics).toContainEqual(expect.objectContaining({ code: expectedCode }));
    expect(compiled.kind).toBe("refusal");
    expect(compiled.diagnostics).toContainEqual(expect.objectContaining({ code: expectedCode }));
  });

  it("accepts and compiles a legacy sidecar whose proofs omit admission", async () => {
    const packet = await authoredPacket();
    const sidecar = structuredClone(packet.sidecar) as { proofs: Array<{ admission?: unknown }> };
    for (const proof of sidecar.proofs) delete proof.admission;
    writeFileSync(packet.sidecarPath, JSON.stringify(sidecar));
    expect(ccc.validateCccPrdPacket(packet)).toEqual({ kind: "validation", valid: true, diagnostics: [] });
    const compiled = ccc.compileCccPrdPacket(packet) as {
      kind: string;
      proofs: Array<Record<string, unknown>>;
    };
    expect(compiled).toMatchObject({
      kind: "bundle",
      proofs: expect.arrayContaining([
        expect.not.objectContaining({ admission: expect.anything() }),
        expect.not.objectContaining({ admission: expect.anything() }),
      ]),
    });
    for (const proof of compiled.proofs) {
      expect(proof).not.toHaveProperty("admission");
    }
  });
});
