import { isAbsolute, resolve } from "node:path";
import { compareCccPrdCodeUnits } from "@fusion/core";

export const CCC_PRD_OPERATOR_CONTEXT_SCHEMA_VERSION =
  "ccc-prd.operator-context.v1" as const;
export const CCC_PRD_OPERATOR_CONTEXT_SOURCE_PATH =
  "__fusion__/REF-HUM-FusionOperatorContext.md" as const;
export const CCC_PRD_OPERATOR_CONTEXT_ORIGIN =
  "operator-context://ccc-prd.operator-context.v1" as const;

export type CccPrdOperatorContext = Readonly<{
  schema: typeof CCC_PRD_OPERATOR_CONTEXT_SCHEMA_VERSION;
  targetRepository: Readonly<{
    path: string;
    baseCommit: string;
  }>;
  taskCustody: Readonly<{
    ownedPaths: readonly string[];
    allowedWriteRoots: readonly string[];
  }>;
  writeRootPurpose: string;
  bounds: Readonly<{
    maxRequests: number;
    maxDurationMs: number;
    maxConcurrency: number;
  }>;
}>;

export class CccPrdOperatorContextError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CccPrdOperatorContextError";
  }
}

function refuse(code: string, message: string): never {
  throw new CccPrdOperatorContextError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const observed = Object.keys(value).sort(compareCccPrdCodeUnits);
  const canonicalExpected = [...expected].sort(compareCccPrdCodeUnits);
  if (
    observed.length !== canonicalExpected.length
    || observed.some((key, index) => key !== canonicalExpected[index])
  ) {
    refuse(
      "CCC_PRD_OPERATOR_CONTEXT_INVALID",
      label + " fields must be exactly " + canonicalExpected.join(", "),
    );
  }
}

function singleLine(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.includes("\n")
    || value.includes("\r")
    || value.includes("\0")
  ) {
    refuse(
      "CCC_PRD_OPERATOR_CONTEXT_INVALID",
      label + " must be one non-empty trimmed line",
    );
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    refuse(
      "CCC_PRD_OPERATOR_CONTEXT_INVALID",
      label + " must be a positive safe integer",
    );
  }
  return value as number;
}

function canonicalTargetRelativePath(value: unknown, label: string): string {
  const path = singleLine(value, label);
  if (
    path.includes("\\")
    || isAbsolute(path)
    || path === "."
    || path.split("/").some((segment) => (
      segment.length === 0 || segment === "." || segment === ".."
    ))
  ) {
    refuse(
      "CCC_PRD_OPERATOR_CONTEXT_INVALID",
      label + " must be a canonical target-relative path",
    );
  }
  return path;
}

function canonicalPathSet(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    refuse(
      "CCC_PRD_OPERATOR_CONTEXT_INVALID",
      label + " must be a non-empty array",
    );
  }
  const paths = value.map((path, index) =>
    canonicalTargetRelativePath(path, label + "[" + index + "]"));
  if (new Set(paths).size !== paths.length) {
    refuse(
      "CCC_PRD_OPERATOR_CONTEXT_INVALID",
      label + " must not contain duplicates",
    );
  }
  return paths.sort(compareCccPrdCodeUnits);
}

function pathContains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + "/");
}

