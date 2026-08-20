import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveTrustedTestGitFile,
  resolveTrustedTestGitShell,
  pathUsesSafeExecGitShim,
} from "../__test-utils__/git-subprocess-policy.js";

const TRUSTED_GIT = "/usr/bin/git";

function policyContext() {
  const workerRoot = process.env.FUSION_TEST_WORKER_ROOT!;
  const cwd = join(workerRoot, "git-policy-repo");
  mkdirSync(cwd, { recursive: true });
  return { cwd, workerRoot, trustedGitBinary: TRUSTED_GIT, enableTrustedGitBypass: true };
}

describe("test git subprocess policy", () => {
  it("uses trusted git for argv invocations confined to the worker root", () => {
    const context = policyContext();

    expect(resolveTrustedTestGitFile("git", ["reset", "--hard", "HEAD"], context))
      .toBe(TRUSTED_GIT);
    expect(resolveTrustedTestGitFile("git", ["-C", context.cwd, "checkout", "--orphan", "next"], context))
      .toBe(TRUSTED_GIT);
  });

  it("trusts an explicit in-worker -C target even when the Vitest thread cwd is the package", () => {
    const context = policyContext();
    const nested = join(context.cwd, "nested");
    mkdirSync(nested, { recursive: true });

    expect(resolveTrustedTestGitFile("git", ["-C", context.cwd, "-C", "nested", "reset", "--hard", "HEAD"], {
      ...context,
      cwd: dirname(context.workerRoot),
    })).toBe(TRUSTED_GIT);
  });

  it("uses trusted git for a simple shell invocation confined to the worker root", () => {
    const context = policyContext();

    expect(resolveTrustedTestGitShell('git reset --hard "HEAD"', context))
      .toBe('/usr/bin/git reset --hard "HEAD"');
    expect(resolveTrustedTestGitShell("git status --short", context))
      .toBe("git status --short");
  });

  it("does not bypass the ambient git guard for an outside cwd or target", () => {
    const context = policyContext();
    const outside = dirname(context.workerRoot);

    expect(resolveTrustedTestGitFile("git", ["reset", "--hard", "HEAD"], {
      ...context,
      cwd: outside,
    })).toBe("git");
    expect(resolveTrustedTestGitFile("git", ["-C", outside, "reset", "--hard", "HEAD"], context))
      .toBe("git");
    expect(resolveTrustedTestGitFile("git", ["init", outside], context))
      .toBe("git");
    const traversalOutside = `nested/${relative(context.cwd, outside)}/../escape`;
    expect(resolveTrustedTestGitFile("git", ["-C", context.cwd, "init", traversalOutside], context))
      .toBe("git");
    expect(resolveTrustedTestGitFile("git", ["-C", context.cwd, "-c", `core.worktree=${outside}`, "reset", "--hard", "HEAD"], context))
      .toBe("git");
    expect(resolveTrustedTestGitFile("git", [`-C${outside}`, "reset", "--hard", "HEAD"], context))
      .toBe("git");
    expect(resolveTrustedTestGitFile("git", ["-C", context.cwd, `-ccore.worktree=${outside}`, "reset", "--hard", "HEAD"], context))
      .toBe("git");
    expect(resolveTrustedTestGitFile("git", ["-C", context.cwd, `--exec-path=${outside}`, "reset", "--hard", "HEAD"], context))
      .toBe("git");
    expect(resolveTrustedTestGitFile("git", ["-C", context.cwd, "config", `--file=${relative(context.cwd, outside)}/config`, "user.name", "bad"], context))
      .toBe("git");
    expect(resolveTrustedTestGitFile("git", ["-C", context.cwd, "-c", "core.quotePath=false", "reset", "--hard", "HEAD"], context))
      .toBe(TRUSTED_GIT);
  });

  it("rejects an explicit trusted binary when its target is outside the worker root", () => {
    const context = policyContext();
    const outside = dirname(context.workerRoot);

    expect(() => resolveTrustedTestGitFile(TRUSTED_GIT, ["-C", outside, "reset", "--hard", "HEAD"], context))
      .toThrow(/outside the Vitest worker root/);
    expect(() => resolveTrustedTestGitShell(`${TRUSTED_GIT} -C ${outside} reset --hard HEAD`, context))
      .toThrow(/outside the Vitest worker root/);
    expect(() => resolveTrustedTestGitFile(TRUSTED_GIT, [`-C${outside}`, "reset", "--hard", "HEAD"], context))
      .toThrow(/outside the Vitest worker root/);
    expect(() => resolveTrustedTestGitFile(TRUSTED_GIT, ["-C", context.cwd, "config", `--file=${relative(context.cwd, outside)}/config`, "user.name", "bad"], context))
      .toThrow(/outside the Vitest worker root/);
    expect(() => resolveTrustedTestGitShell(`${TRUSTED_GIT} -C ${outside} reset --hard HEAD && echo done`, context))
      .toThrow(/trusted git shell command/i);
    expect(() => resolveTrustedTestGitShell(`FOO=bar ${TRUSTED_GIT} -C ${outside} reset --hard HEAD`, context))
      .toThrow(/trusted git shell command/i);
  });

  it("does not bypass when git environment variables point outside the worker root", () => {
    const context = policyContext();

    expect(resolveTrustedTestGitFile("git", ["reset", "--hard", "HEAD"], {
      ...context,
      env: { ...process.env, GIT_WORK_TREE: dirname(context.workerRoot) },
    })).toBe("git");
    expect(resolveTrustedTestGitFile("git", ["reset", "--hard", "HEAD"], {
      ...context,
      env: { ...process.env, GIT_OBJECT_DIRECTORY: dirname(context.workerRoot) },
    })).toBe("git");
    expect(resolveTrustedTestGitFile("git", ["reset", "--hard", "HEAD"], {
      ...context,
      env: { ...process.env, GIT_SSH_COMMAND: "touch /tmp/escaped" },
    })).toBe("git");
    expect(resolveTrustedTestGitFile("git", ["reset", "--hard", "HEAD"], {
      ...context,
      env: { ...process.env, GIT_EXTERNAL_DIFF: "touch /tmp/escaped" },
    })).toBe("git");
    expect(resolveTrustedTestGitFile("git", ["reset", "--hard", "HEAD"], {
      ...context,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: dirname(context.workerRoot),
      },
    })).toBe("git");
    expect(resolveTrustedTestGitFile("git", ["reset", "--hard", "HEAD"], {
      ...context,
      env: { ...process.env, XDG_CONFIG_HOME: dirname(context.workerRoot) },
    })).toBe("git");
  });

  it("resolves symlinks before trusting an in-worker target", () => {
    const context = policyContext();
    const escape = join(context.cwd, "escape");
    symlinkSync("/usr", escape, "dir");

    expect(resolveTrustedTestGitFile("git", ["-C", escape, "reset", "--hard", "HEAD"], context))
      .toBe("git");
  });

  it("leaves compound shell commands and non-git commands untouched", () => {
    const context = policyContext();

    expect(resolveTrustedTestGitShell("git reset --hard HEAD && echo done", context))
      .toBe("git reset --hard HEAD && echo done");
    expect(resolveTrustedTestGitShell("git reset --hard HEAD\necho done", context))
      .toBe("git reset --hard HEAD\necho done");
    expect(resolveTrustedTestGitShell('git reset --hard "$(touch /tmp/escaped)"', context))
      .toBe('git reset --hard "$(touch /tmp/escaped)"');
    expect(resolveTrustedTestGitShell("git reset --hard *", context))
      .toBe("git reset --hard *");
    expect(resolveTrustedTestGitShell("git clone origin ~/outside", context))
      .toBe("git clone origin ~/outside");
    expect(resolveTrustedTestGitShell("git reset --hard HEAD~2", context))
      .toBe("/usr/bin/git reset --hard HEAD~2");
    expect(resolveTrustedTestGitFile("node", ["script.mjs"], context)).toBe("node");
  });

  it("does not prefer trusted git when the ambient binary is not a guarded shim", () => {
    const context = policyContext();

    expect(resolveTrustedTestGitFile("git", ["reset", "--hard", "HEAD"], {
      ...context,
      enableTrustedGitBypass: false,
    })).toBe("git");
  });

  it("detects the first git on an effective PATH instead of a module-load PATH", () => {
    const context = policyContext();
    const guardedBin = join(context.workerRoot, "guarded-bin");
    const plainBin = join(context.workerRoot, "plain-bin");
    mkdirSync(guardedBin, { recursive: true });
    mkdirSync(plainBin, { recursive: true });
    writeFileSync(join(guardedBin, "git"), "#!/bin/sh\nexec /usr/local/safeexec/bin/git \"$@\"\n");
    writeFileSync(join(plainBin, "git"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(guardedBin, "git"), 0o755);
    chmodSync(join(plainBin, "git"), 0o755);

    expect(pathUsesSafeExecGitShim([guardedBin, plainBin].join(delimiter))).toBe(true);
    expect(pathUsesSafeExecGitShim([plainBin, guardedBin].join(delimiter))).toBe(false);
  });
});
