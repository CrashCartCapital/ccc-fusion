import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

export type WorkflowExtensionProvenanceErrorReason =
  | "invalid-host-identity"
  | "invalid-relative-path"
  | "unsupported-file-custody"
  | "outside-trusted-root"
  | "not-regular-file"
  | "file-identity-drift"
  | "source-drift"
  | "manifest-drift"
  | "external-runtime-dependency"
  | "unknown-provenance";

export class WorkflowExtensionProvenanceError extends Error {
  public constructor(
    public readonly reason: WorkflowExtensionProvenanceErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowExtensionProvenanceError";
  }
}

export type WorkflowExtensionHostProvenanceBinding = Readonly<{
  pluginId: string;
  pluginVersion: string;
  extensionRootRelativeSource: string;
  extensionSourceSha256: string;
  extensionManifestSha256: string;
}>;

declare const workflowExtensionHostProvenanceBrand: unique symbol;

export type WorkflowExtensionHostProvenance = Readonly<{
  [workflowExtensionHostProvenanceBrand]: true;
}>;

export type DeriveWorkflowExtensionHostProvenanceInput = Readonly<{
  pluginId: string;
  pluginVersion: string;
  trustedRootPath: string;
  entryRelativePath: string;
  manifestRelativePath: string;
}>;

type FileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type HostProvenanceInternal = Readonly<{
  rootRealPath: string;
  entryCandidatePath: string;
  entryRealPath: string;
  manifestCandidatePath: string;
  manifestRealPath: string;
  binding: WorkflowExtensionHostProvenanceBinding;
}>;

type BoundFileRead = Readonly<{
  bytes: Buffer;
  realPath: string;
}>;

type SourceToken = Readonly<{
  kind: "identifier" | "string" | "punctuation" | "template";
  value: string;
}>;

const provenanceInternals = new WeakMap<WorkflowExtensionHostProvenance, HostProvenanceInternal>();

function provenanceError(
  reason: WorkflowExtensionProvenanceErrorReason,
  message: string,
): WorkflowExtensionProvenanceError {
  return new WorkflowExtensionProvenanceError(reason, message);
}

function requireHostText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw provenanceError("invalid-host-identity", `${label} must be a non-empty string`);
  }
  return value;
}

function containedRelativePath(rootRealPath: string, candidatePath: string, label: string): string {
  const fromRoot = relative(rootRealPath, candidatePath);
  if (
    fromRoot === ""
    || fromRoot === ".."
    || fromRoot.startsWith(`..${sep}`)
    || isAbsolute(fromRoot)
  ) {
    throw provenanceError("outside-trusted-root", `${label} must remain inside the trusted root`);
  }
  return fromRoot.split(sep).join("/");
}

function resolveContainedCandidate(
  rootRealPath: string,
  relativePath: string,
  label: string,
): string {
  if (
    typeof relativePath !== "string"
    || relativePath.trim() === ""
    || /^file:/iu.test(relativePath)
    || relativePath.includes("\\")
    || isAbsolute(relativePath)
    || win32.isAbsolute(relativePath)
    || relativePath.split("/").includes("..")
  ) {
    throw provenanceError(
      "invalid-relative-path",
      `${label} must be a root-relative path inside the trusted root`,
    );
  }
  const candidatePath = resolve(rootRealPath, relativePath);
  containedRelativePath(rootRealPath, candidatePath, label);
  return candidatePath;
}

function secureReadFlags(): number {
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) {
    throw provenanceError(
      "unsupported-file-custody",
      "platform does not provide the required O_NOFOLLOW file-custody guarantee",
    );
  }
  const closeOnExec = (constants as Record<string, number | undefined>).O_CLOEXEC;
  return constants.O_RDONLY | noFollow | (closeOnExec ?? 0);
}

