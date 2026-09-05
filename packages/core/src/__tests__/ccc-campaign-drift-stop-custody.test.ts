import { describe, expect, it } from "vitest";
import {
  CccCampaignCustodyError,
  inspectCccCampaignCustodyDrift,
  reconstructCccCampaignCustody,
  type CccCampaignCustodyRecord,
} from "../ccc-campaign/custody.js";
import {
  createCccCampaignManifest,
  hashCccCampaignManifest,
} from "../ccc-campaign/canonical.js";
import {
  CCC_PRD_IMPORT_STOPPED_STATE,
  assertCccPrdImportNotStopped,
} from "../ccc-prd/importer.js";
import { CccPrdImportError } from "../ccc-prd/import-error.js";
import {
  CCC_CAMPAIGN_OPERATOR_STOPPED_PREFIX,
  productNextAction,
  type CccPrdProductNextActionInput,
} from "../ccc-prd/product-status.js";
import { computeCccPrdSemanticBundleSha256 } from "../ccc-prd/contract.js";
import {
  createCccPrdImportTestProductBundle,
  createCccPrdImportTestProductExecutionPolicy,
  rehashCccPrdImportTestProductBundleV2,
} from "../__test-utils__/ccc-prd-import-fixture.js";
import type {
  CccPrdProofV2,
  CccPrdSemanticBundle,
  CccPrdSemanticBundleV2,
} from "../ccc-prd/types.js";
import type { CccCampaignProductExecutionPolicy } from "../ccc-campaign/types.js";

/*
 * The live shape this file pins.
 *
 * Three Gate 3 campaigns (ccc-gate3-quant-engine-l12-20260903 and its -l12r2- /
 * -l12r3- successors) were imported by the copier that PR #66 (7976064a6)
 * replaced. That copier enumerated `executionToolchain` field by field and so
 * dropped the whole `python` sub-object when it wrote the campaign manifest
 * into the import row. The bundle in the same row kept its python block.
 *
 * Every later reader re-derives the manifest from that bundle, gets the python
 * block back, and finds the stored manifest no longer matches. Reconstruction
 * refuses with "campaign manifest drift". `fn prd stop` needs a fresh status
 * digest and status reconstructs custody, so the refusal is circular and the
 * campaigns cannot be stopped through the CLI at all.
 *
 * The fixture below is deliberately python-less on the stored side only. It
 * does not weaken the refusal; it proves the refusal is detectable as drift,
 * so a stop path can be built that never needs reconstruction to succeed.
 */

const targetRoot = "/tmp/ccc-fusion-drift-stop";
const campaignStartedAt = "2026-09-03T12:00:00.000Z";
const pythonRoot = "/tmp/ccc-fusion-python/cpython-3.12.11";

function pythonBearingProof(): CccPrdProofV2 {
  const identity = {
    executablePath: "/tmp/ccc-fusion-toolchain/task",
    executableSha256: "0".repeat(64),
    version: "task 3.44.1",
    versionOutputSha256: "1".repeat(64),
  };
  return {
    schema: "ccc-prd.proof.v2",
    id: "PROOF-EVIDENCE-LABELS",
    requirementIds: ["REQ-EVIDENCE-LABELS"],
    clauseIds: ["AC-REQ-EVIDENCE-LABELS-001"],
    phases: ["task"],
    command: "task verify:evidence-labels",
    positiveOracle: "the declared candidate passes the frozen verifier",
    positiveCases: [
      { id: "POS-EVIDENCE-LABELS-1", description: "labelled evidence passes" },
    ],
    negativeControls: [
      { id: "NEG-EVIDENCE-LABELS-1", description: "unlabelled evidence fails" },
    ],
    verifierClosure: [
      {
        role: "task_runner",
        path: "Taskfile.yml",
        baseGitBlobOid: "a".repeat(40),
        sha256: "8".repeat(64),
      },
    ],
    candidateInputs: ["src/evidence/labels.py"],
    executionToolchain: {
      task: { ...identity },
      node: { ...identity, executablePath: "/tmp/ccc-fusion-toolchain/node" },
      proofHost: {
        ...identity,
        id: "fusion-cli-semantic-proof-host.v1",
        executablePath: "/tmp/ccc-fusion-toolchain/admission.js",
      },
      linkedRuntime: [],
      python: {
        executablePath: `${pythonRoot}/bin/python3.12`,
        executableSha256: "2".repeat(64),
        version: "Python 3.12.11",
        versionOutputSha256: "3".repeat(64),
        runtimeManifest: {
          schema: "ccc-prd.python-runtime-manifest.v1",
          interpreter: {
            path: `${pythonRoot}/bin/python3.12`,
            sha256: "2".repeat(64),
          },
          stdlibRoot: `${pythonRoot}/lib/python3.12`,
          pythonHomeRoot: pythonRoot,
          sitePackagesRoots: [`${pythonRoot}/lib/python3.12/site-packages`],
          extensionModuleRoots: [`${pythonRoot}/lib/python3.12`],
          runtimeSupport: [],
          stdlib: [
            {
              path: `${pythonRoot}/lib/python3.12/EXTERNALLY-MANAGED`,
              sha256: "4".repeat(64),
            },
          ],
          sitePackages: [],
          extensionModules: [],
          dylibClosure: [],
        },
      },
    },
    verifierProfile: {
      schema: "ccc-prd.verifier.python-adapter.v1",
      adapterPath: "verify/qe_evidence_adapter.py",
      targetPath: "verify/cases/labels",
    },
    spans: [
      {
        documentId: "DOC-EVIDENCE",
        path: "docs/prd.md",
        startLine: 1,
        endLine: 1,
        startColumn: 1,
        endColumn: 2,
        excerptSha256: "c".repeat(64),
      },
    ],
    confidence: "high",
  } as unknown as CccPrdProofV2;
}

