import { execFileSync } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CCC_PRD_SIDECAR_SCHEMA_VERSION,
  canonicalCccPrdJson,
  createCccPrdProductExecutionPlan,
  importCccPrdBundle,
  inspectCccCampaignProofAttempt,
  inspectCccPrdImport,
  inspectCccPrdProductStatus,
  parseCccPrdProductExecutionPlan,
  reconcileCccPrdImport,
  settleCccCampaignProofAttempt,
  type ApprovalRequest,
  type CccCampaignProductExecutionPolicy,
  type CccPrdProductExecutionPlan,
  type CccPrdProductExecutionRouteSelection,
  type CccPrdAuthoringAdapter,
  type CccPrdAuthoringConstraints,
  type CccPrdAuthoringProposal,
  type CccPrdImportInspection,
  type CccPrdImportResult,
  type CccPrdProductApprovalStatus,
  type CccPrdProductStatus,
  type CccPrdSemanticBundle,
  type CccPrdSidecar,
  type WorkflowExtensionRegistry,
} from "@fusion/core";
import * as engine from "@fusion/engine";
import { bootstrapCccCampaignProofAdmissionHost } from "./ccc-native-proof-host.js";
import {
  closeProjectStore,
  resolveProject,
  type ProjectContext,
} from "../project-context.js";
import {
  MAX_OPERATOR_CONTEXT_BYTES,
  readBoundedPrdStdin,
} from "./prd-stdin.js";
import {
  parseOperatorJsonFlag,
  renderIdempotencyKey,
  renderOperatorPayload,
  renderPreview,
} from "./prd-render.js";

export type PrdCommandIo = {
  write(line: string): void;
  readStdin?(): Promise<string>;
};

type Compiler = {
  CCC_PRD_INTAKE_CONTRACT_SCHEMA_VERSION: string;
  lintCccPrdIntakeMarkdown(input: {
    sourcePath: string;
    markdown: string;
  }): {
    readyForIntake: boolean;
  };
  renderCccPrdIntakeTemplate(): string;
  authorCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    adapter: CccPrdAuthoringAdapter;
    constraints?: CccPrdAuthoringConstraints;
    previousSidecar?: CccPrdSidecar;
    workflowExtensionRegistry?: WorkflowExtensionRegistry;
  }): Promise<{ kind: "candidate"; sidecar: unknown; review: unknown } | { kind: "refusal" }>;
  createNativeCccPrdAuthoringAdapter(input: {
    provider: string;
    model: string;
    maxDurationMs: number;
    maxPromptBytes: number;
    maxResponseBytes: number;
    mode?: "execution" | "understanding";
  }): CccPrdAuthoringAdapter;
  understandCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    adapter: CccPrdAuthoringAdapter;
    maxReviewItems: number;
    workflowExtensionRegistry: WorkflowExtensionRegistry;
  }): Promise<engine.CccPrdUnderstandingResult>;
  compileCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    sidecarPath: string;
    expectedTarget: string;
    expectedBase: string;
    requireMaterialCoverage?: boolean;
  }): CccPrdSemanticBundle | { kind: "refusal"; diagnostics?: unknown[] };
  validateCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    sidecarPath: string;
    expectedTarget: string;
    expectedBase: string;
    requireMaterialCoverage?: boolean;
  }): { kind: "validation"; valid: boolean; diagnostics: unknown[] };
  validateCccPrdPacketImplementationFactProvenance(input: {
    rootDir: string;
    manifestPath: string;
    facts: CccPrdSemanticBundle;
  }): unknown[];
};

const compiler = engine as typeof engine & Compiler;
export type VerifierConfinementReadiness = engine.VerifierConfinementReadiness;
export type PrdCommandDependencies = {
  bootstrapProofAdmission?: () => Promise<WorkflowExtensionRegistry>;
  buildCccPrdCorpusManifest?: typeof engine.buildCccPrdCorpusManifest;
  createNativeCccPrdAuthoringAdapter?: typeof engine.createNativeCccPrdAuthoringAdapter;
  discoverCccPrdCandidates?: typeof engine.discoverCccPrdCandidates;
  freezeCccPrdPacket?: typeof engine.freezeCccPrdPacket;
  resolveProject?: (projectName?: string) => Promise<ProjectContext>;
  closeProjectStore?: (context: ProjectContext) => Promise<void>;
  readTargetHead?: (targetRoot: string) => Promise<string>;
  importCccPrdBundle?: typeof importCccPrdBundle;
  inspectVerifierConfinementReadiness?: typeof engine.inspectVerifierConfinementReadiness;
  inspectCccPrdImport?: typeof inspectCccPrdImport;
  reconcileCccPrdImport?: typeof reconcileCccPrdImport;
  inspectCccPrdProductStatus?: typeof inspectCccPrdProductStatus;
  inspectCccCampaignProofAttempt?: typeof inspectCccCampaignProofAttempt;
  settleCccCampaignProofAttempt?: typeof settleCccCampaignProofAttempt;
  understandCccPrdPacket?: typeof engine.understandCccPrdPacket;
  computeCccCampaignLiveExecutionApprovalConfirmation?: typeof engine.computeCccCampaignLiveExecutionApprovalConfirmation;
  computeCccCampaignMergeApprovalConfirmation?: typeof engine.computeCccCampaignMergeApprovalConfirmation;
  approveCccCampaignLiveExecution?: typeof engine.approveCccCampaignLiveExecution;
  approveCccCampaignMerge?: typeof engine.approveCccCampaignMerge;
  computeCccCampaignOperatorControlConfirmation?: typeof engine.computeCccCampaignOperatorControlConfirmation;
  describeCccCampaignOperatorControls?: typeof engine.describeCccCampaignOperatorControls;
  applyCccCampaignOperatorControl?: typeof engine.applyCccCampaignOperatorControl;
};
export type PrdCommandContext = {
  projectName?: string;
  /**
   * Set by {@link runPrdCommand} from the `--json` flag. Human-readable prose
   * is the default; JSON keeps the exact machine-readable payload.
   */
  json?: boolean;
};

function operatorJson(context: PrdCommandContext): boolean {
  return context.json === true;
}

/**
 * The operator loop writes either the exact machine-readable payload or its
 * prose rendering. The JSON branch is deliberately the untouched original
 * expression so `--json` output cannot drift from what tooling already parses.
 */
function writeOperatorPayload(
  io: PrdCommandIo,
  context: PrdCommandContext,
  value: unknown,
): void {
  if (operatorJson(context)) {
    writeOperatorJson(io, value);
    return;
  }
  for (const line of renderOperatorPayload(value)) io.write(line);
}

function writeOperatorValue(
  io: PrdCommandIo,
  context: PrdCommandContext,
  value: unknown,
): void {
  if (operatorJson(context)) {
    io.write(JSON.stringify(value));
    return;
  }
  for (const line of renderOperatorPayload(value)) io.write(line);
}
const usage = [
  "usage: fn prd author <root-dir> <manifest-path> <sidecar-output> --target <repository> --base <40-hex-commit> --provider <provider> --model <model> --max-requests <n> --max-duration-ms <n> --max-concurrency <n> --max-prompt-bytes <n> --max-response-bytes <n> --max-review-items <n>",
  "       fn prd author <root-dir> <manifest-path> <proposal-path> <sidecar-output> (deterministic compatibility fixture)",
  "       fn prd understand <root-dir> <manifest-path> <review-output> --provider <provider> --model <model> --max-duration-ms <n> --max-prompt-bytes <n> --max-response-bytes <n> --max-review-items <n>",
  "       fn prd corpus <active-projects-root>",
  "       fn prd discover <active-projects-root>",
  "       fn prd freeze <active-projects-root> <selected-prd-path> <output-dir>",
  "       fn prd freeze <active-projects-root> <selected-prd-path> <output-dir> --target <repository> --base <40-hex-commit> --owned-path <path> --write-root <path> --write-purpose <purpose> --max-requests <n> --max-duration-ms <n> --max-concurrency <n>",
  "       fn prd freeze <active-projects-root> <selected-prd-path> <output-dir> --context-stdin",
  "       fn prd policy <root-dir> <manifest-path> <sidecar-path> <expected-target> <expected-base> <output-path> --provider <provider> --model <model> --transport <pi|cli> [--cli-adapter <id>]",
  "       fn prd policy <root-dir> <manifest-path> <sidecar-path> <expected-target> <expected-base> <output-path> --routes-file <path> (mutually exclusive with --provider/--model/--transport/--cli-adapter; exactly one form required)",
  "       fn prd template",
  "       fn prd lint <prd-path>",
  "       fn prd <validate|compile> <root-dir> <manifest-path> <sidecar-path> <expected-target> <expected-base>",
  "       fn prd preview <root-dir> <manifest-path> <sidecar-path> <execution-plan-path> <expected-target> <expected-base> [--project <id|name>]",
  "       fn prd import <root-dir> <manifest-path> <sidecar-path> <execution-plan-path> <expected-target> <expected-base> <idempotency-key> --confirm <preview-digest> [--project <id|name>]",
  "       fn prd new-key",
  "       fn prd <inspect|reconcile> <idempotency-key> [--project <id|name>]",
  "       fn prd status <idempotency-key> [--project <id|name>]",
  "       fn prd <pause|resume> <idempotency-key> --confirm <status-digest> [--project <id|name>]",
  "       fn prd <stop|abandon> <idempotency-key> --reason <reason> --confirm <status-digest> [--project <id|name>]",
  "       fn prd resolve-proof <idempotency-key> <attempt-key> <evidence-path> [--confirm <resolution-digest>] [--project <id|name>]",
  "       fn prd resolve-provider <idempotency-key> <attempt-key> <committed|proved-failed> <observer-id> <evidence-sha256> [--confirm <resolution-digest>] [--project <id|name>]",
  "       fn prd approve-execution <idempotency-key> <approval-request-id> --confirm <approval-digest> [--project <id|name>]",
  "       fn prd approve-merge <idempotency-key> <approval-request-id> --confirm <approval-digest> [--project <id|name>]",
  "       add --json to any command above for the exact machine-readable payload instead of operator prose",
].join("\n");

function isEscaping(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function isProtected(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => (
    segment === ".obsidian" || segment === "_KELSEY" || segment === "_secrets"
  ));
}

