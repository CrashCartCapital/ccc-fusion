import { CccPlanningRefusal } from "./errors.js";

/*
FNXC:CccPlanningRuntimeIdentity 2026-10-14-09:10:
The engine process that runs request-to-code work registers the SHA-256 of its installed dist manifest once at startup (D44). The stage host, the review path and the Build bridge then refuse any run whose admission recorded a different runtime, and refuse every run while nothing is registered, so a run admitted under one build can never be advanced by another. Registration is idempotent for the same digest and throws for a different one, because a process cannot change which code it is running.
*/

const SHA256_HEX = /^[0-9a-f]{64}$/u;

let registered: string | null = null;

export function registerCccRunningRuntimeDistManifest(sha256: string): void {
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
    throw new TypeError("running runtime dist manifest digest must be a lowercase sha256");
  }
  if (registered === sha256) return;
  if (registered !== null) {
    throw new Error(`running runtime dist manifest already registered as ${registered}; refusing ${sha256}`);
  }
  registered = sha256;
}

export function readCccRunningRuntimeDistManifest(): string | null {
  return registered;
}

export function assertCccRunningRuntimePermitted(run: Readonly<{ runtimeDistManifestSha256: string }>): void {
  if (registered === null) {
    throw new CccPlanningRefusal("CCC_PLANNING_RUNTIME_NOT_PERMITTED", "no running runtime dist manifest is registered", "runtimeDistManifestSha256");
  }
  if (run.runtimeDistManifestSha256 !== registered) {
    throw new CccPlanningRefusal(
      "CCC_PLANNING_RUNTIME_NOT_PERMITTED",
      `run was admitted under runtime ${run.runtimeDistManifestSha256}, this process runs ${registered}`,
      "runtimeDistManifestSha256",
    );
  }
}