function bundleWithPython(): CccPrdSemanticBundleV2 {
  const base = createCccPrdImportTestProductBundle(targetRoot, "drift-stop");
  const v2 = base as CccPrdSemanticBundle as unknown as CccPrdSemanticBundleV2;
  return rehashCccPrdImportTestProductBundleV2({
    ...v2,
    schema: "ccc-prd.bundle.v2",
    // The two requirement fields the v2 hash projection reads and the legacy
    // product fixture does not carry.
    requirements: v2.requirements.map((requirement) => ({
      acceptanceClauses: [],
      acceptanceDispositions: [],
      ...requirement,
    })),
    proofs: [pythonBearingProof()],
  });
}

/**
 * The row exactly as the pre-#66 copier left it: bundle keeps python, stored
 * manifest does not, and both hashes on the row were computed from the stored
 * (python-less) manifest, because that is what the old writer hashed.
 */
function driftedRow(): CccCampaignCustodyRecord {
  const bundle = bundleWithPython();
  const executionPolicy: CccCampaignProductExecutionPolicy =
    createCccPrdImportTestProductExecutionPolicy(bundle);
  const freshManifest = createCccCampaignManifest({
    projectId: "PROJECT-drift-stop",
    importId: "IMPORT-drift-stop",
    idempotencyKey: "ccc-gate3-quant-engine-l12-20260903",
    campaignId: "CAMPAIGN-drift-stop",
    bundle,
    executionPolicy,
    targetRepositoryPath: targetRoot,
    campaignStartedAt,
    manifestSchema: "ccc-campaign.manifest.v2",
    executionAuthorizationMode: "sealed_bundle_v1",
  });
  const pythonLessManifest = {
    ...freshManifest,
    proofs: (freshManifest.proofs as readonly CccPrdProofV2[]).map((proof) => {
      const { python: _dropped, ...toolchainWithoutPython } =
        proof.executionToolchain as Record<string, unknown>;
      return { ...proof, executionToolchain: toolchainWithoutPython };
    }),
  };
  const storedHash = hashCccCampaignManifest(
    pythonLessManifest as unknown as Parameters<
      typeof hashCccCampaignManifest
    >[0],
  );
  return {
    projectId: "PROJECT-drift-stop",
    importId: "IMPORT-drift-stop",
    idempotencyKey: "ccc-gate3-quant-engine-l12-20260903",
    identityHash: storedHash,
    bundleHash: bundle.bundleHash,
    packetHash: bundle.sourceHash,
    sidecarHash: bundle.sidecarHash,
    sourceVersion: bundle.sourceVersion,
    targetRepository: freshManifest.targetRepository.path,
    targetBase: bundle.targetRepository.baseCommit,
    canonicalBundle: bundle,
    executionPolicy,
    campaignManifest: pythonLessManifest,
    campaignManifestHash: storedHash,
    campaignStartedAt: freshManifest.campaignStartedAt,
    campaignDeadlineAt: freshManifest.campaignDeadlineAt,
  };
}

/** The same campaign, written by the post-#66 copier. Nothing drifts. */
function healthyRow(): CccCampaignCustodyRecord {
  const row = driftedRow();
  const bundle = row.canonicalBundle as CccPrdSemanticBundleV2;
  const manifest = createCccCampaignManifest({
    projectId: row.projectId,
    importId: row.importId,
    idempotencyKey: row.idempotencyKey,
    campaignId: "CAMPAIGN-drift-stop",
    bundle,
    executionPolicy: row.executionPolicy as CccCampaignProductExecutionPolicy,
    targetRepositoryPath: targetRoot,
    campaignStartedAt,
    manifestSchema: "ccc-campaign.manifest.v2",
    executionAuthorizationMode: "sealed_bundle_v1",
  });
  const manifestHash = hashCccCampaignManifest(manifest);
  return {
    ...row,
    identityHash: manifestHash,
    campaignManifest: manifest,
    campaignManifestHash: manifestHash,
  };
}

