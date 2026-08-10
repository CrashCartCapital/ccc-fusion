import { cp } from "node:fs/promises";
import { join } from "node:path";
import { buildCore, buildDashboardServerRuntime, packageRoot, runWorkspaceBin, workspaceRoot } from "./workspace-tools";

const dashboardRoot = join(workspaceRoot, "packages", "dashboard");

async function main(): Promise<void> {
  console.log("[desktop:test] Building @fusion/core...");
  await buildCore();

  console.log("[desktop:test] Building @fusion/dashboard server runtime...");
  await buildDashboardServerRuntime();
  await cp(
    join(dashboardRoot, "src", "registry-manifest.json"),
    join(dashboardRoot, "dist", "registry-manifest.json"),
  );

  console.log("[desktop:test] Running desktop Vitest suite...");
  await runWorkspaceBin("vitest", ["run", "--silent=passed-only", "--reporter=dot"], packageRoot);
}

void main().catch((error) => {
  console.error("[desktop:test] Test run failed", error);
  process.exitCode = 1;
});
