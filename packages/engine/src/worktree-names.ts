import { readdirSync } from "node:fs";
import { existsSync } from "node:fs";
import type { Settings, Task } from "@fusion/core";
import { resolveTaskWorktreePath, resolveWorktreesDir } from "./worktree-paths.js";

export const ADJECTIVES = [
  "amber", "azure", "bold", "brave", "bright",
  "calm", "clear", "cool", "coral", "crisp",
  "deft", "dusky", "eager", "early", "faint",
  "fast", "fleet", "fresh", "gentle", "gilt",
  "glad", "grand", "green", "happy", "hazy",
  "ivory", "jade", "keen", "lemon", "light",
  "lunar", "maple", "merry", "misty", "noble",
  "opal", "pale", "pearl", "plush", "proud",
  "quiet", "rapid", "rosy", "rusty", "sandy",
  "sharp", "sleek", "solar", "swift", "vivid",
];

export const NOUNS = [
  "aspen", "badger", "breeze", "brook", "cedar",
  "cliff", "crane", "creek", "daisy", "delta",
  "dune", "eagle", "ember", "falcon", "fern",
  "finch", "flame", "frost", "grove", "hawk",
  "heron", "iris", "lark", "lotus", "marsh",
  "mesa", "moss", "oak", "olive", "orbit",
  "otter", "panda", "peach", "petal", "pine",
  "plume", "quail", "raven", "reef", "ridge",
  "robin", "sage", "shore", "spark", "stone",
  "thorn", "tiger", "trail", "trout", "wren",
];

export function canonicalFusionBranchName(taskId: string): string {
  return `fusion/${taskId.toLowerCase()}`;
}

/*
FNXC:CccCampaignBranchScope 2026-09-03-00:00:
`fusion/<task-id>` is unique only within ONE task database. A CCC campaign is
imported into a FRESH database, so it re-allocates native ids from the start and
`fusion/kb-005` collides with whatever a previous campaign left in the target
repository. The L12 round-2 run hit exactly that: the owner's August
`fusion/kb-005` branch (with a registered worktree) was found by branch name,
adopted, and relocated out of the owner's repository before the frozen-base
guard refused. The working branch therefore carries the campaign's own identity
token so two campaigns can never name the same branch.

The token is a pure function of the compiler-minted `lineageId`
(`ccc-prd:<identityHash[0:24]>:<semanticTaskId>`, see packages/core/src/ccc-prd/projection.ts),
which is persisted on the task row. Restart and recovery therefore re-derive the
same branch with no extra state, even after `task.branch` has been cleared.
*/
const CCC_CAMPAIGN_LINEAGE_PATTERN = /^ccc-prd:([0-9a-f]{24}):/u;

/** Hex characters of the campaign identity hash carried in the branch name. */
export const CCC_CAMPAIGN_BRANCH_TOKEN_LENGTH = 12;

/**
 * The campaign identity token for an imported CCC campaign task, or `null` for
 * every ordinary task. Lowercase hex, {@link CCC_CAMPAIGN_BRANCH_TOKEN_LENGTH}
 * characters.
 */
export function cccCampaignBranchToken(lineageId: string | null | undefined): string | null {
  if (typeof lineageId !== "string") return null;
  const match = CCC_CAMPAIGN_LINEAGE_PATTERN.exec(lineageId.trim());
  if (!match) return null;
  return match[1].slice(0, CCC_CAMPAIGN_BRANCH_TOKEN_LENGTH);
}

/**
 * The branch name a task owns by construction: `fusion/<task-id>` for ordinary
 * tasks, `fusion/<task-id>-<campaign-token>` for an imported CCC campaign task.
 * Deterministic from the persisted task row alone.
 */
export function campaignScopedFusionBranchName(
  task: { id: string; lineageId?: string | null },
): string {
  const canonical = canonicalFusionBranchName(task.id);
  const token = cccCampaignBranchToken(task.lineageId);
  return token ? `${canonical}-${token}` : canonical;
}

/**
 * Does `branchName` carry `token` as its campaign-identity suffix?
 *
 * The token is fixed-width lowercase hex, so this is an exact suffix test, not
 * a substring one: `fusion/kb-005` never matches, `fusion/kb-005-f03f47757404`
 * does.
 */
export function branchCarriesCampaignToken(branchName: string, token: string): boolean {
  return branchName.trim().toLowerCase().endsWith(`-${token.toLowerCase()}`);
}

/*
FNXC:CccCampaignBranchCustody 2026-09-03-01:00:
`task.branch` is NOT self-certifying. `reconcileInReviewBranchRebind` rebinds an
absent or broken binding to a live `fusion/*` branch on a name + unique-work
match, and a fresh campaign import (branch `null`) is exactly its trigger. If a
previous campaign left `fusion/kb-005` in the target repository, that stranger's
branch can land on the row — and from there it flows into `git branch -D` at
merge cleanup, into the PR head, and into push.

So a consumer that reads the pointer must re-check it. For a campaign task the
pointer is honoured only when it carries this campaign's identity token; the
deterministic campaign-scoped name wins otherwise. Ordinary tasks keep whatever
was persisted (operators do choose custom branches) and fall back to the bare
canonical name, exactly as before.

This is defence in depth, not the primary gate: the primary gate is the git
custody proof in ccc-campaign-branch-custody.ts, enforced at every write.
*/
export function resolveTrustedTaskBranchName(
  task: { id: string; branch?: string | null; lineageId?: string | null },
): string {
  const persisted = typeof task.branch === "string" ? task.branch.trim() : "";
  const token = cccCampaignBranchToken(task.lineageId);
  if (!token) return persisted || canonicalFusionBranchName(task.id);
  if (persisted && branchCarriesCampaignToken(persisted, token)) return persisted;
  return campaignScopedFusionBranchName(task);
}

