import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { compareCccPrdCodeUnits } from "@fusion/core";
import type { CccConfinedFsOperations } from "../agent-runtime.js";
import { cccConfinedWriteRefusal } from "./confined-shell.js";
import {
  CccConfinedPathRefusedError,
  cccConfinedGlobMatches,
  cccConfinedValidatedDeniedNames,
  markCccConfinedTool,
} from "./confined-fs-tools.js";

/*
FNXC:CccConfinedGrepTool 2026-10-14-21:10:
Card C2 (D11, CONTRACT-v3 section 2.13, verify-v2 item 47, errata E2-7 and E4-10). A planning session's grep is this Fusion tool, never Pi's: Pi's grep runs rg, which reads every file under the search path whatever the confinement says, and needs a binary the sealed host may not have. It takes Pi's parameters, walks only through the confined ls and read operations, and spawns nothing. Its own path filter calls X1's cccConfinedWriteRefusal with the read roots as the predicate's roots, so a read root is never "outside the write roots" and only the .git and denied-name checks apply; the denied names are validated first because the predicate throws a plain Error on an invalid one. The signature has no working directory, so a relative or omitted path resolves against the first read root.
*/

export type CccConfinedGrepLimits = Readonly<{ maxFiles: number; maxBytesPerFile: number; maxMatches: number }>;

export const CCC_CONFINED_GREP_DEFAULT_LIMITS: CccConfinedGrepLimits = Object.freeze({
  maxFiles: 10_000,
  maxBytesPerFile: 1024 * 1024,
  maxMatches: 1_000,
});

const DEFAULT_MATCH_LIMIT = 100;
const MAX_LINE_LENGTH = 500;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_WALK_DEPTH = 64;
const BINARY_PROBE_BYTES = 8_000;

type GrepParams = {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
};

