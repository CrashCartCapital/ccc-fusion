import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CCC_PRD_SEMANTIC_PROOF_HOST_ID } from "@fusion/core";
import {
  itRequiresPython3,
  itRequiresVersionedPython3,
  resolvePython3Binary,
  resolveVersionedPython3Binary,
} from "../../../../core/src/__test-utils__/proof-host-tools.js";
import {
  resolveCccPrdSemanticProofToolchainPaths,
  resolveCccPrdTargetPythonPathRoots,
} from "../ccc-semantic-proof-toolchain.js";
import { repoRoot } from "./prd-built-cli-fixture.js";

/**
 * The host's real python3, resolved the same way the shared proof-host gate
 * resolves it (PATH lookup, then a live `--version` probe). A hardcoded
 * `/usr/bin/python3` or `/opt/homebrew/bin/python3` only exists on a
 * Homebrew-managed Darwin host or a traditional Linux distro install; a
 * uv-managed venv interpreter (as CI now provisions on Linux) resolves through
 * a `python3` PATH entry instead, so tests that need "some real python3
 * launcher" must resolve it the same way, not assume a fixed path per
 * platform. Callers only reach this from an `itRequiresPython3`-gated test, so
 * a null result here means the gate itself has a defect, not a missing host
 * capability.
 */
function resolveTestPython3Launcher(): string {
  const resolved = resolvePython3Binary();
  if (!resolved) {
    throw new Error(
      "resolvePython3Binary() found no python3 on PATH; itRequiresPython3 should have skipped this test",
    );
  }
  return resolved;
}

/**
 * Like `resolveTestPython3Launcher`, but for the target-venv fixtures below
 * that build a fake `.venv` matched to the real interpreter's `X.Y` version
 * (`lib/pythonX.Y/site-packages`). Those fixtures need a python3 whose
 * canonical (realpath) form is a versioned `pythonX.Y` binary -- a
 * version-manager shim (pyenv, asdf, ...) is real and on PATH but does not
 * resolve to one, so plain PATH resolution is not enough here. Callers only
 * reach this from an `itRequiresVersionedPython3`-gated test.
 */