/**
 * Canonical per-instance branch name for a worktree-isolated foreach step
 * (step-inversion KTD-11, U10): `fusion/<task>-step-<i>`. Deterministic from the
 * task id + 0-based step index so crash-resume can reconstruct the branch name
 * (and probe its existence) without persisting it separately — though the
 * instance row also carries `branchName` for the integration/reconcile path.
 */
export function canonicalStepInstanceBranchName(taskId: string, stepIndex: number): string {
  return `${canonicalFusionBranchName(taskId)}-step-${stepIndex}`;
}

export function resolveTaskWorkingBranch(
  task: Pick<Task, "id" | "branch" | "branchContext"> & Partial<Pick<Task, "lineageId">>,
): string {
  if (task.branchContext?.assignmentMode === "shared") {
    return campaignScopedFusionBranchName(task);
  }
  return task.branch || campaignScopedFusionBranchName(task);
}

/**
 * Convert a string to a URL-friendly slug.
 *
 * - Lowercase
 * - Replace spaces, underscores, and special chars with hyphens
 * - Collapse multiple hyphens
 * - Trim leading/trailing hyphens
 */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "") // Remove special characters except spaces and hyphens
    .replace(/\s+/g, "-") // Replace spaces with hyphens
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .replace(/^-|-$/g, ""); // Trim leading/trailing hyphens
}

/**
 * Generate a random, human-friendly worktree directory name.
 *
 * Names follow an `adjective-noun` pattern (e.g., `swirly-monkey`,
 * `quiet-falcon`, `bright-orchid`) drawn from embedded word lists of
 * ~50 adjectives × ~50 nouns, producing ~2,500 unique combinations.
 *
 * **Collision avoidance:** The function checks existing subdirectories
 * under `<rootDir>/.worktrees/`. If the randomly chosen name already
 * exists, a numeric suffix is appended (e.g., `swift-falcon-2`,
 * `swift-falcon-3`) until a unique name is found.
 *
 * @param rootDir - The project root directory (parent of `.worktrees/`)
 * @returns A unique worktree directory name (not a full path)
 */
export function generateWorktreeName(rootDir: string, settings?: Pick<Settings, "worktreesDir">): string {
  return generateReservedWorktreeName(rootDir, new Set(), settings);
}

/**
 * Generate a unique worktree directory name while also avoiding names that
 * have been reserved in-memory but may not exist on disk yet.
 */
export function generateReservedWorktreeName(
  rootDir: string,
  reservedNames: Set<string> = new Set(),
  settings?: Pick<Settings, "worktreesDir">,
): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const baseName = `${adjective}-${noun}`;

  const worktreesDir = resolveWorktreesDir(rootDir, settings);
  const existing = getExistingWorktreeNames(worktreesDir);
  for (const reserved of reservedNames) {
    existing.add(reserved);
  }

  if (!existing.has(baseName)) {
    return baseName;
  }

  // Collision — append numeric suffix
  let suffix = 2;
  while (existing.has(`${baseName}-${suffix}`)) {
    suffix++;
  }
  return `${baseName}-${suffix}`;
}

/**
 * Plan a worktree directory path for a task that is about to enter
 * `in-progress`. Returns the absolute path under `<rootDir>/.worktrees/`.
 *
 * If the task already carries a `worktree` value, it is reused — the
 * caller is responsible for ensuring it does not collide with another
 * active task. Otherwise a name is generated according to `naming`,
 * avoiding any names already in `reservedNames`.
 *
 * Shared by the scheduler dispatch path and the manual-move HTTP route
 * so both allocate via the same collision rules.
 */
export function planTaskWorktreePath(
  task: { id: string; title?: string | null; description: string; worktree?: string | null },
  rootDir: string,
  naming: string | undefined,
  reservedNames: Set<string>,
  settings?: Pick<Settings, "worktreesDir">,
): string {
  if (task.worktree) {
    const existingName = task.worktree.split("/").filter(Boolean).pop();
    if (existingName) reservedNames.add(existingName);
    return task.worktree;
  }

  let worktreeName: string;
  switch (naming || "random") {
    case "task-id":
      worktreeName = task.id.toLowerCase();
      break;
    case "task-title":
      worktreeName = slugify(task.title || task.description.slice(0, 60));
      break;
    case "random":
    default:
      worktreeName = generateReservedWorktreeName(rootDir, reservedNames, settings);
      break;
  }

  reservedNames.add(worktreeName);
  return resolveTaskWorktreePath(rootDir, settings, worktreeName);
}

function getExistingWorktreeNames(worktreesDir: string): Set<string> {
  if (!existsSync(worktreesDir)) {
    return new Set();
  }
  try {
    const entries = readdirSync(worktreesDir, { withFileTypes: true });
    return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    return new Set();
  }
}
