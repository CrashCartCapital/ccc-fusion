import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalCccPrdJson, registerCccRunningRuntimeDistManifest } from "@fusion/core";

/*
FNXC:CccPlanningHost 2026-10-14-22:17:
D44, ADR D installed receipt: the running runtime's identity is sha256(canonical JSON of the sorted
[relativePath, sha256] pairs of every dist/**\/*.js file), relative to the dist directory and "/"-separated, sorted by
code unit. The engine registers it once at start. A source run (this module loaded from .ts) has no dist, registers
nothing, and so every planning stage refuses with RUNTIME_NOT_PERMITTED, which is the D44 rule for an unregistered digest.
*/

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listJsFiles(root: string, prefix: string): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listJsFiles(root, relative));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(relative);
  }
  return files;
}

export async function computeCccRuntimeDistManifestSha256(distRoot: string): Promise<string> {
  const files = (await listJsFiles(distRoot, "")).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const manifest: Array<[string, string]> = [];
  for (const relative of files) manifest.push([relative, sha256(await readFile(join(distRoot, ...relative.split("/"))))]);
  return sha256(canonicalCccPrdJson(manifest));
}

export async function registerCccRunningRuntimeAtEngineStart(i: Readonly<{ distRoot: string | null }>): Promise<void> {
  if (i.distRoot === null) return;
  registerCccRunningRuntimeDistManifest(await computeCccRuntimeDistManifestSha256(i.distRoot));
}

/** The nearest `dist` directory above a built module, or null when the module is TypeScript source. */
export function resolveCccRuntimeDistRoot(moduleUrl: string): string | null {
  if (!moduleUrl.startsWith("file:")) return null;
  const modulePath = fileURLToPath(moduleUrl);
  if (!modulePath.endsWith(".js")) return null;
  for (let dir = dirname(modulePath); ; dir = dirname(dir)) {
    if (basename(dir) === "dist") return dir;
    if (dirname(dir) === dir) return null;
  }
}
