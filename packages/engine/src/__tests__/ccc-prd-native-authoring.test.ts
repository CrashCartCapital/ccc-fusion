import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
  WorkflowExtensionRegistry,
  canonicalCccPrdJson,
  computeCccPrdProofDefinitionSha256,
  deriveWorkflowExtensionHostProvenance,
  type CccPrdAuthoringProposal,
  type WorkflowProofAdmissionExtensionContribution,
} from "@fusion/core";
import {
  authorCccPrdPacket as authorCccPrdPacketWithoutProofAdmission,
} from "../ccc-prd/authoring.js";
import {
  createNativeCccPrdAuthoringAdapter,
  type CccPrdNativeAuthoringTransport,
} from "../ccc-prd/native-authoring-adapter.js";

const sourceFixture = new URL("./fixtures/ccc-prd-canaries/ccc-lab-super-r2/", import.meta.url);
const sourceManifestPath = new URL("manifest.json", sourceFixture).pathname;
const baseProposal = JSON.parse(
  readFileSync(new URL("authoring-response.fixture.json", sourceFixture), "utf8"),
) as CccPrdAuthoringProposal;
const REVIEWED_DECISIONS_PATH = "reviewed-operator-decisions.md";

type SourceReference = CccPrdAuthoringProposal["requirements"][number]["sourceRefs"];
type FixtureConstraints = {
  targetRepository: CccPrdAuthoringProposal["targetRepository"];
  bounds: CccPrdAuthoringProposal["bounds"];
  maxReviewItems: number;
};

let temporaryFixtureRoot = "";
let fixtureRoot = "";
let manifestPath = "";
let firstSourcePath = "";
let proposal: CccPrdAuthoringProposal;
let constraints: FixtureConstraints;
let alternateRequirementSourceRefs: SourceReference;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function sourceReference(exactQuote: string): SourceReference {
  return [{ path: REVIEWED_DECISIONS_PATH, exactQuote }];
}

function buildReviewedOperatorDecisions(input: CccPrdAuthoringProposal): {
  content: string;
  proposal: CccPrdAuthoringProposal;
  alternateRequirementSourceRefs: SourceReference;
} {
  const executionContract = [
    "## Target repository, execution bounds, and admitted writes",
    `Target repository path: ${input.targetRepository.path}`,
    `Frozen baseline commit: ${input.targetRepository.baseCommit}`,
    `Maximum requests: ${input.bounds.maxRequests}`,
    `Maximum duration in milliseconds: ${input.bounds.maxDurationMs}`,
    `Maximum concurrency: ${input.bounds.maxConcurrency}`,
    ...input.admittedWriteRoots.flatMap((root) => [
      `Admitted write root: ${root.path}`,
      `Admitted write purpose: ${root.purpose}`,
    ]),
    ...input.nonGoals.map((nonGoal) => `Non-goal: ${nonGoal}`),
  ].join("\n");
  const requirementSections = new Map(input.requirements.map((requirement) => [
    requirement.id,
    [
      `## Reviewed requirement: ${requirement.id}`,
      `Requirement statement: ${requirement.statement}`,
      `Acceptance behavior: ${requirement.acceptance}`,
    ].join("\n"),
  ]));
  const proofSections = new Map(input.proofs.map((proof) => [
    proof.id,
    [
      `## Reviewed proof: ${proof.id}`,
      `Verifier command: ${proof.command}`,
      `Positive oracle: ${proof.positiveOracle}`,
      ...proof.negativeControls.map((control) => `Negative control: ${control}`),
    ].join("\n"),
  ]));
  const protectedActionSections = new Map(input.protectedActions.map((action) => [
    action.id,
    [
      `## Reviewed protected action: ${action.id}`,
      `Protected action kind: ${action.kind}`,
      `Protected action target: ${action.target}`,
    ].join("\n"),
  ]));
  const alternateRequirement = input.requirements[0]!;
  const alternateRequirementSection = [
    `## Alternate reviewed requirement evidence: ${alternateRequirement.id}`,
    `Alternate requirement statement: ${alternateRequirement.statement}`,
    `Alternate acceptance behavior: ${alternateRequirement.acceptance}`,
  ].join("\n");
  const reviewedProposal = structuredClone(input);
  reviewedProposal.requirements = reviewedProposal.requirements.map((requirement) => ({
    ...requirement,
    sourceRefs: sourceReference(requirementSections.get(requirement.id)!),
  }));
  reviewedProposal.proofs = reviewedProposal.proofs.map((proof) => ({
    ...proof,
    sourceRefs: sourceReference(proofSections.get(proof.id)!),
  }));
  reviewedProposal.protectedActions = reviewedProposal.protectedActions.map((action) => ({
    ...action,
    sourceRefs: sourceReference(protectedActionSections.get(action.id)!),
  }));
  return {
    content: [
      "# Reviewed Operator Decisions",
      executionContract,
      ...requirementSections.values(),
      ...proofSections.values(),
      ...protectedActionSections.values(),
      alternateRequirementSection,
      "",
    ].join("\n\n"),
    proposal: reviewedProposal,
    alternateRequirementSourceRefs: sourceReference(alternateRequirementSection),
  };
}