function resolveTestVersionedPython3Launcher(): string {
  const resolved = resolveVersionedPython3Binary();
  if (!resolved) {
    throw new Error(
      "resolveVersionedPython3Binary() found no versioned python3 on PATH; "
      + "itRequiresVersionedPython3 should have skipped this test",
    );
  }
  return resolved.launcherPath;
}

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

  itRequiresPython3("RED-R1-python-semantic-v2-toolchain: admits an explicitly controller-selected python3 executable without ambient fallback", () => {
    const pythonExecutablePath = resolveTestPython3Launcher();
    const resolved = resolveCccPrdSemanticProofToolchainPaths({ pythonExecutablePath } as any);
    expect(resolved.pythonExecutablePath).toBe(realpathSync(pythonExecutablePath));
  });

  itRequiresPython3("RED-R1-python-semantic-v2-pythonpath: forwards a canonical target .venv site-packages root", () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "ccc-semantic-proof-pythonpath-"));
    try {
      const sitePackagesRoot = join(isolatedRoot, ".venv", "lib", "python3.12", "site-packages");
      mkdirSync(sitePackagesRoot, { recursive: true });
      const canonicalSitePackagesRoot = realpathSync(sitePackagesRoot);
      const pythonExecutablePath = resolveTestPython3Launcher();
      const resolved = resolveCccPrdSemanticProofToolchainPaths({
        pythonExecutablePath,
        pythonPathRoots: [canonicalSitePackagesRoot],
      });
      expect(resolved.pythonPathRoots).toEqual([canonicalSitePackagesRoot]);
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  itRequiresVersionedPython3("RED-R1-python-semantic-v2-target-venv: resolves the active target interpreter and exactly one versioned site-packages root", () => {
    const targetRoot = mkdtempSync(join(tmpdir(), "ccc-semantic-proof-target-venv-"));
    try {
      const launcher = resolveTestVersionedPython3Launcher();
      const canonicalPython = realpathSync(launcher);
      const version = basename(canonicalPython).match(/^python(\d+\.\d+)$/u)?.[1];
      if (!version) throw new Error(`test launcher is not versioned: ${canonicalPython}`);
      const venvRoot = join(targetRoot, ".venv");
      const sitePackagesRoot = join(venvRoot, "lib", `python${version}`, "site-packages");
      mkdirSync(join(venvRoot, "bin"), { recursive: true });
      mkdirSync(sitePackagesRoot, { recursive: true });
      symlinkSync(canonicalPython, join(venvRoot, "bin", "python3"));
      writeFileSync(join(venvRoot, "pyvenv.cfg"), [
        `home = ${dirname(canonicalPython)}`,
        `version_info = ${version}`,
        "include-system-site-packages = false",
        "",
      ].join("\n"));

      const resolved = resolveCccPrdSemanticProofToolchainPaths({
        pythonRequired: true,
        targetRoot,
      } as never);

      expect(resolved.pythonExecutablePath).toBe(canonicalPython);
      expect(resolved.pythonPathRoots).toEqual([realpathSync(sitePackagesRoot)]);
      expect(resolveCccPrdTargetPythonPathRoots(targetRoot)).toEqual([realpathSync(sitePackagesRoot)]);
    } finally {
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  itRequiresVersionedPython3("RED-R1-python-semantic-v2-target-venv: admits a resolved uv-style home alias that matches the canonical interpreter home", () => {
    const targetRoot = mkdtempSync(join(tmpdir(), "ccc-semantic-proof-target-venv-home-alias-"));
    try {
      const launcher = resolveTestVersionedPython3Launcher();
      const canonicalPython = realpathSync(launcher);
      const version = basename(canonicalPython).match(/^python(\d+\.\d+)$/u)?.[1];
      if (!version) throw new Error(`test launcher is not versioned: ${canonicalPython}`);
      const venvRoot = join(targetRoot, ".venv");
      const sitePackagesRoot = join(venvRoot, "lib", `python${version}`, "site-packages");
      const homeAlias = join(targetRoot, "python-home-alias");
      mkdirSync(join(venvRoot, "bin"), { recursive: true });
      mkdirSync(sitePackagesRoot, { recursive: true });
      symlinkSync(dirname(canonicalPython), homeAlias, "dir");
      symlinkSync(canonicalPython, join(venvRoot, "bin", "python3"));
      writeFileSync(join(venvRoot, "pyvenv.cfg"), [
        `home = ${homeAlias}`,
        `version_info = ${version}`,
        "include-system-site-packages = false",
        "",
      ].join("\n"));

      const resolved = resolveCccPrdSemanticProofToolchainPaths({
        pythonRequired: true,
        targetRoot,
      } as never);

      expect(resolved.pythonExecutablePath).toBe(canonicalPython);
      expect(resolved.pythonPathRoots).toEqual([realpathSync(sitePackagesRoot)]);
    } finally {
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  itRequiresVersionedPython3("RED-R1-python-semantic-v2-target-venv: refuses absent, ambiguous, symlinked, and mismatched active roots", () => {
    const makeTarget = (setup: (venvRoot: string, version: string, canonicalPython: string) => void) => {
      const targetRoot = mkdtempSync(join(tmpdir(), "ccc-semantic-proof-target-venv-invalid-"));
      const venvRoot = join(targetRoot, ".venv");
      const launcher = resolveTestVersionedPython3Launcher();
      const canonicalPython = realpathSync(launcher);
      const version = basename(canonicalPython).match(/^python(\d+\.\d+)$/u)?.[1] ?? "3.12";
      mkdirSync(join(venvRoot, "bin"), { recursive: true });
      symlinkSync(canonicalPython, join(venvRoot, "bin", "python3"));
      writeFileSync(join(venvRoot, "pyvenv.cfg"), [
        `home = ${dirname(canonicalPython)}`,
        `version_info = ${version}`,
        "include-system-site-packages = false",
        "",
      ].join("\n"));
      setup(venvRoot, version, canonicalPython);
      return targetRoot;
    };

    const absent = mkdtempSync(join(tmpdir(), "ccc-semantic-proof-target-venv-absent-"));
    expect(() => resolveCccPrdSemanticProofToolchainPaths({
      pythonRequired: true,
      targetRoot: absent,
    } as never)).toThrow(/\.venv|Python/u);
    rmSync(absent, { recursive: true, force: true });

    const ambiguous = makeTarget((venvRoot, version) => {
      mkdirSync(join(venvRoot, "lib", `python${version}`, "site-packages"), { recursive: true });
      mkdirSync(join(venvRoot, "lib", "python9.9", "site-packages"), { recursive: true });
    });
    expect(() => resolveCccPrdSemanticProofToolchainPaths({
      pythonRequired: true,
      targetRoot: ambiguous,
    } as never)).toThrow(/ambiguous|site-packages/u);
    rmSync(ambiguous, { recursive: true, force: true });

    const symlinked = makeTarget((venvRoot, version) => {
      const realRoot = join(venvRoot, "lib", `python${version}`, "site-packages-real");
      mkdirSync(realRoot, { recursive: true });
      symlinkSync(realRoot, join(venvRoot, "lib", `python${version}`, "site-packages"));
    });
    expect(() => resolveCccPrdSemanticProofToolchainPaths({
      pythonRequired: true,
      targetRoot: symlinked,
    } as never)).toThrow(/symlink|site-packages/u);
    rmSync(symlinked, { recursive: true, force: true });

    const mismatched = makeTarget((venvRoot, version, canonicalPython) => {
      writeFileSync(join(venvRoot, "pyvenv.cfg"), [
        `home = ${dirname(canonicalPython)}`,
        `version_info = ${version === "3.12" ? "3.13" : "3.12"}`,
        "include-system-site-packages = false",
        "",
      ].join("\n"));
      mkdirSync(join(venvRoot, "lib", `python${version}`, "site-packages"), { recursive: true });
    });
    expect(() => resolveCccPrdSemanticProofToolchainPaths({
      pythonRequired: true,
      targetRoot: mismatched,
    } as never)).toThrow(/mismatch|version|site-packages/u);
    rmSync(mismatched, { recursive: true, force: true });

    const homeMismatched = makeTarget((venvRoot, version, canonicalPython) => {
      writeFileSync(join(venvRoot, "pyvenv.cfg"), [
        "home = /tmp",
        `version_info = ${version}`,
        "include-system-site-packages = false",
        "",
      ].join("\n"));
      mkdirSync(join(venvRoot, "lib", `python${version}`, "site-packages"), { recursive: true });
      expect(dirname(canonicalPython)).not.toBe("/tmp");
    });
    expect(() => resolveCccPrdSemanticProofToolchainPaths({
      pythonRequired: true,
      targetRoot: homeMismatched,
    } as never)).toThrow(/canonical|mismatch|version/u);
    rmSync(homeMismatched, { recursive: true, force: true });

    const homeAliasMismatched = makeTarget((venvRoot, version, canonicalPython) => {
      const wrongHome = join(dirname(venvRoot), "wrong-python-home");
      const wrongHomeAlias = join(dirname(venvRoot), "wrong-python-home-alias");
      mkdirSync(wrongHome);
      symlinkSync(wrongHome, wrongHomeAlias, "dir");
      writeFileSync(join(venvRoot, "pyvenv.cfg"), [
        `home = ${wrongHomeAlias}`,
        `version_info = ${version}`,
        "include-system-site-packages = false",
        "",
      ].join("\n"));
      mkdirSync(join(venvRoot, "lib", `python${version}`, "site-packages"), { recursive: true });
      expect(realpathSync(wrongHomeAlias)).not.toBe(dirname(canonicalPython));
    });
    expect(() => resolveCccPrdSemanticProofToolchainPaths({
      pythonRequired: true,
      targetRoot: homeAliasMismatched,
    } as never)).toThrow(/mismatch|version/u);
    rmSync(homeAliasMismatched, { recursive: true, force: true });
  });
});
