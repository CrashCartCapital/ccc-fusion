/*
FNXC:CccPrdImportPreflight 2026-10-14-18:46:
One import preflight for `fn prd preview|import` and the planning import bridge (D18, ADR B Q2 step 6, card B3, critic 6). The importer re-checks only custody for a fresh product import; verifier conformance, target HEAD, implementation-fact provenance, the request floor and both confinement readiness probes used to live only in the CLI's inline chain, so a second caller (the bridge, IB2) would have skipped them. The chain moved here unchanged, in the CLI's exact order, as two phases:
- Phase A, `preflightCccPrdProductPacket`: compile with material coverage, bundle completeness, fact provenance, the preview-only v1 refusal, the execution plan, the request floor, toolchain custody paths, then the agent-verification confinement probe (import refuses when not ready) and the semantic-proof sandbox probe. No project or database is needed.
- Phase B, `preflightCccPrdProductTarget`: project/target match, target HEAD against the frozen base, semantic-proof v2 custody, verifier conformance when the sandbox is ready, the v1 exact-replay check, then the preview identity and its confirmation digest.
The CLI keeps argument parsing, project resolution, the PostgreSQL layer check, the confirmation comparison and all rendering, so its codes, messages and refusal order are unchanged (its prd tests pin them). Neither phase shells out: `readTargetHead` and the CLI-owned toolchain resolver are injected (the engine no-blocking-shellout rule).
*/
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  CCC_CAMPAIGN_RECOMMENDED_REQUESTS_PER_PROVIDER_TASK,
  CCC_PRD_REQUEST_BUDGET_BELOW_PROVIDER_TASK_FLOOR,
  assertCccPrdSemanticProofV2Custody,
  canonicalCccPrdJson,
  cccCampaignRequestFloor,
  cccCampaignRequestSizingGuidance,
  inspectCccPrdImport,
  parseCccPrdProductExecutionPlan,
  type AsyncDataLayer,
  type CccCampaignProductExecutionPolicy,
  type CccPrdSemanticBundle,
  type CccPrdSemanticProofToolchainPaths,
} from "@fusion/core";
import { assertCccSemanticProofVerifierConformance } from "../ccc-campaign-proof-execution.js";
import {
  inspectCccSemanticProofSandboxReadiness,
  isCccSemanticProofSandboxReady,
  type CccSemanticProofSandboxReadiness,
} from "../ccc-campaign-proof-sandbox.js";
import {
  inspectVerifierConfinementReadiness,
  isVerifierConfinementReady,
  type VerifierConfinementReadiness,
} from "../run-verification-tool.js";
import { validateCccPrdPacketImplementationFactProvenance } from "./authoring.js";
import { compileCccPrdPacket } from "./compiler.js";

export const CCC_PRD_PRODUCT_PREVIEW_SCHEMA = "ccc-prd.product-preview.v1" as const;

const SEMANTIC_V2_REQUIRED_MESSAGE =
  "Fresh CCC PRD product campaigns require a controller-admitted semantic bundle v2; v1 remains inspection and exact-replay only";

/** A coded refusal raised inside the preflight; both phases return it as `product_refusal`. */
export class CccPrdProductPreflightError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CccPrdProductPreflightError";
  }
}

export type CccPrdProductPreviewIdentity = Readonly<{
  schema: string;
  projectId: string;
  projectPath: string;
  bundleHash: string;
  packetHash: string;
  sidecarHash: string;
  targetRepository: string;
  targetBase: string;
  targetHead: string;
  executionPolicy: CccCampaignProductExecutionPolicy;
}>;

export type CccPrdProductRequestBudget = Readonly<{
  scope: "campaign-global";
  maximum: number;
  providerTasks: number;
  deterministicMinimum: number;
  headroomAboveMinimum: number;
  recommendedStartingMaximum: number;
  headroomAboveRecommendation: number;
  sizingPosture: "tight" | "generous";
  completionAdequacy: "unproven";
  explanation: string;
}>;

