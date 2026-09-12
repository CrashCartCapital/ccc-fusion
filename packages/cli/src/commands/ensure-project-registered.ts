import { exec } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  type CentralCore,
  type RegisteredProject,
  type ProjectIdentity,
  readProjectIdentity,
  writeProjectIdentity,
} from "@fusion/core";

const execAsync = promisify(exec);

export interface EnsureCwdProjectRegisteredOptions {
  cwd: string;
  central: CentralCore;
  logPrefix: string;
  autoRegister: boolean;
}

function stampProjectIdentityBestEffort(
  cwd: string,
  project: RegisteredProject,
  logPrefix: string,
): void {
  try {
    writeProjectIdentity(join(cwd, ".fusion"), {
      id: project.id,
      createdAt: project.createdAt,
    });
  } catch (error) {
    console.warn(
      `[${logPrefix}] Could not persist project identity for ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function ensureCwdProjectRegistered(
  options: EnsureCwdProjectRegisteredOptions,
): Promise<RegisteredProject | null> {
  const { cwd, central, logPrefix, autoRegister } = options;

  const existing = await central.getProjectByPath(cwd);
  if (existing) {
    stampProjectIdentityBestEffort(cwd, existing, logPrefix);
    return existing;
  }

  if (!autoRegister) {
    logManualRegistrationHint(logPrefix, cwd);
    return null;
  }

  if (looksLikeFusionSourceCheckout(cwd)) {
    logFusionSourceCheckoutRefusal(logPrefix, cwd);
    return null;
  }

  try {
    const fusionDir = join(cwd, ".fusion");

    if (!existsSync(fusionDir)) {
      mkdirSync(fusionDir, { recursive: true });
    }

    const projectName = await detectProjectName(cwd);
    // FNXC:ProjectIdentityMarker 2026-07-14-17:20: Auto-registration writes
    // project.json and reads fusion.db only through the legacy identity migrator.
    const identity: ProjectIdentity | null = readProjectIdentity(fusionDir);

    const ensured = await central.ensureProjectForPath({
      path: cwd,
      identity: identity ?? undefined,
      name: projectName,
    });

    const project = ensured.project;
    await central.updateProject(project.id, { status: "active" });
    stampProjectIdentityBestEffort(cwd, project, logPrefix);

    if (ensured.outcome === "reattached") {
      console.log(
        `[${logPrefix}] Recovered project identity ${project.id} from ${fusionDir} (central had no row)`,
      );
    } else if (ensured.outcome === "registered") {
      console.log(`[${logPrefix}] Auto-registered project "${project.name}" at ${cwd}`);
    }

    return project;
  } catch (error) {
    console.error(
      `[${logPrefix}] Failed to auto-register current project: ${error instanceof Error ? error.message : String(error)}`,
    );
    logManualRegistrationHint(logPrefix, cwd);
    return null;
  }
}

async function detectProjectName(dir: string): Promise<string> {
  if (!existsSync(join(dir, ".git"))) {
    return basename(dir) || "my-project";
  }

  try {
    const { stdout: remoteUrl } = await execAsync("git remote get-url origin", {
      cwd: dir,
      timeout: 10_000,
    });

    const trimmed = remoteUrl.trim();
    if (trimmed) {
      const match = trimmed.match(/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
      if (match) {
        return match[2];
      }
    }
  } catch {
    // ignore
  }

  return basename(dir) || "my-project";
}

function logManualRegistrationHint(logPrefix: string, cwd: string): void {
  console.error(`[${logPrefix}] Run 'fn init' to register this project, or 'fn project add <name> <path>' (${cwd})`);
}

/*
FNXC:FusionSourceCheckoutGuard 2026-09-06 (worktree-sweep incident): `serve`
launched with a cwd that was never explicitly `cd`'d into a target repo
resolves to the Fusion source checkout itself, and prior to this guard that
got silently auto-registered as its own project — see
`packages/cli/src/commands/serve.ts`'s `resolveRuntimeProjectPath` for how the
cwd is derived. That gave the source checkout a second, database-empty
ProjectEngine whose maintenance sweep then had zero task records for ANY
worktree under `.worktrees/`, so it swept two real, unrelated git worktrees as
"idle" (see the ownership-guard fix in `packages/engine/src/worktree-pool.ts`
for the other half of this incident). A `.fusion-source` marker file is an
optional escape hatch for a genuinely renamed or vendored copy of this
monorepo that still wants the auto-register foot-gun disabled; the primary
signal is the `packages/engine/package.json` name, since a real user project's
package.json will never be `@fusion/engine`.
*/
function looksLikeFusionSourceCheckout(cwd: string): boolean {
  if (existsSync(join(cwd, ".fusion-source"))) return true;
  try {
    const engineManifestPath = join(cwd, "packages", "engine", "package.json");
    if (!existsSync(engineManifestPath)) return false;
    const manifest = JSON.parse(readFileSync(engineManifestPath, "utf-8")) as { name?: unknown };
    return manifest.name === "@fusion/engine";
  } catch {
    // An unreadable/unparseable manifest is not a confident "yes" — fail
    // open to the normal auto-register path rather than block a real project
    // that merely happens to vendor a similarly-shaped packages/engine dir.
    return false;
  }
}

function logFusionSourceCheckoutRefusal(logPrefix: string, cwd: string): void {
  console.error(
    `[${logPrefix}] Refusing to auto-register ${cwd} as a project: it looks like the Fusion source checkout itself ` +
    `(packages/engine/package.json declares "@fusion/engine"). This usually means serve/daemon/desktop was launched ` +
    `without first cd-ing into your target project's directory. Fix: cd into your target repo before running the ` +
    `command, or register/select a project explicitly with 'fn project add <name> <path>' and '--project <name>'.`,
  );
}