function authorProtectedPaths(
  rootDir: string,
  manifestPath: string,
  proposalPath: string,
): Set<string> {
  const root = realpathSync(rootDir);
  const paths = new Set<string>([
    resolve(manifestPath),
    realpathSync(manifestPath),
    resolve(proposalPath),
    realpathSync(proposalPath),
  ]);
  const manifest = JSON.parse(readFileSync(realpathSync(manifestPath), "utf8")) as {
    entries?: Array<{ relative_path?: unknown }>;
  };
  for (const entry of manifest.entries ?? []) {
    if (typeof entry.relative_path !== "string") continue;
    const lexicalPath = resolve(rootDir, entry.relative_path);
    const canonicalPath = resolve(root, entry.relative_path);
    paths.add(lexicalPath);
    paths.add(canonicalPath);
    try {
      paths.add(realpathSync(canonicalPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return paths;
}

function resolveAuthorOutput(
  rootDir: string,
  manifestPath: string,
  proposalPath: string,
  outputPath: string,
): string {
  const root = realpathSync(rootDir);
  const output = resolve(outputPath);
  const relativeOutput = relative(resolve(rootDir), output);
  if (isEscaping(relativeOutput) || isProtected(relativeOutput)) {
    throw new Error(`CCC_PRD_PATH_ESCAPE: sidecar output is outside the admitted root: ${outputPath}`);
  }
  const parent = realpathSync(dirname(output));
  const canonicalRelative = relative(root, parent);
  if (isEscaping(canonicalRelative) || isProtected(canonicalRelative)) {
    throw new Error(`CCC_PRD_PATH_ESCAPE: sidecar output parent is outside the admitted root: ${outputPath}`);
  }
  const canonicalOutput = join(parent, output.slice(output.lastIndexOf(sep) + 1));
  const protectedPaths = authorProtectedPaths(rootDir, manifestPath, proposalPath);
  if (protectedPaths.has(output) || protectedPaths.has(canonicalOutput)) {
    throw new Error(`CCC_PRD_SIDECAR_TARGET_PROTECTED: sidecar output is an admitted input: ${outputPath}`);
  }
  try {
    const stat = lstatSync(output);
    if (stat.isSymbolicLink()) {
      throw new Error(`CCC_PRD_PATH_ESCAPE: sidecar output is a symlink: ${outputPath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`CCC_PRD_SIDECAR_TARGET_OCCUPIED: sidecar output is not a regular file: ${outputPath}`);
    }
    let existing: unknown;
    try {
      existing = JSON.parse(readFileSync(output, "utf8"));
    } catch {
      throw new Error(`CCC_PRD_SIDECAR_TARGET_OCCUPIED: existing output is not a versioned sidecar: ${outputPath}`);
    }
    if (
      !existing
      || typeof existing !== "object"
      || Array.isArray(existing)
      || (existing as { schema?: unknown }).schema !== CCC_PRD_SIDECAR_SCHEMA_VERSION
    ) {
      throw new Error(`CCC_PRD_SIDECAR_TARGET_OCCUPIED: existing output is not a versioned sidecar: ${outputPath}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  return output;
}

function resolveAuthorInput(rootDir: string, inputPath: string): string {
  const root = realpathSync(rootDir);
  const input = realpathSync(inputPath);
  const canonicalRelative = relative(root, input);
  if (isEscaping(canonicalRelative) || isProtected(canonicalRelative)) {
    throw new Error(`CCC_PRD_PATH_ESCAPE: authoring proposal is outside the admitted root: ${inputPath}`);
  }
  const lexicalRelative = relative(resolve(rootDir), resolve(inputPath));
  if (!isEscaping(lexicalRelative)) {
    let cursor = resolve(rootDir);
    for (const segment of lexicalRelative.split(sep).filter(Boolean)) {
      cursor = resolve(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new Error(`CCC_PRD_PATH_ESCAPE: authoring proposal traverses a symlink: ${inputPath}`);
      }
    }
  }
  return input;
}

type GeneratedAuthorArgs = {
  rootDir: string;
  manifestPath: string;
  outputPath: string;
  provider: string;
  model: string;
  constraints: CccPrdAuthoringConstraints;
  maxDurationMs: number;
  maxPromptBytes: number;
  maxResponseBytes: number;
};

type GeneratedUnderstandingArgs = {
  rootDir: string;
  manifestPath: string;
  outputPath: string;
  provider: string;
  model: string;
  maxDurationMs: number;
  maxPromptBytes: number;
  maxResponseBytes: number;
  maxReviewItems: number;
};

const generatedUnderstandingFlags = [
  "--provider",
  "--model",
  "--max-duration-ms",
  "--max-prompt-bytes",
  "--max-response-bytes",
  "--max-review-items",
] as const;

const generatedAuthorFlags = [
  "--target",
  "--base",
  "--provider",
  "--model",
  "--max-requests",
  "--max-duration-ms",
  "--max-concurrency",
  "--max-prompt-bytes",
  "--max-response-bytes",
  "--max-review-items",
] as const;

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseGeneratedAuthorArgs(args: string[]): GeneratedAuthorArgs | undefined {
  const [subcommand, rootDir, manifestPath, outputPath, ...options] = args;
  if (subcommand !== "author" || !rootDir || !manifestPath || !outputPath) return undefined;
  if (options.length !== generatedAuthorFlags.length * 2) return undefined;

  const values = new Map<string, string>();
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index];
    const value = options[index + 1];
    if (
      !flag
      || !generatedAuthorFlags.includes(flag as (typeof generatedAuthorFlags)[number])
      || values.has(flag)
      || !value
      || value.startsWith("--")
    ) {
      return undefined;
    }
    values.set(flag, value);
  }
  if (values.size !== generatedAuthorFlags.length) return undefined;

  const target = values.get("--target");
  const base = values.get("--base");
  const provider = values.get("--provider");
  const model = values.get("--model");
  const maxRequests = parsePositiveInteger(values.get("--max-requests"));
  const maxDurationMs = parsePositiveInteger(values.get("--max-duration-ms"));
  const maxConcurrency = parsePositiveInteger(values.get("--max-concurrency"));
  const maxPromptBytes = parsePositiveInteger(values.get("--max-prompt-bytes"));
  const maxResponseBytes = parsePositiveInteger(values.get("--max-response-bytes"));
  const maxReviewItems = parseNonNegativeInteger(values.get("--max-review-items"));
  if (
    !target
    || !base
    || !provider
    || !model
    || !/^[0-9a-f]{40}$/.test(base)
    || !maxRequests
    || !maxDurationMs
    || !maxConcurrency
    || !maxPromptBytes
    || !maxResponseBytes
    || maxReviewItems === undefined
  ) {
    return undefined;
  }

  return {
    rootDir,
    manifestPath,
    outputPath,
    provider,
    model,
    constraints: {
      targetRepository: { path: target, baseCommit: base },
      bounds: { maxRequests, maxDurationMs, maxConcurrency },
      maxReviewItems,
    },
    maxDurationMs,
    maxPromptBytes,
    maxResponseBytes,
  };
}

function parseGeneratedUnderstandingArgs(
  args: string[],
): GeneratedUnderstandingArgs | undefined {
  const [subcommand, rootDir, manifestPath, outputPath, ...options] = args;
  if (
    subcommand !== "understand"
    || !rootDir
    || !manifestPath
    || !outputPath
    || options.length !== generatedUnderstandingFlags.length * 2
  ) {
    return undefined;
  }
  const values = new Map<string, string>();
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index];
    const value = options[index + 1];
    if (
      !flag
      || !generatedUnderstandingFlags.includes(
        flag as (typeof generatedUnderstandingFlags)[number],
      )
      || values.has(flag)
      || !value
      || value.startsWith("--")
    ) {
      return undefined;
    }
    values.set(flag, value);
  }
  const provider = values.get("--provider");
  const model = values.get("--model");
  const maxDurationMs = parsePositiveInteger(values.get("--max-duration-ms"));
  const maxPromptBytes = parsePositiveInteger(values.get("--max-prompt-bytes"));
  const maxResponseBytes = parsePositiveInteger(values.get("--max-response-bytes"));
  const maxReviewItems = parseNonNegativeInteger(values.get("--max-review-items"));
  if (
    !provider
    || !model
    || !maxDurationMs
    || !maxPromptBytes
    || !maxResponseBytes
    || maxReviewItems === undefined
    || values.size !== generatedUnderstandingFlags.length
  ) {
    return undefined;
  }
  return {
    rootDir,
    manifestPath,
    outputPath,
    provider,
    model,
    maxDurationMs,
    maxPromptBytes,
    maxResponseBytes,
    maxReviewItems,
  };
}

function writeSidecarAtomically(
  rootDir: string,
  manifestPath: string,
  proposalPath: string,
  outputPath: string,
  value: unknown,
): void {
  const output = resolveAuthorOutput(rootDir, manifestPath, proposalPath, outputPath);
  const temporaryRoot = mkdtempSync(join(realpathSync(rootDir), ".fusion-prd-tmp-"));
  const temporaryPath = join(temporaryRoot, "candidate.sidecar.json");
  try {
    writeFileSync(temporaryPath, `${canonicalCccPrdJson(value)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporaryPath, output);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

type ProductPolicyCommonArgs = {
  rootDir: string;
  manifestPath: string;
  sidecarPath: string;
  expectedTarget: string;
  expectedBase: string;
  outputPath: string;
};

type ProductPolicyArgs = ProductPolicyCommonArgs & (
  | {
    routeSelection: "single";
    providerId: string;
    modelId: string;
    transport: "pi" | "cli";
    cliAdapterId?: string;
  }
  | {
    routeSelection: "routes-file";
    routesFilePath: string;
  }
);

const PRODUCT_POLICY_FLAGS = [
  "--provider",
  "--model",
  "--transport",
  "--cli-adapter",
  "--routes-file",
] as const;

const PRODUCT_POLICY_ROUTE_SELECTION_MESSAGE =
  "fn prd policy requires exactly one route selection: --provider/--model/--transport [--cli-adapter] for a single route applied to every task, or --routes-file <path> for one route per task; provide exactly one form, not both and not neither.";

type ProductPolicyParseResult =
  | { kind: "usage" }
  | { kind: "route-selection-invalid" }
  | { kind: "parsed"; value: ProductPolicyArgs };

function parseProductPolicyArgs(args: string[]): ProductPolicyParseResult {
  const [
    subcommand,
    rootDir,
    manifestPath,
    sidecarPath,
    expectedTarget,
    expectedBase,
    outputPath,
    ...options
  ] = args;
  if (
    subcommand !== "policy"
    || !rootDir
    || !manifestPath
    || !sidecarPath
    || !expectedTarget
    || !expectedBase
    || !outputPath
    || !/^[0-9a-f]{40}$/.test(expectedBase)
    || options.length % 2 !== 0
  ) {
    return { kind: "usage" };
  }
  const values = new Map<string, string>();
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index];
    const value = options[index + 1];
    if (
      !flag
      || !PRODUCT_POLICY_FLAGS.includes(flag as (typeof PRODUCT_POLICY_FLAGS)[number])
      || !value
      || value.startsWith("--")
      || values.has(flag)
    ) {
      return { kind: "usage" };
    }
    values.set(flag, value);
  }

  const routesFilePath = values.get("--routes-file");
  const providerId = values.get("--provider");
  const modelId = values.get("--model");
  const transport = values.get("--transport");
  const cliAdapterId = values.get("--cli-adapter");
  const hasRoutesFile = routesFilePath !== undefined;
  const hasSingleFlag = providerId !== undefined
    || modelId !== undefined
    || transport !== undefined
    || cliAdapterId !== undefined;

  if (hasRoutesFile === hasSingleFlag) {
    return { kind: "route-selection-invalid" };
  }

  const common: ProductPolicyCommonArgs = {
    rootDir,
    manifestPath,
    sidecarPath,
    expectedTarget,
    expectedBase,
    outputPath,
  };

  if (hasRoutesFile) {
    return {
      kind: "parsed",
      value: { ...common, routeSelection: "routes-file", routesFilePath: routesFilePath! },
    };
  }

  if (
    !providerId
    || !modelId
    || (transport !== "pi" && transport !== "cli")
    || (transport === "cli" && !cliAdapterId)
    || (transport === "pi" && cliAdapterId)
    || values.size !== (transport === "cli" ? 4 : 3)
  ) {
    return { kind: "usage" };
  }
  return {
    kind: "parsed",
    value: {
      ...common,
      routeSelection: "single",
      providerId,
      modelId,
      transport,
      ...(cliAdapterId ? { cliAdapterId } : {}),
    },
  };
}

const CCC_PRD_ROUTES_BY_TASK_SCHEMA = "ccc-prd.routes-by-task.v1" as const;
const PRODUCT_POLICY_ROUTE_ENTRY_PI_KEYS = new Set(["providerId", "modelId", "transport"]);
const PRODUCT_POLICY_ROUTE_ENTRY_CLI_KEYS = new Set([
  "providerId",
  "modelId",
  "transport",
  "cliAdapterId",
]);

function readProductPolicyRoutesFile(
  rootDir: string,
  routesFilePath: string,
): Record<string, CccPrdProductExecutionRouteSelection> {
  let resolvedPath: string;
  try {
    resolvedPath = resolveAuthorInput(rootDir, routesFilePath);
  } catch (error) {
    throw new PrdProductCommandError(
      "CCC_PRD_ROUTES_FILE_READ_FAILED",
      `routes file ${routesFilePath} could not be admitted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    throw new PrdProductCommandError(
      "CCC_PRD_ROUTES_FILE_READ_FAILED",
      `routes file ${routesFilePath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PrdProductCommandError(
      "CCC_PRD_ROUTES_FILE_READ_FAILED",
      `routes file ${routesFilePath} is not valid JSON`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PrdProductCommandError(
      "CCC_PRD_ROUTES_FILE_INVALID",
      `routes file ${routesFilePath} must contain one JSON object`,
    );
  }
  const document = value as Record<string, unknown>;
  const extraTopKeys = Object.keys(document).filter((key) => key !== "schema" && key !== "routes");
  if (extraTopKeys.length > 0) {
    throw new PrdProductCommandError(
      "CCC_PRD_ROUTES_FILE_INVALID",
      `routes file ${routesFilePath} has unknown top-level fields: ${extraTopKeys.join(", ")}`,
    );
  }
  if (document.schema !== CCC_PRD_ROUTES_BY_TASK_SCHEMA) {
    throw new PrdProductCommandError(
      "CCC_PRD_ROUTES_FILE_INVALID",
      `routes file ${routesFilePath} must declare schema ${CCC_PRD_ROUTES_BY_TASK_SCHEMA}`,
    );
  }
  if (
    !document.routes
    || typeof document.routes !== "object"
    || Array.isArray(document.routes)
  ) {
    throw new PrdProductCommandError(
      "CCC_PRD_ROUTES_FILE_INVALID",
      `routes file ${routesFilePath} routes field must be an object keyed by task id`,
    );
  }
  const routesRaw = document.routes as Record<string, unknown>;
  const taskIds = Object.keys(routesRaw);
  if (taskIds.length === 0) {
    throw new PrdProductCommandError(
      "CCC_PRD_ROUTES_FILE_INVALID",
      `routes file ${routesFilePath} routes must declare at least one task route`,
    );
  }
  const routesByTaskId: Record<string, CccPrdProductExecutionRouteSelection> = {};
  for (const taskId of taskIds) {
    const entry = routesRaw[taskId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PrdProductCommandError(
        "CCC_PRD_ROUTES_FILE_INVALID",
        `routes file ${routesFilePath} route for task ${taskId} must be an object`,
      );
    }
    const route = entry as Record<string, unknown>;
    const transport = route.transport;
    const allowedKeys = transport === "cli"
      ? PRODUCT_POLICY_ROUTE_ENTRY_CLI_KEYS
      : PRODUCT_POLICY_ROUTE_ENTRY_PI_KEYS;
    const unknownKeys = Object.keys(route).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
      throw new PrdProductCommandError(
        "CCC_PRD_ROUTES_FILE_INVALID",
        `routes file ${routesFilePath} route for task ${taskId} has unknown fields: ${unknownKeys.join(", ")}`,
      );
    }
    const providerId = route.providerId;
    const modelId = route.modelId;
    const cliAdapterId = route.cliAdapterId;
    if (
      typeof providerId !== "string"
      || providerId.length === 0
      || typeof modelId !== "string"
      || modelId.length === 0
      || (transport !== "pi" && transport !== "cli")
      || (transport === "cli" && (typeof cliAdapterId !== "string" || cliAdapterId.length === 0))
      || (transport === "pi" && cliAdapterId !== undefined)
    ) {
      throw new PrdProductCommandError(
        "CCC_PRD_ROUTES_FILE_INVALID",
        `routes file ${routesFilePath} route for task ${taskId} must declare providerId, modelId, and transport pi|cli (cliAdapterId is required only for cli transport)`,
      );
    }
    routesByTaskId[taskId] = {
      providerId,
      modelId,
      transport,
      ...(transport === "cli" ? { cliAdapterId: cliAdapterId as string } : {}),
    };
  }
  return routesByTaskId;
}

function writeExecutionPlanAtomically(
  input: ProductPolicyArgs,
  plan: CccPrdProductExecutionPlan,
): string {
  const root = realpathSync(input.rootDir);
  const output = resolve(input.outputPath);
  const relativeOutput = relative(resolve(input.rootDir), output);
  if (isEscaping(relativeOutput) || isProtected(relativeOutput)) {
    throw new PrdProductCommandError(
      "CCC_PRD_PATH_ESCAPE",
      "execution-plan output is outside the admitted packet root",
    );
  }
  const parent = realpathSync(dirname(output));
  const canonicalRelative = relative(root, parent);
  if (isEscaping(canonicalRelative) || isProtected(canonicalRelative)) {
    throw new PrdProductCommandError(
      "CCC_PRD_PATH_ESCAPE",
      "execution-plan output parent is outside the admitted packet root",
    );
  }
  if (existsSync(output)) {
    throw new PrdProductCommandError(
      "CCC_PRD_EXECUTION_PLAN_OUTPUT_EXISTS",
      "execution-plan output already exists",
    );
  }
  const protectedPaths = authorProtectedPaths(
    input.rootDir,
    input.manifestPath,
    input.sidecarPath,
  );
  if (protectedPaths.has(output)) {
    throw new PrdProductCommandError(
      "CCC_PRD_EXECUTION_PLAN_TARGET_PROTECTED",
      "execution-plan output overlaps an admitted input",
    );
  }
  const temporaryRoot = mkdtempSync(join(root, ".fusion-prd-tmp-"));
  const temporaryPath = join(temporaryRoot, "execution-plan.json");
  try {
    writeFileSync(
      temporaryPath,
      canonicalCccPrdJson(plan) + "\n",
      { encoding: "utf8", flag: "wx" },
    );
    renameSync(temporaryPath, output);
    return output;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function runProductPolicyCommand(
  args: string[],
  io: PrdCommandIo,
): Promise<number> {
  const parsed = parseProductPolicyArgs(args);
  if (parsed.kind === "usage") {
    io.write(usage);
    return 2;
  }
  if (parsed.kind === "route-selection-invalid") {
    return writeProductRefusal(
      io,
      "CCC_PRD_POLICY_ROUTE_SELECTION_INVALID",
      PRODUCT_POLICY_ROUTE_SELECTION_MESSAGE,
    );
  }
  const input = parsed.value;
  try {
    const compiled = compileProductBundle({
      rootDir: input.rootDir,
      manifestPath: input.manifestPath,
      sidecarPath: input.sidecarPath,
      expectedTarget: input.expectedTarget,
      expectedBase: input.expectedBase,
    });
    if (compiled.kind === "refusal") {
      io.write(JSON.stringify(compiled));
      return 1;
    }
    const plan = input.routeSelection === "routes-file"
      ? createCccPrdProductExecutionPlan({
        bundle: compiled,
        routesByTaskId: readProductPolicyRoutesFile(input.rootDir, input.routesFilePath),
      })
      : createCccPrdProductExecutionPlan({
        bundle: compiled,
        route: {
          providerId: input.providerId,
          modelId: input.modelId,
          transport: input.transport,
          ...(input.cliAdapterId ? { cliAdapterId: input.cliAdapterId } : {}),
        },
      });
    const outputPath = writeExecutionPlanAtomically(input, plan);
    const bytes = readFileSync(outputPath);
    io.write(JSON.stringify({
      kind: "execution-plan",
      path: outputPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      packetHash: plan.packetHash,
      sidecarHash: plan.sidecarHash,
      bundleHash: plan.bundleHash,
      routeCount: plan.policy.routes.length,
    }));
    return 0;
  } catch (error) {
    const detail = error as { code?: unknown; message?: unknown };
    return writeProductRefusal(
      io,
      typeof detail.code === "string" ? detail.code : "CCC_PRD_EXECUTION_PLAN_FAILED",
      typeof detail.message === "string" ? detail.message : "CCC PRD execution plan failed",
    );
  }
}

async function runGeneratedAuthor(
  input: GeneratedAuthorArgs,
  io: PrdCommandIo,
  bootstrapProofAdmission: () => Promise<WorkflowExtensionRegistry>,
): Promise<number> {
  let outputPath: string;
  let previousSidecar: CccPrdSidecar | undefined;
  try {
    outputPath = resolveAuthorOutput(
      input.rootDir,
      input.manifestPath,
      input.manifestPath,
      input.outputPath,
    );
    if (existsSync(outputPath)) {
      previousSidecar = JSON.parse(readFileSync(outputPath, "utf8")) as CccPrdSidecar;
    }
  } catch (error) {
    io.write(JSON.stringify({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_AUTHORING_ADMISSION_FAILED",
        message: error instanceof Error ? error.message : "authoring request could not be admitted",
      }],
    }));
    return 1;
  }

  let adapter: ReturnType<Compiler["createNativeCccPrdAuthoringAdapter"]>;
  try {
    adapter = compiler.createNativeCccPrdAuthoringAdapter({
      provider: input.provider,
      model: input.model,
      maxDurationMs: input.maxDurationMs,
      maxPromptBytes: input.maxPromptBytes,
      maxResponseBytes: input.maxResponseBytes,
    });
  } catch (error) {
    io.write(JSON.stringify({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_AUTHORING_ADMISSION_FAILED",
        message: error instanceof Error ? error.message : "native authoring adapter could not be created",
      }],
    }));
    return 1;
  }

  let workflowExtensionRegistry: WorkflowExtensionRegistry;
  try {
    workflowExtensionRegistry = await bootstrapProofAdmission();
  } catch (error) {
    io.write(JSON.stringify({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_PROOF_ADMISSION_BOOTSTRAP_FAILED",
        message: error instanceof Error
          ? error.message
          : "fixed proof-admission host could not be bootstrapped",
      }],
    }));
    return 1;
  }

  const result = await compiler.authorCccPrdPacket({
    rootDir: input.rootDir,
    manifestPath: input.manifestPath,
    adapter,
    constraints: input.constraints,
    ...(previousSidecar ? { previousSidecar } : {}),
    workflowExtensionRegistry,
  });
  if (result.kind === "refusal") {
    io.write(JSON.stringify(result));
    return 1;
  }
  try {
    writeSidecarAtomically(
      input.rootDir,
      input.manifestPath,
      input.manifestPath,
      outputPath,
      result.sidecar,
    );
  } catch (error) {
    io.write(JSON.stringify({
      kind: "refusal",
      diagnostics: [{
        code: "CCC_PRD_SIDECAR_WRITE_FAILED",
        message: error instanceof Error ? error.message : "sidecar could not be written",
      }],
    }));
    return 1;
  }
  io.write(JSON.stringify({
    kind: "candidate",
    sidecarPath: outputPath,
    review: result.review,
  }));
  return 0;
}

async function runGeneratedUnderstanding(
  input: GeneratedUnderstandingArgs,
  io: PrdCommandIo,
  dependencies: PrdCommandDependencies,
): Promise<number> {
  let outputPath: string;
  try {
    outputPath = resolveAuthorOutput(
      input.rootDir,
      input.manifestPath,
      input.manifestPath,
      input.outputPath,
    );
    if (existsSync(outputPath)) {
      throw new PrdProductCommandError(
        "CCC_PRD_UNDERSTANDING_OUTPUT_EXISTS",
        "understanding review output already exists",
      );
    }
  } catch (error) {
    return writeProductRefusal(
      io,
      "CCC_PRD_UNDERSTANDING_ADMISSION_FAILED",
      error instanceof Error
        ? error.message
        : "understanding review request could not be admitted",
    );
  }

  let adapter: CccPrdAuthoringAdapter;
  try {
    adapter = (
      dependencies.createNativeCccPrdAuthoringAdapter
      ?? compiler.createNativeCccPrdAuthoringAdapter
    )({
      provider: input.provider,
      model: input.model,
      maxDurationMs: input.maxDurationMs,
      maxPromptBytes: input.maxPromptBytes,
      maxResponseBytes: input.maxResponseBytes,
      mode: "understanding",
    });
  } catch (error) {
    return writeProductRefusal(
      io,
      "CCC_PRD_UNDERSTANDING_ADMISSION_FAILED",
      error instanceof Error
        ? error.message
        : "native understanding adapter could not be created",
    );
  }

  let workflowExtensionRegistry: WorkflowExtensionRegistry;
  try {
    workflowExtensionRegistry = await (
      dependencies.bootstrapProofAdmission ?? bootstrapCccCampaignProofAdmissionHost
    )();
  } catch (error) {
    return writeProductRefusal(
      io,
      "CCC_PRD_PROOF_ADMISSION_BOOTSTRAP_FAILED",
      error instanceof Error
        ? error.message
        : "fixed proof-admission host could not be bootstrapped",
    );
  }

  const result = await (
    dependencies.understandCccPrdPacket ?? compiler.understandCccPrdPacket
  )({
    rootDir: input.rootDir,
    manifestPath: input.manifestPath,
    adapter,
    maxReviewItems: input.maxReviewItems,
    workflowExtensionRegistry,
  });
  if (result.kind === "refusal") {
    io.write(JSON.stringify(result));
    return 1;
  }
  try {
    writeSidecarAtomically(
      input.rootDir,
      input.manifestPath,
      input.manifestPath,
      outputPath,
      result,
    );
  } catch (error) {
    return writeProductRefusal(
      io,
      "CCC_PRD_UNDERSTANDING_WRITE_FAILED",
      error instanceof Error ? error.message : "understanding review could not be written",
    );
  }
  io.write(JSON.stringify({ ...result, reviewPath: outputPath }));
  return 0;
}

const CCC_PRD_PRODUCT_PREVIEW_SCHEMA = "ccc-prd.product-preview.v1" as const;

class PrdProductCommandError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PrdProductCommandError";
  }
}

function writeProductRefusal(
  io: PrdCommandIo,
  code: string,
  message: string,
  json = true,
): number {
  writeRefusalPayload(io, json, {
    kind: "refusal",
    diagnostics: [{ code, message }],
    safeState:
      "Fusion did not report this operation complete. Durable state may include previously completed transactional steps; inspect current status before retrying.",
    decisionOwner: "human operator",
    consequence:
      "The requested transition is not complete and Fusion will not assume the refused or uncertain effect succeeded.",
    approvalExpiresAt: null,
    recoveryOptions: [
      "Run fn prd status <idempotency-key> to inspect durable work, receipts, approvals, and the next safe action.",
      "Correct the cited input or custody problem and request a fresh confirmation.",
      "Use fn prd stop with a fresh status digest to abandon an unleased campaign while preserving evidence.",
    ],
    nextSafeAction:
      "Run fn prd status <idempotency-key> and follow its fresh operator controls; do not blindly retry an uncertain effect.",
  });
  return 1;
}

function writeRefusalPayload(
  io: PrdCommandIo,
  json: boolean,
  payload: unknown,
): void {
  if (json) {
    io.write(JSON.stringify(payload));
    return;
  }
  for (const line of renderOperatorPayload(payload)) io.write(line);
}

function writeVerifierConfinementImportRefusal(
  io: PrdCommandIo,
  readiness: VerifierConfinementReadiness,
  json: boolean,
): number {
  const backend = verifierConfinementBackendLabel(readiness);
  writeRefusalPayload(io, json, {
    kind: "refusal",
    diagnostics: [{
      code: "CCC_CAMPAIGN_VERIFIER_CONFINEMENT_UNAVAILABLE",
      message: `Exact requirement verification is unavailable: ${readiness.message}`,
    }],
    verifierConfinement: sanitizedVerifierConfinementReadiness(readiness),
    safeState:
      "This import created no campaign rows, staging files, approvals, provider effects, or source changes.",
    decisionOwner: "Fusion host or CI runner operator",
    consequence:
      "The PRD packet remains reviewable, but Fusion cannot safely import or execute it on this host.",
    approvalExpiresAt: null,
    recoveryOptions: [
      `Provision and functionally verify ${backend} at one trusted system path.`,
      "Keep the frozen packet unchanged and rerun preview after the host is repaired.",
    ],
    nextSafeAction:
      "Repair verifier confinement, rerun fn prd preview, then issue a fresh import confirmation.",
  });
  return 1;
}

function writeVerifierConfinementExecutionRefusal(
  io: PrdCommandIo,
  readiness: VerifierConfinementReadiness,
  approval: Pick<CccPrdProductApprovalStatus, "id" | "status" | "campaign">,
  workItem: Readonly<{ id: string; state: string }>,
  idempotencyKey: string,
  json: boolean,
): number {
  const backend = verifierConfinementBackendLabel(readiness);
  writeRefusalPayload(io, json, {
    kind: "refusal",
    diagnostics: [{
      code: "CCC_CAMPAIGN_VERIFIER_CONFINEMENT_UNAVAILABLE",
      message: `Exact requirement verification is unavailable: ${readiness.message}`,
    }],
    verifierConfinement: sanitizedVerifierConfinementReadiness(readiness),
    safeState:
      `Approval ${approval.id} remains ${approval.status} and workflow ${workItem.id} remains ${workItem.state}; this command started no provider, source, or proof effect.`,
    decisionOwner: "Fusion host or CI runner operator",
    consequence:
      "Live coding cannot start because Fusion could not prove exact requirement tests can run under enforced confinement.",
    approvalExpiresAt: approval.campaign.expiresAt,
    recoveryOptions: [
      `Repair and functionally verify ${backend} before this approval expires.`,
      "If the approval expires, request a fresh exact live-execution approval after the host is ready.",
      "Stop the campaign with a fresh status digest if the operator does not want to continue.",
    ],
    nextSafeAction:
      `Repair verifier confinement, rerun fn prd status ${idempotencyKey}, then submit a still-current exact approval.`,
  });
  return 1;
}

function runIntakeContractCommand(
  args: string[],
  io: PrdCommandIo,
): number {
  const [subcommand, inputPath] = args;
  if (subcommand === "template" && args.length === 1) {
    io.write(JSON.stringify({
      kind: "prd-intake-template",
      schema: compiler.CCC_PRD_INTAKE_CONTRACT_SCHEMA_VERSION,
      markdown: compiler.renderCccPrdIntakeTemplate(),
    }));
    return 0;
  }
  if (subcommand !== "lint" || args.length !== 2 || !inputPath) {
    io.write(usage);
    return 2;
  }

  try {
    const lexicalPath = resolve(inputPath);
    if (isProtected(lexicalPath) || !/\.md$/iu.test(lexicalPath)) {
      throw new Error("the intake lint input must be one unprotected Markdown file");
    }
    const sourcePath = resolveAuthorInput(dirname(lexicalPath), lexicalPath);
    const lint = compiler.lintCccPrdIntakeMarkdown({
      sourcePath,
      markdown: readFileSync(sourcePath, "utf8"),
    });
    io.write(JSON.stringify(lint));
    return lint.readyForIntake ? 0 : 1;
  } catch (error) {
    return writeProductRefusal(
      io,
      "CCC_PRD_INTAKE_LINT_READ_FAILED",
      error instanceof Error ? error.message : "the PRD could not be linted",
    );
  }
}

function parseGuidedFreezeContext(
  options: string[],
): engine.CccPrdOperatorContext | undefined {
  if (options.length === 0 || options.length % 2 !== 0) return undefined;
  const ownedPaths: string[] = [];
  const allowedWriteRoots: string[] = [];
  const values = new Map<string, string>();
  const accepted = new Set([
    "--target",
    "--base",
    "--owned-path",
    "--write-root",
    "--write-purpose",
    "--max-requests",
    "--max-duration-ms",
    "--max-concurrency",
  ]);
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index];
    const value = options[index + 1];
    if (!flag || !value || !accepted.has(flag) || value.startsWith("--")) {
      return undefined;
    }
    if (flag === "--owned-path") {
      ownedPaths.push(value);
      continue;
    }
    if (flag === "--write-root") {
      allowedWriteRoots.push(value);
      continue;
    }
    if (values.has(flag)) return undefined;
    values.set(flag, value);
  }
  const maxRequests = parsePositiveInteger(values.get("--max-requests"));
  const maxDurationMs = parsePositiveInteger(values.get("--max-duration-ms"));
  const maxConcurrency = parsePositiveInteger(values.get("--max-concurrency"));
  const target = values.get("--target");
  const baseCommit = values.get("--base");
  const writeRootPurpose = values.get("--write-purpose");
  if (
    !target
    || !baseCommit
    || !writeRootPurpose
    || ownedPaths.length === 0
    || allowedWriteRoots.length === 0
    || !maxRequests
    || !maxDurationMs
    || !maxConcurrency
    || values.size !== 6
  ) {
    return undefined;
  }
  return engine.parseCccPrdOperatorContext({
    schema: engine.CCC_PRD_OPERATOR_CONTEXT_SCHEMA_VERSION,
    targetRepository: { path: target, baseCommit },
    taskCustody: { ownedPaths, allowedWriteRoots },
    writeRootPurpose,
    bounds: { maxRequests, maxDurationMs, maxConcurrency },
  });
}

async function runIntakePacketCommand(
  args: string[],
  io: PrdCommandIo,
  dependencies: PrdCommandDependencies,
): Promise<number> {
  const [subcommand, activeProjectsRoot, selectedPrdPath, outputDir, ...options] = args;
  try {
    if (subcommand === "corpus" && args.length === 2 && activeProjectsRoot) {
      io.write(JSON.stringify(
        (dependencies.buildCccPrdCorpusManifest ?? engine.buildCccPrdCorpusManifest)({
          activeProjectsRoot,
        }),
      ));
      return 0;
    }
    if (subcommand === "discover" && args.length === 2 && activeProjectsRoot) {
      io.write(JSON.stringify(
        (dependencies.discoverCccPrdCandidates ?? engine.discoverCccPrdCandidates)({
          activeProjectsRoot,
        }),
      ));
      return 0;
    }
    if (
      subcommand === "freeze"
      && activeProjectsRoot
      && selectedPrdPath
      && outputDir
    ) {
      let operatorContext: engine.CccPrdOperatorContext | undefined;
      if (options.length === 1 && options[0] === "--context-stdin") {
        if (!io.readStdin) {
          throw new PrdProductCommandError(
            "CCC_PRD_OPERATOR_CONTEXT_STDIN_UNAVAILABLE",
            "typed operator context stdin is unavailable",
          );
        }
        const contextJson = await io.readStdin();
        if (Buffer.byteLength(contextJson, "utf8") > MAX_OPERATOR_CONTEXT_BYTES) {
          throw new PrdProductCommandError(
            "CCC_PRD_OPERATOR_CONTEXT_INVALID",
            "typed operator context exceeds " + MAX_OPERATOR_CONTEXT_BYTES + " bytes",
          );
        }
        let value: unknown;
        try {
          value = JSON.parse(contextJson) as unknown;
        } catch {
          throw new PrdProductCommandError(
            "CCC_PRD_OPERATOR_CONTEXT_INVALID",
            "typed operator context stdin must contain one JSON object",
          );
        }
        operatorContext = engine.parseCccPrdOperatorContext(value);
      } else if (options.length > 0) {
        operatorContext = parseGuidedFreezeContext(options);
        if (!operatorContext) {
          io.write(usage);
          return 2;
        }
      }
      io.write(JSON.stringify(
        (dependencies.freezeCccPrdPacket ?? engine.freezeCccPrdPacket)({
          activeProjectsRoot,
          selectedPrdPath,
          outputDir,
          ...(operatorContext ? { operatorContext } : {}),
        }),
      ));
      return 0;
    }
    io.write(usage);
    return 2;
  } catch (error) {
    const code = (
      error
      && typeof error === "object"
      && "code" in error
      && typeof error.code === "string"
    )
      ? error.code
      : "CCC_PRD_INTAKE_FAILED";
    return writeProductRefusal(
      io,
      code,
      error instanceof Error ? error.message : "CCC PRD intake failed",
    );
  }
}

async function readTargetHead(targetRoot: string): Promise<string> {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    delete env[key];
  }
  return execFileSync(
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    {
      cwd: targetRoot,
      encoding: "utf8",
      env,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function readProductExecutionPolicy(
  rootDir: string,
  executionPlanPath: string,
  bundle: CccPrdSemanticBundle,
): CccCampaignProductExecutionPolicy {
  let value: unknown;
  try {
    value = JSON.parse(
      readFileSync(resolveAuthorInput(rootDir, executionPlanPath), "utf8"),
    ) as unknown;
  } catch (error) {
    throw new PrdProductCommandError(
      "CCC_PRD_EXECUTION_POLICY_READ_FAILED",
      error instanceof Error
        ? "execution plan could not be read: " + error.message
        : "execution plan could not be read: " + executionPlanPath,
    );
  }
  return parseCccPrdProductExecutionPlan(value, bundle).policy;
}

function assertProductBundleComplete(bundle: CccPrdSemanticBundle): void {
  for (const [label, values] of [
    ["requirements", bundle.requirements],
    ["proofs", bundle.proofs],
    ["tasks", bundle.tasks],
    ["workflows", bundle.workflows],
  ] as const) {
    if (values.length === 0) {
      throw new PrdProductCommandError(
        "CCC_PRD_PRODUCT_BUNDLE_SHALLOW",
        `CCC PRD product import refuses zero ${label}`,
      );
    }
  }
  const taskRequirementIds = new Set(
    bundle.tasks.flatMap(({ requirementIds }) => requirementIds),
  );
  const declaredProofIds = new Set(bundle.proofs.map(({ id }) => id));
  for (const requirement of bundle.requirements) {
    if (!taskRequirementIds.has(requirement.id)) {
      throw new PrdProductCommandError(
        "CCC_PRD_REQUIREMENT_TASK_COVERAGE_MISSING",
        `CCC PRD requirement ${requirement.id} has no task disposition`,
      );
    }
    if (
      requirement.proofIds.length === 0
      || requirement.proofIds.some((proofId) => !declaredProofIds.has(proofId))
    ) {
      throw new PrdProductCommandError(
        "CCC_PRD_REQUIREMENT_PROOF_COVERAGE_MISSING",
        `CCC PRD requirement ${requirement.id} has no complete proof disposition`,
      );
    }
  }
}

function productPreviewIdentity(input: {
  projectId: string;
  projectPath: string;
  targetHead: string;
  bundle: CccPrdSemanticBundle;
  executionPolicy: CccCampaignProductExecutionPolicy;
}) {
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

function productConfirmationDigest(
  identity: ReturnType<typeof productPreviewIdentity>,
): string {
  return createHash("sha256")
    .update(canonicalCccPrdJson(identity), "utf8")
    .digest("hex");
}

function operatorVerifierConfinementReadiness(
  readiness: VerifierConfinementReadiness,
) {
  const operatorReadiness = sanitizedVerifierConfinementReadiness(readiness);
  if (engine.isVerifierConfinementReady(readiness)) return operatorReadiness;
  return {
    ...operatorReadiness,
    safeState:
      "The frozen PRD preview is intact; no campaign, approval, provider effect, or source change was created.",
    decisionOwner: "Fusion host or CI runner operator",
    consequence:
      "Campaign import and live execution remain blocked because exact requirement proof cannot run safely.",
    recoveryOptions: [
      "Provision and functionally verify the trusted verifier confinement backend on this host.",
      "Keep the packet as a review-only preview until confinement is ready.",
    ],
    nextSafeAction:
      "Repair the trusted verifier confinement backend, then rerun fn prd preview before import.",
  };
}

function sanitizedVerifierConfinementReadiness(
  readiness: VerifierConfinementReadiness,
) {
  const { detail: _detail, ...operatorReadiness } = readiness;
  return {
    ...operatorReadiness,
    ready: engine.isVerifierConfinementReady(readiness),
    backend: engine.isAdmittedVerifierConfinementBackend(readiness.backend)
      ? readiness.backend
      : null,
  };
}

function verifierConfinementBackendLabel(
  readiness: VerifierConfinementReadiness,
): string {
  return engine.isAdmittedVerifierConfinementBackend(readiness.backend)
    ? readiness.backend
    : "the trusted verifier confinement backend";
}

function productPreview(
  identity: ReturnType<typeof productPreviewIdentity>,
  bundle: CccPrdSemanticBundle,
  verifierConfinement: VerifierConfinementReadiness,
) {
  return {
    kind: "preview" as const,
    ...identity,
    confirmationDigest: productConfirmationDigest(identity),
    orderedSources: bundle.orderedSources,
    requirements: bundle.requirements,
    tasks: bundle.tasks,
    proofs: bundle.proofs,
    workflows: bundle.workflows,
    protectedActions: bundle.protectedActions,
    admittedWriteRoots: bundle.admittedWriteRoots,
    bounds: bundle.bounds,
    nonGoals: bundle.nonGoals,
    materialCoverage: bundle.materialCoverage,
    verifierConfinement: operatorVerifierConfinementReadiness(
      verifierConfinement,
    ),
  };
}

async function withPrdProject(
  io: PrdCommandIo,
  dependencies: PrdCommandDependencies,
  context: PrdCommandContext,
  operation: (project: ProjectContext) => Promise<number>,
): Promise<number> {
  const resolveProjectDependency = dependencies.resolveProject ?? resolveProject;
  const closeProjectStoreDependency = dependencies.closeProjectStore ?? closeProjectStore;
  let project: ProjectContext | undefined;
  let closeAttempted = false;
  try {
    project = await resolveProjectDependency(context.projectName);
    const result = await operation(project);
    closeAttempted = true;
    await closeProjectStoreDependency(project);
    return result;
  } catch (error) {
    let failure: unknown = error;
    if (project && !closeAttempted) {
      try {
        closeAttempted = true;
        await closeProjectStoreDependency(project);
      } catch (closeError) {
        failure = new AggregateError(
          [error, closeError],
          "CCC PRD project operation and PostgreSQL cleanup both failed",
        );
      }
    }
    const detail = failure as { code?: unknown; message?: unknown };
    return writeProductRefusal(
      io,
      typeof detail.code === "string" ? detail.code : "CCC_PRD_PROJECT_OPERATION_FAILED",
      typeof detail.message === "string" ? detail.message : "CCC PRD project operation failed",
      operatorJson(context),
    );
  }
}

function compileProductBundle(input: {
  rootDir: string;
  manifestPath: string;
  sidecarPath: string;
  expectedTarget: string;
  expectedBase: string;
}): CccPrdSemanticBundle | { kind: "refusal"; diagnostics?: unknown[] } {
  const result = compiler.compileCccPrdPacket({
    ...input,
    requireMaterialCoverage: true,
  });
  if (result.kind === "refusal") return result;
  assertProductBundleComplete(result);
  const provenanceDiagnostics = compiler.validateCccPrdPacketImplementationFactProvenance({
    rootDir: input.rootDir,
    manifestPath: input.manifestPath,
    facts: result,
  });
  if (provenanceDiagnostics.length > 0) {
    return { kind: "refusal", diagnostics: provenanceDiagnostics };
  }
  return result;
}

async function runProductPacketCommand(
  args: string[],
  io: PrdCommandIo,
  dependencies: PrdCommandDependencies,
  commandContext: PrdCommandContext,
): Promise<number> {
  const [
    subcommand,
    rootDir,
    manifestPath,
    sidecarPath,
    executionPlanPath,
    expectedTarget,
    expectedBase,
    idempotencyKey,
    confirmFlag,
    confirmationDigest,
  ] = args;
  const preview = subcommand === "preview";
  const importing = subcommand === "import";
  if (
    !rootDir
    || !manifestPath
    || !sidecarPath
    || !executionPlanPath
    || !expectedTarget
    || !expectedBase
    || !/^[0-9a-f]{40}$/.test(expectedBase)
    || (preview && args.length !== 7)
    || (importing && (
      args.length !== 10
      || !idempotencyKey
      || confirmFlag !== "--confirm"
      || !confirmationDigest
      || !/^[0-9a-f]{64}$/.test(confirmationDigest)
    ))
    || (!preview && !importing)
  ) {
    io.write(usage);
    return 2;
  }

  let bundle: CccPrdSemanticBundle;
  let executionPolicy: CccCampaignProductExecutionPolicy;
  try {
    const compiled = compileProductBundle({
      rootDir,
      manifestPath,
      sidecarPath,
      expectedTarget,
      expectedBase,
    });
    if (compiled.kind === "refusal") {
      writeRefusalPayload(io, operatorJson(commandContext), compiled);
      return 1;
    }
    bundle = compiled;
    executionPolicy = readProductExecutionPolicy(rootDir, executionPlanPath, bundle);
  } catch (error) {
    const detail = error as { code?: unknown; message?: unknown };
    return writeProductRefusal(
      io,
      typeof detail.code === "string" ? detail.code : "CCC_PRD_PRODUCT_PREFLIGHT_FAILED",
      typeof detail.message === "string" ? detail.message : "CCC PRD product preflight failed",
      operatorJson(commandContext),
    );
  }

  const verifierConfinement = await (
    dependencies.inspectVerifierConfinementReadiness
    ?? compiler.inspectVerifierConfinementReadiness
  )();
  if (importing && !engine.isVerifierConfinementReady(verifierConfinement)) {
    return writeVerifierConfinementImportRefusal(
      io,
      verifierConfinement,
      operatorJson(commandContext),
    );
  }

  return withPrdProject(io, dependencies, commandContext, async (project) => {
    const layer = project.store.getAsyncLayer();
    if (!layer) {
      throw new PrdProductCommandError(
        "CCC_PRD_POSTGRES_UNAVAILABLE",
        `PostgreSQL AsyncDataLayer unavailable for ${project.projectPath}`,
      );
    }
    if (resolve(project.projectPath) !== resolve(bundle.targetRepository.path)) {
      throw new PrdProductCommandError(
        "CCC_PRD_PROJECT_TARGET_MISMATCH",
        `resolved project ${project.projectPath} does not match PRD target ${bundle.targetRepository.path}`,
      );
    }
    const targetHead = await (dependencies.readTargetHead ?? readTargetHead)(project.projectPath);
    if (targetHead !== bundle.targetRepository.baseCommit) {
      throw new PrdProductCommandError(
        "CCC_PRD_TARGET_HEAD_DRIFT",
        `target HEAD ${targetHead} does not match frozen base ${bundle.targetRepository.baseCommit}`,
      );
    }
    const identity = productPreviewIdentity({
      projectId: project.projectId,
      projectPath: project.projectPath,
      targetHead,
      bundle,
      executionPolicy,
    });
    const currentPreview = productPreview(identity, bundle, verifierConfinement);
    if (preview) {
      if (operatorJson(commandContext)) {
        io.write(JSON.stringify(currentPreview));
        return 0;
      }
      // The candidate key is not an input to productPreviewIdentity, so
      // printing one here cannot change the confirmation digest below it.
      const previewLines = renderPreview(currentPreview, {
        packetArgs: [
          rootDir,
          manifestPath,
          sidecarPath,
          executionPlanPath,
          expectedTarget,
          expectedBase,
        ],
        candidateIdempotencyKey: newIdempotencyKey(),
      });
      for (const line of previewLines) io.write(line);
      return 0;
    }
    if (confirmationDigest !== currentPreview.confirmationDigest) {
      return writeProductRefusal(
        io,
        "CCC_PRD_CONFIRMATION_MISMATCH",
        `confirmation digest does not match current preview ${currentPreview.confirmationDigest}`,
        operatorJson(commandContext),
      );
    }
    const result = await (dependencies.importCccPrdBundle ?? importCccPrdBundle)({
      bundle,
      executionPolicy,
      idempotencyKey: idempotencyKey!,
      store: project.store,
      layer,
      rootDir: project.projectPath,
    });
    writeOperatorValue(io, commandContext, {
      kind: "imported",
      confirmationDigest: currentPreview.confirmationDigest,
      result,
    });
    return 0;
  });
}

async function runProductStateCommand(
  args: string[],
  io: PrdCommandIo,
  dependencies: PrdCommandDependencies,
  commandContext: PrdCommandContext,
): Promise<number> {
  const [subcommand, idempotencyKey] = args;
  if (
    (subcommand !== "inspect" && subcommand !== "reconcile")
    || args.length !== 2
    || !idempotencyKey
  ) {
    io.write(usage);
    return 2;
  }
  return withPrdProject(io, dependencies, commandContext, async (project) => {
    const layer = project.store.getAsyncLayer();
    if (!layer) {
      throw new PrdProductCommandError(
        "CCC_PRD_POSTGRES_UNAVAILABLE",
        `PostgreSQL AsyncDataLayer unavailable for ${project.projectPath}`,
      );
    }
    if (subcommand === "inspect") {
      const inspection: CccPrdImportInspection | null = await (
        dependencies.inspectCccPrdImport ?? inspectCccPrdImport
      )({
        idempotencyKey,
        layer,
        rootDir: project.projectPath,
      });
      writeOperatorValue(
        io,
        commandContext,
        { kind: "inspection", found: inspection !== null, inspection },
      );
      return inspection ? 0 : 1;
    }
    const result: CccPrdImportResult = await (
      dependencies.reconcileCccPrdImport ?? reconcileCccPrdImport
    )({
      idempotencyKey,
      layer,
      store: project.store,
      rootDir: project.projectPath,
    });
    writeOperatorValue(io, commandContext, { kind: "reconciled", result });
    return 0;
  });
}

const CCC_PRODUCT_MERGE_HOLD =
  "ccc-permanent:CCC_CAMPAIGN_MERGE_APPROVAL_REQUIRED";
const CCC_PRODUCT_LIVE_EXECUTION_HOLD =
  "ccc-permanent:CCC_CAMPAIGN_LIVE_EXECUTION_APPROVAL_REQUIRED";
const OPERATOR_REDACTED_KEYS = new Set([
  "claimToken",
  "controllerToken",
]);

function writeOperatorJson(io: PrdCommandIo, value: unknown): void {
  io.write(JSON.stringify(value, (key, entry) =>
    OPERATOR_REDACTED_KEYS.has(key) ? undefined : entry));
}

function isMergeApproval(
  approval: CccPrdProductApprovalStatus,
): boolean {
  return approval.targetAction.resourceType === "ccc-campaign-merge"
    && approval.targetAction.context?.protectedActionKind === "merge";
}

function isLiveExecutionApproval(
  approval: CccPrdProductApprovalStatus,
): boolean {
  return approval.targetAction.resourceType === "ccc-campaign-live_execution"
    && approval.targetAction.context?.protectedActionKind === "live_execution";
}

function exactDigest(provided: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(provided) || !/^[0-9a-f]{64}$/.test(expected)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(provided, "hex"),
    Buffer.from(expected, "hex"),
  );
}

function exactImportedProductWorkItem(status: CccPrdProductStatus) {
  if (status.workItems.length !== 1) {
    throw new PrdProductCommandError(
      "CCC_PRD_MERGE_WORK_ITEM_AMBIGUOUS",
      `merge approval requires exactly one imported workflow work item; found ${status.workItems.length}`,
    );
  }
  const workItem = status.workItems[0]!;
  if (
    workItem.kind !== "task"
    || workItem.runId !== `ccc-prd:${status.import.importId}`
    || workItem.stableWorkflowRunId !== workItem.runId
    || workItem.leaseOwner !== null
    || workItem.leaseExpiresAt !== null
    || !Number.isSafeInteger(workItem.attempt)
    || workItem.attempt < 1
  ) {
    throw new PrdProductCommandError(
      "CCC_PRD_MERGE_WORK_ITEM_REFUSED",
      `workflow work item ${workItem.id} does not match exact imported campaign custody`,
    );
  }
  return workItem;
}

function exactMergeWorkItem(status: CccPrdProductStatus) {
  const workItem = exactImportedProductWorkItem(status);
  const exactHold = workItem.state === "manual-required"
    && workItem.lastError === CCC_PRODUCT_MERGE_HOLD
    && workItem.blockedReason === CCC_PRODUCT_MERGE_HOLD;
  if (!exactHold && workItem.state !== "succeeded") {
    throw new PrdProductCommandError(
      "CCC_PRD_MERGE_WORK_ITEM_REFUSED",
      `workflow work item ${workItem.id} is not parked for exact merge approval`,
    );
  }
  return workItem;
}

function exactLiveExecutionWorkItem(status: CccPrdProductStatus) {
  const workItem = exactImportedProductWorkItem(status);
  const exactHold = workItem.state === "manual-required"
    && workItem.lastError === CCC_PRODUCT_LIVE_EXECUTION_HOLD
    && workItem.blockedReason === CCC_PRODUCT_LIVE_EXECUTION_HOLD;
  if (
    !exactHold
    && workItem.state !== "runnable"
    && workItem.state !== "retrying"
    && workItem.state !== "running"
  ) {
    throw new PrdProductCommandError(
      "CCC_PRD_LIVE_EXECUTION_WORK_ITEM_REFUSED",
      `workflow work item ${workItem.id} is not parked for exact live-execution approval`,
    );
  }
  return workItem;
}

async function inspectProductStatus(
  dependencies: PrdCommandDependencies,
  project: ProjectContext,
  idempotencyKey: string,
): Promise<CccPrdProductStatus | null> {
  const layer = project.store.getAsyncLayer();
  if (!layer) {
    throw new PrdProductCommandError(
      "CCC_PRD_POSTGRES_UNAVAILABLE",
      `PostgreSQL AsyncDataLayer unavailable for ${project.projectPath}`,
    );
  }
  return (dependencies.inspectCccPrdProductStatus ?? inspectCccPrdProductStatus)({
    idempotencyKey,
    layer,
    rootDir: project.projectPath,
  });
}

async function runProductControlCommand(
  args: string[],
  io: PrdCommandIo,
  dependencies: PrdCommandDependencies,
  commandContext: PrdCommandContext,
): Promise<number> {
  const [
    subcommand,
    idempotencyKey,
    approvalRequestId,
    confirmFlag,
    confirmation,
  ] = args;
  const showingStatus = subcommand === "status";
  const approvingExecution = subcommand === "approve-execution";
  const approvingMerge = subcommand === "approve-merge";
  if (
    !idempotencyKey
    || (showingStatus && args.length !== 2)
    || ((approvingExecution || approvingMerge) && (
      args.length !== 5
      || !approvalRequestId
      || confirmFlag !== "--confirm"
      || !confirmation
      || !/^[0-9a-f]{64}$/.test(confirmation)
    ))
    || (!showingStatus && !approvingExecution && !approvingMerge)
  ) {
    io.write(usage);
    return 2;
  }

  return withPrdProject(io, dependencies, commandContext, async (project) => {
    const status = await inspectProductStatus(
      dependencies,
      project,
      idempotencyKey,
    );
    if (!status) {
      writeOperatorPayload(io, commandContext, {
        kind: "product-status",
        found: false,
        idempotencyKey,
      });
      return 1;
    }
    const computeConfirmation =
      dependencies.computeCccCampaignMergeApprovalConfirmation
      ?? engine.computeCccCampaignMergeApprovalConfirmation;
    const computeLiveExecutionConfirmation =
      dependencies.computeCccCampaignLiveExecutionApprovalConfirmation
      ?? engine.computeCccCampaignLiveExecutionApprovalConfirmation;
    if (showingStatus) {
      const mergeApprovalConfirmations = status.approvals
        .filter(isMergeApproval)
        .map((approval) => ({
          approvalRequestId: approval.id,
          confirmation: computeConfirmation(
            approval as ApprovalRequest,
          ),
          expiresAt: approval.campaign.expiresAt,
          status: approval.status,
        }));
      const liveExecutionApprovalConfirmations = status.approvals
        .filter(isLiveExecutionApproval)
        .map((approval) => ({
          approvalRequestId: approval.id,
          confirmation: computeLiveExecutionConfirmation(
            approval as ApprovalRequest,
          ),
          expiresAt: approval.campaign.expiresAt,
          status: approval.status,
          taskId: approval.taskId,
        }));
      writeOperatorPayload(io, commandContext, {
        kind: "product-status",
        found: true,
        status,
        operatorControls: (
          dependencies.describeCccCampaignOperatorControls
          ?? engine.describeCccCampaignOperatorControls
        )(status),
        mergeApprovalConfirmations,
        liveExecutionApprovalConfirmations,
      });
      return 0;
    }

    const approval = status.approvals.find(({ id }) =>
      id === approvalRequestId);
    if (!approval || (
      approvingExecution
        ? !isLiveExecutionApproval(approval)
        : !isMergeApproval(approval)
    )) {
      throw new PrdProductCommandError(
        approvingExecution
          ? "CCC_PRD_LIVE_EXECUTION_APPROVAL_MISSING"
          : "CCC_PRD_MERGE_APPROVAL_MISSING",
        `${approvingExecution ? "live-execution" : "merge"} approval ${approvalRequestId} is missing from exact product status`,
      );
    }
    const expectedConfirmation = (
      approvingExecution
        ? computeLiveExecutionConfirmation
        : computeConfirmation
    )(approval as ApprovalRequest);
    if (!exactDigest(confirmation!, expectedConfirmation)) {
      throw new PrdProductCommandError(
        approvingExecution
          ? "CCC_PRD_LIVE_EXECUTION_CONFIRMATION_REFUSED"
          : "CCC_PRD_MERGE_CONFIRMATION_REFUSED",
        `${approvingExecution ? "live-execution" : "merge"} approval confirmation is stale or does not match`,
      );
    }
    if (approvingExecution) {
      const workItem = exactLiveExecutionWorkItem(status);
      const verifierConfinement = await (
        dependencies.inspectVerifierConfinementReadiness
        ?? compiler.inspectVerifierConfinementReadiness
      )();
      if (!engine.isVerifierConfinementReady(verifierConfinement)) {
        return writeVerifierConfinementExecutionRefusal(
          io,
          verifierConfinement,
          approval,
          workItem,
          idempotencyKey,
          operatorJson(commandContext),
        );
      }
      const approved = await (
        dependencies.approveCccCampaignLiveExecution
        ?? engine.approveCccCampaignLiveExecution
      )({
        store: project.store,
        rootDir: project.projectPath,
        taskId: approval.taskId!,
        approvalRequestId: approval.id,
        confirmation: confirmation!,
        actor: {
          actorId: "ccc-fusion-local-operator",
          actorType: "user",
          actorName: "CCC Fusion Local Operator",
        },
      });
      if (workItem.state === "manual-required") {
        await project.store.transitionWorkflowWorkItem(
          workItem.id,
          "runnable",
          {
            expectedState: "manual-required",
            expectedAttempt: workItem.attempt,
            attempt: workItem.attempt,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: null,
            blockedReason: null,
          },
        );
      }
      const resumedStatus = await inspectProductStatus(
        dependencies,
        project,
        idempotencyKey,
      );
      if (!resumedStatus) {
        throw new PrdProductCommandError(
          "CCC_PRD_PRODUCT_STATUS_MISSING",
          "product status disappeared after live-execution approval",
        );
      }
      writeOperatorPayload(io, commandContext, {
        kind: "execution-approved",
        approvalRequestId: approval.id,
        approval: approved,
        status: resumedStatus,
      });
      return 0;
    }
    const workItem = exactMergeWorkItem(status);
    const result = await (
      dependencies.approveCccCampaignMerge
      ?? engine.approveCccCampaignMerge
    )({
      store: project.store,
      rootDir: project.projectPath,
      taskId: approval.taskId!,
      approvalRequestId: approval.id,
      confirmation: confirmation!,
      actor: {
        actorId: "ccc-fusion-local-operator",
        actorType: "user",
        actorName: "CCC Fusion Local Operator",
      },
    });
    if (workItem.state === "manual-required") {
      await project.store.transitionWorkflowWorkItem(
        workItem.id,
        "succeeded",
        {
          expectedState: "manual-required",
          expectedAttempt: workItem.attempt,
          attempt: workItem.attempt,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
          blockedReason: null,
        },
      );
    }
    const completedStatus = await inspectProductStatus(
      dependencies,
      project,
      idempotencyKey,
    );
    if (!completedStatus) {
      throw new PrdProductCommandError(
        "CCC_PRD_PRODUCT_STATUS_MISSING",
        "product status disappeared after controlled Git landing",
      );
    }
    writeOperatorPayload(io, commandContext, {
      kind: "merge-approved",
      approvalRequestId: approval.id,
      result,
      status: completedStatus,
    });
    return 0;
  });
}

async function runCampaignLifecycleCommand(
  args: string[],
  io: PrdCommandIo,
  dependencies: PrdCommandDependencies,
  commandContext: PrdCommandContext,
): Promise<number> {
  const [subcommand, idempotencyKey] = args;
  const action = subcommand === "abandon" ? "stop" : subcommand;
  const simpleControl = action === "pause" || action === "resume";
  const stopping = action === "stop";
  const reason = stopping && args[2] === "--reason" ? args[3] : undefined;
  const confirmIndex = stopping ? 4 : 2;
  const confirmation = args[confirmIndex + 1];
  if (
    !idempotencyKey
    || (!simpleControl && !stopping)
    || args[confirmIndex] !== "--confirm"
    || !confirmation
    || !/^[0-9a-f]{64}$/.test(confirmation)
    || (simpleControl && args.length !== 4)
    || (stopping && (
      args.length !== 6
      || args[2] !== "--reason"
      || typeof reason !== "string"
      || reason.trim() !== reason
      || reason.length < 10
    ))
  ) {
    io.write(usage);
    return 2;
  }
  return withPrdProject(io, dependencies, commandContext, async (project) => {
    const status = await inspectProductStatus(
      dependencies,
      project,
      idempotencyKey,
    );
    if (!status) {
      writeOperatorPayload(io, commandContext, {
        kind: "product-status",
        found: false,
        idempotencyKey,
      });
      return 1;
    }
    const exactAction = action as engine.CccCampaignOperatorControlAction;
    const computeConfirmation =
      dependencies.computeCccCampaignOperatorControlConfirmation
      ?? engine.computeCccCampaignOperatorControlConfirmation;
    const expectedConfirmation = computeConfirmation(status, exactAction);
    if (!exactDigest(confirmation, expectedConfirmation)) {
      return writeProductRefusal(
        io,
        "CCC_CAMPAIGN_OPERATOR_CONTROL_CONFIRMATION_REFUSED",
        `operator ${exactAction} confirmation is stale or does not match current campaign status`,
        operatorJson(commandContext),
      );
    }
    const result = await (
      dependencies.applyCccCampaignOperatorControl
      ?? engine.applyCccCampaignOperatorControl
    )({
      action: exactAction,
      ...(stopping ? { reason } : {}),
      status,
      store: project.store,
    });
    const completedStatus = await inspectProductStatus(
      dependencies,
      project,
      idempotencyKey,
    );
    if (!completedStatus) {
      throw new PrdProductCommandError(
        "CCC_PRD_PRODUCT_STATUS_MISSING",
        "product status disappeared after operator campaign control",
      );
    }
    const describeControls =
      dependencies.describeCccCampaignOperatorControls
      ?? engine.describeCccCampaignOperatorControls;
    writeOperatorPayload(io, commandContext, {
      kind: exactAction === "pause"
        ? "campaign-paused"
        : exactAction === "resume"
          ? "campaign-resumed"
          : "campaign-stopped",
      result,
      status: completedStatus,
      operatorControls: describeControls(completedStatus),
    });
    return 0;
  });
}

type ProofResolutionEvidence = Readonly<{
  schema: "ccc-campaign.proof-resolution.v1";
  observerId: string;
  summary: string;
  result: Readonly<{
    success: boolean;
    exitCode: number | null;
    durationMs: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    killed: boolean;
    warnings: readonly string[];
    changedPathsSha256?: string;
    negativeControlLabel?: string;
  }>;
}>;

function exactObjectKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function readProofResolutionEvidence(
  evidencePath: string,
): ProofResolutionEvidence {
  if (isProtected(evidencePath)) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROOF_RESOLUTION_EVIDENCE_PROTECTED",
      "proof-resolution evidence cannot be read from a protected path",
    );
  }
  const lexicalPath = resolve(evidencePath);
  let physicalPath: string;
  try {
    if (!lstatSync(lexicalPath).isFile()) throw new Error("not a regular file");
    physicalPath = realpathSync(lexicalPath);
  } catch (error) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROOF_RESOLUTION_EVIDENCE_READ_FAILED",
      `proof-resolution evidence is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (isProtected(physicalPath)) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROOF_RESOLUTION_EVIDENCE_SYMLINK_REFUSED",
      "proof-resolution evidence must resolve outside protected paths",
    );
  }
  const raw = readFileSync(physicalPath, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 1_000_000) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROOF_RESOLUTION_EVIDENCE_TOO_LARGE",
      "proof-resolution evidence exceeds the 1 MB operator limit",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PrdProductCommandError(
      "CCC_PRD_PROOF_RESOLUTION_EVIDENCE_INVALID",
      "proof-resolution evidence must be valid JSON",
    );
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || !exactObjectKeys(
      parsed as Record<string, unknown>,
      ["schema", "observerId", "summary", "result"],
    )
  ) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROOF_RESOLUTION_EVIDENCE_INVALID",
      "proof-resolution evidence has unexpected or missing top-level fields",
    );
  }
  const candidate = parsed as Record<string, unknown>;
  const result = candidate.result;
  if (
    candidate.schema !== "ccc-campaign.proof-resolution.v1"
    || typeof candidate.observerId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(candidate.observerId)
    || typeof candidate.summary !== "string"
    || candidate.summary !== candidate.summary.trim()
    || candidate.summary.length < 10
    || candidate.summary.length > 1_000
    || !result
    || typeof result !== "object"
    || Array.isArray(result)
    || !exactObjectKeys(
      result as Record<string, unknown>,
      [
        "success",
        "exitCode",
        "durationMs",
        "stdout",
        "stderr",
        "timedOut",
        "killed",
        "warnings",
      ],
      ["changedPathsSha256", "negativeControlLabel"],
    )
  ) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROOF_RESOLUTION_EVIDENCE_INVALID",
      "proof-resolution evidence identity or result shape is invalid",
    );
  }
  const proofResult = result as Record<string, unknown>;
  const warnings = proofResult.warnings;
  const validExitCode = proofResult.exitCode === null
    || (
      Number.isSafeInteger(proofResult.exitCode)
      && (proofResult.exitCode as number) >= -2_147_483_648
      && (proofResult.exitCode as number) <= 2_147_483_647
    );
  if (
    typeof proofResult.success !== "boolean"
    || !validExitCode
    || !Number.isSafeInteger(proofResult.durationMs)
    || (proofResult.durationMs as number) < 0
    || typeof proofResult.stdout !== "string"
    || typeof proofResult.stderr !== "string"
    || Buffer.byteLength(proofResult.stdout, "utf8") > 400_000
    || Buffer.byteLength(proofResult.stderr, "utf8") > 400_000
    || typeof proofResult.timedOut !== "boolean"
    || typeof proofResult.killed !== "boolean"
    || !Array.isArray(warnings)
    || warnings.length > 63
    || !warnings.every((warning) =>
      typeof warning === "string"
      && warning.length > 0
      && warning.length <= 2_000)
    || (
      proofResult.changedPathsSha256 !== undefined
      && (
        typeof proofResult.changedPathsSha256 !== "string"
        || !/^[0-9a-f]{64}$/u.test(proofResult.changedPathsSha256)
      )
    )
    || (
      proofResult.negativeControlLabel !== undefined
      && (
        typeof proofResult.negativeControlLabel !== "string"
        || proofResult.negativeControlLabel.length === 0
        || proofResult.negativeControlLabel.length > 512
      )
    )
    || (
      proofResult.success === true
      && (
        proofResult.exitCode !== 0
        || proofResult.timedOut !== false
        || proofResult.killed !== false
      )
    )
  ) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROOF_RESOLUTION_EVIDENCE_INVALID",
      "proof-resolution result fields are invalid or internally inconsistent",
    );
  }
  const evidence = candidate as unknown as ProofResolutionEvidence;
  return Object.freeze({
    ...evidence,
    result: Object.freeze({
      ...evidence.result,
      warnings: Object.freeze([
        ...evidence.result.warnings,
        `operator-reconciliation:${evidence.observerId}: ${evidence.summary}`,
      ]),
    }),
  });
}

