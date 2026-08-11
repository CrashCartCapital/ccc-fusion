#!/usr/bin/env node
/*
FNXC:DashboardBrowserSafeCore 2026-07-16-12:00:
Dashboard browser code must import core leaves through confirmed browser-safe @fusion/core subpaths.
The package-root Vite alias resolves to types.ts, while relative core/src imports bypass the
explicit subpath aliases and can pull core source into client build and typecheck graphs.
Keep the dated allowlist limited to leaves whose transitive dependencies were reviewed.
*/
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ALLOWLIST_PATH = "scripts/lib/dashboard-browser-safe-core-modules.json";
export const DASHBOARD_APP_ROOT = "packages/dashboard/app";
const CORE_SOURCE_ROOT = "packages/core/src";

function listTrackedTargets() {
  const result = spawnSync("git", ["ls-files", "--", DASHBOARD_APP_ROOT], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || "git ls-files failed");
  return result.stdout.split("\n").map((filePath) => filePath.trim()).filter((filePath) => {
    return /\.tsx?$/.test(filePath) && !/(?:^|\/)__tests__\/|\.test\.[^/]+$/.test(filePath);
  });
}

function loadAllowlist(path = ALLOWLIST_PATH) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(parsed.modules)) throw new Error(`${path} must contain a modules array`);
  return validateAllowlist(parsed.modules);
}

export function validateAllowlist(entries) {
  if (!Array.isArray(entries)) throw new Error(`${ALLOWLIST_PATH} allowlist must be an array`);
  return new Set(entries.map((entry, index) => {
    const prefix = `${ALLOWLIST_PATH} modules[${index}]`;
    if (!entry || typeof entry.module !== "string" || !entry.module.trim()) throw new Error(`${prefix} must include a non-empty module`);
    if (typeof entry.reason !== "string" || !entry.reason.trim()) throw new Error(`${prefix} must include a non-empty reason`);
    if (typeof entry.verifiedAt !== "string" || Number.isNaN(Date.parse(entry.verifiedAt))) throw new Error(`${prefix} must include an ISO-8601 verifiedAt date`);
    return entry.module;
  }));
}

function moduleFromSpecifier(specifier, filePath) {
  const withoutSuffix = specifier.replace(/[?#].*$/, "");
  const packagePrefix = "@fusion/core/";
  if (withoutSuffix.startsWith(packagePrefix)) {
    return { module: posix.normalize(withoutSuffix.slice(packagePrefix.length)), isRelative: false };
  }

  const normalized = posix.normalize(withoutSuffix);

  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    const coreRoot = posix.resolve(CORE_SOURCE_ROOT);
    const resolved = posix.resolve(posix.dirname(posix.resolve(filePath)), normalized);
    const relativeToCore = posix.relative(coreRoot, resolved);
    const isInsideCoreSource = relativeToCore === "" || (!relativeToCore.startsWith("../") && relativeToCore !== ".." && !posix.isAbsolute(relativeToCore));
    if (isInsideCoreSource) {
      return { module: relativeToCore.replace(/\.(?:[cm]?[jt]sx?)$/, ""), isRelative: true };
    }
  }

  return null;
}

function importIsTypeOnly(node) {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false;
  return clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((element) => element.isTypeOnly);
}

function exportIsTypeOnly(node) {
  if (node.isTypeOnly) return true;
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return false;
  return node.exportClause.elements.length > 0 && node.exportClause.elements.every((element) => element.isTypeOnly);
}

function literalText(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function lineAt(content, index) {
  const lineNumber = content.slice(0, index).split("\n").length;
  const start = content.lastIndexOf("\n", index - 1) + 1;
  const end = content.indexOf("\n", index);
  return { lineNumber, line: content.slice(start, end < 0 ? content.length : end).trim() };
}

function normalizeAllowlist(allowlist) {
  if (allowlist instanceof Set) return allowlist;
  if (Array.isArray(allowlist)) return new Set(allowlist);
  if (allowlist && Array.isArray(allowlist.modules)) return validateAllowlist(allowlist.modules);
  return loadAllowlist();
}

export function scanFileContent(content, filePath, { allowlist } = {}) {
  const safeModules = normalizeAllowlist(allowlist);
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, false, scriptKind);
  const matches = [];

  const record = (node, specifier, isTypeOnly) => {
    const coreImport = moduleFromSpecifier(specifier, filePath);
    if (!coreImport) return;
    const { module, isRelative } = coreImport;
    if (!isRelative && (safeModules.has(module) || isTypeOnly)) return;
    const { lineNumber, line } = lineAt(content, node.getStart(sourceFile));
    matches.push({ type: "node-only-core-import", filePath, lineNumber, line, specifier, module });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier !== null) record(node, specifier, importIsTypeOnly(node));
    } else if (ts.isExportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier !== null) record(node, specifier, exportIsTypeOnly(node));
    } else if (ts.isImportTypeNode(node)) {
      const specifier = ts.isLiteralTypeNode(node.argument) ? literalText(node.argument.literal) : null;
      if (specifier !== null) record(node, specifier, true);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = literalText(node.arguments[0]);
      if (specifier !== null) record(node, specifier, false);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return matches;
}

export function scanTrackedFiles(files = listTrackedTargets(), { allowlist, readFile = readFileSync } = {}) {
  const matches = [];
  for (const filePath of files) {
    let content;
    try { content = readFile(filePath, "utf8"); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue; throw error; }
    matches.push(...scanFileContent(content, filePath, { allowlist }));
  }
  return matches;
}

export function formatFailureMessage(matches) {
  return [
    "[check-no-node-only-core-imports-in-dashboard] found a relative core source import or a dashboard browser value import outside the browser-safe core allowlist.",
    "Dashboard browser code must use reviewed @fusion/core/<leaf> subpaths; use near-duplicate-canonical instead of near-duplicate.",
    `After verifying transitive dependencies contain no Node-only modules, add a dated entry to ${ALLOWLIST_PATH}.`,
    ...matches.map(({ filePath, lineNumber, line }) => `${filePath}:${lineNumber}: import: ${line}`),
  ].join("\n");
}

export function main() {
  const matches = scanTrackedFiles();
  if (!matches.length) return 0;
  console.error(formatFailureMessage(matches));
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
