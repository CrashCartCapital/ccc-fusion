import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
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

/*
FNXC:CccConfinedGrepTool 2026-10-14-22:34:
Card C2 repair 1 (review findings on the confined grep). A model's pattern runs in a worker thread, never on the engine thread: JavaScript regular expressions backtrack, so a pattern such as ^(\w+\s?)+$ on one 40-character line can take hours, and on the engine thread that froze every timer, abort, watchdog and lease heartbeat. A worker thread is not a process, so the grep still spawns nothing. The main thread reads each file through the confined read operation and sends its text to one worker per call; the worker returns the formatted match lines. The time the worker spends matching is bounded by matchDeadlineMs (default CCC_CONFINED_GREP_MATCH_DEADLINE_MS); on that deadline, or when the signal aborts, the worker is terminated and the call rejects with a short "grep timed out" or "Operation aborted" error. The walk enters each directory once, keyed by the device and inode of the stat it already makes (symlinks to an ancestor would otherwise make it exponential), and skips a directory whose stat has no identity. A file whose stat size exceeds maxBytesPerFile is skipped before it is read. A search that stops at maxFiles says so, also when nothing matched, so a truncated search never reads as proof that a symbol is absent.
*/

export type CccConfinedGrepLimits = Readonly<{ maxFiles: number; maxBytesPerFile: number; maxMatches: number }>;

export const CCC_CONFINED_GREP_DEFAULT_LIMITS: CccConfinedGrepLimits = Object.freeze({
  maxFiles: 10_000,
  maxBytesPerFile: 1024 * 1024,
  maxMatches: 1_000,
});

/** The worker time one grep call may spend matching before it is terminated. */
export const CCC_CONFINED_GREP_MATCH_DEADLINE_MS = 20_000;

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

function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_PROBE_BYTES);
  for (let index = 0; index < end; index += 1) if (bytes[index] === 0) return true;
  return false;
}

/** Runs in the matcher worker: compiles the pattern once, then answers one request per file with its formatted match lines. */
const MATCH_WORKER_SOURCE = String.raw`"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const regex = new RegExp(workerData.source, workerData.flags);
const truncateLine = (line) => (line.length > workerData.maxLineLength ? line.slice(0, workerData.maxLineLength) + "... [truncated]" : line);
parentPort.on("message", (request) => {
  const lines = request.text.split(/\r\n|\r|\n/u);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const output = [];
  let matches = 0;
  for (let index = 0; index < lines.length && matches < request.remaining; index += 1) {
    if (!regex.test(lines[index])) continue;
    matches += 1;
    const first = Math.max(0, index - request.context);
    const last = Math.min(lines.length - 1, index + request.context);
    for (let line = first; line <= last; line += 1) {
      const separator = line === index ? ":" : "-";
      output.push(request.shown + separator + (line + 1) + separator + " " + truncateLine(lines[line]));
    }
  }
  parentPort.postMessage({ id: request.id, matches, output });
});
`;

type MatchRequest = Readonly<{ text: string; shown: string; remaining: number; context: number }>;
type MatchReply = Readonly<{ matches: number; output: readonly string[] }>;