/**
 * `executionPlan` is the parsed plan value (the planning bridge passes its
 * `execution_plan` artifact). A caller that reads the plan from a file may
 * pass a function instead: it is called exactly where the CLI always read its
 * file (after compile and the preview-only v1 refusal), so a missing plan file
 * is never reported before those refusals. A thrown error becomes a
 * `product_refusal` with the error's own code. A JSON value is never a
 * function, so the two forms cannot be confused.
 */
export type CccPrdProductExecutionPlanReader = () => unknown;

export type CccPrdProductPacketPreflightInput = Readonly<{
  mode: "preview" | "import";
  packet: Readonly<{ rootDir: string; manifestPath: string; sidecarPath: string }>;
  expectedTarget: string;
  expectedBase: string;
  /** The plan value, or a {@link CccPrdProductExecutionPlanReader}. */
  executionPlan: unknown;
  /** CLI: preview "check", import "importer" (the importer enforces it); planning: "check". */
  requestFloor: "check" | "importer";
}>;

export type CccPrdProductImportPreflightDependencies = Readonly<{
  /** Required: the CLI locates the built proof host relative to its own module. */
  resolveSemanticProofToolchainPaths: (input: Readonly<{
    pythonRequired: boolean;
    targetRoot?: string;
  }>) => CccPrdSemanticProofToolchainPaths;
  /** Required: async, because engine code may not shell out synchronously. */
  readTargetHead: (targetRoot: string) => Promise<string>;
  compileCccPrdPacket?: typeof compileCccPrdPacket;
  validateImplementationFactProvenance?: typeof validateCccPrdPacketImplementationFactProvenance;
  inspectVerifierConfinementReadiness?: () => Promise<VerifierConfinementReadiness>;
  inspectSemanticProofSandboxReadiness?: () => Promise<CccSemanticProofSandboxReadiness>;
  assertSemanticProofV2Custody?: typeof assertCccPrdSemanticProofV2Custody;
  assertSemanticProofVerifierConformance?: typeof assertCccSemanticProofVerifierConformance;
  inspectCccPrdImport?: typeof inspectCccPrdImport;
}>;

export type CccPrdProductCompileRefusal = Readonly<{ kind: "refusal"; diagnostics?: readonly unknown[] }>;

export type CccPrdProductPacketPreflight =
  | Readonly<{ kind: "compile_refusal"; refusal: CccPrdProductCompileRefusal }>
  | Readonly<{ kind: "product_refusal"; code: string; message: string }>
  | Readonly<{ kind: "agent_confinement_unavailable"; readiness: VerifierConfinementReadiness }>
  | Readonly<{
    kind: "packet_admitted";
    bundle: CccPrdSemanticBundle;
    executionPolicy: CccCampaignProductExecutionPolicy;
    semanticProofToolchainPaths?: CccPrdSemanticProofToolchainPaths;
    verifierConfinement: VerifierConfinementReadiness;
    semanticProofSandboxReadiness: CccSemanticProofSandboxReadiness;
  }>;

export type CccPrdProductTargetPreflight =
  | Readonly<{ kind: "product_refusal"; code: string; message: string }>
  | Readonly<{
    kind: "admitted";
    bundle: CccPrdSemanticBundle;
    executionPolicy: CccCampaignProductExecutionPolicy;
    semanticProofToolchainPaths?: CccPrdSemanticProofToolchainPaths;
    targetHead: string;
    identity: CccPrdProductPreviewIdentity;
    confirmationDigest: string;
    /** True only when the verifier-conformance check actually ran. */
    verifierConformanceChecked: boolean;
    /** Import must still refuse with this after the caller's own digest comparison (CLI order). */
    importBlocker?: Readonly<{
      kind: "semantic_proof_sandbox_unavailable";
      readiness: CccSemanticProofSandboxReadiness;
    }>;
  }>;