beforeAll(() => {
  temporaryFixtureRoot = mkdtempSync(join(tmpdir(), "ccc-prd-native-authoring-"));
  fixtureRoot = join(temporaryFixtureRoot, "packet");
  cpSync(sourceFixture.pathname, fixtureRoot, { recursive: true });

  const reviewed = buildReviewedOperatorDecisions(baseProposal);
  writeFileSync(join(fixtureRoot, REVIEWED_DECISIONS_PATH), reviewed.content, "utf8");
  const originalManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8")) as {
    schema: string;
    source_version: string;
    entries: Array<Record<string, unknown>>;
  };
  const testManifest = {
    schema: originalManifest.schema,
    source_version: originalManifest.source_version,
    entries: [
      ...originalManifest.entries,
      {
        authoritative: true,
        relative_path: REVIEWED_DECISIONS_PATH,
        role: "operator_decision",
        sha256: sha256(reviewed.content),
      },
    ],
  };
  manifestPath = join(fixtureRoot, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(testManifest, null, 2)}\n`, "utf8");

  firstSourcePath = testManifest.entries[0]!.relative_path as string;
  proposal = reviewed.proposal;
  alternateRequirementSourceRefs = reviewed.alternateRequirementSourceRefs;
  constraints = {
    targetRepository: proposal.targetRepository,
    bounds: proposal.bounds,
    maxReviewItems: 8,
  };
});

afterAll(() => {
  if (temporaryFixtureRoot) {
    rmSync(temporaryFixtureRoot, { recursive: true, force: true });
  }
});

async function proofAdmissionRegistry(
  proofVersion = "ccc-proof-admission.v1",
): Promise<WorkflowExtensionRegistry> {
  const registry = new WorkflowExtensionRegistry();
  const contribution: WorkflowProofAdmissionExtensionContribution = {
    extensionId: "ccc-proof-admission",
    name: "CCC proof admission",
    kind: "proof-admission",
    schemaVersion: 1,
    fallback: "failClosed",
    proofVersion,
    evaluate: async ({ inputSha256 }) => ({
      outcome: "pass",
      evaluatedInputSha256: inputSha256,
      summary: "definition admitted; command not executed",
    }),
  };
  const provenance = await deriveWorkflowExtensionHostProvenance({
    pluginId: "fusion-native",
    pluginVersion: "1.0.0",
    trustedRootPath: fixtureRoot,
    entryRelativePath: "authoring-response.fixture.json",
    manifestRelativePath: "manifest.json",
  });
  registry.register("fusion-native", contribution, provenance);
  return registry;
}

async function authorCccPrdPacket(
  input: Parameters<typeof authorCccPrdPacketWithoutProofAdmission>[0],
) {
  return authorCccPrdPacketWithoutProofAdmission({
    ...input,
    workflowExtensionRegistry:
      input.workflowExtensionRegistry ?? await proofAdmissionRegistry(),
  });
}

function nativeAdapter(
  transport: CccPrdNativeAuthoringTransport,
  overrides: Partial<{
    maxDurationMs: number;
    maxPromptBytes: number;
    maxResponseBytes: number;
  }> = {},
) {
  return createNativeCccPrdAuthoringAdapter({
    provider: "loopback-authoring",
    model: "fixture-model",
    maxDurationMs: overrides.maxDurationMs ?? 5_000,
    maxPromptBytes: overrides.maxPromptBytes ?? 1_000_000,
    maxResponseBytes: overrides.maxResponseBytes ?? 256_000,
    transport,
  });
}

describe("CCC PRD native authoring adapter", () => {
  it("generates a traceable candidate from unchanged packet bytes through one bounded native request", async () => {
    const generate = vi.fn<CccPrdNativeAuthoringTransport>(async (request) => ({
      text: canonicalCccPrdJson(proposal),
      provider: request.provider,
      model: request.model,
    }));
    const adapter = nativeAdapter(generate);
    const workflowExtensionRegistry = await proofAdmissionRegistry();

    const result = await authorCccPrdPacket({
      rootDir: fixtureRoot,
      manifestPath,
      adapter,
      constraints,
      workflowExtensionRegistry,
    });

    expect(result.kind, JSON.stringify(result)).toBe("candidate");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      provider: "loopback-authoring",
      model: "fixture-model",
      maxDurationMs: 5_000,
      maxResponseBytes: 256_000,
      prompt: expect.stringContaining("\"packetHash\""),
    }));
    expect(generate.mock.calls[0]![0].prompt).toContain(
      `"path":${JSON.stringify(firstSourcePath)}`,
    );
    expect(generate.mock.calls[0]![0].prompt).toContain(
      "\"targetRepository\"",
    );
    expect(generate.mock.calls[0]![0].prompt).toContain(
      "collectively disposition every Markdown heading block and requirement-like row",
    );
    expect(result).toMatchObject({
      kind: "candidate",
      sidecar: {
        targetRepository: proposal.targetRepository,
        bounds: proposal.bounds,
        provenance: {
          authoringAdapterId: "fusion-native-model-runtime-v1",
          authoringModel: "loopback-authoring/fixture-model",
        },
      },
      review: {
        ambiguities: [],
        unresolvedDecisions: [],
        exceptions: [],
      },
    });
    if (result.kind !== "candidate") throw new Error("expected candidate");
    expect(result.sidecar.proofs).toHaveLength(proposal.proofs.length);
    for (const proof of result.sidecar.proofs) {
      expect(proof.admission).toMatchObject({
        schema: CCC_PRD_PROOF_ADMISSION_SCHEMA_VERSION,
        pluginId: "fusion-native",
        pluginVersion: "1.0.0",
        extensionId: "ccc-proof-admission",
        proofVersion: "ccc-proof-admission.v1",
        definitionSha256: computeCccPrdProofDefinitionSha256(proof),
      });
    }
  });

  it("refuses authoring when the fixed native proof admission entry is missing", async () => {
    const result = await authorCccPrdPacket({
      rootDir: fixtureRoot,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
        text: canonicalCccPrdJson(proposal),
        provider: request.provider,
        model: request.model,
      })),
      constraints,
      workflowExtensionRegistry: new WorkflowExtensionRegistry(),
    });

    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_PROOF_ADMISSION_MISSING" }],
    });
  });

  it("refuses authoring when the fixed native proof admission entry is degraded", async () => {
    const workflowExtensionRegistry = await proofAdmissionRegistry();
    workflowExtensionRegistry.degrade(
      ["plugin:fusion-native:ccc-proof-admission"],
      "runtime-fault",
      "test degradation",
    );

    const result = await authorCccPrdPacket({
      rootDir: fixtureRoot,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
        text: canonicalCccPrdJson(proposal),
        provider: request.provider,
        model: request.model,
      })),
      constraints,
      workflowExtensionRegistry,
    });

    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_PROOF_ADMISSION_DEGRADED" }],
    });
  });

  it("refuses authoring when the fixed registry id is occupied by the wrong proof identity", async () => {
    const result = await authorCccPrdPacket({
      rootDir: fixtureRoot,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
        text: canonicalCccPrdJson(proposal),
        provider: request.provider,
        model: request.model,
      })),
      constraints,
      workflowExtensionRegistry: await proofAdmissionRegistry("wrong-proof-version"),
    });

    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_PROOF_ADMISSION_IDENTITY" }],
    });
  });

  it("refuses malformed native response text instead of accepting prose", async () => {
    const result = await authorCccPrdPacket({
      rootDir: fixtureRoot,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
        text: "Here is the sidecar:\n{}",
        provider: request.provider,
        model: request.model,
      })),
      constraints,
    });

    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_FAILED" }],
    });
  });

  it("refuses malformed proposal rows with the proposal-invalid diagnostic", async () => {
    const malformedProposal = structuredClone(proposal) as { requirements: unknown[] };
    malformedProposal.requirements = [null];

    const result = await authorCccPrdPacket({
      rootDir: fixtureRoot,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
        text: canonicalCccPrdJson(malformedProposal),
        provider: request.provider,
        model: request.model,
      })),
      constraints,
    });

    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_PROPOSAL_INVALID" }],
    });
  });

  it("refuses provider or model identity drift from the native transport", async () => {
    const result = await authorCccPrdPacket({
      rootDir: fixtureRoot,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
        text: canonicalCccPrdJson(proposal),
        provider: request.provider,
        model: "different-model",
      })),
      constraints,
    });

    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_FAILED" }],
    });
  });

  it("refuses over-large prompts before calling the native transport", async () => {
    const generate = vi.fn<CccPrdNativeAuthoringTransport>();

    const result = await authorCccPrdPacket({
      rootDir: fixtureRoot,
      manifestPath,
      adapter: nativeAdapter(generate, { maxPromptBytes: 1 }),
      constraints,
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_FAILED" }],
    });
  });

  it("refuses over-large native responses after the bounded request", async () => {
    const generate = vi.fn<CccPrdNativeAuthoringTransport>(async (request) => ({
      text: canonicalCccPrdJson(proposal),
      provider: request.provider,
      model: request.model,
    }));

    const result = await authorCccPrdPacket({
      rootDir: fixtureRoot,
      manifestPath,
      adapter: nativeAdapter(generate, { maxResponseBytes: 1 }),
      constraints,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_FAILED" }],
    });
  });

  it("refuses generated review lists that exceed the admitted human-review bound", async () => {
    const excessiveReview = structuredClone(proposal);
    excessiveReview.ambiguities = [{
      id: "AMBIGUITY-EXTRA-001",
      statement: "The packet contains an extra unresolved phrasing question.",
      sourceRefs: proposal.requirements[0]!.sourceRefs,
    }];

    const result = await authorCccPrdPacket({
      rootDir: fixtureRoot,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
        text: canonicalCccPrdJson(excessiveReview),
        provider: request.provider,
        model: request.model,
      })),
      constraints: {
        ...constraints,
        maxReviewItems: 1,
      },
    });

    expect(result).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_REVIEW_UNBOUNDED" }],
    });
  });

  it("accepts a zero-item review ceiling when the proposal has no review entries", async () => {
    const noReview = structuredClone(proposal);
    noReview.protectedActions = [];
    noReview.tasks = noReview.tasks.map((task) => ({
      ...task,
      protectedActionIds: [],
    }));

    const result = await authorCccPrdPacket({
      rootDir: fixtureRoot,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
        text: canonicalCccPrdJson(noReview),
        provider: request.provider,
        model: request.model,
      })),
      constraints: {
        ...constraints,
        maxReviewItems: 0,
      },
    });

    expect(result.kind, JSON.stringify(result)).toBe("candidate");
  });

  it("refuses stable-ID drift when regenerating the same admitted packet", async () => {
    const firstAdapter = nativeAdapter(async (request) => ({
        text: canonicalCccPrdJson(proposal),
        provider: request.provider,
        model: request.model,
      }));
    const first = await authorCccPrdPacket({
      rootDir: fixtureRoot,
      manifestPath,
      adapter: firstAdapter,
      constraints,
    });
    expect(first.kind).toBe("candidate");
    if (first.kind !== "candidate") throw new Error("expected initial candidate");

    const changed = structuredClone(proposal);
    changed.requirements[0]!.id = "REQ-CHURNED";
    const second = await authorCccPrdPacket({
      rootDir: fixtureRoot,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
          text: canonicalCccPrdJson(changed),
          provider: request.provider,
          model: request.model,
        })),
      constraints,
      previousSidecar: first.sidecar,
    });

    expect(second).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_IDENTITY_DRIFT" }],
    });
  });

  it("accepts an unchanged packet when prior source-bound declarations are reordered", async () => {
    const first = await authorCccPrdPacket({
      rootDir: fixtureRoot,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
        text: canonicalCccPrdJson(proposal),
        provider: request.provider,
        model: request.model,
      })),
      constraints,
    });
    expect(first.kind).toBe("candidate");
    if (first.kind !== "candidate") throw new Error("expected initial candidate");

    const previousSidecar = structuredClone(first.sidecar);
    previousSidecar.requirements.reverse();
    const second = await authorCccPrdPacket({
      rootDir: fixtureRoot,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
        text: canonicalCccPrdJson(proposal),
        provider: request.provider,
        model: request.model,
      })),
      constraints,
      previousSidecar,
    });

    expect(second.kind, JSON.stringify(second)).toBe("candidate");
  });

  it("refuses a stable ID that is silently rebound to different source evidence", async () => {
    const first = await authorCccPrdPacket({
      rootDir: fixtureRoot,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
          text: canonicalCccPrdJson(proposal),
          provider: request.provider,
          model: request.model,
        })),
      constraints,
    });
    expect(first.kind).toBe("candidate");
    if (first.kind !== "candidate") throw new Error("expected initial candidate");

    const rebound = structuredClone(proposal);
    rebound.requirements[0]!.sourceRefs = structuredClone(alternateRequirementSourceRefs);
    const second = await authorCccPrdPacket({
      rootDir: fixtureRoot,
      manifestPath,
      adapter: nativeAdapter(async (request) => ({
          text: canonicalCccPrdJson(rebound),
          provider: request.provider,
          model: request.model,
        })),
      constraints,
      previousSidecar: first.sidecar,
    });

    expect(second).toMatchObject({
      kind: "refusal",
      diagnostics: [{ code: "CCC_PRD_AUTHORING_IDENTITY_DRIFT" }],
    });
  });
});
