import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CCC_PRD_SEMANTIC_PROOF_HOST_ID } from "@fusion/core";
import { resolveCccPrdSemanticProofToolchainPaths } from "../ccc-semantic-proof-toolchain.js";
import { repoRoot } from "./prd-built-cli-fixture.js";

describe("CCC semantic-proof CLI toolchain resolver", () => {
  it("RED-S5-dedicated-proof-host: binds a movable self-contained proof host and never the ambient test runner", () => {
    const resolved = resolveCccPrdSemanticProofToolchainPaths();
    expect(resolved).toMatchObject({
      nodeExecutablePath: realpathSync(process.execPath),
      proofHost: {
        id: CCC_PRD_SEMANTIC_PROOF_HOST_ID,
        executablePath: realpathSync(join(
          repoRoot,
          "packages/cli/dist/ccc-campaign-proof-admission.js",
        )),
      },
    });
    expect(resolved.proofHost.executablePath).not.toBe(realpathSync(process.argv[1]!));
    expect(resolved.taskExecutablePath).toMatch(/\/task$/u);

    const isolatedRoot = mkdtempSync(join(tmpdir(), "ccc-semantic-proof-host-"));
    try {
      const isolatedHost = join(isolatedRoot, "ccc-campaign-proof-admission.js");
      copyFileSync(resolved.proofHost.executablePath, isolatedHost);
      chmodSync(isolatedHost, 0o555);
      const probe = spawnSync(resolved.nodeExecutablePath, [isolatedHost, "--version"], {
        encoding: "utf8",
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      });
      expect(probe.status, probe.stderr).toBe(0);
      expect(probe.stdout.trim()).toBe(CCC_PRD_SEMANTIC_PROOF_HOST_ID);
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when Task is not available on the admitted PATH", () => {
    expect(() => resolveCccPrdSemanticProofToolchainPaths({
      env: { PATH: "/definitely/missing" },
    })).toThrow(/Task executable is absent from PATH/u);
  });

  it("RED-R1-python-semantic-v2-toolchain: admits an explicitly controller-selected python3 executable without ambient fallback", () => {
    const pythonExecutablePath = process.platform === "darwin"
      ? "/opt/homebrew/bin/python3"
      : "/usr/bin/python3";
    const resolved = resolveCccPrdSemanticProofToolchainPaths({ pythonExecutablePath } as any);
    expect(resolved.pythonExecutablePath).toBe(realpathSync(pythonExecutablePath));
  });
});