function nextActionInput(
  overrides: Partial<CccPrdProductNextActionInput> = {},
): CccPrdProductNextActionInput {
  return {
    row: {
      state: "active",
      runnable: 1,
      lastError: null,
      requestCount: 0,
    },
    observedAt: "2026-09-04T00:00:00.000Z",
    campaignDeadlineAt: "2026-09-04T09:57:40.000Z",
    requestBudget: {
      scope: "campaign-global",
      maximum: 576,
      used: 0,
      remaining: 576,
      providerTasks: 0,
      deterministicMinimum: 0,
      headroomAboveMinimum: 576,
      completionAdequacy: "unproven",
    },
    taskStatuses: [],
    workItems: [],
    proofs: [],
    orphanProofAttempts: [],
    providerAttempts: [],
    approvals: [],
    landingIntents: [],
    landingMaterializations: [],
    landingTerminals: [],
    liveExecutionActionIds: new Set<string>(),
    mergeActionIds: new Set<string>(),
    ...overrides,
  } as unknown as CccPrdProductNextActionInput;
}

describe("drifted CCC campaign stop custody", () => {
  it("RED-L16-a: the python-less stored manifest still refuses reconstruction", () => {
    // The refusal itself must not move. This is the check the stop path is
    // forbidden from weakening.
    expect(() => reconstructCccCampaignCustody(driftedRow()))
      .toThrow(CccCampaignCustodyError);
    expect(() => reconstructCccCampaignCustody(driftedRow()))
      .toThrow("campaign manifest drift");
  });

  it("RED-L16-a: drift is reportable without reconstruction succeeding", () => {
    const drift = inspectCccCampaignCustodyDrift(driftedRow());

    expect(drift.drifted).toBe(true);
    expect(drift.drifted && drift.reason).toBe("campaign manifest drift");
  });

  it("RED-L16-a: a campaign whose custody reconstructs is not drifted", () => {
    const row = healthyRow();

    // Guards the fixture: without this, a broken fixture would report drift for
    // the wrong reason and the stop path would look usable on healthy campaigns.
    expect(() => reconstructCccCampaignCustody(row)).not.toThrow();
    expect(inspectCccCampaignCustodyDrift(row)).toEqual({ drifted: false });
  });

  it("RED-L16-a: the drift is the dropped python block, not the hashes", () => {
    const row = driftedRow();
    const bundle = row.canonicalBundle as CccPrdSemanticBundleV2;
    const storedProofs =
      (row.campaignManifest as { proofs: readonly CccPrdProofV2[] }).proofs;

    // Bundle custody is intact; only the manifest copy lost python.
    expect(computeCccPrdSemanticBundleSha256(bundle)).toBe(row.bundleHash);
    expect(bundle.proofs[0]!.executionToolchain.python).toBeDefined();
    expect(
      (storedProofs[0]!.executionToolchain as Record<string, unknown>).python,
    ).toBeUndefined();
  });

  it("RED-L16-d: a stopped import refuses reconcile instead of re-projecting", () => {
    const stopMarker = `${CCC_CAMPAIGN_OPERATOR_STOPPED_PREFIX}${"f".repeat(64)}`;

    let thrown: unknown = null;
    try {
      assertCccPrdImportNotStopped({
        idempotencyKey: "ccc-gate3-quant-engine-l12-20260903",
        state: CCC_PRD_IMPORT_STOPPED_STATE,
        lastError: `${stopMarker} custody-drift: campaign manifest drift`,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CccPrdImportError);
    expect((thrown as CccPrdImportError).code).toBe("CCC_PRD_IMPORT_STOPPED");
    // The operator sees why the campaign is closed, not just that it is.
    expect((thrown as CccPrdImportError).message)
      .toContain("custody-drift: campaign manifest drift");
  });

  it("RED-L16-d: an active import is still free to reconcile", () => {
    expect(() =>
      assertCccPrdImportNotStopped({
        idempotencyKey: "ccc-gate3-quant-engine-l12-20260903",
        state: "active",
        lastError: null,
      })
    ).not.toThrow();
  });

  it("RED-L16-c: a stopped import reports abandoned, not reconcile-import", () => {
    const stopMarker = `${CCC_CAMPAIGN_OPERATOR_STOPPED_PREFIX}${"f".repeat(64)}`;
    const action = productNextAction(nextActionInput({
      row: {
        state: CCC_PRD_IMPORT_STOPPED_STATE,
        runnable: 0,
        lastError: `${stopMarker} custody-drift: campaign manifest drift`,
        requestCount: 0,
      },
      workItems: [
        {
          id: "work-1",
          state: "cancelled",
          lastError: stopMarker,
          blockedReason:
            `${stopMarker} operator stop | custody-drift: campaign manifest drift`,
        },
      ],
    } as unknown as Partial<CccPrdProductNextActionInput>));

    // Telling the operator to reconcile a stopped campaign is what re-projects
    // its tasks back into the owner's repository.
    expect(action.kind).toBe("abandoned");
    expect(action.reason).toContain("campaign manifest drift");
  });
});
