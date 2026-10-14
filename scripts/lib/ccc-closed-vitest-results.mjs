/*
FNXC:CccPlanningProof 2026-10-14-08:45:
Closed-result policy for the request-to-code planning proof runner (card P0; CONTRACT-v2 section 2.20, ADR D Q1). It re-implements the policy of `scripts/run-ccc-pg-proof.mjs` (assertionName, assertClosedNamedResults, assertMachineResultJson, assertMachineResultInventory), which cannot be imported because that file runs top-level side effects on import and is frozen evidence. Everything here is pure: it takes parsed reports and file text and throws a coded `CccPlanningProofError`, so every branch is unit-testable without running vitest.

Two closure modes exist and a card chooses per command (carry-forward P0 note; ADR D says "targeted is file-closed", contract rule 6 says "closed names"):
- closure "names": the exact set of expected test names, built as ancestorTitles joined by " > " plus the title (the join `scripts/run-ccc-pg-proof.mjs:837` uses; vitest's own `fullName` joins with spaces and is never used). No missing, extra, duplicate, skipped, pending, todo or failed name, and numPassedTests equals the list length. Use it for suites a card owns, so a rename, a deletion or a quiet skip fails the run. The `offline` mode accepts only this closure.
- closure "files": every listed file must execute at least one test, every test in it must pass, no unlisted file may appear, and nothing may be skipped, pending, todo or failed. Use it for large pre-existing suites whose names the card does not own (for example `ccc-prd-intake.test.ts`), where only "it still ran and passed" is the claim. Allowed in `targeted` and `ci-linux`.
The two modes never mix inside one command; a command that wants both lists the same file twice, once per closure, under two ids.

This module is also usable as a node:test reporter (`node --test --test-reporter=<this file>`): its default export writes a vitest-shaped JSON report, so `node-test` commands close with the same functions.
*/
import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * @typedef {{ ancestorTitles?: string[], title: string, status: "passed" | "failed" | "pending" | "skipped" | "todo" }} VitestAssertion
 * @typedef {{ numTotalTests: number, numPassedTests: number, numFailedTests: number, numPendingTests: number, numTodoTests: number, testResults: { name: string, status?: string, assertionResults?: VitestAssertion[] }[] }} VitestJsonReport
 * @typedef {Readonly<{
 *   id: string,
 *   packageFilter: "@fusion/core" | "@fusion/engine" | "@runfusion/fusion" | "@fusion/dashboard" | "node-test",
 *   project: "engine-default" | "engine-slow" | "dashboard-api-quality-backfill" | null,
 *   config: string | null,
 *   files: readonly string[],
 *   closure: "names" | "files",
 *   expectedNames: readonly string[],
 *   platform: "any" | "darwin",
 *   needsPostgres: boolean,
 *   timeoutMs: number,
 * }>} ClosedSuiteCommand
 */

export const CCC_PLANNING_RESULTS_NOT_CLOSED = "CCC_PLANNING_PROOF_RESULTS_NOT_CLOSED";
export const CCC_PLANNING_INVENTORY_INVALID = "CCC_PLANNING_PROOF_INVENTORY_INVALID";

export class CccPlanningProofError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "CccPlanningProofError";
    this.code = code;
  }
}

/**
 * Where each package filter runs and which vitest projects it may pin. The contract's union is closed, so a pairing that is not listed here is a mistake (an engine run without a pinned project would trigger the `engine-core` build-on-setup; a core run with `--project=engine-default` would fail).
 * `node-test` files are repo-relative; every other package's files are relative to its directory.
 */
export const CCC_PLANNING_PACKAGE_DIRS = Object.freeze({
  "@fusion/core": "packages/core",
  "@fusion/engine": "packages/engine",
  "@runfusion/fusion": "packages/cli",
  "@fusion/dashboard": "packages/dashboard",
  "node-test": ".",
});

export const CCC_PLANNING_PACKAGE_PROJECTS = Object.freeze({
  "@fusion/core": Object.freeze([null]),
  "@fusion/engine": Object.freeze(["engine-default", "engine-slow"]),
  "@runfusion/fusion": Object.freeze([null]),
  "@fusion/dashboard": Object.freeze(["dashboard-api-quality-backfill"]),
  "node-test": Object.freeze([null]),
});

