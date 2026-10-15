import { constants as fsConstants, lstatSync, realpathSync, type Dirent } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, matchesGlob, resolve, sep } from "node:path";
import { compareCccPrdCodeUnits } from "@fusion/core";
import type { CccConfinedFsOperations } from "../agent-runtime.js";
import { cccConfinedEffectiveDeniedNames, cccConfinedWriteRefusal, type CccConfinedWriteRefusal } from "./confined-shell.js";

/*
FNXC:CccConfinedFsTools 2026-10-14-21:10:
Card C2 (CONTRACT-v3 section 2.13, D11, errata E2-7 and E4-10). A planning session's read, write, edit, ls and find run Pi 0.81.1's own tools over these operations, so every path Pi hands over is checked here first. A path must be absolute with no ".." segment, and X1's shared predicate cccConfinedWriteRefusal decides the rest from its real landing path: reads pass the read roots as the predicate's roots, writes and edits pass the write roots, and both pass the effective denied names, so a .git segment and every denied name are refused exactly as the confined shell refuses them. The operation then runs on the real path the predicate checked. Directory listings and find results hide every entry a read would refuse, and find's glob walks in TypeScript, so Pi never needs fd. Denied names are validated against [A-Za-z0-9._*-] with a TypeError before any predicate call, because the predicate throws a plain Error on an invalid name.
*/

/** Carried by every Fusion confined tool definition, so a session check can tell it from Pi's tool of the same name (D11). */
export const CCC_CONFINED_TOOL_MARK: unique symbol = Symbol.for("ccc-fusion.confined-tool.v1");

export type CccConfinedPathRefusalReason =
  | "not-absolute"
  | "parent-segment"
  | "outside-read-roots"
  | CccConfinedWriteRefusal;

/** A confined file operation refused its path. It deliberately has no `code`, so Pi's edit tool reports the reason. */
export class CccConfinedPathRefusedError extends Error {
  readonly reason: CccConfinedPathRefusalReason;
  readonly path: string;

  constructor(reason: CccConfinedPathRefusalReason, path: string) {
    super(`confined path refused (${reason}): ${path}`);
    this.name = "CccConfinedPathRefusedError";
    this.reason = reason;
    this.path = path;
  }
}

const DENIED_NAME_SHAPE = /^[A-Za-z0-9._*-]+$/u;
const MAX_WALK_DEPTH = 64;

/**
 * E4-10: validates each caller name against [A-Za-z0-9._*-] (a TypeError, before any predicate call), then returns
 * X1's effective denied names: the caller's united with the defaults, folded and sorted.
 */
export function cccConfinedValidatedDeniedNames(names: readonly string[]): readonly string[] {
  if (!Array.isArray(names)) throw new TypeError("denied names must be an array of [A-Za-z0-9._*-] path components");
  for (const name of names) {
    if (typeof name !== "string" || !DENIED_NAME_SHAPE.test(name) || name === "." || name === "..") {
      throw new TypeError(`denied name must be one path component of [A-Za-z0-9._*-]: ${String(name)}`);
    }
  }
  return cccConfinedEffectiveDeniedNames(names);
}

/** A copy of `tool` that carries CCC_CONFINED_TOOL_MARK. */
export function markCccConfinedTool<T extends object>(tool: T): T {
  return { ...tool, [CCC_CONFINED_TOOL_MARK]: true } as T;
}

export function isCccConfinedTool(tool: unknown): boolean {
  return typeof tool === "object" && tool !== null && (tool as Record<PropertyKey, unknown>)[CCC_CONFINED_TOOL_MARK] === true;
}

/**
 * fd's glob rule, which Pi's find documents: a pattern without "/" matches the base name; a pattern with "/" matches
 * the path relative to the search directory, with a leading "**\/" added unless it has one.
 */
export function cccConfinedGlobMatches(relativePath: string, pattern: string): boolean {
  const posixPath = relativePath.split(sep).join("/");
  if (!pattern.includes("/")) return matchesGlob(basename(posixPath), pattern);
  return matchesGlob(posixPath, pattern) || (!pattern.startsWith("**/") && matchesGlob(posixPath, `**/${pattern}`));
}

function canonicalRoots(roots: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(roots)) throw new TypeError(`${label} must be an array of absolute paths`);
  for (const root of roots) {
    if (typeof root !== "string" || !isAbsolute(root)) throw new TypeError(`${label} must contain only absolute paths`);
  }
  return Object.freeze([...roots]);
}

