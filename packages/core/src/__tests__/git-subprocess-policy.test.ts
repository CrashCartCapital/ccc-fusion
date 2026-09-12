import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isolateTrustedTestGitEnvironment,
  resolveTrustedTestGitFile,
  resolveTrustedTestGitShell,
  pathUsesSafeExecGitShim,
  shellUsesTrustedTestGit,
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
    expect(resolveTrustedTestGitShell("git revert --no-commit --no-edit 'abc123'", context))
      .toBe("/usr/bin/git revert --no-commit --no-edit 'abc123'");
    expect(resolveTrustedTestGitShell("git stash drop stash@{0}", context))
      .toBe("/usr/bin/git stash drop stash@{0}");
    expect(resolveTrustedTestGitShell("git stash apply abc123", context))
      .toBe("git stash apply abc123");
    expect(resolveTrustedTestGitShell("git switch main", context))
      .toBe("git switch main");
    expect(resolveTrustedTestGitFile(TRUSTED_GIT, [
      "-c", "user.name=Fusion CLI Test",
      "-c", "user.email=fusion-cli-test@example.invalid",
      "commit", "-m", "proof baseline",
    ], context)).toBe(TRUSTED_GIT);
  });

  it("names the rule that fired, plus the full invocation context, when it refuses", () => {
    const context = policyContext();
    const outside = dirname(context.workerRoot);

    // A refusal that only says "outside the worker root" cannot be triaged:
    // eight distinct conditions share the throw, and the message never showed
    // which one fired, what the resolved offending value was, or what the
    // worker root actually is. CI run 34617605454 produced 74 of these.
    const directoryRefusal = (() => {
      try {
        resolveTrustedTestGitFile(TRUSTED_GIT, ["-C", outside, "status"], context);
        throw new Error("expected a refusal");
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(directoryRefusal).toContain("rule=path-option-outside-worker-root");
    expect(directoryRefusal).toContain(`executable=${TRUSTED_GIT}`);
    expect(directoryRefusal).toContain("args=-C ");
    expect(directoryRefusal).toContain(`cwd=${context.cwd}`);
    expect(directoryRefusal).toContain(`workerRoot=${context.workerRoot}`);
    expect(directoryRefusal).toContain(outside);

    // core.fsmonitor=false and core.hooksPath=<null device> are now allowlisted
    // (production hardening in ccc-campaign-local-git.ts runGitRaw, among
    // others, passes them unconditionally -- see the dedicated allowlist tests
    // below). A hardening -c option the allowlist still does not name, such as
    // a mismatched boolean, is the shape that must keep refusing.
    const configRefusal = (() => {
      try {
        resolveTrustedTestGitFile(
          TRUSTED_GIT,
          ["-c", "core.fsmonitor=true", "-C", context.cwd, "rev-parse", "--is-inside-work-tree"],
          context,
        );
        throw new Error("expected a refusal");
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(configRefusal).toContain("rule=config-option-not-allowlisted");
    expect(configRefusal).toContain("core.fsmonitor=true");

    const envRefusal = (() => {
      try {
        resolveTrustedTestGitFile(TRUSTED_GIT, ["status"], {
          ...context,
          env: { ...process.env, GIT_WORK_TREE: outside },
        });
        throw new Error("expected a refusal");
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(envRefusal).toContain("rule=git-path-env-outside-worker-root");
    expect(envRefusal).toContain("GIT_WORK_TREE");
  });

  it("allows the git-worker-root hardening config production Git wrappers pass unconditionally", () => {
    const context = policyContext();
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";

    // ccc-campaign-local-git.ts runGitRaw, ccc-campaign-required-commit.ts and
    // ccc-campaign-join-base.ts all pass core.fsmonitor=false and
    // core.hooksPath=<null device> on every invocation as containment-neutral
    // hardening (disable the fsmonitor daemon; disable hooks by pointing
    // hooksPath at the null device). runGitRaw additionally passes
    // core.untrackedCache=false on `ls-files --others` invocations. On Linux
    // CI this policy refused all of them with
    // rule=config-option-not-allowlisted -- the guard only trips there
    // because wellKnownGitBinaryPaths never treats a macOS developer git
    // binary as "trusted", so the strict branch was Linux-only.
    expect(resolveTrustedTestGitFile(
      TRUSTED_GIT,
      [
        "-c", "core.fsmonitor=false",
        "-c", `core.hooksPath=${nullDevice}`,
        "-c", "core.untrackedCache=false",
        "-C", context.cwd, "ls-files", "--others",
      ],
      context,
    )).toBe(TRUSTED_GIT);

    // Each option is accepted independently of the others and regardless of
    // ordering, matching how the production call sites order them
    // differently from one another.
    expect(resolveTrustedTestGitFile(
      TRUSTED_GIT,
      ["-c", `core.hooksPath=${nullDevice}`, "-c", "core.fsmonitor=false", "-C", context.cwd, "status", "--short"],
      context,
    )).toBe(TRUSTED_GIT);
    expect(resolveTrustedTestGitFile(
      TRUSTED_GIT,
      ["-c", "core.fsmonitor=false", "-C", context.cwd, "status", "--short"],
      context,
    )).toBe(TRUSTED_GIT);
    expect(resolveTrustedTestGitFile(
      TRUSTED_GIT,
      ["-c", `core.hooksPath=${nullDevice}`, "-C", context.cwd, "status", "--short"],
      context,
    )).toBe(TRUSTED_GIT);
    expect(resolveTrustedTestGitFile(
      TRUSTED_GIT,
      ["-c", "core.untrackedCache=false", "-C", context.cwd, "ls-files", "--others"],
      context,
    )).toBe(TRUSTED_GIT);
  });

  it("keeps refusing hardening-shaped -c options the allowlist does not name exactly", () => {
    const context = policyContext();
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    const wrongHooksPath = "/somewhere/else";

    const refusalFor = (config: string): string => {
      try {
        resolveTrustedTestGitFile(TRUSTED_GIT, ["-c", config, "-C", context.cwd, "status"], context);
        throw new Error(`expected a refusal for -c ${config}`);
      } catch (error) {
        return (error as Error).message;
      }
    };

    // A hooksPath value that is not the platform null device stays refused --
    // hooks execute arbitrary code, so the allowlist matches the exact device
    // path rather than any core.hooksPath value.
    expect(refusalFor(`core.hooksPath=${wrongHooksPath}`)).toContain("rule=config-option-not-allowlisted");
    expect(refusalFor(`core.hooksPath=${wrongHooksPath}`)).toContain(`core.hooksPath=${wrongHooksPath}`);

    // A mismatched boolean stays refused -- the allowlist matches the exact
    // value "false", not the bare option name.
    expect(refusalFor("core.fsmonitor=true")).toContain("rule=config-option-not-allowlisted");
    expect(refusalFor("core.fsmonitor=true")).toContain("core.fsmonitor=true");
    expect(refusalFor("core.untrackedCache=true")).toContain("rule=config-option-not-allowlisted");
    expect(refusalFor("core.untrackedCache=true")).toContain("core.untrackedCache=true");

    // An unrelated -c option is unaffected by this allowlist addition.
    expect(refusalFor("core.editor=vim")).toContain("rule=config-option-not-allowlisted");

    // Exact-value matching, not prefix matching: a value that merely starts
    // with an allowlisted value must not slip through.
    expect(refusalFor("core.fsmonitor=false-ish")).toContain("rule=config-option-not-allowlisted");
    expect(refusalFor(`core.hooksPath=${nullDevice}-ish`)).toContain("rule=config-option-not-allowlisted");
    expect(refusalFor("core.untrackedCache=false-ish")).toContain("rule=config-option-not-allowlisted");
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
    const relativeTrustedAlias = join(context.cwd, "trusted-git-alias");
    symlinkSync(TRUSTED_GIT, relativeTrustedAlias);

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
    expect(() => resolveTrustedTestGitFile("/usr/bin/./git", ["-C", outside, "reset", "--hard", "HEAD"], context))
      .toThrow(/outside the Vitest worker root/);
    expect(() => resolveTrustedTestGitShell(`/usr/bin/./git -C ${outside} reset --hard HEAD`, context))
      .toThrow(/outside the Vitest worker root/);
    expect(() => resolveTrustedTestGitFile("./trusted-git-alias", ["-C", outside, "reset", "--hard", "HEAD"], context))
      .toThrow(/outside the Vitest worker root/);
    expect(() => resolveTrustedTestGitShell(`./trusted-git-alias -C ${outside} reset --hard HEAD`, context))
      .toThrow(/outside the Vitest worker root/);
    expect(() => resolveTrustedTestGitShell(`echo $(/usr/bin/git -C ${outside} reset --hard HEAD)`, context))
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
    expect(resolveTrustedTestGitFile("git", ["reset", "--hard", "HEAD"], {
      ...context,
      env: { ...process.env, GIT_CONFIG_GLOBAL: join(context.workerRoot, "host.gitconfig") },
    })).toBe("git");
    expect(resolveTrustedTestGitFile("git", ["reset", "--hard", "HEAD"], {
      ...context,
      env: { ...process.env, GIT_CONFIG_SYSTEM: join(context.workerRoot, "host.gitconfig") },
    })).toBe("git");
    expect(resolveTrustedTestGitFile("git", ["reset", "--hard", "HEAD"], {
      ...context,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "0" },
    })).toBe("git");
    expect(resolveTrustedTestGitFile("git", ["reset", "--hard", "HEAD"], {
      ...context,
      env: { ...process.env, GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/tmp'" },
    })).toBe("git");
    expect(resolveTrustedTestGitFile("git", ["reset", "--hard", "HEAD"], {
      ...context,
      env: { ...process.env, GIT_TRACE: join(dirname(context.workerRoot), "trace.log") },
    })).toBe("git");
    expect(resolveTrustedTestGitFile("git", ["reset", "--hard", "HEAD"], {
      ...context,
      env: { ...process.env, GIT_EXEC_PATH: dirname(context.workerRoot) },
    })).toBe("git");
    expect(resolveTrustedTestGitFile("git", ["reset", "--hard", "HEAD"], {
      ...context,
      env: { ...process.env, GIT_TEMPLATE_DIR: dirname(context.workerRoot) },
    })).toBe("git");
  });

  it("accepts the null device as an explicit no-config boundary", () => {
    const context = policyContext();
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    const tracePath = join(context.workerRoot, "git-trace.json");

    expect(resolveTrustedTestGitFile(TRUSTED_GIT, ["-C", context.cwd, "status", "--short"], {
      ...context,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: nullDevice,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: nullDevice,
        GIT_TRACE2_EVENT: tracePath,
      },
    })).toBe(TRUSTED_GIT);
  });

  it("forces every trusted git subprocess off host Git configuration", () => {
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";

    expect(isolateTrustedTestGitEnvironment({
      HOME: "/worker/home",
      GIT_CONFIG_GLOBAL: "/host/global.gitconfig",
      GIT_CONFIG_SYSTEM: "/host/system.gitconfig",
      GIT_CONFIG_NOSYSTEM: "0",
    })).toMatchObject({
      HOME: "/worker/home",
      GIT_CONFIG_GLOBAL: nullDevice,
      GIT_CONFIG_SYSTEM: nullDevice,
      GIT_CONFIG_NOSYSTEM: "1",
    });
  });

  it("reroutes a contained invocation when a display-only pager variable is set", () => {
    const context = policyContext();
    const outside = dirname(context.workerRoot);
    const contained = ["-C", context.cwd, "checkout", "--quiet", "--detach", "HEAD"];

    // PAGER, GIT_PAGER and GIT_EDITOR only name programs that display or edit text.
    // None of them can move a git invocation outside the worker root, so none of them
    // may veto a reroute whose target is already contained.
    expect(resolveTrustedTestGitFile("git", contained, { ...context, env: { PAGER: "less" } }))
      .toBe(TRUSTED_GIT);
    expect(resolveTrustedTestGitFile("git", contained, { ...context, env: { GIT_PAGER: "delta" } }))
      .toBe(TRUSTED_GIT);
    expect(resolveTrustedTestGitFile("git", contained, { ...context, env: { GIT_EDITOR: "vim" } }))
      .toBe(TRUSTED_GIT);

    // Containment is unchanged: an out-of-worker target still declines.
    expect(resolveTrustedTestGitFile("git", ["-C", outside, "checkout", "--quiet", "--detach", "HEAD"], {
      ...context,
      env: { PAGER: "less" },
    })).toBe("git");
  });

  it("neutralizes display-only git environment variables on the trusted path", () => {
    expect(isolateTrustedTestGitEnvironment({ PAGER: "less", GIT_PAGER: "delta", GIT_EDITOR: "vim" }))
      .toMatchObject({ PAGER: "cat", GIT_PAGER: "cat", GIT_EDITOR: "true" });
  });

  it("recognizes trusted shell Git across supported whitespace", () => {
    expect(shellUsesTrustedTestGit("  /usr/bin/git\tstatus --short")).toBe(true);
    expect(shellUsesTrustedTestGit("/usr/bin/git-other status --short")).toBe(false);
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
    expect(resolveTrustedTestGitShell("/usr/bin/git-lfs status", context))
      .toBe("/usr/bin/git-lfs status");
    expect(resolveTrustedTestGitShell("git commit -m foo/usr/bin/git", context))
      .toBe("git commit -m foo/usr/bin/git");
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
