import { constants as fsConstants } from "node:fs";
import { accessSync, lstatSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CCC_PRD_SEMANTIC_PROOF_HOST_ID,
  type CccPrdSemanticProofToolchainPaths,
} from "@fusion/core";

function regularExecutable(path: string): string | null {
  try {
    const canonical = realpathSync(path);
    const metadata = lstatSync(canonical);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    accessSync(canonical, fsConstants.X_OK);
    return canonical;
  } catch {
    return null;
  }
}

function resolvePathExecutable(name: string, label: string, env: NodeJS.ProcessEnv): string {
  const pathValue = env.PATH;
  if (!pathValue) throw new Error(`CCC semantic-proof ${label} executable is absent from PATH`);
  const suffixes = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const root of pathValue.split(delimiter)) {
    if (!root) continue;
    for (const suffix of suffixes) {
      const candidate = regularExecutable(join(root, `${name}${suffix}`));
      if (candidate) return candidate;
    }
  }
  throw new Error(`CCC semantic-proof ${label} executable is absent from PATH`);
}

function resolveBuiltProofHost(moduleUrl: string): string {
  const modulePath = fileURLToPath(moduleUrl);
  const moduleDir = dirname(modulePath);
  const candidates = [
    join(moduleDir, "ccc-campaign-proof-admission.js"),
    resolve(moduleDir, "../../dist/ccc-campaign-proof-admission.js"),
  ];
  for (const candidate of candidates) {
    const executable = regularExecutable(candidate);
    if (executable) return executable;
  }
  throw new Error(
    "CCC semantic-proof dedicated proof host is unavailable; build packages/cli/dist/ccc-campaign-proof-admission.js before executable authoring",
  );
}

/**
 * Resolve only deliberate production identities. In particular this never
 * falls back to process.argv[1], which may be Vitest, tsx, or another caller
 * that has no authority to become the persisted proof host.
 */
export function resolveCccPrdSemanticProofToolchainPaths(input: Readonly<{
  moduleUrl?: string;
  env?: NodeJS.ProcessEnv;
  nodeExecutablePath?: string;
}> = {}): CccPrdSemanticProofToolchainPaths {
  const nodeExecutablePath = regularExecutable(input.nodeExecutablePath ?? process.execPath);
  if (!nodeExecutablePath || !isAbsolute(nodeExecutablePath)) {
    throw new Error("CCC semantic-proof Node executable identity is unavailable");
  }
  return {
    taskExecutablePath: resolvePathExecutable("task", "Task", input.env ?? process.env),
    nodeExecutablePath,
    proofHost: {
      id: CCC_PRD_SEMANTIC_PROOF_HOST_ID,
      executablePath: resolveBuiltProofHost(input.moduleUrl ?? import.meta.url),
    },
  };
}