function exactProofResolutionContext(
  status: CccPrdProductStatus,
  attemptKey: string,
) {
  const matches = status.proofs
    .flatMap(({ attempts }) => attempts)
    .filter((attempt) => attempt.attemptKey === attemptKey);
  if (matches.length !== 1) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROOF_RESOLUTION_ATTEMPT_MISSING",
      `proof attempt ${attemptKey} is not one exact declared campaign attempt`,
    );
  }
  const attempt = matches[0]!;
  if (
    attempt.importId !== status.import.importId
    || attempt.packetHash !== status.import.packetHash
    || attempt.sidecarHash !== status.import.sidecarHash
    || attempt.bundleHash !== status.import.bundleHash
    || attempt.targetRepository !== status.import.targetRepository
    || attempt.targetBase !== status.import.targetBase
  ) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROOF_RESOLUTION_IMPORT_BINDING_REFUSED",
      `proof attempt ${attemptKey} does not match the frozen import custody`,
    );
  }
  if (
    attempt.state !== "dispatched_unknown"
    && attempt.state !== "committed"
    && attempt.state !== "proved_failed"
  ) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROOF_RESOLUTION_STATE_REFUSED",
      `proof attempt ${attemptKey} cannot be manually resolved from ${attempt.state}`,
    );
  }
  const workItems = status.workItems.filter(({ id }) =>
    id === attempt.workItemId);
  if (workItems.length !== 1) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROOF_RESOLUTION_WORK_ITEM_MISSING",
      `proof attempt ${attemptKey} has no exact imported workflow work item`,
    );
  }
  const workItem = workItems[0]!;
  if (
    workItem.state !== "manual-required"
    || workItem.runId !== attempt.runId
    || workItem.attempt !== attempt.workItemAttempt
    || workItem.leaseOwner !== null
    || workItem.leaseExpiresAt !== null
  ) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROOF_RESOLUTION_WORK_ITEM_REFUSED",
      `proof attempt ${attemptKey} is not parked at one unleased manual-resolution boundary`,
    );
  }
  return { attempt, workItem };
}