function identityOf(stats: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function verifyPathStillNamesHandle(
  rootRealPath: string,
  candidatePath: string,
  handleIdentity: FileIdentity,
  label: string,
): Promise<string> {
  const postResolvedPath = await realpath(candidatePath);
  containedRelativePath(rootRealPath, postResolvedPath, label);
  const pathIdentity = identityOf(await stat(postResolvedPath, { bigint: true }));
  if (
    pathIdentity.dev !== handleIdentity.dev
    || pathIdentity.ino !== handleIdentity.ino
  ) {
    throw provenanceError(
      "file-identity-drift",
      `${label} changed identity while its custody handle was open`,
    );
  }
  return postResolvedPath;
}

async function readFileWithBoundCustody(
  rootRealPath: string,
  candidatePath: string,
  label: string,
): Promise<BoundFileRead> {
  let handle;
  try {
    const preResolvedPath = await realpath(candidatePath);
    containedRelativePath(rootRealPath, preResolvedPath, label);
    handle = await open(candidatePath, secureReadFlags());
    const beforeStats = await handle.stat({ bigint: true });
    if (!beforeStats.isFile()) {
      throw provenanceError("not-regular-file", `${label} must be a regular file`);
    }
    const beforeIdentity = identityOf(beforeStats);
    await verifyPathStillNamesHandle(rootRealPath, candidatePath, beforeIdentity, label);
    const bytes = await handle.readFile();
    const afterStats = await handle.stat({ bigint: true });
    const afterIdentity = identityOf(afterStats);
    if (!sameFileIdentity(beforeIdentity, afterIdentity)) {
      throw provenanceError(
        "file-identity-drift",
        `${label} changed while its custody handle was being read`,
      );
    }
    const postResolvedPath = await verifyPathStillNamesHandle(
      rootRealPath,
      candidatePath,
      afterIdentity,
      label,
    );
    return { bytes, realPath: postResolvedPath };
  } catch (error) {
    if (error instanceof WorkflowExtensionProvenanceError) throw error;
    throw provenanceError(
      "file-identity-drift",
      `${label} could not be read through a stable no-follow custody handle: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await handle?.close();
  }
}

function readQuotedToken(source: string, start: number): { token: SourceToken; end: number } {
  const quote = source[start]!;
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined) break;
      value += escaped;
      index += 1;
      continue;
    }
    if (character === quote) {
      return { token: { kind: "string", value }, end: index + 1 };
    }
    value += character;
  }
  throw provenanceError(
    "external-runtime-dependency",
    "fixed proof entry must be self-contained and contain valid string literals",
  );
}

function readTemplateToken(source: string, start: number): { token: SourceToken; end: number } {
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined) break;
      value += character + escaped;
      index += 1;
      continue;
    }
    if (character === "`") {
      if (/\b(?:import|require)\s*\(/u.test(value)) {
        throw provenanceError(
          "external-runtime-dependency",
          "fixed proof entry must be self-contained; template runtime dependency is not allowed",
        );
      }
      return { token: { kind: "template", value }, end: index + 1 };
    }
    value += character;
  }
  throw provenanceError(
    "external-runtime-dependency",
    "fixed proof entry must be self-contained and contain valid template literals",
  );
}

function tokenizeSource(source: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  for (let index = 0; index < source.length;) {
    const character = source[index]!;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) {
        throw provenanceError(
          "external-runtime-dependency",
          "fixed proof entry must be self-contained and contain valid comments",
        );
      }
      index = end + 2;
      continue;
    }
    if (character === "'" || character === "\"") {
      const quoted = readQuotedToken(source, index);
      tokens.push(quoted.token);
      index = quoted.end;
      continue;
    }
    if (character === "`") {
      const template = readTemplateToken(source, index);
      tokens.push(template.token);
      index = template.end;
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/u.test(source[end]!)) end += 1;
      tokens.push({ kind: "identifier", value: source.slice(index, end) });
      index = end;
      continue;
    }
    tokens.push({ kind: "punctuation", value: character });
    index += 1;
  }
  return tokens;
}

function requireAllowedRuntimeSpecifier(specifier: string): void {
  if (specifier.startsWith("node:")) return;
  throw provenanceError(
    "external-runtime-dependency",
    `fixed proof entry must be self-contained; runtime dependency '${specifier}' is not allowed`,
  );
}

function findFromSpecifier(
  tokens: readonly SourceToken[],
  start: number,
): { index: number; specifier?: string } {
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.value === ";" || token.value === "\n") break;
    if (token.kind === "identifier" && token.value === "from") {
      const specifier = tokens[index + 1];
      return {
        index,
        ...(specifier?.kind === "string" ? { specifier: specifier.value } : {}),
      };
    }
  }
  return { index: start };
}

function isInlineTypeOnlyClause(
  tokens: readonly SourceToken[],
  start: number,
  end: number,
): boolean {
  const clause = tokens.slice(start, end);
  if (clause[0]?.value !== "{" || clause.at(-1)?.value !== "}") return false;
  const bindings = clause.slice(1, -1);
  let groupStart = 0;
  for (let index = 0; index <= bindings.length; index += 1) {
    if (index < bindings.length && bindings[index]?.value !== ",") continue;
    const group = bindings.slice(groupStart, index);
    if (group.length === 0 || group[0]?.value !== "type") return false;
    groupStart = index + 1;
  }
  return bindings.length > 0;
}