const COMMAND_KEYS = Object.freeze([
  "id",
  "packageFilter",
  "project",
  "config",
  "files",
  "closure",
  "expectedNames",
  "platform",
  "needsPostgres",
  "timeoutMs",
]);
const MAX_COMMAND_TIMEOUT_MS = 3_600_000;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function notClosed(message) {
  return new CccPlanningProofError(CCC_PLANNING_RESULTS_NOT_CLOSED, message);
}

function inventoryInvalid(command, message) {
  const id = command && typeof command === "object" && typeof command.id === "string" ? command.id : "command";
  return new CccPlanningProofError(CCC_PLANNING_INVENTORY_INVALID, `${id}: ${message}`);
}

/**
 * The name a result is closed against: ancestor titles and the title joined by " > ".
 * @param {VitestAssertion} assertion
 */
export function assertionName(assertion) {
  return [...(assertion.ancestorTitles ?? []), assertion.title].join(" > ");
}

/**
 * Exact-set check of passed names.
 * @param {readonly string[]} expectedNames
 * @param {readonly VitestAssertion[]} assertions
 * @param {string} label
 */
export function assertClosedNamedResults(expectedNames, assertions, label) {
  const expected = new Set(expectedNames);
  if (expected.size !== expectedNames.length) throw notClosed(`${label}: expected-name list contains duplicates`);
  const seen = new Map();
  for (const assertion of assertions) {
    const name = assertionName(assertion);
    if (!expected.has(name)) throw notClosed(`${label}: unexpected named test: ${name}`);
    seen.set(name, (seen.get(name) ?? 0) + 1);
    if (assertion.status !== "passed") throw notClosed(`${label}: ${name} is ${assertion.status}`);
  }
  for (const name of expectedNames) {
    const count = seen.get(name) ?? 0;
    if (count === 0) throw notClosed(`${label}: missing named test: ${name}`);
    if (count !== 1) throw notClosed(`${label}: duplicate named test: ${name}`);
  }
}

/**
 * Counts by outcome, computed from the assertions themselves rather than from the reporter's summary counters, so a counter that lies cannot hide a skipped test. "skipped" folds vitest's skipped, pending and todo statuses together: all three mean the test did not run.
 * @param {VitestJsonReport} report
 */