/** Moved verbatim from the CLI (`prd.ts` assertProductBundleComplete). */
export function assertCccPrdProductBundleComplete(bundle: CccPrdSemanticBundle): void {
  for (const [label, values] of [
    ["requirements", bundle.requirements],
    ["proofs", bundle.proofs],
    ["tasks", bundle.tasks],
    ["workflows", bundle.workflows],
  ] as const) {
    if (values.length === 0) {
      throw new CccPrdProductPreflightError(
        "CCC_PRD_PRODUCT_BUNDLE_SHALLOW",
        `CCC PRD product import refuses zero ${label}`,
      );
    }
  }
  const taskRequirementIds = new Set(
    bundle.tasks.flatMap(({ requirementIds }) => requirementIds),
  );
  const declaredProofIds = new Set<string>(bundle.proofs.map(({ id }) => id));
  for (const requirement of bundle.requirements) {
    if (!taskRequirementIds.has(requirement.id)) {
      throw new CccPrdProductPreflightError(
        "CCC_PRD_REQUIREMENT_TASK_COVERAGE_MISSING",
        `CCC PRD requirement ${requirement.id} has no task disposition`,
      );
    }
    if (
      requirement.proofIds.length === 0
      || requirement.proofIds.some((proofId) => !declaredProofIds.has(proofId))
    ) {
      throw new CccPrdProductPreflightError(
        "CCC_PRD_REQUIREMENT_PROOF_COVERAGE_MISSING",
        `CCC PRD requirement ${requirement.id} has no complete proof disposition`,
      );
    }
  }
}

/** Moved verbatim from the CLI (`prd.ts` productPreviewIdentity); key order is the preview's. */
export function createCccPrdProductPreviewIdentity(input: Readonly<{
  projectId: string;
  projectPath: string;
  targetHead: string;
  bundle: CccPrdSemanticBundle;
  executionPolicy: CccCampaignProductExecutionPolicy;
}>): CccPrdProductPreviewIdentity {
  return {
    schema: CCC_PRD_PRODUCT_PREVIEW_SCHEMA,
    projectId: input.projectId,
    projectPath: resolve(input.projectPath),
    bundleHash: input.bundle.bundleHash,
    packetHash: input.bundle.sourceHash,
    sidecarHash: input.bundle.sidecarHash,
    targetRepository: resolve(input.bundle.targetRepository.path),
    targetBase: input.bundle.targetRepository.baseCommit,
    targetHead: input.targetHead,
    executionPolicy: input.executionPolicy,
  };
}

/** Moved verbatim from the CLI (`prd.ts` productConfirmationDigest). */
export function computeCccPrdProductConfirmationDigest(
  identity: CccPrdProductPreviewIdentity,
): string {
  return createHash("sha256")
    .update(canonicalCccPrdJson(identity), "utf8")
    .digest("hex");
}

/** Moved verbatim from the CLI (`prd.ts` productRequestBudget). */
export function cccPrdProductRequestBudget(
  bundle: CccPrdSemanticBundle,
  executionPolicy: CccCampaignProductExecutionPolicy,
): CccPrdProductRequestBudget {
  const providerTasks = executionPolicy.routes.length;
  // Same structural floor core's importer enforces (2 per provider task: one
  // MUTATE turn plus the single REPAIR turn); preview must never admit a
  // bundle that import will refuse.
  const deterministicMinimum = cccCampaignRequestFloor(providerTasks);
  const {
    recommendedStartingMaximum,
    headroomAboveRecommendation,
    sizingPosture,
  } = cccCampaignRequestSizingGuidance(
    providerTasks,
    bundle.bounds.maxRequests,
  );
  const recommendationGap = Math.abs(headroomAboveRecommendation);
  const recommendationPosition = headroomAboveRecommendation === 0
    ? "meets that recommendation exactly"
    : `is ${recommendationGap} requests ${sizingPosture === "generous" ? "above" : "below"} that recommendation`;
  return {
    scope: "campaign-global",
    maximum: bundle.bounds.maxRequests,
    providerTasks,
    deterministicMinimum,
    headroomAboveMinimum: bundle.bounds.maxRequests - deterministicMinimum,
    recommendedStartingMaximum,
    headroomAboveRecommendation,
    sizingPosture,
    completionAdequacy: "unproven",
    explanation:
      `Two requests per provider task (one MUTATE turn plus the single REPAIR turn) is only a structural admission floor. Start at ${CCC_CAMPAIGN_RECOMMENDED_REQUESTS_PER_PROVIDER_TASK} requests per provider task (${recommendedStartingMaximum} total here) unless evidence supports another finite envelope. This packet is ${sizingPosture}: it ${recommendationPosition}, but remains valid because the recommendation is guidance, not an admission or safety ceiling. The campaign cap is global, creates no per-task quota or reservation, and completion adequacy remains unproven.`,
  };
}