function proofResolutionConfirmation(
  status: CccPrdProductStatus,
  attemptKey: string,
  evidence: ProofResolutionEvidence,
): string {
  const { attempt, workItem } = exactProofResolutionContext(status, attemptKey);
  return createHash("sha256")
    .update(canonicalCccPrdJson({
      schema: "ccc-campaign.proof-resolution-confirmation.v1",
      projectId: status.projectId,
      import: {
        importId: status.import.importId,
        idempotencyKey: status.import.idempotencyKey,
        packetHash: status.import.packetHash,
        sidecarHash: status.import.sidecarHash,
        bundleHash: status.import.bundleHash,
        targetRepository: status.import.targetRepository,
        targetBase: status.import.targetBase,
      },
      attempt: {
        attemptKey: attempt.attemptKey,
        taskId: attempt.taskId,
        semanticTaskId: attempt.semanticTaskId,
        proofId: attempt.proofId,
        sourceCommit: attempt.sourceCommit,
        sourceTree: attempt.sourceTree,
        definitionSha256: attempt.definitionSha256,
        commandSha256: attempt.commandSha256,
        state: attempt.state,
      },
      workItem: {
        id: workItem.id,
        runId: workItem.runId,
        state: workItem.state,
        attempt: workItem.attempt,
        leaseOwner: workItem.leaseOwner,
        leaseExpiresAt: workItem.leaseExpiresAt,
      },
      evidence,
    }), "utf8")
    .digest("hex");
}