/** The real path an operation on `path` lands on (the predicate's rule): the real longest existing ancestor plus the missing tail. */
function landingPath(path: string): string | null {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    // missing, or present but unresolvable
  }
  try {
    lstatSync(resolved);
    return null;
  } catch {
    // missing: keep this component
  }
  const parent = dirname(resolved);
  if (parent === resolved) return null;
  const landing = landingPath(parent);
  return landing === null ? null : join(landing, basename(resolved));
}

function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]+/u).includes("..");
}

export function createCccConfinedFsOperations(i: Readonly<{ readRoots: readonly string[]; writeRoots: readonly string[];
  deniedNames: readonly string[] }>): CccConfinedFsOperations {
  const deniedNames = cccConfinedValidatedDeniedNames(i.deniedNames);
  const readRoots = canonicalRoots(i.readRoots, "readRoots");
  const writeRoots = canonicalRoots(i.writeRoots, "writeRoots");

  const refusal = (path: unknown, roots: readonly string[]): CccConfinedPathRefusalReason | null => {
    if (typeof path !== "string" || !isAbsolute(path)) return "not-absolute";
    if (hasParentSegment(path)) return "parent-segment";
    const refused = cccConfinedWriteRefusal({ path, writeRoots: roots, deniedNames });
    if (refused === "outside-write-roots" && roots === readRoots) return "outside-read-roots";
    return refused;
  };
  const gate = (path: string, roots: readonly string[]): string => {
    const reason = refusal(path, roots);
    if (reason !== null) throw new CccConfinedPathRefusedError(reason, String(path));
    const landing = landingPath(path);
    if (landing === null) throw new CccConfinedPathRefusedError(roots === readRoots ? "outside-read-roots" : "outside-write-roots", path);
    return landing;
  };
  const readable = (path: string): string => gate(path, readRoots);
  const writable = (path: string): string => gate(path, writeRoots);
  const visible = (path: string): boolean => refusal(path, readRoots) === null;

  const glob = async (pattern: string, searchPath: string, options: Readonly<{ ignore: string[]; limit: number }>): Promise<string[]> => {
    readable(searchPath);
    const results: string[] = [];
    const ignore = options.ignore ?? [];
    const ignored = (relativePath: string): boolean => ignore.some((entry) => matchesGlob(`${relativePath}/_`, entry));
    const walk = async (spelledDirectory: string, relativeDirectory: string, depth: number): Promise<void> => {
      if (results.length >= options.limit || depth > MAX_WALK_DEPTH) return;
      let entries: Dirent[];
      try {
        entries = await readdir(readable(spelledDirectory), { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((left, right) => compareCccPrdCodeUnits(left.name, right.name));
      for (const entry of entries) {
        if (results.length >= options.limit) return;
        const spelled = join(spelledDirectory, entry.name);
        const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
        if (!visible(spelled)) continue;
        if (entry.isDirectory()) {
          if (!ignored(relativePath)) await walk(spelled, relativePath, depth + 1);
          continue;
        }
        if (entry.isSymbolicLink()) {
          // A symlinked file inside the roots is a result; a symlinked directory is never followed.
          const target = await stat(readable(spelled)).catch(() => null);
          if (!target?.isFile()) continue;
        } else if (!entry.isFile()) {
          continue;
        }
        if (cccConfinedGlobMatches(relativePath, pattern)) results.push(join(searchPath, relativePath));
      }
    };
    await walk(searchPath, "", 0);
    return results;
  };

  return Object.freeze({
    read: Object.freeze({
      readFile: async (path: string) => readFile(readable(path)),
      access: async (path: string) => access(readable(path), fsConstants.R_OK),
    }),
    write: Object.freeze({
      writeFile: async (path: string, content: string) => writeFile(writable(path), content),
      mkdir: async (directory: string) => {
        await mkdir(writable(directory), { recursive: true });
      },
    }),
    edit: Object.freeze({
      readFile: async (path: string) => readFile(writable(path)),
      writeFile: async (path: string, content: string) => writeFile(writable(path), content),
      access: async (path: string) => access(writable(path), fsConstants.R_OK | fsConstants.W_OK),
    }),
    ls: Object.freeze({
      exists: async (path: string) => {
        try {
          await access(readable(path), fsConstants.F_OK);
          return true;
        } catch (error) {
          if (error instanceof CccConfinedPathRefusedError) throw error;
          return false;
        }
      },
      stat: async (path: string) => stat(readable(path)),
      readdir: async (path: string) => {
        const names = await readdir(readable(path));
        return names.filter((name) => visible(join(path, name)));
      },
    }),
    find: Object.freeze({
      exists: async (path: string) => {
        try {
          await access(readable(path), fsConstants.F_OK);
          return true;
        } catch (error) {
          if (error instanceof CccConfinedPathRefusedError) throw error;
          return false;
        }
      },
      glob,
    }),
  });
}
