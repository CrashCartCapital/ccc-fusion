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
  type CccPrdAuthoringAdapter,
  type CccPrdAuthoringConstraints,
  type CccPrdAuthoringProposal,
  type CccPrdSidecar,
  type WorkflowExtensionRegistry,
} from "@fusion/core";
import * as engine from "@fusion/engine";
import { bootstrapCccCampaignProofAdmissionHost } from "./ccc-native-proof-host.js";

export type PrdCommandIo = {
  write(line: string): void;
};

type Compiler = {
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
  }): CccPrdAuthoringAdapter;
  compileCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    sidecarPath: string;
    expectedTarget: string;
    expectedBase: string;
  }): { kind: "bundle" | "refusal" };
  validateCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    sidecarPath: string;
    expectedTarget: string;
    expectedBase: string;
  }): { kind: "validation"; valid: boolean; diagnostics: unknown[] };
};

const compiler = engine as typeof engine & Compiler;
export type PrdCommandDependencies = {
  bootstrapProofAdmission?: () => Promise<WorkflowExtensionRegistry>;
};
const usage = [
  "usage: fn prd author <root-dir> <manifest-path> <sidecar-output> --target <repository> --base <40-hex-commit> --provider <provider> --model <model> --max-requests <n> --max-duration-ms <n> --max-concurrency <n> --max-prompt-bytes <n> --max-response-bytes <n> --max-review-items <n>",
  "       fn prd author <root-dir> <manifest-path> <proposal-path> <sidecar-output> (deterministic compatibility fixture)",
  "       fn prd <validate|compile> <root-dir> <manifest-path> <sidecar-path> <expected-target> <expected-base>",
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

export async function runPrdCommand(
  args: string[],
  io: PrdCommandIo = { write: (line) => console.log(line) },
  dependencies: PrdCommandDependencies = {},
): Promise<number> {
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