export function tallyVitestReport(report) {
  const results = Array.isArray(report?.testResults) ? report.testResults : [];
  const tally = { total: 0, passed: 0, failed: 0, skipped: 0, files: results.length };
  for (const result of results) {
    for (const assertion of result?.assertionResults ?? []) {
      tally.total += 1;
      if (assertion.status === "passed") tally.passed += 1;
      else if (assertion.status === "failed") tally.failed += 1;
      else tally.skipped += 1;
    }
  }
  return tally;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function tryRealpath(value) {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

/**
 * A report names files by absolute path. Resolve it against the package root, and also against the real paths of both (macOS reports /private/var for a /var scratch directory), and take the first answer that stays inside the package.
 */
function relativeReportPath(reportedName, packageRoot) {
  const normalized = toPosix(String(reportedName));
  if (packageRoot === undefined) return normalized;
  for (const root of [packageRoot, tryRealpath(packageRoot)]) {
    for (const name of [String(reportedName), tryRealpath(String(reportedName))]) {
      const relative = toPosix(path.relative(root, name));
      if (relative !== "" && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative)) return relative;
    }
  }
  return normalized;
}

function matchListedFile(reportedName, files, packageRoot) {
  const relative = relativeReportPath(reportedName, packageRoot);
  if (packageRoot !== undefined) return files.includes(relative) ? relative : null;
  return files.find((file) => relative === file || relative.endsWith(`/${file}`)) ?? null;
}

function assertReportShape(report, label) {
  if (!report || typeof report !== "object" || !Array.isArray(report.testResults)) {
    throw notClosed(`${label}: machine result has no testResults array`);
  }
  for (const key of ["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests"]) {
    if (!Number.isInteger(report[key]) || report[key] < 0) throw notClosed(`${label}: machine result counter ${key} is not a non-negative integer`);
  }
}

/**
 * Checks that hold for both closures: the reporter's counters agree with its assertions and report nothing but passes, no file failed outside a test, and the files in the report are exactly the listed files.
 * @returns {{ assertions: VitestAssertion[], tally: ReturnType<typeof tallyVitestReport>, perFile: Map<string, VitestAssertion[]> }}
 */
function assertReportBasics(command, report, options) {
  const label = command.id;
  assertReportShape(report, label);
  if (report.numFailedTests !== 0 || report.numPendingTests !== 0 || report.numTodoTests !== 0) {
    throw notClosed(`${label}: failed, skipped, pending or todo tests reported (failed ${report.numFailedTests}, pending ${report.numPendingTests}, todo ${report.numTodoTests})`);
  }
  const tally = tallyVitestReport(report);
  if (tally.failed !== 0 || tally.skipped !== 0) {
    throw notClosed(`${label}: ${tally.failed} failed and ${tally.skipped} skipped, pending or todo assertions despite clean reporter counters`);
  }
  if (report.numPassedTests !== tally.passed || report.numTotalTests !== tally.total) {
    throw notClosed(`${label}: reporter counters (total ${report.numTotalTests}, passed ${report.numPassedTests}) disagree with ${tally.total} assertions (${tally.passed} passed)`);
  }
  const perFile = new Map(command.files.map((file) => [file, []]));
  const seenFiles = new Set();
  for (const result of report.testResults) {
    const listed = matchListedFile(result?.name ?? "", command.files, options?.packageRoot);
    if (listed === null) throw notClosed(`${label}: report holds an unlisted file: ${result?.name}`);
    if (seenFiles.has(listed)) throw notClosed(`${label}: report holds ${listed} more than once`);
    seenFiles.add(listed);
    if (result.status === "failed") throw notClosed(`${label}: ${listed} failed outside a named test (load, syntax or suite error)`);
    perFile.set(listed, [...(result.assertionResults ?? [])]);
  }
  for (const file of command.files) {
    if (!seenFiles.has(file)) throw notClosed(`${label}: listed file missing from the report: ${file}`);
  }
  return { assertions: report.testResults.flatMap((result) => result.assertionResults ?? []), tally, perFile };
}

/**
 * File-closed check: every listed file executed at least one test, everything passed, nothing unlisted ran.
 * @param {ClosedSuiteCommand} command
 * @param {VitestJsonReport} report
 * @param {{ packageRoot?: string }} [options] when given, report paths are made relative to it before matching
 * @returns {{ files: number, executed: number }}
 */
export function assertFileClosedResults(command, report, options) {
  const { tally, perFile } = assertReportBasics(command, report, options);
  for (const [file, assertions] of perFile) {
    if (assertions.length === 0) throw notClosed(`${command.id}: listed file executed 0 tests: ${file}`);
  }
  return { files: command.files.length, executed: tally.passed };
}

/**
 * Name-closed check, or file-closed check, by the command's own closure.
 * @param {VitestJsonReport} report
 * @param {ClosedSuiteCommand} command
 * @param {{ packageRoot?: string }} [options]
 * @returns {{ passed: number, skipped: number, failed: number, files: number }}
 */
export function assertMachineResultJson(report, command, options) {
  if (command.closure === "files") {
    const { executed, files } = assertFileClosedResults(command, report, options);
    return { passed: executed, skipped: 0, failed: 0, files };
  }
  const { assertions, tally } = assertReportBasics(command, report, options);
  if (tally.passed === 0) throw notClosed(`${command.id}: empty machine result`);
  if (report.numPassedTests !== command.expectedNames.length) {
    throw notClosed(`${command.id}: numPassedTests ${report.numPassedTests} does not match the closed expected-name inventory count ${command.expectedNames.length}`);
  }
  assertClosedNamedResults(command.expectedNames, assertions, command.id);
  return { passed: tally.passed, skipped: 0, failed: 0, files: command.files.length };
}

function assertPackageRelativeFile(command, file) {
  if (typeof file !== "string" || file.length === 0) throw inventoryInvalid(command, "files must be non-empty strings");
  if (file.startsWith("-")) throw inventoryInvalid(command, `file looks like a command-line flag: ${file}`);
  if (path.isAbsolute(file) || file.startsWith("/")) throw inventoryInvalid(command, `file must be package-relative, not absolute: ${file}`);
  if (file.includes("\\") || file.includes("\0")) throw inventoryInvalid(command, `file holds a backslash or NUL: ${JSON.stringify(file)}`);
  if (path.posix.normalize(file) !== file || file.split("/").includes("..")) {
    throw inventoryInvalid(command, `file must be a normalized path with no '.' or '..' segment: ${file}`);
  }
  if (!TEST_FILE_PATTERN.test(file)) throw inventoryInvalid(command, `file is not a *.test.* or *.spec.* file: ${file}`);
}

/**
 * Shape and policy check of one inventory command. Closed on purpose: unknown keys are refused, so a typo such as `needsPg` (CONTRACT-v2 spells it that way in prose; ADR D Q1 and every shipped card use `needsPostgres`) cannot silently default.
 * @param {unknown} command
 */
export function assertMachineResultInventory(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) throw inventoryInvalid(command, "command must be an object");
  const value = /** @type {Record<string, unknown>} */ (command);
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !COMMAND_KEYS.includes(key));
  if (unknown.length > 0) {
    const hint = unknown.includes("needsPg") ? " (the field is needsPostgres)" : "";
    throw inventoryInvalid(command, `unknown command key(s): ${unknown.join(", ")}${hint}`);
  }
  const missing = COMMAND_KEYS.filter((key) => !(key in value) || value[key] === undefined);
  if (missing.length > 0) throw inventoryInvalid(command, `missing command key(s): ${missing.join(", ")}`);

  const { id, packageFilter, project, config, files, closure, expectedNames, platform, needsPostgres, timeoutMs } = value;
  if (typeof id !== "string" || !/^[a-z0-9-]+$/.test(id)) throw inventoryInvalid(command, "id must match /^[a-z0-9-]+$/");
  if (typeof packageFilter !== "string" || !Object.hasOwn(CCC_PLANNING_PACKAGE_DIRS, packageFilter)) {
    throw inventoryInvalid(command, `unknown packageFilter: ${String(packageFilter)}`);
  }
  if (!CCC_PLANNING_PACKAGE_PROJECTS[packageFilter].includes(project)) {
    throw inventoryInvalid(command, `project ${JSON.stringify(project)} is not admitted for ${packageFilter} (allowed: ${CCC_PLANNING_PACKAGE_PROJECTS[packageFilter].map((p) => JSON.stringify(p)).join(", ")})`);
  }
  if (config !== null) {
    if (typeof config !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.[cm]?[jt]s$/.test(config)) {
      throw inventoryInvalid(command, `config must be null or a bare vitest config file name, got ${JSON.stringify(config)}`);
    }
    if (packageFilter === "node-test") throw inventoryInvalid(command, "node-test commands take no config");
  }
  if (!Array.isArray(files) || files.length === 0) throw inventoryInvalid(command, "files must be a non-empty array");
  for (const file of files) assertPackageRelativeFile(command, file);
  if (new Set(files).size !== files.length) throw inventoryInvalid(command, "files contains duplicates");
  if (closure !== "names" && closure !== "files") throw inventoryInvalid(command, `closure must be "names" or "files", got ${JSON.stringify(closure)}`);
  if (!Array.isArray(expectedNames) || expectedNames.some((name) => typeof name !== "string" || name.length === 0)) {
    throw inventoryInvalid(command, "expectedNames must be an array of non-empty strings");
  }
  if (closure === "names") {
    if (expectedNames.length === 0) throw inventoryInvalid(command, "a names closure requires a non-empty expected-name inventory");
    if (new Set(expectedNames).size !== expectedNames.length) throw inventoryInvalid(command, "expected-name inventory contains duplicates");
  } else if (expectedNames.length !== 0) {
    throw inventoryInvalid(command, "a files closure must have an empty expectedNames list");
  }
  if (platform !== "any" && platform !== "darwin") throw inventoryInvalid(command, `platform must be "any" or "darwin", got ${JSON.stringify(platform)}`);
  if (typeof needsPostgres !== "boolean") throw inventoryInvalid(command, "needsPostgres must be a boolean");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    throw inventoryInvalid(command, `timeoutMs must be a positive integer of at most ${MAX_COMMAND_TIMEOUT_MS}`);
  }
}

