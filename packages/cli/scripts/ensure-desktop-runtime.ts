import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  ensureDesktopRuntimeAssetsBuilt,
  wantsFullCliPackage,
} from "../tsup.config";

type EnsureDesktopRuntime = () => Promise<void>;

export async function runDesktopRuntimePreflight(
  env: NodeJS.ProcessEnv = process.env,
  ensureDesktopRuntime: EnsureDesktopRuntime = ensureDesktopRuntimeAssetsBuilt,
): Promise<boolean> {
  if (!wantsFullCliPackage(env)) {
    return false;
  }

  await ensureDesktopRuntime();
  return true;
}

const invokedPath = process.argv[1];
if (invokedPath && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  await runDesktopRuntimePreflight();
}