export function validateWorkflowExtensionFixedEntrySource(source: Buffer | string): void {
  const tokens = tokenizeSource(Buffer.isBuffer(source) ? source.toString("utf8") : source);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== "identifier") continue;
    if (token.value === "require" && tokens[index + 1]?.value === "(") {
      const specifier = tokens[index + 2];
      if (specifier?.kind !== "string" || tokens[index + 3]?.value !== ")") {
        throw provenanceError(
          "external-runtime-dependency",
          "fixed proof entry must be self-contained; dynamic require is not allowed",
        );
      }
      requireAllowedRuntimeSpecifier(specifier.value);
      continue;
    }
    if (token.value === "import") {
      if (tokens[index + 1]?.value === ".") continue;
      if (tokens[index + 1]?.value === "(") {
        const specifier = tokens[index + 2];
        if (specifier?.kind !== "string" || tokens[index + 3]?.value !== ")") {
          throw provenanceError(
            "external-runtime-dependency",
            "fixed proof entry must be self-contained; dynamic import is not allowed",
          );
        }
        requireAllowedRuntimeSpecifier(specifier.value);
        continue;
      }
      if (tokens[index + 1]?.kind === "string") {
        requireAllowedRuntimeSpecifier(tokens[index + 1]!.value);
        continue;
      }
      const found = findFromSpecifier(tokens, index + 1);
      const typeOnly = tokens[index + 1]?.value === "type"
        || isInlineTypeOnlyClause(tokens, index + 1, found.index);
      if (found.specifier !== undefined && !typeOnly) {
        requireAllowedRuntimeSpecifier(found.specifier);
      }
      continue;
    }
    if (token.value === "export") {
      const found = findFromSpecifier(tokens, index + 1);
      const typeOnly = tokens[index + 1]?.value === "type"
        || isInlineTypeOnlyClause(tokens, index + 1, found.index);
      if (found.specifier !== undefined && !typeOnly) {
        requireAllowedRuntimeSpecifier(found.specifier);
      }
    }
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireProvenanceInternal(
  provenance: WorkflowExtensionHostProvenance,
): HostProvenanceInternal {
  const internal = provenanceInternals.get(provenance);
  if (!internal) {
    throw provenanceError(
      "unknown-provenance",
      "workflow extension provenance was not constructed by the host custody helper",
    );
  }
  return internal;
}

export async function deriveWorkflowExtensionHostProvenance(
  input: DeriveWorkflowExtensionHostProvenanceInput,
): Promise<WorkflowExtensionHostProvenance> {
  const pluginId = requireHostText(input.pluginId, "pluginId");
  const pluginVersion = requireHostText(input.pluginVersion, "pluginVersion");
  if (!isAbsolute(input.trustedRootPath)) {
    throw provenanceError("outside-trusted-root", "trusted root must be an absolute path");
  }
  const rootRealPath = await realpath(input.trustedRootPath);
  const entryCandidatePath = resolveContainedCandidate(
    rootRealPath,
    input.entryRelativePath,
    "extension source",
  );
  const manifestCandidatePath = resolveContainedCandidate(
    rootRealPath,
    input.manifestRelativePath,
    "extension manifest",
  );
  const entryRead = await readFileWithBoundCustody(
    rootRealPath,
    entryCandidatePath,
    "extension source",
  );
  validateWorkflowExtensionFixedEntrySource(entryRead.bytes);
  const manifestRead = await readFileWithBoundCustody(
    rootRealPath,
    manifestCandidatePath,
    "extension manifest",
  );
  const binding: WorkflowExtensionHostProvenanceBinding = Object.freeze({
    pluginId,
    pluginVersion,
    extensionRootRelativeSource: containedRelativePath(
      rootRealPath,
      entryRead.realPath,
      "extension source",
    ),
    extensionSourceSha256: sha256(entryRead.bytes),
    extensionManifestSha256: sha256(manifestRead.bytes),
  });
  const provenance = Object.freeze({}) as WorkflowExtensionHostProvenance;
  provenanceInternals.set(provenance, Object.freeze({
    rootRealPath,
    entryCandidatePath,
    entryRealPath: entryRead.realPath,
    manifestCandidatePath,
    manifestRealPath: manifestRead.realPath,
    binding,
  }));
  return provenance;
}

export function getWorkflowExtensionHostProvenanceBinding(
  provenance: WorkflowExtensionHostProvenance,
): WorkflowExtensionHostProvenanceBinding {
  return requireProvenanceInternal(provenance).binding;
}

export function hasSameWorkflowExtensionHostProvenanceIdentity(
  left: WorkflowExtensionHostProvenance,
  right: WorkflowExtensionHostProvenance,
): boolean {
  const leftInternal = requireProvenanceInternal(left);
  const rightInternal = requireProvenanceInternal(right);
  return leftInternal.rootRealPath === rightInternal.rootRealPath
    && leftInternal.entryRealPath === rightInternal.entryRealPath
    && leftInternal.manifestRealPath === rightInternal.manifestRealPath;
}

export async function verifyWorkflowExtensionHostProvenance(
  provenance: WorkflowExtensionHostProvenance,
): Promise<WorkflowExtensionHostProvenanceBinding> {
  const internal = requireProvenanceInternal(provenance);
  const entryRead = await readFileWithBoundCustody(
    internal.rootRealPath,
    internal.entryCandidatePath,
    "extension source",
  );
  validateWorkflowExtensionFixedEntrySource(entryRead.bytes);
  if (
    entryRead.realPath !== internal.entryRealPath
    || sha256(entryRead.bytes) !== internal.binding.extensionSourceSha256
  ) {
    throw provenanceError("source-drift", "extension source changed after registration");
  }
  const manifestRead = await readFileWithBoundCustody(
    internal.rootRealPath,
    internal.manifestCandidatePath,
    "extension manifest",
  );
  if (
    manifestRead.realPath !== internal.manifestRealPath
    || sha256(manifestRead.bytes) !== internal.binding.extensionManifestSha256
  ) {
    throw provenanceError("manifest-drift", "extension manifest changed after registration");
  }
  return internal.binding;
}
