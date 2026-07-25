import {
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
  type CccPrdAuthoringProposal,
} from "@fusion/core";
import * as engine from "@fusion/engine";

export type PrdCommandIo = {
  write(line: string): void;
};

type Compiler = {
  authorCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    adapter: {
      id: string;
      model?: string;
      generateCandidate(): Promise<CccPrdAuthoringProposal>;
    };
  }): Promise<{ kind: "candidate"; sidecar: unknown; review: unknown } | { kind: "refusal" }>;
  compileCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    sidecarPath: string;
  }): { kind: "bundle" | "refusal" };
  validateCccPrdPacket(input: {
    rootDir: string;
    manifestPath: string;
    sidecarPath: string;
  }): { kind: "validation"; valid: boolean; diagnostics: unknown[] };
};

const compiler = engine as typeof engine & Compiler;
const usage = "usage: fn prd <author|validate|compile> <root-dir> <manifest-path> <proposal-or-sidecar-path> [sidecar-output]";

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

export async function runPrdCommand(
  args: string[],
  io: PrdCommandIo = { write: (line) => console.log(line) },
): Promise<number> {
  const [subcommand, rootDir, manifestPath, inputPath, outputPath] = args;
  if (
    !rootDir
    || !manifestPath
    || !inputPath
    || (subcommand === "author" && !outputPath)
    || !["author", "validate", "compile"].includes(subcommand ?? "")
  ) {
    io.write(usage);
    return 2;
  }

  if (subcommand === "author") {
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
    const result = await compiler.authorCccPrdPacket({
      rootDir,
      manifestPath,
      adapter: {
        id: "local-deterministic-fixture",
        model: "proposal-file-v1",
        generateCandidate: async () => proposal,
      },
    });
    if (result.kind === "refusal") {
      io.write(JSON.stringify(result));
      return 1;
    }
    try {
      writeSidecarAtomically(rootDir, manifestPath, inputPath, outputPath!, result.sidecar);
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
      sidecarPath: resolve(outputPath!),
      review: result.review,
    }));
    return 0;
  }

  const input = {
    rootDir,
    manifestPath,
    sidecarPath: inputPath,
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