function sameProofAttemptIdentity(
  statusAttempt: ReturnType<typeof exactProofResolutionContext>["attempt"],
  persisted: Awaited<ReturnType<typeof inspectCccCampaignProofAttempt>>,
): boolean {
  if (!persisted) return false;
  return canonicalCccPrdJson({
    attemptKey: persisted.attemptKey,
    importId: persisted.importId,
    campaignId: persisted.campaignId,
    taskId: persisted.taskId,
    semanticTaskId: persisted.semanticTaskId,
    proofId: persisted.proofId,
    packetHash: persisted.packetHash,
    sidecarHash: persisted.sidecarHash,
    bundleHash: persisted.bundleHash,
    manifestHash: persisted.manifestHash,
    campaignBindingHash: persisted.campaignBindingHash,
    targetRepository: persisted.targetRepository,
    targetBase: persisted.targetBase,
    sourceCommit: persisted.sourceCommit,
    sourceTree: persisted.sourceTree,
    definitionSha256: persisted.definitionSha256,
    commandSha256: persisted.commandSha256,
    workItemId: persisted.workItemId,
    runId: persisted.runId,
    workItemAttempt: persisted.workItemAttempt,
    state: persisted.state,
  }) === canonicalCccPrdJson({
    attemptKey: statusAttempt.attemptKey,
    importId: statusAttempt.importId,
    campaignId: statusAttempt.campaignId,
    taskId: statusAttempt.taskId,
    semanticTaskId: statusAttempt.semanticTaskId,
    proofId: statusAttempt.proofId,
    packetHash: statusAttempt.packetHash,
    sidecarHash: statusAttempt.sidecarHash,
    bundleHash: statusAttempt.bundleHash,
    manifestHash: statusAttempt.manifestHash,
    campaignBindingHash: statusAttempt.campaignBindingHash,
    targetRepository: statusAttempt.targetRepository,
    targetBase: statusAttempt.targetBase,
    sourceCommit: statusAttempt.sourceCommit,
    sourceTree: statusAttempt.sourceTree,
    definitionSha256: statusAttempt.definitionSha256,
    commandSha256: statusAttempt.commandSha256,
    workItemId: statusAttempt.workItemId,
    runId: statusAttempt.runId,
    workItemAttempt: statusAttempt.workItemAttempt,
    state: statusAttempt.state,
  });
}