export function parseCccPrdOperatorContext(
  value: unknown,
): CccPrdOperatorContext {
  if (!isRecord(value)) {
    refuse(
      "CCC_PRD_OPERATOR_CONTEXT_INVALID",
      "operator context must be an object",
    );
  }
  exactKeys(
    value,
    ["bounds", "schema", "targetRepository", "taskCustody", "writeRootPurpose"],
    "operator context",
  );
  if (value.schema !== CCC_PRD_OPERATOR_CONTEXT_SCHEMA_VERSION) {
    refuse(
      "CCC_PRD_OPERATOR_CONTEXT_INVALID",
      "operator context schema must be " + CCC_PRD_OPERATOR_CONTEXT_SCHEMA_VERSION,
    );
  }
  if (!isRecord(value.targetRepository)) {
    refuse(
      "CCC_PRD_OPERATOR_CONTEXT_INVALID",
      "operator context targetRepository must be an object",
    );
  }
  exactKeys(value.targetRepository, ["baseCommit", "path"], "targetRepository");
  const targetPath = singleLine(value.targetRepository.path, "targetRepository.path");
  if (!isAbsolute(targetPath) || resolve(targetPath) !== targetPath) {
    refuse(
      "CCC_PRD_OPERATOR_CONTEXT_INVALID",
      "targetRepository.path must be a canonical absolute path",
    );
  }
  const baseCommit = singleLine(
    value.targetRepository.baseCommit,
    "targetRepository.baseCommit",
  );
  if (baseCommit.length !== 40 || /[^0-9a-f]/u.test(baseCommit)) {
    refuse(
      "CCC_PRD_OPERATOR_CONTEXT_INVALID",
      "targetRepository.baseCommit must be lowercase 40-hex",
    );
  }
  if (!isRecord(value.taskCustody)) {
    refuse(
      "CCC_PRD_OPERATOR_CONTEXT_INVALID",
      "operator context taskCustody must be an object",
    );
  }
  exactKeys(value.taskCustody, ["allowedWriteRoots", "ownedPaths"], "taskCustody");
  const ownedPaths = canonicalPathSet(value.taskCustody.ownedPaths, "ownedPaths");
  const allowedWriteRoots = canonicalPathSet(
    value.taskCustody.allowedWriteRoots,
    "allowedWriteRoots",
  );
  for (const allowedRoot of allowedWriteRoots) {
    if (!ownedPaths.some((ownedPath) => pathContains(ownedPath, allowedRoot))) {
      refuse(
        "CCC_PRD_OPERATOR_CONTEXT_INVALID",
        "allowed write root " + allowedRoot + " is outside task ownership",
      );
    }
  }
  if (!isRecord(value.bounds)) {
    refuse(
      "CCC_PRD_OPERATOR_CONTEXT_INVALID",
      "operator context bounds must be an object",
    );
  }
  exactKeys(
    value.bounds,
    ["maxConcurrency", "maxDurationMs", "maxRequests"],
    "bounds",
  );
  const writeRootPurpose = singleLine(value.writeRootPurpose, "writeRootPurpose");
  return {
    schema: CCC_PRD_OPERATOR_CONTEXT_SCHEMA_VERSION,
    targetRepository: {
      path: targetPath,
      baseCommit,
    },
    taskCustody: {
      ownedPaths,
      allowedWriteRoots,
    },
    writeRootPurpose,
    bounds: {
      maxRequests: positiveInteger(value.bounds.maxRequests, "bounds.maxRequests"),
      maxDurationMs: positiveInteger(
        value.bounds.maxDurationMs,
        "bounds.maxDurationMs",
      ),
      maxConcurrency: positiveInteger(
        value.bounds.maxConcurrency,
        "bounds.maxConcurrency",
      ),
    },
  };
}

function unfencedLines(markdown: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/u)) {
    const trimmed = line.trimStart();
    if (fence) {
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }
    if (trimmed.startsWith("```")) {
      fence = "```";
      continue;
    }
    if (trimmed.startsWith("~~~")) {
      fence = "~~~";
      continue;
    }
    lines.push(line);
  }
  return lines;
}