/** Moved verbatim from the CLI (`prd.ts` assertProductRequestBudgetFloor). */
export function assertCccPrdProductRequestBudgetFloor(
  bundle: CccPrdSemanticBundle,
  executionPolicy: CccCampaignProductExecutionPolicy,
): void {
  const budget = cccPrdProductRequestBudget(bundle, executionPolicy);
  if (budget.maximum >= budget.deterministicMinimum) return;
  throw new CccPrdProductPreflightError(
    CCC_PRD_REQUEST_BUDGET_BELOW_PROVIDER_TASK_FLOOR,
    `campaign maxRequests ${budget.maximum} is below the structural floor ${budget.deterministicMinimum} (2 per provider task: one MUTATE turn plus the single REPAIR turn; this floor is not an adequacy guarantee)`,
  );
}

/**
 * Compile with material coverage, then require a complete bundle and
 * source-bound implementation facts (`prd.ts` compileProductBundle, moved).
 * Shared by Phase A and by `fn prd policy`, which compiles the same way.
 */
export function compileCccPrdProductBundle(
  input: Readonly<{
    rootDir: string;
    manifestPath: string;
    sidecarPath: string;
    expectedTarget: string;
    expectedBase: string;
  }>,
  deps: Pick<
    CccPrdProductImportPreflightDependencies,
    "compileCccPrdPacket" | "validateImplementationFactProvenance"
  > = {},
): CccPrdSemanticBundle | CccPrdProductCompileRefusal {
  const result = (deps.compileCccPrdPacket ?? compileCccPrdPacket)({
    ...input,
    requireMaterialCoverage: true,
  });
  if (result.kind === "refusal") return result;
  assertCccPrdProductBundleComplete(result);
  const provenanceDiagnostics = (
    deps.validateImplementationFactProvenance
    ?? validateCccPrdPacketImplementationFactProvenance
  )({
    rootDir: input.rootDir,
    manifestPath: input.manifestPath,
    facts: result,
  });
  if (provenanceDiagnostics.length > 0) {
    return { kind: "refusal", diagnostics: provenanceDiagnostics };
  }
  return result;
}

function codedRefusal(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): Readonly<{ kind: "product_refusal"; code: string; message: string }> {
  const detail = error as { code?: unknown; message?: unknown } | null | undefined;
  return {
    kind: "product_refusal",
    code: typeof detail?.code === "string" ? detail.code : fallbackCode,
    message: typeof detail?.message === "string" ? detail.message : fallbackMessage,
  };
}