function grepParameters() {
  return Type.Object({
    pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
    path: Type.Optional(Type.String({ description: "Directory or file to search (default: the first read root)" })),
    glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
    literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
    context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
  });
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`confined grep ${label} must be a positive integer`);
  }
  return value;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function truncateLine(line: string): string {
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}... [truncated]` : line;
}

function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_PROBE_BYTES);
  for (let index = 0; index < end; index += 1) if (bytes[index] === 0) return true;
  return false;
}

export function createCccConfinedGrepTool(i: Readonly<{ fs: CccConfinedFsOperations; readRoots: readonly string[];
  deniedNames: readonly string[]; limits: Readonly<{ maxFiles: number; maxBytesPerFile: number; maxMatches: number }> }>): ToolDefinition {
  const deniedNames = cccConfinedValidatedDeniedNames(i.deniedNames);
  if (!Array.isArray(i.readRoots) || i.readRoots.length === 0) throw new TypeError("confined grep needs at least one read root");
  for (const root of i.readRoots) {
    if (typeof root !== "string" || !isAbsolute(root)) throw new TypeError("confined grep read roots must be absolute paths");
  }
  const readRoots = Object.freeze([...i.readRoots]);
  const limits = Object.freeze({
    maxFiles: positiveInteger(i.limits?.maxFiles, "limits.maxFiles"),
    maxBytesPerFile: positiveInteger(i.limits?.maxBytesPerFile, "limits.maxBytesPerFile"),
    maxMatches: positiveInteger(i.limits?.maxMatches, "limits.maxMatches"),
  });
  const fs = i.fs;
  const base = readRoots[0]!;
  // E2-7 and E4-10: the read roots are the predicate's roots, so only the .git and denied-name checks can refuse inside them.
  const refusal = (path: string) => cccConfinedWriteRefusal({ path, writeRoots: readRoots, deniedNames });

  const execute = async (_toolCallId: string, params: GrepParams, signal?: AbortSignal) => {
    if (typeof params?.pattern !== "string") throw new Error("grep pattern must be a string");
    const rawPath = typeof params.path === "string" && params.path.trim() !== "" ? params.path : undefined;
    const searchPath = rawPath === undefined ? base : isAbsolute(rawPath) ? resolve(rawPath) : resolve(base, rawPath);
    const refused = refusal(searchPath);
    if (refused !== null) {
      throw new CccConfinedPathRefusedError(refused === "outside-write-roots" ? "outside-read-roots" : refused, searchPath);
    }
    if (!(await fs.ls.exists(searchPath))) throw new Error(`Path not found: ${searchPath}`);
    const isDirectory = (await fs.ls.stat(searchPath)).isDirectory();

    let regex: RegExp;
    try {
      regex = new RegExp(params.literal === true ? escapeRegExp(params.pattern) : params.pattern, params.ignoreCase === true ? "i" : "");
    } catch (error) {
      throw new Error(`grep pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
    const requested = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.floor(params.limit) : DEFAULT_MATCH_LIMIT;
    const matchLimit = Math.min(Math.max(1, requested), limits.maxMatches);
    const contextLines = typeof params.context === "number" && params.context > 0 ? Math.floor(params.context) : 0;
    const globPattern = typeof params.glob === "string" && params.glob !== "" ? params.glob : undefined;

    const files: string[] = [];
    let fileLimitReached = false;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_WALK_DEPTH) return;
      if (signal?.aborted) throw new Error("Operation aborted");
      let names: string[];
      try {
        names = [...(await fs.ls.readdir(directory))].sort(compareCccPrdCodeUnits);
      } catch {
        return;
      }
      for (const name of names) {
        if (files.length >= limits.maxFiles) {
          fileLimitReached = true;
          return;
        }
        const child = join(directory, name);
        if (refusal(child) !== null) continue;
        let childIsDirectory: boolean;
        try {
          childIsDirectory = (await fs.ls.stat(child)).isDirectory();
        } catch {
          continue;
        }
        if (childIsDirectory) {
          if (name !== "node_modules") await walk(child, depth + 1);
          continue;
        }
        if (globPattern !== undefined && !cccConfinedGlobMatches(relative(searchPath, child), globPattern)) continue;
        files.push(child);
      }
    };
    if (isDirectory) await walk(searchPath, 0);
    else files.push(searchPath);

    const formatPath = (file: string): string => {
      if (isDirectory) {
        const relativePath = relative(searchPath, file);
        if (relativePath !== "" && !relativePath.startsWith("..")) return relativePath.split(sep).join("/");
      }
      return basename(file);
    };
    const output: string[] = [];
    let matches = 0;
    for (const file of files) {
      if (matches >= matchLimit) break;
      if (signal?.aborted) throw new Error("Operation aborted");
      let bytes: Uint8Array;
      try {
        bytes = await fs.read.readFile(file);
      } catch {
        continue;
      }
      if (bytes.length > limits.maxBytesPerFile || isBinary(bytes)) continue;
      const lines = Buffer.from(bytes).toString("utf8").split(/\r\n|\r|\n/u);
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      const shown = formatPath(file);
      for (let index = 0; index < lines.length && matches < matchLimit; index += 1) {
        if (!regex.test(lines[index]!)) continue;
        matches += 1;
        const first = Math.max(0, index - contextLines);
        const last = Math.min(lines.length - 1, index + contextLines);
        for (let line = first; line <= last; line += 1) {
          const separator = line === index ? ":" : "-";
          output.push(`${shown}${separator}${line + 1}${separator} ${truncateLine(lines[line]!)}`);
        }
      }
    }
    if (matches === 0) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
    let text = output.join("\n");
    const notices: string[] = [];
    if (matches >= matchLimit) notices.push(`${matchLimit} matches limit reached. Use limit=${matchLimit * 2} for more, or refine pattern`);
    if (fileLimitReached) notices.push(`${limits.maxFiles} files limit reached`);
    if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) {
      text = Buffer.from(text, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
      notices.push(`${MAX_OUTPUT_BYTES / 1024}KB output limit reached`);
    }
    if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;
    return { content: [{ type: "text" as const, text }], details: { matches, matchLimitReached: matches >= matchLimit } };
  };

  return markCccConfinedTool<ToolDefinition>({
    name: "grep",
    label: "grep",
    description: `Search file contents for a pattern inside this session's read roots. Returns matching lines with file paths and line numbers. Output is limited to ${DEFAULT_MATCH_LIMIT} matches by default. Long lines are truncated to ${MAX_LINE_LENGTH} chars.`,
    promptSnippet: "Search file contents for patterns",
    parameters: grepParameters(),
    execute: (toolCallId, params, signal) => execute(toolCallId, params as GrepParams, signal),
  });
}