function inlineValues(markdown: string, labels: readonly string[]): string[] {
  const values: string[] = [];
  for (const line of unfencedLines(markdown)) {
    const normalized = line
      .replace(/^\s*(?:[-*+]\s+)?/u, "")
      .replace(/^\s*#{1,6}\s+/u, "")
      .trim();
    const lower = normalized.toLowerCase();
    for (const label of labels) {
      const prefix = label.toLowerCase() + ":";
      if (!lower.startsWith(prefix)) continue;
      const value = normalized.slice(prefix.length).trim();
      if (value.length > 0 && !value.startsWith("<")) values.push(value);
    }
  }
  return values;
}

function assertCompatibleValues(
  sources: readonly { path: string; markdown: string; authoritative: boolean }[],
  label: string,
  labels: readonly string[],
  admitted: ReadonlySet<string>,
  splitValues = false,
): void {
  for (const source of sources) {
    if (!source.authoritative) continue;
    const values = inlineValues(source.markdown, labels).flatMap((value) => (
      splitValues ? value.split(",").map((part) => part.trim()).filter(Boolean) : [value]
    ));
    const conflicting = values.find((value) => !admitted.has(value));
    if (conflicting) {
      refuse(
        "CCC_PRD_OPERATOR_CONTEXT_CONFLICT",
        "operator context " + label + " conflicts with " + source.path
          + ": " + conflicting,
      );
    }
  }
}

export function assertCccPrdOperatorContextCompatible(input: {
  context: CccPrdOperatorContext;
  sources: readonly { path: string; markdown: string; authoritative: boolean }[];
}): void {
  const absoluteWriteRoots = input.context.taskCustody.allowedWriteRoots.map((path) =>
    resolve(input.context.targetRepository.path, path));
  assertCompatibleValues(
    input.sources,
    "target repository",
    ["Target repository", "Repository target"],
    new Set([input.context.targetRepository.path]),
  );
  assertCompatibleValues(
    input.sources,
    "baseline",
    ["Baseline", "Base commit", "Baseline commit", "Frozen baseline commit"],
    new Set([input.context.targetRepository.baseCommit]),
  );
  assertCompatibleValues(
    input.sources,
    "task ownership",
    ["Task owned path", "Task owned paths", "Owned path", "Owned paths"],
    new Set(input.context.taskCustody.ownedPaths),
    true,
  );
  assertCompatibleValues(
    input.sources,
    "write roots",
    [
      "Task allowed write root",
      "Task allowed write roots",
      "Allowed write root",
      "Allowed write roots",
      "Allowed paths",
      "Writable paths",
    ],
    new Set([
      ...input.context.taskCustody.allowedWriteRoots,
      ...absoluteWriteRoots,
    ]),
    true,
  );
  assertCompatibleValues(
    input.sources,
    "write-root purpose",
    ["Allowed write root purpose", "Admitted write purpose"],
    new Set([input.context.writeRootPurpose]),
  );
  assertCompatibleValues(
    input.sources,
    "maximum requests",
    ["Max requests", "Maximum requests"],
    new Set([String(input.context.bounds.maxRequests)]),
  );
  assertCompatibleValues(
    input.sources,
    "maximum duration",
    ["Max duration ms", "Maximum duration in milliseconds"],
    new Set([String(input.context.bounds.maxDurationMs)]),
  );
  assertCompatibleValues(
    input.sources,
    "maximum concurrency",
    ["Max concurrency", "Maximum concurrency"],
    new Set([String(input.context.bounds.maxConcurrency)]),
  );
}

export function renderCccPrdOperatorContextMarkdown(
  value: unknown,
): { context: CccPrdOperatorContext; markdown: string } {
  const context = parseCccPrdOperatorContext(value);
  const lines = [
    "# Fusion Reviewed Operator Context",
    "",
    "This deterministic companion supplements missing implementation facts only.",
    "The original PRD controls product behavior. Any contradiction is unresolved and blocks intake.",
    "",
    "## Target repository and baseline",
    "",
    "- Target repository: " + context.targetRepository.path,
    "- Baseline commit: " + context.targetRepository.baseCommit,
    "",
    "## Task custody",
    "",
    ...context.taskCustody.ownedPaths.map((path) => "- Task owned path: " + path),
    ...context.taskCustody.allowedWriteRoots.map(
      (path) => "- Task allowed write root: " + path,
    ),
    "",
    "## Admitted write roots",
    "",
    ...context.taskCustody.allowedWriteRoots.map(
      (path) => "- Allowed write root: " + resolve(context.targetRepository.path, path),
    ),
    "- Allowed write root purpose: " + context.writeRootPurpose,
    "",
    "## Execution bounds",
    "",
    "- Maximum requests: " + context.bounds.maxRequests,
    "- Maximum duration in milliseconds: " + context.bounds.maxDurationMs,
    "- Maximum concurrency: " + context.bounds.maxConcurrency,
    "",
  ];
  return { context, markdown: lines.join("\n") };
}