async function runProofResolutionCommand(
  args: string[],
  io: PrdCommandIo,
  dependencies: PrdCommandDependencies,
  commandContext: PrdCommandContext,
): Promise<number> {
  const [, idempotencyKey, attemptKey, evidencePath, confirmFlag, provided] =
    args;
  if (
    !idempotencyKey
    || !attemptKey
    || !/^ccc-proof-attempt-[0-9a-f]{64}$/u.test(attemptKey)
    || !evidencePath
    || (
      args.length !== 4
      && (
        args.length !== 6
        || confirmFlag !== "--confirm"
        || !provided
        || !/^[0-9a-f]{64}$/u.test(provided)
      )
    )
  ) {
    io.write(usage);
    return 2;
  }
  const evidence = readProofResolutionEvidence(evidencePath);
  return withPrdProject(io, dependencies, commandContext, async (project) => {
    const layer = project.store.getAsyncLayer();
    if (!layer) {
      throw new PrdProductCommandError(
        "CCC_PRD_POSTGRES_UNAVAILABLE",
        `PostgreSQL AsyncDataLayer unavailable for ${project.projectPath}`,
      );
    }
    const status = await inspectProductStatus(
      dependencies,
      project,
      idempotencyKey,
    );
    if (!status) {
      writeOperatorPayload(io, commandContext, {
        kind: "product-status",
        found: false,
        idempotencyKey,
      });
      return 1;
    }
    const context = exactProofResolutionContext(status, attemptKey);
    const confirmation = proofResolutionConfirmation(
      status,
      attemptKey,
      evidence,
    );
    if (args.length === 4) {
      writeOperatorPayload(io, commandContext, {
        kind: "proof-resolution-preview",
        attemptKey,
        decision: "settle",
        observerId: evidence.observerId,
        evidenceSummary: evidence.summary,
        outcome: evidence.result.success ? "committed" : "proved_failed",
        confirmation,
        consequence:
          "Persists the operator-observed verifier result, then requeues only the exact parked work item so runtime replay can settle it.",
        safeState:
          "No verifier command is rerun. The source commit, worktree, and existing receipts remain unchanged.",
        decisionOwner: "human operator",
        approvalExpiresAt: null,
        rollback:
          "Terminal proof evidence is immutable. If the evidence is wrong, stop this campaign and import a corrected reviewed campaign.",
        nextSafeAction:
          `Rerun this command with --confirm ${confirmation}.`,
      });
      return 0;
    }
    if (!exactDigest(provided!, confirmation)) {
      return writeProductRefusal(
        io,
        "CCC_PRD_PROOF_RESOLUTION_CONFIRMATION_REFUSED",
        "proof-resolution confirmation is stale or does not match current campaign evidence",
        operatorJson(commandContext),
      );
    }
    const persisted = await (
      dependencies.inspectCccCampaignProofAttempt
      ?? inspectCccCampaignProofAttempt
    )({
      layer,
      attemptKey,
    });
    if (!sameProofAttemptIdentity(context.attempt, persisted)) {
      throw new PrdProductCommandError(
        "CCC_PRD_PROOF_RESOLUTION_ATTEMPT_DRIFT",
        `proof attempt ${attemptKey} no longer matches the redacted product status`,
      );
    }
    const settled = await (
      dependencies.settleCccCampaignProofAttempt
      ?? settleCccCampaignProofAttempt
    )({
      layer,
      attemptKey,
      controllerToken: persisted!.controllerToken,
      result: evidence.result,
    });
    await project.store.transitionWorkflowWorkItem(
      context.workItem.id,
      "runnable",
      {
        expectedState: "manual-required",
        expectedAttempt: context.workItem.attempt,
        expectedLeaseOwner: null,
        attempt: context.workItem.attempt,
        leaseOwner: null,
        leaseExpiresAt: null,
        retryAfter: null,
        lastError: null,
        blockedReason: null,
      },
    );
    const completedStatus = await inspectProductStatus(
      dependencies,
      project,
      idempotencyKey,
    );
    if (!completedStatus) {
      throw new PrdProductCommandError(
        "CCC_PRD_PRODUCT_STATUS_MISSING",
        "product status disappeared after proof resolution",
      );
    }
    writeOperatorPayload(io, commandContext, {
      kind: "proof-resolved",
      attempt: settled,
      status: completedStatus,
      nextSafeAction:
        "Resume the campaign runtime; it will replay the terminal receipt without rerunning the verifier.",
    });
    return 0;
  });
}

