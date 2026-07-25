import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalCccPrdJson,
  type CccPrdAuthoringProposal,
  type CccPrdSemanticBundle,
} from "@fusion/core";
import * as engine from "@fusion/engine";

const ccc = engine as typeof engine & {
  authorCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    adapter: {
      id: string;
      model: string;
      generateCandidate(): Promise<CccPrdAuthoringProposal>;
    };
  }): Promise<{ kind: string; sidecar?: unknown; review?: Record<string, unknown[]> }>;
  compileCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    sidecarPath: string;
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
    const authored = await ccc.authorCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      adapter: {
        id: "local-deterministic-fixture",
        model: "proposal-file-v1",
        generateCandidate: async () => proposal,
      },
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
    expect(`${canonicalCccPrdJson(authored.sidecar)}\n`).toBe(readFileSync(sidecarPath, "utf8"));
  });

  it("compiles exact non-zero entity counts and stable real-packet identities", () => {
    const result = ccc.compileCccPrdPacket({
      rootDir: fixture.pathname,
      manifestPath,
      sidecarPath,
    });
    expect(result.kind).toBe("bundle");
    const bundle = result as CccPrdSemanticBundle;
    expect({
      sources: bundle.orderedSources.length,
      requirements: bundle.requirements.length,
      proofs: bundle.proofs.length,
      tasks: bundle.tasks.length,
      edges: bundle.edges.length,
      workflows: bundle.workflows.length,
      documents: bundle.documents.length,
      artifacts: bundle.artifacts.length,
      importIntents: bundle.importIntents.length,
      protectedActions: bundle.protectedActions.length,
    }).toEqual({
      sources: 18,
      requirements: 3,
      proofs: 3,
      tasks: 3,
      edges: 2,
      workflows: 1,
      documents: 1,
      artifacts: 1,
      importIntents: 12,
      protectedActions: 2,
    });
    expect(bundle.sourceHash).toBe("6dec9877961c1055ae8210daabbf707a2893248f353220d0f9801958b3a47b39");
    expect(bundle.sidecarHash).toBe("644624afede709b457a075094df0c4b69072ca1823422e94fa2429449b039ed8");
    expect(bundle.bundleHash).toBe("3efeb73b93826a24098a34919222c27a4235c29635b3bfa37b945e9e6dbe629e");
  });
});