function boundedMessage(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

/** One worker per grep call. Every request shares the call's matching budget; a timeout or abort terminates the worker. */
function startCccGrepMatcher(i: Readonly<{ source: string; flags: string; deadlineMs: number; signal?: AbortSignal }>) {
  const worker = new Worker(MATCH_WORKER_SOURCE, {
    eval: true,
    workerData: { source: i.source, flags: i.flags, maxLineLength: MAX_LINE_LENGTH },
  });
  let failure: Error | null = null;
  let disposed = false;
  let spentMs = 0;
  let nextId = 0;
  let pending: { id: number; resolve: (reply: MatchReply) => void; reject: (error: Error) => void } | null = null;
  const fail = (error: Error) => {
    if (failure !== null) return;
    failure = error;
    void worker.terminate();
    const waiting = pending;
    pending = null;
    waiting?.reject(error);
  };
  worker.on("message", (reply: { id: number; matches: number; output: string[] }) => {
    if (pending === null || reply.id !== pending.id) return;
    const waiting = pending;
    pending = null;
    waiting.resolve({ matches: reply.matches, output: reply.output });
  });
  worker.on("error", (error: unknown) => fail(new Error(`grep matcher failed: ${boundedMessage(error instanceof Error ? error.message : String(error))}`)));
  worker.on("exit", (code: number) => {
    if (!disposed) fail(new Error(`grep matcher exited with code ${code}`));
  });
  const onAbort = () => fail(new Error("Operation aborted"));
  i.signal?.addEventListener("abort", onAbort, { once: true });
  if (i.signal?.aborted) onAbort();

  return {
    search(request: MatchRequest): Promise<MatchReply> {
      if (failure !== null) return Promise.reject(failure);
      nextId += 1;
      const id = nextId;
      const started = performance.now();
      return new Promise<MatchReply>((resolveReply, rejectReply) => {
        const timer = setTimeout(() => {
          fail(new Error(`grep timed out after ${i.deadlineMs} ms of matching; use a simpler pattern or literal: true`));
        }, Math.max(0, i.deadlineMs - spentMs));
        pending = {
          id,
          resolve: (reply) => {
            clearTimeout(timer);
            spentMs += performance.now() - started;
            resolveReply(reply);
          },
          reject: (error) => {
            clearTimeout(timer);
            rejectReply(error);
          },
        };
        worker.postMessage({ id, ...request });
      });
    },
    dispose(): void {
      disposed = true;
      i.signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
    },
  };
}

/** `${dev}:${ino}` of a stat result, or null when the operations' stat carries no identity. */
function directoryIdentity(stat: unknown): string | null {
  const { dev, ino } = (stat ?? {}) as { dev?: unknown; ino?: unknown };
  const usable = (value: unknown) => typeof value === "number" || typeof value === "bigint";
  return usable(dev) && usable(ino) ? `${String(dev)}:${String(ino)}` : null;
}

function statSize(stat: unknown): number | null {
  const { size } = (stat ?? {}) as { size?: unknown };
  return typeof size === "number" ? size : typeof size === "bigint" ? Number(size) : null;
}

export function createCccConfinedGrepTool(i: Readonly<{ fs: CccConfinedFsOperations; readRoots: readonly string[];
  deniedNames: readonly string[]; limits: Readonly<{ maxFiles: number; maxBytesPerFile: number; maxMatches: number }>;
  /** Repair 1: the matching budget of one call in ms (default CCC_CONFINED_GREP_MATCH_DEADLINE_MS). */
  matchDeadlineMs?: number }>): ToolDefinition {
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
  const matchDeadlineMs = i.matchDeadlineMs === undefined
    ? CCC_CONFINED_GREP_MATCH_DEADLINE_MS
    : positiveInteger(i.matchDeadlineMs, "matchDeadlineMs");
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
    const searchStat = await fs.ls.stat(searchPath);
    const isDirectory = searchStat.isDirectory();

    const source = params.literal === true ? escapeRegExp(params.pattern) : params.pattern;
    const flags = params.ignoreCase === true ? "i" : "";
    try {
      // Compiling is linear in the pattern; only matching can backtrack, and that runs in the worker.
      new RegExp(source, flags);
    } catch (error) {
      throw new Error(`grep pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
    const requested = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.floor(params.limit) : DEFAULT_MATCH_LIMIT;
    const matchLimit = Math.min(Math.max(1, requested), limits.maxMatches);
    const contextLines = typeof params.context === "number" && params.context > 0 ? Math.floor(params.context) : 0;
    const globPattern = typeof params.glob === "string" && params.glob !== "" ? params.glob : undefined;
    const oversized = (stat: unknown) => {
      const size = statSize(stat);
      return size !== null && size > limits.maxBytesPerFile;
    };

    const files: string[] = [];
    let fileLimitReached = false;
    const enteredDirectories = new Set<string>();
    const rootIdentity = directoryIdentity(searchStat);
    if (rootIdentity !== null) enteredDirectories.add(rootIdentity);
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
        let childStat: Awaited<ReturnType<typeof fs.ls.stat>>;
        try {
          childStat = await fs.ls.stat(child);
        } catch {
          continue;
        }
        if (childStat.isDirectory()) {
          if (name === "node_modules") continue;
          // stat follows symlinks, so a link to an ancestor has the ancestor's identity and is not entered again.
          const identity = directoryIdentity(childStat);
          if (identity === null || enteredDirectories.has(identity)) continue;
          enteredDirectories.add(identity);
          await walk(child, depth + 1);
          continue;
        }
        if (globPattern !== undefined && !cccConfinedGlobMatches(relative(searchPath, child), globPattern)) continue;
        if (oversized(childStat)) continue;
        files.push(child);
      }
    };
    if (isDirectory) await walk(searchPath, 0);
    else if (!oversized(searchStat)) files.push(searchPath);

    const formatPath = (file: string): string => {
      if (isDirectory) {
        const relativePath = relative(searchPath, file);
        if (relativePath !== "" && !relativePath.startsWith("..")) return relativePath.split(sep).join("/");
      }
      return basename(file);
    };
    const output: string[] = [];
    let matches = 0;
    let matcher: ReturnType<typeof startCccGrepMatcher> | null = null;
    try {
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
        matcher ??= startCccGrepMatcher({ source, flags, deadlineMs: matchDeadlineMs, signal });
        const reply = await matcher.search({
          text: Buffer.from(bytes).toString("utf8"),
          shown: formatPath(file),
          remaining: matchLimit - matches,
          context: contextLines,
        });
        matches += reply.matches;
        output.push(...reply.output);
      }
    } finally {
      matcher?.dispose();
    }
    const fileLimitNotice = `${limits.maxFiles} files limit reached; files after the limit were not searched, so narrow path or glob`;
    const details = { matches, matchLimitReached: matches >= matchLimit, fileLimitReached };
    if (matches === 0) {
      const empty = fileLimitReached ? `No matches found\n\n[${fileLimitNotice}]` : "No matches found";
      return { content: [{ type: "text" as const, text: empty }], details };
    }
    let text = output.join("\n");
    const notices: string[] = [];
    if (matches >= matchLimit) notices.push(`${matchLimit} matches limit reached. Use limit=${matchLimit * 2} for more, or refine pattern`);
    if (fileLimitReached) notices.push(fileLimitNotice);
    if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) {
      text = Buffer.from(text, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
      notices.push(`${MAX_OUTPUT_BYTES / 1024}KB output limit reached`);
    }
    if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;
    return { content: [{ type: "text" as const, text }], details };
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