type ProviderResolutionOutcome = "committed" | "proved_failed";

function exactProviderResolutionContext(
  status: CccPrdProductStatus,
  attemptKey: string,
  outcome: ProviderResolutionOutcome,
) {
  const matches = (status.providerAttempts ?? [])
    .filter((attempt) => attempt.attemptKey === attemptKey);
  if (matches.length !== 1) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROVIDER_RESOLUTION_ATTEMPT_MISSING",
      `provider attempt ${attemptKey} is not one exact imported campaign attempt`,
    );
  }
  const attempt = matches[0]!;
  if (
    attempt.binding.projectId !== status.projectId
    || attempt.binding.importId !== status.import.importId
    || attempt.binding.campaignId !== status.import.campaignId
    || attempt.binding.idempotencyKey !== status.import.idempotencyKey
    || attempt.binding.packetHash !== status.import.packetHash
    || attempt.binding.sidecarHash !== status.import.sidecarHash
    || attempt.binding.bundleHash !== status.import.bundleHash
    || attempt.binding.targetRepository !== status.import.targetRepository
    || attempt.binding.targetBase !== status.import.targetBase
    || attempt.taskId !== attempt.binding.taskId
  ) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROVIDER_RESOLUTION_IMPORT_BINDING_REFUSED",
      `provider attempt ${attemptKey} does not match the frozen import custody`,
    );
  }
  const terminalState = outcome;
  if (
    attempt.state !== "dispatched_unknown"
    && attempt.state !== terminalState
  ) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROVIDER_RESOLUTION_STATE_REFUSED",
      `provider attempt ${attemptKey} cannot settle as ${outcome} from ${attempt.state}`,
    );
  }
  if (attempt.binding.transport === "cli") {
    throw new PrdProductCommandError(
      "CCC_PRD_PROVIDER_RESOLUTION_CLI_FENCE_REQUIRED",
      "Native CLI provider effects require the held-session recovery fence; restart the campaign runtime to replay that native CLI recovery, or stop the campaign to abandon it.",
    );
  }
  if (
    attempt.binding.transport !== "pi"
    && attempt.binding.transport !== "workflow"
  ) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROVIDER_RESOLUTION_TRANSPORT_REFUSED",
      `provider attempt ${attemptKey} uses unsupported transport ${attempt.binding.transport}`,
    );
  }
  const tasks = status.tasks.filter((task) =>
    task.nativeTaskId === attempt.taskId
    && task.semanticTaskId === attempt.semanticTaskId);
  if (
    tasks.length !== 1
    || !tasks[0]!.present
    || !tasks[0]!.route
    || tasks[0]!.route.providerId !== attempt.binding.providerId
    || tasks[0]!.route.modelId !== attempt.binding.modelId
    || tasks[0]!.route.transport !== attempt.binding.transport
  ) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROVIDER_RESOLUTION_ROUTE_REFUSED",
      `provider attempt ${attemptKey} no longer matches one imported task route`,
    );
  }
  if (attempt.workItemFence === null) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROVIDER_RESOLUTION_WORK_ITEM_FENCE_MISSING",
      `provider attempt ${attemptKey} predates exact work-item fencing and requires campaign stop or direct evidence review`,
    );
  }
  const workItems = status.workItems.filter((workItem) =>
    workItem.id === attempt.workItemFence!.workItemId
    && workItem.runId === attempt.workItemFence!.runId
    && workItem.attempt === attempt.workItemFence!.attempt);
  if (workItems.length !== 1) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROVIDER_RESOLUTION_WORK_ITEM_MISSING",
      `provider attempt ${attemptKey} has no exact imported workflow work item`,
    );
  }
  const workItem = workItems[0]!;
  const expectedRunId = `ccc-prd:${status.import.importId}`;
  if (
    workItem.kind !== "task"
    || workItem.runId !== expectedRunId
    || workItem.stableWorkflowRunId !== expectedRunId
    || workItem.state !== "manual-required"
    || workItem.leaseOwner !== null
    || workItem.leaseExpiresAt !== null
  ) {
    throw new PrdProductCommandError(
      "CCC_PRD_PROVIDER_RESOLUTION_WORK_ITEM_REFUSED",
      `provider attempt ${attemptKey} is not parked at one unleased manual-resolution boundary`,
    );
  }
  return { attempt, workItem };
}

