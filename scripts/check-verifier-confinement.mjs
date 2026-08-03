#!/usr/bin/env node

import { spawnSync } from "node:child_process";

function boundedText(value) {
  return typeof value === "string" ? value.slice(0, 512) : "";
}

function emit(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function inspectTaskToolchain() {
  const probe = spawnSync("task", ["--version"], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  const taskVersion = boundedText(`${probe.stdout ?? ""}\n${probe.stderr ?? ""}`.trim());
  if (probe.status === 0 && taskVersion.length > 0) {
    return { ready: true, taskVersion, detail: "" };
  }

  const detail = boundedText(
    probe.error instanceof Error
      ? probe.error.message
      : taskVersion || `task --version exited ${probe.status ?? "without a status"}`,
  );
  return { ready: false, taskVersion: "", detail };
}

const toolchain = inspectTaskToolchain();
if (!toolchain.ready) {
  emit({
    kind: "fusion.verifier-confinement-readiness.v1",
    ready: false,
    backend: null,
    code: "VERIFIER_TOOLCHAIN_UNAVAILABLE",
    message: "Go Task is required to execute admitted requirement verifiers on this runner.",
    trustedPaths: [],
    detail: toolchain.detail,
    taskVersion: "",
  });
  process.exitCode = 1;
} else {
  try {
    const engine = await import("../packages/engine/dist/index.js");
    if (typeof engine.inspectVerifierConfinementReadiness !== "function") {
      throw new Error("Built engine does not export inspectVerifierConfinementReadiness");
    }

    const inspected = await engine.inspectVerifierConfinementReadiness();
    const backend =
      inspected?.backend === "sandbox-exec" || inspected?.backend === "bubblewrap"
        ? inspected.backend
        : null;
    const ready = inspected?.ready === true && backend !== null;
    const result = {
      kind: "fusion.verifier-confinement-readiness.v1",
      ready,
      backend,
      code: boundedText(inspected?.code) || "VERIFIER_CONFINEMENT_INVALID_RESULT",
      message: boundedText(inspected?.message) || "Verifier confinement readiness returned no message",
      trustedPaths: Array.isArray(inspected?.trustedPaths)
        ? inspected.trustedPaths
            .filter((value) => typeof value === "string")
            .slice(0, 4)
            .map((value) => value.slice(0, 512))
        : [],
      detail: boundedText(inspected?.detail),
      taskVersion: toolchain.taskVersion,
    };

    emit(result);
    if (!ready) {
      process.exitCode = 1;
    }
  } catch (error) {
    emit({
      kind: "fusion.verifier-confinement-readiness.v1",
      ready: false,
      backend: null,
      code: "VERIFIER_CONFINEMENT_PREFLIGHT_ERROR",
      message: boundedText(error instanceof Error ? error.message : String(error)),
      trustedPaths: [],
      detail: "",
      taskVersion: toolchain.taskVersion,
    });
    process.exitCode = 1;
  }
}
