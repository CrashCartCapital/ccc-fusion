import { canonicalCccPrdJson, compareCccPrdCodeUnits } from "@fusion/core";

// Single source of truth for the task protected-action ID rule that
// packages/core/src/ccc-campaign/store.ts requireCanonicalProtectedActionIds enforces fail-closed
// at semantic campaign-context resolution: a task's protectedActionIds must be an array of
// non-empty strings that are already trimmed (no leading/trailing whitespace), duplicate-free, and
// sorted in code-unit order. Padded entries are refused, never silently trimmed, because trimming
// would silently rewrite the identity reference between a task's protectedActionIds and the
// matching packages/core protectedActions[].id.
//
// Shared by authoring (./authoring.ts) and validation (./compiler.ts) so the two enforcement sites
// cannot drift from this rule or from each other.

export function isWellFormedProtectedActionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

export function isCanonicalProtectedActionIdSet(ids: readonly string[]): boolean {
  const canonicalOrder = [...ids].sort(compareCccPrdCodeUnits);
  return new Set(ids).size === ids.length
    && canonicalCccPrdJson(ids) === canonicalCccPrdJson(canonicalOrder);
}

export function canonicalizeProtectedActionIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort(compareCccPrdCodeUnits);
}
