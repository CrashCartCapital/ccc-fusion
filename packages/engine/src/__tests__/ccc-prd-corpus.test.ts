import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkflowExtensionRegistry,
  canonicalCccPrdJson,
  deriveWorkflowExtensionHostProvenance,
  type CccPrdAuthoringProposal,
  type CccPrdSemanticBundle,
} from "@fusion/core";
import * as engine from "@fusion/engine";
import {
  CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION,
  CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
} from "../ccc-campaign-proof-admission.js";

const ccc = engine as typeof engine & {
  authorCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    adapter: {
      id: string;
      model: string;
      generateCandidate(): Promise<CccPrdAuthoringProposal>;
    };
    workflowExtensionRegistry: WorkflowExtensionRegistry;
  }): Promise<{ kind: string; sidecar?: unknown; review?: Record<string, unknown[]> }>;
  compileCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    sidecarPath: string;
    requireMaterialCoverage?: boolean;
  }): CccPrdSemanticBundle | { kind: "refusal"; diagnostics: unknown[] };
};

const fixture = new URL("./fixtures/ccc-prd-canaries/ccc-lab-super-r2/", import.meta.url);
const manifestPath = new URL("manifest.json", fixture).pathname;
const proposalPath = new URL("authoring-response.fixture.json", fixture).pathname;
const sidecarPath = new URL("candidate.sidecar.v1.json", fixture).pathname;
const sourcePaths = (JSON.parse(readFileSync(manifestPath, "utf8")) as {
  entries: Array<{ relative_path: string; authoritative: boolean }>;
}).entries.filter((entry) => entry.authoritative).map((entry) => entry.relative_path);
const before = new Map(sourcePaths.map((path) => [path, readFileSync(new URL(path, fixture))]));

afterEach(() => {
  for (const [path, bytes] of before) {
    expect(readFileSync(new URL(path, fixture)).equals(bytes), `${path} changed`).toBe(true);
  }
});

describe("ccc-prd admitted ccc-lab-super oracle", () => {
  it("generates the frozen sidecar from unchanged dense Markdown through the production authoring seam", async () => {
    const proposal = JSON.parse(readFileSync(proposalPath, "utf8")) as CccPrdAuthoringProposal;
    const workflowExtensionRegistry = new WorkflowExtensionRegistry();
    workflowExtensionRegistry.register(
      CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
      CCC_CAMPAIGN_PROOF_ADMISSION_CONTRIBUTION,
      await deriveWorkflowExtensionHostProvenance({
        pluginId: CCC_CAMPAIGN_PROOF_ADMISSION_PLUGIN_ID,
        pluginVersion: "1.0.0",
        trustedRootPath: fixture.pathname,
        entryRelativePath: "authoring-response.fixture.json",
        manifestRelativePath: "manifest.json",
      }),
    );
    const authored = await ccc.authorCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      adapter: {
        id: "local-deterministic-fixture",
        model: "proposal-file-v1",
        generateCandidate: async () => proposal,
      },
      workflowExtensionRegistry,
    });
    expect(authored.kind).toBe("candidate");
    expect(authored.review).toMatchObject({
      ambiguities: [],
      unresolvedDecisions: [],
      exceptions: [],
      protectedActions: [
        { id: "ACTION-LIVE-EXECUTION", target: "ccc-lab-super:pre-live-provider-gate" },
        { id: "ACTION-PHYSICAL-DELETION", target: "ccc-lab-super:cleanup_eligibility.physical_delete" },
      ],
    });
    const legacyProjection = structuredClone(authored.sidecar) as {
      materialCoverage?: unknown;
      proofs: Array<{ admission?: unknown }>;
    };
    delete legacyProjection.materialCoverage;
    expect(legacyProjection.proofs).toHaveLength(3);
    for (const proof of legacyProjection.proofs) {
      expect(proof.admission).toMatchObject({
        schema: "ccc-prd.proof-admission.v1",
        pluginId: "fusion-native",
        pluginVersion: "1.0.0",
        extensionId: "ccc-proof-admission",
        proofVersion: "ccc-proof-admission.v1",
      });
      delete proof.admission;
    }
    expect(`${canonicalCccPrdJson(legacyProjection)}\n`).toBe(
      readFileSync(sidecarPath, "utf8"),
    );
  });

  it("refuses the historical three-requirement projection as implausibly shallow", () => {
    const result = ccc.compileCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      sidecarPath,
      requireMaterialCoverage: true,
    });
    expect(result.kind).toBe("refusal");
    expect(result).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "CCC_PRD_EXTRACTION_IMPLAUSIBLY_SHALLOW" }),
        expect.objectContaining({ code: "CCC_PRD_MATERIAL_SECTION_UNDISPOSITIONED" }),
        expect.objectContaining({ code: "CCC_PRD_SOURCE_REQUIREMENT_UNDISPOSITIONED" }),
      ]),
    });
  });
});