/** Phase A: everything before a project or database is needed (`prd.ts` 2030-2094 before B3). */
export async function preflightCccPrdProductPacket(
  input: CccPrdProductPacketPreflightInput,
  deps: CccPrdProductImportPreflightDependencies,
): Promise<CccPrdProductPacketPreflight> {
  let bundle: CccPrdSemanticBundle;
  let executionPolicy: CccCampaignProductExecutionPolicy;
  let semanticProofToolchainPaths: CccPrdSemanticProofToolchainPaths | undefined;
  // Same region and same fallback code as the CLI's own catch: any failure
  // from compile to toolchain custody is a product refusal.
  try {
    const compiled = compileCccPrdProductBundle({
      rootDir: input.packet.rootDir,
      manifestPath: input.packet.manifestPath,
      sidecarPath: input.packet.sidecarPath,
      expectedTarget: input.expectedTarget,
      expectedBase: input.expectedBase,
    }, deps);
    if (compiled.kind === "refusal") return { kind: "compile_refusal", refusal: compiled };
    bundle = compiled;
    if (input.mode === "preview" && bundle.schema !== "ccc-prd.bundle.v2") {
      throw new CccPrdProductPreflightError(
        "CCC_PRD_PRODUCT_SEMANTIC_V2_REQUIRED",
        SEMANTIC_V2_REQUIRED_MESSAGE,
      );
    }
    const planValue = typeof input.executionPlan === "function"
      ? (input.executionPlan as CccPrdProductExecutionPlanReader)()
      : input.executionPlan;
    executionPolicy = parseCccPrdProductExecutionPlan(planValue, bundle).policy;
    if (input.requestFloor === "check") assertCccPrdProductRequestBudgetFloor(bundle, executionPolicy);
    if (bundle.schema === "ccc-prd.bundle.v2") {
      const pythonRequired = bundle.proofs.some((proof) => proof.verifierProfile?.schema === "ccc-prd.verifier.python-adapter.v1");
      semanticProofToolchainPaths = deps.resolveSemanticProofToolchainPaths({
        pythonRequired,
        ...(pythonRequired ? { targetRoot: bundle.targetRepository.path } : {}),
      });
    }
  } catch (error) {
    return codedRefusal(error, "CCC_PRD_PRODUCT_PREFLIGHT_FAILED", "CCC PRD product preflight failed");
  }

  const verifierConfinement = await (
    deps.inspectVerifierConfinementReadiness ?? inspectVerifierConfinementReadiness
  )();
  if (input.mode === "import" && !isVerifierConfinementReady(verifierConfinement)) {
    return { kind: "agent_confinement_unavailable", readiness: verifierConfinement };
  }
  // Probed once here: the verifier-conformance check needs the semantic-proof
  // v2 sandbox (sandbox-exec, Darwin only today), a different backend from the
  // agent-verification confinement above. Its import refusal is the caller's,
  // after the confirmation comparison (Phase B's importBlocker), so a stale
  // digest is always reported first. See
  // docs/plans/2026-09-03-semantic-proof-sandbox-linux-gap.md.
  const semanticProofSandboxReadiness = await (
    deps.inspectSemanticProofSandboxReadiness ?? inspectCccSemanticProofSandboxReadiness
  )();
  return {
    kind: "packet_admitted",
    bundle,
    executionPolicy,
    ...(semanticProofToolchainPaths ? { semanticProofToolchainPaths } : {}),
    verifierConfinement,
    semanticProofSandboxReadiness,
  };
}

/**
 * Phase B: project/target match, HEAD, custody, conformance, v1 replay and
 * identity (`prd.ts` 2097-2236 before B3). The caller resolves the project and
 * its PostgreSQL layer. A failure that carries a string `code` and `message`
 * (every refusal here and in custody, conformance and import inspection) is
 * returned as a `product_refusal`; any other failure is rethrown unchanged, so
 * the CLI's project wrapper reports it exactly as before.
 */
