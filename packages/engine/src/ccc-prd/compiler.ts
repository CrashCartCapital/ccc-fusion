import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { CCC_PRD_SCHEMA_VERSION, createRefusalBundle, normalizeProtectedAction, type CccPrdManifestEntry, type CccPrdRequirement, type CccPrdSemanticBundle } from "@fusion/core";

type RawManifest = { schema?: string; source_version?: string; entries?: Array<{ relative_path?: string; role?: string; sha256?: string; authoritative?: boolean }> };
export type CompileCccPrdInput = { rootDir: string; manifestPath: string };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const refused = (code: string, message: string, path?: string) => createRefusalBundle({ code, message, ...(path ? { source: { path, line: 1, column: 1 } } : {}) });
const isProtected = (path: string) => /(^|[\\/])(?:\.obsidian|_KELSEY|_secrets)(?:[\\/]|$)/.test(path);
const actions = ["promotion", "live_execution", "deletion", "merge", "publication", "credential", "billing", "upstream_write"] as const;

function parseRequirements(content: string, path: string): CccPrdRequirement[] {
  return content.split(/\r?\n/).flatMap((line, index) => { const match = line.match(/^\|\s*(FR-\d+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/); if (!match) return []; const span = { path, line: index + 1, column: 1 }; return [{ id: match[1], text: match[2], acceptance: match[3], span, proofs: match[3] ? [{ id: `${match[1]}-acceptance`, command: match[3], span }] : [] }]; });
}

export function compileCccPrdPacket(input: CompileCccPrdInput): CccPrdSemanticBundle | ReturnType<typeof createRefusalBundle> {
  let raw: RawManifest;
  try { raw = JSON.parse(readFileSync(input.manifestPath, "utf8")) as RawManifest; } catch { return refused("CCC_PRD_MANIFEST_READ_FAILED", "manifest could not be read", input.manifestPath); }
  if (raw.schema !== "ccc-prd.packet.v1" && raw.schema !== "ccc-lab-super.source-custody.v1") return refused("CCC_PRD_UNKNOWN_SCHEMA", "unknown required schema", input.manifestPath);
  const entries: CccPrdManifestEntry[] = (raw.entries ?? []).map((entry) => ({ relativePath: entry.relative_path ?? "", role: entry.role ?? "", sha256: entry.sha256 ?? "", authoritative: entry.authoritative === true }));
  const root = realpathSync(input.rootDir);
  const requirements: CccPrdRequirement[] = []; const sources: CccPrdSemanticBundle["sources"] = []; const detectedActions = new Map<string, string>();
  for (const entry of [...entries].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    if (isProtected(entry.relativePath)) return refused("CCC_PRD_PROTECTED_PATH", "protected path was not read", entry.relativePath);
    if (!entry.authoritative) continue;
    const path = resolve(root, entry.relativePath);
    if (!path.startsWith(`${root}${sep}`)) return refused("CCC_PRD_PATH_ESCAPE", "undeclared companion or path escape rejected", entry.relativePath);
    let stat; try { stat = lstatSync(path); } catch { return refused("CCC_PRD_UNDECLARED_COMPANION", "declared companion is absent", entry.relativePath); }
    if (stat.isSymbolicLink()) return refused("CCC_PRD_PATH_ESCAPE", "symlink escape rejected before read", entry.relativePath);
    const content = readFileSync(path, "utf8"); const actual = sha256(content);
    if (actual !== entry.sha256) return refused("CCC_PRD_SOURCE_HASH_MISMATCH", "admitted source hash changed", entry.relativePath);
    if (/\bwhile\s*\(?\s*true\s*\)?|\bloop\s*:\s*unbounded/i.test(content)) return refused("CCC_PRD_UNBOUNDED_LOOP", "unbounded loop rejected", entry.relativePath);
    if (/\bstatus\s*:\s*DEFERRED\b/i.test(content)) return refused("CCC_PRD_UNRESOLVED_DEFERRED", "unresolved deferred state", entry.relativePath);
    if (/\bpromot(?:e|ion)/i.test(content)) detectedActions.set("promotion", entry.relativePath);
    if (/\blive[- ]?(?:execution|mode|run|source)|\bpre-live\b/i.test(content)) detectedActions.set("live_execution", entry.relativePath);
    if (/\bdelete\b|\bdeletion\b|\borphan-delete\b/i.test(content)) detectedActions.set("deletion", entry.relativePath);
    if (/\bmerge\b/i.test(content)) detectedActions.set("merge", entry.relativePath);
    if (/\bpublish(?:ed|ing)?\b/i.test(content)) detectedActions.set("publication", entry.relativePath);
    if (/\bcredential\b/i.test(content)) detectedActions.set("credential", entry.relativePath);
    if (/\bbilling\b|\bspending\b/i.test(content)) detectedActions.set("billing", entry.relativePath);
    if (/\bupstream[- ]write\b|\bupstream\b.*\bmutat/i.test(content)) detectedActions.set("upstream_write", entry.relativePath);
    sources.push({ path: entry.relativePath, sha256: actual, span: { path: entry.relativePath, line: 1, column: 1 } }); requirements.push(...parseRequirements(content, entry.relativePath));
  }
  const duplicate = requirements.find((item, index) => requirements.findIndex((other) => other.id === item.id) !== index); if (duplicate) return refused("CCC_PRD_AUTHORITY_CONFLICT", "authority conflict for requirement", duplicate.span.path);
  const missingProof = requirements.find((item) => item.proofs.length === 0); if (missingProof) return refused("CCC_PRD_MISSING_PROOF", "required proof missing", missingProof.span.path);
  const protectedActions = actions.filter((kind) => detectedActions.has(kind)).map((kind) => normalizeProtectedAction({ kind, target: detectedActions.get(kind)! }));
  const sortedRequirements = [...requirements].sort((left, right) => Number(left.id.slice(3)) - Number(right.id.slice(3)) || left.id.localeCompare(right.id)); const sortedSources = [...sources].sort((left, right) => left.path.localeCompare(right.path));
  const sourceHash = sha256(sortedSources.map((source) => `${source.path}:${source.sha256}`).join("\n")); const bundleHash = sha256(JSON.stringify({ schema: CCC_PRD_SCHEMA_VERSION, sourceHash, sources: sortedSources, requirements: sortedRequirements, protectedActions }));
  return { kind: "bundle", schema: CCC_PRD_SCHEMA_VERSION, sourceHash, bundleHash, sources: sortedSources, requirements: sortedRequirements, protectedActions };
}

export function validateNeoCandidate(candidate: unknown): { valid: boolean; dispatch: ReturnType<typeof createRefusalBundle> } { const value = candidate as { schema_id?: string; status?: string }; const valid = value.schema_id === "autonomous_builder_handoff_candidate.v1" && value.status === "READY_FOR_COLD_REVIEW"; return { valid, dispatch: refused("CCC_PRD_DISPATCH_REFUSED", valid ? "READY_FOR_COLD_REVIEW is validation-only" : "candidate is not valid for dispatch") }; }