function providerResolutionConfirmation(
  status: CccPrdProductStatus,
  attemptKey: string,
  outcome: ProviderResolutionOutcome,
  observerId: string,
  evidenceDigest: string,
): string {
  const { attempt, workItem } = exactProviderResolutionContext(
    status,
    attemptKey,
    outcome,
  );
  return createHash("sha256")
    .update(canonicalCccPrdJson({
      schema: "ccc-campaign.provider-resolution-confirmation.v1",
      projectId: status.projectId,
      import: {
        importId: status.import.importId,
        idempotencyKey: status.import.idempotencyKey,
        packetHash: status.import.packetHash,
        sidecarHash: status.import.sidecarHash,
        bundleHash: status.import.bundleHash,
        targetRepository: status.import.targetRepository,
        targetBase: status.import.targetBase,
      },
      attempt,
      workItem: {
        id: workItem.id,
        runId: workItem.runId,
        taskId: workItem.taskId,
        state: workItem.state,
        attempt: workItem.attempt,
        leaseOwner: workItem.leaseOwner,
        leaseExpiresAt: workItem.leaseExpiresAt,
      },
      resolution: {
        outcome,
        observerId,
        evidenceDigest,
      },
    }), "utf8")
    .digest("hex");
}

function sameProviderAttemptIdentity(
  statusAttempt: ReturnType<
    typeof exactProviderResolutionContext
  >["attempt"],
  persisted: Awaited<
    ReturnType<ProjectContext["store"]["inspectCccProviderAttempt"]>
  >,
): boolean {
  if (!persisted) return false;
  const {
    controllerToken: _persistedControllerToken,
    ...persistedRedacted
  } = persisted;
  return canonicalCccPrdJson(persistedRedacted)
    === canonicalCccPrdJson(statusAttempt);
}

async function runProviderResolutionCommand(
  args: string[],
  io: PrdCommandIo,
  dependencies: PrdCommandDependencies,
  commandContext: PrdCommandContext,
): Promise<number> {
  const [
    ,
    idempotencyKey,
    attemptKey,
    rawOutcome,
    observerId,
    evidenceDigest,
    confirmFlag,
    provided,
  ] = args;
  const outcome: ProviderResolutionOutcome | undefined =
    rawOutcome === "committed"
      ? "committed"
      : rawOutcome === "proved-failed"
        ? "proved_failed"
        : undefined;
  if (
    !idempotencyKey
    || !attemptKey
    || !/^ccc-provider-attempt-[0-9a-f]{64}$/u.test(attemptKey)
    || !outcome
    || !observerId
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(observerId)
    || !evidenceDigest
    || !/^[0-9a-f]{64}$/u.test(evidenceDigest)
    || (
      args.length !== 6
      && (
        args.length !== 8
        || confirmFlag !== "--confirm"
        || !provided
        || !/^[0-9a-f]{64}$/u.test(provided)
      )
    )
  ) {
    io.write(usage);
    return 2;
  }
  return withPrdProject(io, dependencies, commandContext, async (project) => {
    const status = await inspectProductStatus(
      dependencies,
      project,
      idempotencyKey,
    );
    if (!status) {
      writeOperatorPayload(io, commandContext, {
        kind: "product-status",
        found: false,
        idempotencyKey,
      });
      return 1;
    }
    const context = exactProviderResolutionContext(
      status,
      attemptKey,
      outcome,
    );
    const confirmation = providerResolutionConfirmation(
      status,
      attemptKey,
      outcome,
      observerId,
      evidenceDigest,
    );
    if (args.length === 6) {
      writeOperatorPayload(io, commandContext, {
        kind: "provider-resolution-preview",
        attemptKey,
        outcome,
        observerId,
        evidenceDigest,
        confirmation,
        consequence:
          "Persists the operator-observed provider outcome, consumes an exact claimed approval only for a committed effect, then requeues only the exact parked work item.",
        safeState:
          "No provider request is replayed. The worktree, source commit, approval, and existing receipts remain unchanged until confirmation.",
        decisionOwner: "human operator",
        approvalExpiresAt: null,
        rollback:
          "Terminal provider evidence is immutable. If the observation is wrong, stop this campaign and import a corrected reviewed campaign.",
        nextSafeAction:
          `Rerun this command with --confirm ${confirmation}, or use fn prd stop to abandon the campaign.`,
      });
      return 0;
    }
    if (!exactDigest(provided!, confirmation)) {
      return writeProductRefusal(
        io,
        "CCC_PRD_PROVIDER_RESOLUTION_CONFIRMATION_REFUSED",
        "provider-resolution confirmation is stale or does not match current campaign evidence",
        operatorJson(commandContext),
      );
    }
    const persisted = await project.store.inspectCccProviderAttempt({
      taskId: context.attempt.taskId,
      attemptKey,
    });
    if (!sameProviderAttemptIdentity(context.attempt, persisted)) {
      throw new PrdProductCommandError(
        "CCC_PRD_PROVIDER_RESOLUTION_ATTEMPT_DRIFT",
        `provider attempt ${attemptKey} no longer matches the redacted product status`,
      );
    }
    const settled = await project.store.settleCccProviderAttemptAndApproval({
      ...persisted!,
      outcome,
      observerId,
      evidenceDigest,
    });
    await project.store.transitionWorkflowWorkItem(
      context.workItem.id,
      "runnable",
      {
        expectedState: "manual-required",
        expectedAttempt: context.workItem.attempt,
        expectedLeaseOwner: null,
        attempt: context.workItem.attempt,
        leaseOwner: null,
        leaseExpiresAt: null,
        retryAfter: null,
        lastError: null,
        blockedReason: null,
      },
    );
    const completedStatus = await inspectProductStatus(
      dependencies,
      project,
      idempotencyKey,
    );
    if (!completedStatus) {
      throw new PrdProductCommandError(
        "CCC_PRD_PRODUCT_STATUS_MISSING",
        "product status disappeared after provider resolution",
      );
    }
    writeOperatorPayload(io, commandContext, {
      kind: "provider-resolved",
      attempt: settled,
      status: completedStatus,
      nextSafeAction:
        "Resume the campaign runtime; it will replay the terminal receipt without repeating the provider effect.",
    });
    return 0;
  });
}

function newIdempotencyKey(): string {
  return `ccc-prd-${randomUUID()}`;
}

export async function runPrdCommand(
  rawArgs: string[],
  io: PrdCommandIo = {
    write: (line) => console.log(line),
    readStdin: () => readBoundedPrdStdin(process.stdin),
  },
  dependencies: PrdCommandDependencies = {},
  rawCommandContext: PrdCommandContext = {},
): Promise<number> {
  // Every subcommand below checks an exact argument count, so the output-mode
  // flag has to be removed before any dispatch.
  const { args, json } = parseOperatorJsonFlag(rawArgs);
  const commandContext: PrdCommandContext = { ...rawCommandContext, json };
  if (args[0] === "new-key") {
    if (args.length !== 1) {
      io.write(usage);
      return 2;
    }
    const idempotencyKey = newIdempotencyKey();
    if (json) {
      writeOperatorJson(io, { kind: "idempotency-key", idempotencyKey });
      return 0;
    }
    for (const line of renderIdempotencyKey(idempotencyKey)) io.write(line);
    return 0;
  }
  if (args[0] === "understand") {
    const parsed = parseGeneratedUnderstandingArgs(args);
    if (!parsed) {
      io.write(usage);
      return 2;
    }
    return runGeneratedUnderstanding(parsed, io, dependencies);
  }
  if (args[0] === "policy") {
    return runProductPolicyCommand(args, io);
  }
  if (args[0] === "corpus" || args[0] === "discover" || args[0] === "freeze") {
    return runIntakePacketCommand(args, io, dependencies);
  }
  if (args[0] === "template" || args[0] === "lint") {
    return runIntakeContractCommand(args, io);
  }
  if (args[0] === "preview" || args[0] === "import") {
    return runProductPacketCommand(args, io, dependencies, commandContext);
  }
  if (args[0] === "inspect" || args[0] === "reconcile") {
    return runProductStateCommand(args, io, dependencies, commandContext);
  }
  if (
    args[0] === "status"
    || args[0] === "approve-execution"
    || args[0] === "approve-merge"
  ) {
    return runProductControlCommand(args, io, dependencies, commandContext);
  }
  if (
    args[0] === "pause"
    || args[0] === "resume"
    || args[0] === "stop"
    || args[0] === "abandon"
  ) {
    return runCampaignLifecycleCommand(
      args,
      io,
      dependencies,
      commandContext,
    );
  }
  if (args[0] === "resolve-proof") {
    return runProofResolutionCommand(
      args,
      io,
      dependencies,
      commandContext,
    );
  }
  if (args[0] === "resolve-provider") {
    return runProviderResolutionCommand(
      args,
      io,
      dependencies,
      commandContext,
    );
  }
  const [subcommand, rootDir, manifestPath, inputPath, fifth, sixth] = args;
  const author = subcommand === "author";
  const generatedAuthor = parseGeneratedAuthorArgs(args);
  const legacyAuthor = author && args.length === 5 && Boolean(fifth);
  const compilerCommand = subcommand === "validate" || subcommand === "compile";
  if (
    !rootDir
    || !manifestPath
    || !inputPath
    || (author && !generatedAuthor && !legacyAuthor)
    || (compilerCommand && (
      args.length !== 6
      || !fifth
      || !sixth
      || !/^[0-9a-f]{40}$/.test(sixth)
    ))
    || (!author && !compilerCommand)
  ) {
    io.write(usage);
    return 2;
  }

  if (generatedAuthor) {
    return runGeneratedAuthor(
      generatedAuthor,
      io,
      dependencies.bootstrapProofAdmission ?? bootstrapCccCampaignProofAdmissionHost,
    );
  }

  if (author) {
    let proposal: CccPrdAuthoringProposal;
    try {
      proposal = JSON.parse(readFileSync(resolveAuthorInput(rootDir, inputPath), "utf8")) as CccPrdAuthoringProposal;
    } catch {
      io.write(JSON.stringify({
        kind: "refusal",
        diagnostics: [{
          code: "CCC_PRD_AUTHORING_PROPOSAL_READ_FAILED",
          message: `authoring proposal could not be read: ${inputPath}`,
        }],
      }));
      return 1;
    }
    let workflowExtensionRegistry: WorkflowExtensionRegistry;
    try {
      workflowExtensionRegistry = await (
        dependencies.bootstrapProofAdmission ?? bootstrapCccCampaignProofAdmissionHost
      )();
    } catch (error) {
      io.write(JSON.stringify({
        kind: "refusal",
        diagnostics: [{
          code: "CCC_PRD_PROOF_ADMISSION_BOOTSTRAP_FAILED",
          message: error instanceof Error
            ? error.message
            : "fixed proof-admission host could not be bootstrapped",
        }],
      }));
      return 1;
    }
    const result = await compiler.authorCccPrdPacket({
      rootDir,
      manifestPath,
      adapter: {
        id: "local-deterministic-fixture",
        model: "proposal-file-v1",
        generateCandidate: async () => proposal,
      },
      constraints: {
        targetRepository: proposal.targetRepository,
        bounds: proposal.bounds,
        maxReviewItems:
          proposal.ambiguities.length
          + proposal.unresolvedDecisions.length
          + proposal.exceptions.length
          + proposal.protectedActions.length,
      },
      workflowExtensionRegistry,
    });
    if (result.kind === "refusal") {
      io.write(JSON.stringify(result));
      return 1;
    }
    try {
      writeSidecarAtomically(rootDir, manifestPath, inputPath, fifth!, result.sidecar);
    } catch (error) {
      io.write(JSON.stringify({
        kind: "refusal",
        diagnostics: [{
          code: "CCC_PRD_SIDECAR_WRITE_FAILED",
          message: error instanceof Error ? error.message : "sidecar could not be written",
        }],
      }));
      return 1;
    }
    io.write(JSON.stringify({
      kind: "candidate",
      sidecarPath: resolve(fifth!),
      review: result.review,
    }));
    return 0;
  }

  const input = {
    rootDir,
    manifestPath,
    sidecarPath: inputPath,
    expectedTarget: fifth!,
    expectedBase: sixth!,
    requireMaterialCoverage: true,
  };
  if (subcommand === "validate") {
    const result = compiler.validateCccPrdPacket(input);
    io.write(JSON.stringify({
      kind: "diagnostics",
      valid: result.valid,
      diagnostics: result.diagnostics,
    }));
    return result.valid ? 0 : 1;
  }

  const result = compiler.compileCccPrdPacket(input);
  io.write(JSON.stringify(result));
  return result.kind === "bundle" ? 0 : 1;
}