export async function preflightCccPrdProductTarget(
  admitted: Extract<CccPrdProductPacketPreflight, { kind: "packet_admitted" }>,
  project: Readonly<{ projectId: string; projectPath: string; layer: AsyncDataLayer }>,
  options: Readonly<{ mode: "preview" | "import"; idempotencyKey?: string }>,
  deps: CccPrdProductImportPreflightDependencies,
): Promise<CccPrdProductTargetPreflight> {
  const { bundle, executionPolicy, semanticProofToolchainPaths, semanticProofSandboxReadiness } = admitted;
  const sandboxReady = isCccSemanticProofSandboxReady(semanticProofSandboxReadiness);
  try {
    if (resolve(project.projectPath) !== resolve(bundle.targetRepository.path)) {
      throw new CccPrdProductPreflightError(
        "CCC_PRD_PROJECT_TARGET_MISMATCH",
        `resolved project ${project.projectPath} does not match PRD target ${bundle.targetRepository.path}`,
      );
    }
    const targetHead = await deps.readTargetHead(project.projectPath);
    if (targetHead !== bundle.targetRepository.baseCommit) {
      throw new CccPrdProductPreflightError(
        "CCC_PRD_TARGET_HEAD_DRIFT",
        `target HEAD ${targetHead} does not match frozen base ${bundle.targetRepository.baseCommit}`,
      );
    }
    let verifierConformanceChecked = false;
    if (bundle.schema === "ccc-prd.bundle.v2") {
      if (!semanticProofToolchainPaths) {
        throw new CccPrdProductPreflightError(
          "CCC_PRD_SEMANTIC_PROOF_CUSTODY_REFUSED",
          "semantic-proof toolchain custody paths are missing from the packet preflight",
        );
      }
      const modelWriteRoots = executionPolicy.routes.flatMap((route) => [
        ...(route.ownedPaths ?? []),
        ...(route.allowedWriteRoots ?? []),
      ]);
      await (deps.assertSemanticProofV2Custody ?? assertCccPrdSemanticProofV2Custody)({
        repositoryRoot: project.projectPath,
        baseCommit: bundle.targetRepository.baseCommit,
        proofs: bundle.proofs,
        modelWriteRoots,
        toolchainPaths: semanticProofToolchainPaths,
      });
      // Custody above proves the closure/candidate/toolchain shape on
      // bundle.proofs is exactly what a fresh Git re-derivation would produce,
      // so those proof definitions are already the conformance input, with no
      // second hydration pass. Running a declared proof's real verify command
      // needs the semantic-proof v2 sandbox, so both modes skip the check when
      // it is not ready; verifierConformanceChecked says so, and import still
      // refuses through importBlocker after the caller's digest comparison.
      if (sandboxReady) {
        await (
          deps.assertSemanticProofVerifierConformance ?? assertCccSemanticProofVerifierConformance
        )({
          repositoryRoot: project.projectPath,
          baseCommit: bundle.targetRepository.baseCommit,
          proofs: bundle.proofs,
          modelWriteRoots,
        });
        verifierConformanceChecked = true;
      }
    } else {
      // v1 is exact replay only: without a key there is nothing to replay.
      const inspected = options.idempotencyKey === undefined
        ? null
        : await (deps.inspectCccPrdImport ?? inspectCccPrdImport)({
          idempotencyKey: options.idempotencyKey,
          layer: project.layer,
          rootDir: project.projectPath,
        });
      if (
        !inspected
        || inspected.bundleHash !== bundle.bundleHash
        || resolve(inspected.targetRepository) !== resolve(project.projectPath)
        || inspected.targetBase !== bundle.targetRepository.baseCommit
      ) {
        throw new CccPrdProductPreflightError(
          "CCC_PRD_PRODUCT_SEMANTIC_V2_REQUIRED",
          SEMANTIC_V2_REQUIRED_MESSAGE,
        );
      }
    }
    const identity = createCccPrdProductPreviewIdentity({
      projectId: project.projectId,
      projectPath: project.projectPath,
      targetHead,
      bundle,
      executionPolicy,
    });
    return {
      kind: "admitted",
      bundle,
      executionPolicy,
      ...(semanticProofToolchainPaths ? { semanticProofToolchainPaths } : {}),
      targetHead,
      identity,
      confirmationDigest: computeCccPrdProductConfirmationDigest(identity),
      verifierConformanceChecked,
      // A campaign cannot run any declared proof's verify command without the
      // semantic-proof v2 sandbox, so import must refuse with this, using the
      // confinement-unavailable shape (no verifier has been judged yet).
      ...(bundle.schema === "ccc-prd.bundle.v2" && bundle.proofs.length > 0 && !sandboxReady
        ? {
          importBlocker: {
            kind: "semantic_proof_sandbox_unavailable" as const,
            readiness: semanticProofSandboxReadiness,
          },
        }
        : {}),
    };
  } catch (error) {
    const detail = error as { code?: unknown; message?: unknown } | null | undefined;
    if (typeof detail?.code !== "string" || typeof detail.message !== "string") throw error;
    return { kind: "product_refusal", code: detail.code, message: detail.message };
  }
}