/*
FNXC:CccPlanningProof 2026-10-14-09:32:
Errata E1-7. Every index in this lexer is a UTF-16 code unit, so the output buffer is `text.split("")`. `Array.from(text)` splits by code point, counts an emoji as one slot while `text.length` and every `index` count two, and so shifts the blanking after the first character outside the Basic Multilingual Plane: a real skip hid behind an emoji and a legal Darwin skipIf after one was refused. Never switch this buffer back to code points.
*/
/**
 * Replaces comments, string literals, template-literal text and regular-expression literals with spaces (newlines kept), so the skip patterns below only ever see code. Fails closed: text it cannot read to the end throws instead of passing quietly, because a scanner that gives up midway could hide a real skip.
 * With `keepLiterals`, string and template text stays visible (comments and regular expressions are still blanked): the PostgreSQL skip flag rule needs it, because `process.env["NAME"]` reads an environment variable through a string.
 * @param {string} text
 * @param {string} file
 * @param {{ keepLiterals?: boolean }} [options]
 * @returns {string}
 */
function maskNonCode(text, file, options = {}) {
  const keepLiterals = options.keepLiterals === true;
  const out = text.split("");
  const length = text.length;
  const REGEX_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
  const REGEX_PRECEDERS = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
  let index = 0;

  const fail = (what, at) => {
    const line = text.slice(0, at).split("\n").length;
    throw new CccPlanningProofError(CCC_PLANNING_INVENTORY_INVALID, `${file}:${line}: static skip policy cannot read the file (${what}); fix the file or its syntax so the policy can prove it holds no skip form`);
  };
  const blank = (from, to) => {
    for (let at = from; at < to; at += 1) if (out[at] !== "\n") out[at] = " ";
  };
  const blankLiteral = (from, to) => {
    if (!keepLiterals) blank(from, to);
  };

  function scanTemplate() {
    const start = index;
    index += 1;
    while (index < length) {
      const char = text[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "`") {
        index += 1;
        blankLiteral(start, index);
        return;
      }
      if (char === "$" && text[index + 1] === "{") {
        blankLiteral(start, index);
        index += 2;
        scanCode(true);
        // scanCode returns just past the closing brace; resume blanking template text from there.
        return scanTemplateRest(index);
      }
      index += 1;
    }
    fail("unterminated template literal", start);
  }

  function scanTemplateRest(from) {
    const start = from;
    while (index < length) {
      const char = text[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "`") {
        index += 1;
        blankLiteral(start, index);
        return;
      }
      if (char === "$" && text[index + 1] === "{") {
        blankLiteral(start, index);
        index += 2;
        scanCode(true);
        return scanTemplateRest(index);
      }
      index += 1;
    }
    fail("unterminated template literal", start);
  }

  function scanQuoted(quote) {
    const start = index;
    index += 1;
    while (index < length) {
      const char = text[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "\n") fail("unterminated string literal", start);
      if (char === quote) {
        index += 1;
        blankLiteral(start, index);
        return;
      }
      index += 1;
    }
    fail("unterminated string literal", start);
  }

  function scanRegex() {
    const start = index;
    index += 1;
    let inClass = false;
    while (index < length) {
      const char = text[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "\n") fail("unterminated regular expression", start);
      if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) {
        index += 1;
        while (index < length && /[A-Za-z]/.test(text[index])) index += 1;
        blank(start, index);
        return;
      }
      index += 1;
    }
    fail("unterminated regular expression", start);
  }

  function scanCode(stopAtBrace) {
    let depth = 0;
    let previous = "";
    let previousWord = "";
    while (index < length) {
      const char = text[index];
      const next = text[index + 1];
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        index += 1;
        continue;
      }
      if (char === "/" && next === "/") {
        const start = index;
        while (index < length && text[index] !== "\n") index += 1;
        blank(start, index);
        continue;
      }
      if (char === "/" && next === "*") {
        const start = index;
        const end = text.indexOf("*/", index + 2);
        if (end === -1) fail("unterminated block comment", start);
        index = end + 2;
        blank(start, index);
        continue;
      }
      if (char === "'" || char === '"') {
        scanQuoted(char);
        previous = '"';
        previousWord = "";
        continue;
      }
      if (char === "`") {
        scanTemplate();
        previous = '"';
        previousWord = "";
        continue;
      }
      if (char === "/") {
        if (REGEX_PRECEDERS.has(previous) || REGEX_KEYWORDS.has(previousWord)) {
          scanRegex();
          previous = '"';
          previousWord = "";
        } else {
          index += 1;
          previous = "/";
          previousWord = "";
        }
        continue;
      }
      if (stopAtBrace) {
        if (char === "{") depth += 1;
        else if (char === "}") {
          if (depth === 0) {
            index += 1;
            return;
          }
          depth -= 1;
        }
      }
      if (/[A-Za-z0-9_$]/.test(char)) {
        const start = index;
        while (index < length && /[A-Za-z0-9_$]/.test(text[index])) index += 1;
        previousWord = text.slice(start, index);
        previous = "a";
        continue;
      }
      previous = char;
      previousWord = "";
      index += 1;
    }
    if (stopAtBrace) fail("unterminated template expression", index);
  }

  scanCode(false);
  return out.join("");
}

const DARWIN_SKIP_IF = /^\.skipIf\(\s*process\.platform\s*!==\s*(["'])darwin\1\s*\)/;

/*
FNXC:CccPlanningProof 2026-10-14-09:32:
Errata E1-2 and E1-2b. The runner sets the PostgreSQL skip flag in the environment of every command that does not declare needsPostgres, so a test file listed under such a command that READS the flag could return early and pass without testing anything. The policy therefore refuses the flag name anywhere in such a file except a comment (a comment cannot read an environment): in code, in a string such as `process.env["NAME"]`, in a template. A needsPostgres file may name the flag, because the runner never sets it for those commands, and may use exactly one skip-shaped form, the existing idiom `const pgDescribe = PG_AVAILABLE ? describe : describe.skip;` (packages/core/src/__tests__/postgres/schema-applier.test.ts:92-97). Its runtime closure (zero skipped, every expected name passed) is the backstop.
*/
const PG_SKIP_FLAG_NAME = "FUSION_PG_TEST_SKIP";
const PG_DESCRIBE_IDIOM = /\bconst\s+pgDescribe\s*=\s*PG_AVAILABLE\s*\?\s*describe\s*:\s*describe\s*\.\s*skip\s*;/g;
/** A skip or todo modifier read off a test-runner API without being called (`describe.skip` as a value, `it.concurrent.skip`, a tagged template). A call is caught by the first rule. */
const BARE_SKIP_REFERENCE = /\b(?:it|test|describe|suite|bench)(?:\s*\.\s*(?:concurrent|sequential|only|each|fails|shuffle|random))*\s*\.\s*(skip|todo)\b/g;

/**
 * Static skip policy for a planning test file (contract section 2.20, errata E1-2/E1-2b/E1-7): the only allowed skip form is `skipIf(process.platform !== "darwin")`, and only in a file tagged `platform: "darwin"`; `pgDescribe` (which collapses to `describe.skip` when no server answers) only in a file tagged `needsPostgres`, where the single idiom above is also allowed; the PostgreSQL skip flag name only in a file tagged `needsPostgres` (or in a comment). Skip-shaped text inside comments, strings, template text and regular expressions is ignored, except for the flag name, which is also refused inside strings and templates.
 * @param {string} fileText
 * @param {{ file: string, platform: "any" | "darwin", needsPostgres: boolean }} input
 */
export function assertCccPlanningSuiteSkipPolicy(fileText, input) {
  const code = maskNonCode(fileText, input.file);
  const lineOf = (at) => fileText.slice(0, at).split("\n").length;
  const refuse = (at, reason) => {
    throw new CccPlanningProofError(CCC_PLANNING_INVENTORY_INVALID, `${input.file}:${lineOf(at)}: ${reason}`);
  };
  const allowedIdioms = input.needsPostgres ? [...code.matchAll(PG_DESCRIBE_IDIOM)].map((match) => [match.index, match.index + match[0].length]) : [];
  const insideAllowedIdiom = (at) => allowedIdioms.some(([from, to]) => at >= from && at < to);

  for (const match of code.matchAll(/\.\s*(skip|todo)\s*(?:\(|\.\s*each\b|\.\s*(?:concurrent|sequential)\b)/g)) {
    if (insideAllowedIdiom(match.index)) continue;
    refuse(match.index, `.${match[1]}() is not an allowed skip form in a planning suite`);
  }
  for (const match of code.matchAll(BARE_SKIP_REFERENCE)) {
    if (insideAllowedIdiom(match.index)) continue;
    refuse(
      match.index,
      `a bare .${match[1]} reference is not an allowed skip form in a planning suite${input.needsPostgres ? " (only 'const pgDescribe = PG_AVAILABLE ? describe : describe.skip;' is allowed)" : ""}`,
    );
  }
  for (const match of code.matchAll(/\b(skip|todo)\s*:\s*(?!false\b)/g)) {
    refuse(match.index, `a '${match[1]}' test option is not an allowed skip form in a planning suite`);
  }
  for (const match of code.matchAll(/\b(xit|xdescribe|xtest)\s*\(/g)) {
    refuse(match.index, `${match[1]}() disables tests and is not allowed in a planning suite`);
  }
  for (const match of code.matchAll(/\.\s*runIf\s*\(/g)) {
    refuse(match.index, ".runIf() conditionally selects tests and is not allowed in a planning suite");
  }
  for (const match of code.matchAll(/\.\s*skipIf\s*\(/g)) {
    const form = DARWIN_SKIP_IF.exec(fileText.slice(match.index));
    if (input.platform === "darwin" && form !== null) continue;
    refuse(
      match.index,
      input.platform === "darwin"
        ? '.skipIf() may only be skipIf(process.platform !== "darwin")'
        : '.skipIf() is only allowed as skipIf(process.platform !== "darwin") in a file tagged platform "darwin"',
    );
  }
  if (!input.needsPostgres) {
    for (const match of code.matchAll(/\bpgDescribe\b/g)) {
      refuse(match.index, "pgDescribe collapses to describe.skip without a server and is only allowed in a file tagged needsPostgres");
    }
    const withLiterals = maskNonCode(fileText, input.file, { keepLiterals: true });
    const flagAt = withLiterals.indexOf(PG_SKIP_FLAG_NAME);
    if (flagAt !== -1) {
      refuse(flagAt, `${PG_SKIP_FLAG_NAME} is set by the runner for every command without needsPostgres, so a test that reads it can pass without testing anything; the name is only allowed in a file tagged needsPostgres or in a comment`);
    }
  }
}

/**
 * node:test reporter that writes the same JSON shape vitest's json reporter does, so a `node-test` command is closed by the same functions. Suites are not assertions; a suite that failed only because a subtest failed is not counted twice; a suite that failed for its own reason, and a file that failed outside any test, are.
 * Usage: `node --test --test-reporter=<this file> --test-reporter-destination=<out.json> <test files>`.
 */
export default async function* cccPlanningNodeTestReporter(source) {
  const files = new Map();
  const stacks = new Map();
  // node reports the same file as /var/... on its enqueue event and /private/var/... on its test events; key by real path so one file is one entry.
  const canonical = new Map();
  const canonicalFile = (file) => {
    if (!canonical.has(file)) canonical.set(file, tryRealpath(file));
    return canonical.get(file);
  };
  const fileEntry = (file) => {
    if (!files.has(file)) files.set(file, { name: file, status: "passed", assertionResults: [] });
    return files.get(file);
  };
  const stackFor = (file) => {
    if (!stacks.has(file)) stacks.set(file, []);
    return stacks.get(file);
  };

  for await (const event of source) {
    const data = event.data;
    if (!data || typeof data.file !== "string") continue;
    const file = canonicalFile(data.file);
    const isFileLevel = data.nesting === 0 && canonicalFile(String(data.name)) === file;
    if (event.type === "test:enqueue" && isFileLevel) {
      fileEntry(file);
    } else if (event.type === "test:start") {
      const stack = stackFor(file);
      stack[data.nesting] = data.name;
      stack.length = data.nesting + 1;
    } else if (event.type === "test:pass" || event.type === "test:fail") {
      const entry = fileEntry(file);
      const isSuite = data.details?.type === "suite";
      if (isFileLevel) {
        if (event.type === "test:fail") entry.status = "failed";
        continue;
      }
      if (isSuite && (event.type === "test:pass" || data.details?.error?.failureType === "subtestsFailed")) continue;
      const ancestorTitles = stackFor(file).slice(0, data.nesting);
      let status = "passed";
      if (event.type === "test:fail") status = "failed";
      else if (data.skip) status = "skipped";
      else if (data.todo) status = "todo";
      const assertion = { ancestorTitles, title: data.name, status };
      if (status === "failed") {
        const cause = data.details?.error?.cause ?? data.details?.error;
        assertion.failureMessages = [String(cause?.message ?? "test failed").slice(0, 2000)];
      }
      entry.assertionResults.push(assertion);
    }
  }

  const testResults = [...files.values()];
  const all = testResults.flatMap((result) => result.assertionResults);
  const count = (...statuses) => all.filter((assertion) => statuses.includes(assertion.status)).length;
  for (const result of testResults) {
    if (result.assertionResults.some((assertion) => assertion.status === "failed")) result.status = "failed";
  }
  yield JSON.stringify({
    numTotalTests: all.length,
    numPassedTests: count("passed"),
    numFailedTests: count("failed"),
    numPendingTests: count("skipped", "pending"),
    numTodoTests: count("todo"),
    testResults,
  });
}
