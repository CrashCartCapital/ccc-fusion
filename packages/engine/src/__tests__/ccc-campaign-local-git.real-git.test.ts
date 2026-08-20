import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { devNull, tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const gitBinaryCatalogOverride = vi.hoisted(() => ({
  paths: undefined as string[] | undefined,
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    wellKnownGitBinaryPaths: (
      ...args: Parameters<typeof actual.wellKnownGitBinaryPaths>
    ): string[] => (
      gitBinaryCatalogOverride.paths
      ?? actual.wellKnownGitBinaryPaths(...args)
    ),
  };
});

import {
  inspectCccCampaignLocalGit,
  recheckCccCampaignLocalGit,
} from "../ccc-campaign-local-git.js";

const cleanupRoots: string[] = [];

function track(path: string): string {
  cleanupRoots.push(path);
  return path;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepository(
  objectFormat: "sha1" | "sha256" = "sha1",
): { root: string; base: string } {
  const root = track(mkdtempSync(join(tmpdir(), "ccc-campaign-local-git-")));
  const initArgs = ["init", "-q", "-b", "main"];
  if (objectFormat !== "sha1") {
    initArgs.push(`--object-format=${objectFormat}`);
  }
  git(root, initArgs);
  git(root, ["config", "user.name", "CCC Test"]);
  git(root, ["config", "user.email", "ccc-test@example.invalid"]);
  writeFileSync(join(root, "tracked.txt"), "base\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-q", "-m", "base"]);
  return { root: realpathSync(root), base: git(root, ["rev-parse", "HEAD"]) };
}

function commitDescendant(root: string, contents = "descendant\n"): string {
  writeFileSync(join(root, "tracked.txt"), contents);
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-q", "-m", "descendant"]);
  return git(root, ["rev-parse", "HEAD"]);
}

function objectStoreFiles(root: string): string[] {
  const objectRoot = join(root, ".git", "objects");
  const files: string[] = [];
  const visit = (directory: string, relative: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const childRelative = join(relative, entry.name);
      const child = join(directory, entry.name);
      if (entry.isDirectory()) visit(child, childRelative);
      else files.push(childRelative);
    }
  };
  visit(objectRoot, "");
  return files.sort();
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readRecordedEnvironment(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        return separator < 0
          ? [entry, ""]
          : [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error
      && typeof error === "object"
      && (error as NodeJS.ErrnoException).code !== "ESRCH",
    );
  }
}

async function waitForPath(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await delay(10);
  }
  return existsSync(path);
}

function mkfifoSync(path: string): void {
  execFileSync("/usr/bin/mkfifo", [path], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function releaseBlockedFifo(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        path,
        fsConstants.O_WRONLY | fsConstants.O_NONBLOCK,
      );
      writeSync(descriptor, Buffer.from("base\n", "utf8"));
      return;
    } catch (error) {
      if (
        !error
        || typeof error !== "object"
        || (error as NodeJS.ErrnoException).code !== "ENXIO"
      ) {
        throw error;
      }
      await delay(10);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  throw new Error("Timed out releasing the exact tracked FIFO");
}

afterEach(() => {
  gitBinaryCatalogOverride.paths = undefined;
  for (const root of cleanupRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("CCC campaign local Git observation", () => {
  it("returns a frozen physical snapshot for a clean descendant checkout", async () => {
    const { root, base } = createRepository();
    const head = commitDescendant(root);

    const snapshot = await inspectCccCampaignLocalGit({
      targetRoot: root,
      expectedBaseObject: base,
    });

    expect(snapshot).toMatchObject({
      targetRoot: root,
      gitDir: realpathSync(join(root, ".git")),
      gitCommonDir: realpathSync(join(root, ".git")),
      expectedBaseObject: base,
      head,
      headDescendsFromExpectedBase: true,
      dirty: false,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.physicalIdentity)).toBe(true);
    expect(snapshot.gitBinary).toBe(realpathSync(snapshot.gitBinary));
    for (const identity of Object.values(snapshot.physicalIdentity)) {
      expect(Object.isFrozen(identity)).toBe(true);
      expect(typeof identity.dev).toBe("bigint");
      expect(typeof identity.ino).toBe("bigint");
    }
  });

  it("hashes tracked worktree blobs using the repository SHA-256 object format", async () => {
    const { root, base } = createRepository("sha256");

    await expect(inspectCccCampaignLocalGit({
      targetRoot: root,
      expectedBaseObject: base,
    })).resolves.toMatchObject({
      expectedBaseObject: base,
      head: base,
      dirty: false,
    });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects noncanonical and missing expected base objects", async () => {
    const { root, base } = createRepository();

    await expect(inspectCccCampaignLocalGit({
      targetRoot: root,
      expectedBaseObject: base.toUpperCase(),
    })).rejects.toThrow(/canonical/i);
    await expect(inspectCccCampaignLocalGit({
      targetRoot: root,
      expectedBaseObject: "f".repeat(base.length),
    })).rejects.toThrow(/resolve expected base/i);
  });

  it("rejects a clean HEAD that does not descend from the expected base", async () => {
    const { root, base } = createRepository();
    git(root, ["switch", "-q", "--orphan", "foreign"]);
    writeFileSync(join(root, "foreign.txt"), "foreign\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "foreign"]);

    await expect(inspectCccCampaignLocalGit({
      targetRoot: root,
      expectedBaseObject: base,
    })).rejects.toThrow(/does not descend/i);
  });

  it("rejects foreign ancestry spoofed by an inherited Git graft file", async () => {
    const { root, base } = createRepository();
    git(root, ["switch", "-q", "--orphan", "grafted-foreign"]);
    writeFileSync(join(root, "foreign.txt"), "foreign\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "grafted foreign"]);
    const foreignHead = git(root, ["rev-parse", "HEAD"]);
    const graftRoot = track(mkdtempSync(join(tmpdir(), "ccc-campaign-graft-")));
    const graftFile = join(graftRoot, "grafts");
    writeFileSync(graftFile, `${foreignHead} ${base}\n`);
    const priorGraftFile = process.env.GIT_GRAFT_FILE;
    process.env.GIT_GRAFT_FILE = graftFile;
    try {
      await expect(inspectCccCampaignLocalGit({
        targetRoot: root,
        expectedBaseObject: base,
      })).rejects.toThrow(/does not descend/i);
    } finally {
      if (priorGraftFile === undefined) delete process.env.GIT_GRAFT_FILE;
      else process.env.GIT_GRAFT_FILE = priorGraftFile;
    }
  });

  it.each([
    ["staged", (root: string) => {
      writeFileSync(join(root, "tracked.txt"), "staged\n");
      git(root, ["add", "tracked.txt"]);
    }],
    ["unstaged", (root: string) => {
      writeFileSync(join(root, "tracked.txt"), "unstaged\n");
    }],
    ["untracked", (root: string) => {
      writeFileSync(join(root, "untracked.txt"), "untracked\n");
    }],
  ])("rejects a %s worktree", async (_kind, makeDirty) => {
    const { root, base } = createRepository();
    makeDirty(root);

    await expect(inspectCccCampaignLocalGit({
      targetRoot: root,
      expectedBaseObject: base,
    })).rejects.toThrow(/dirty|index.*HEAD|tracked worktree|untracked/i);
  });

  it("RED-W1-acceptance-diagnostic: reports the exact nonignored untracked path", async () => {
    const { root, base } = createRepository();
    writeFileSync(join(root, "unexpected-runtime-file.txt"), "unexpected\n");

    await expect(inspectCccCampaignLocalGit({
      targetRoot: root,
      expectedBaseObject: base,
    })).rejects.toThrow(/unexpected-runtime-file\.txt/u);
  });

  it.skipIf(process.platform === "win32")(
    "never admits dirty bytes through an ambient PATH Git that spoofs index and HEAD",
    async () => {
      const { root, base } = createRepository();
      const trustedSnapshot = await inspectCccCampaignLocalGit({
        targetRoot: root,
        expectedBaseObject: base,
      });
      const modifiedBytes = Buffer.from("evil\n", "utf8");
      const forgedObjectId = createHash("sha1")
        .update(Buffer.from(`blob ${modifiedBytes.length}\0`, "utf8"))
        .update(modifiedBytes)
        .digest("hex");
      writeFileSync(join(root, "tracked.txt"), modifiedBytes);
      const nativeGitStatus = execFileSync(
        trustedSnapshot.gitBinary,
        [
          "-C",
          root,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--ignore-submodules=none",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();

      const probeRoot = track(mkdtempSync(join(tmpdir(), "ccc-campaign-hostile-path-")));
      const wrapperPath = join(probeRoot, "git");
      const markerPath = join(probeRoot, "invoked");
      writeFileSync(
        wrapperPath,
        [
          "#!/bin/sh",
          `: > ${shellSingleQuote(markerPath)}`,
          "saw_ls_files=false",
          "saw_stage=false",
          "saw_ls_tree=false",
          'for argument in "$@"; do',
          '  [ "$argument" = "ls-files" ] && saw_ls_files=true',
          '  [ "$argument" = "--stage" ] && saw_stage=true',
          '  [ "$argument" = "ls-tree" ] && saw_ls_tree=true',
          "done",
          'if [ "$saw_ls_files" = true ] && [ "$saw_stage" = true ]; then',
          `  printf '%s\\t%s\\000' '100644 ${forgedObjectId} 0' 'tracked.txt'`,
          "  exit 0",
          "fi",
          'if [ "$saw_ls_tree" = true ]; then',
          `  printf '%s\\t%s\\000' '100644 blob ${forgedObjectId}' 'tracked.txt'`,
          "  exit 0",
          "fi",
          `exec ${shellSingleQuote(trustedSnapshot.gitBinary)} "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const priorPath = process.env.PATH;
      let outcome:
        | Readonly<{
          kind: "resolved";
          dirty: false;
          gitBinary: string;
        }>
        | Readonly<{
          kind: "rejected";
          message: string;
        }>;
      try {
        process.env.PATH = probeRoot;
        const snapshot = await inspectCccCampaignLocalGit({
          targetRoot: root,
          expectedBaseObject: base,
        });
        outcome = {
          kind: "resolved",
          dirty: snapshot.dirty,
          gitBinary: snapshot.gitBinary,
        };
      } catch (error) {
        outcome = {
          kind: "rejected",
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (priorPath === undefined) delete process.env.PATH;
        else process.env.PATH = priorPath;
      }

      expect({
        nativeGitStatus,
        wrapperInvoked: existsSync(markerPath),
        selectedGitBinary: outcome.kind === "resolved" ? outcome.gitBinary : null,
        outcome,
      }).toEqual({
        nativeGitStatus: "M tracked.txt",
        wrapperInvoked: false,
        selectedGitBinary: null,
        outcome: {
          kind: "rejected",
          message: expect.stringMatching(/dirty|tracked worktree/i),
        },
      });
    },
  );

  it.each([
    ["modify", (root: string) => {
      writeFileSync(join(root, "tracked.txt"), "staged replacement\n");
      git(root, ["add", "--", "tracked.txt"]);
    }],
    ["add", (root: string) => {
      writeFileSync(join(root, "added.txt"), "staged addition\n");
      git(root, ["add", "--", "added.txt"]);
    }],
    ["delete", (root: string) => {
      rmSync(join(root, "tracked.txt"));
      git(root, ["add", "-u", "--", "tracked.txt"]);
    }],
  ])(
    "rejects staged index drift from %s even when worktree matches the index",
    async (_kind, stageDrift) => {
      const { root, base } = createRepository();
      stageDrift(root);
      expect(git(root, ["diff", "--cached", "--name-only"])).not.toBe("");

      await expect(inspectCccCampaignLocalGit({
        targetRoot: root,
        expectedBaseObject: base,
      })).rejects.toThrow(/index.*HEAD|dirty/i);
    },
  );

  it("rejects same-length tracked byte drift hidden by Git stat settings", async () => {
    const { root, base } = createRepository();
    const trackedPath = join(root, "tracked.txt");
    git(root, ["config", "core.trustctime", "false"]);
    git(root, ["config", "core.checkStat", "minimal"]);
    git(root, ["status", "--porcelain=v1"]);
    const originalStat = statSync(trackedPath);
    const nonRacyIndexTime = new Date(Date.now() + 10_000);
    utimesSync(join(root, ".git", "index"), nonRacyIndexTime, nonRacyIndexTime);
    writeFileSync(trackedPath, "evil\n");
    utimesSync(trackedPath, originalStat.atime, originalStat.mtime);

    expect(readFileSync(trackedPath, "utf8")).toBe("evil\n");
    expect(git(root, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ])).toBe("");
    await expect(inspectCccCampaignLocalGit({
      targetRoot: root,
      expectedBaseObject: base,
    })).rejects.toThrow(/tracked worktree|dirty/i);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a tracked FIFO without blocking for a writer",
    async () => {
      const { root, base } = createRepository();
      const trackedPath = join(root, "tracked.txt");
      rmSync(trackedPath);
      mkfifoSync(trackedPath);

      let settled = false;
      const inspection = inspectCccCampaignLocalGit({
        targetRoot: root,
        expectedBaseObject: base,
      }).then(
        () => {
          settled = true;
          return { kind: "resolved" as const, message: "" };
        },
        (error: unknown) => {
          settled = true;
          return {
            kind: "rejected" as const,
            message: error instanceof Error ? error.message : String(error),
          };
        },
      );
      const observation = await Promise.race([
        inspection.then((outcome) => ({
          settledWithinBound: true as const,
          outcome,
        })),
        delay(2_000).then(() => ({
          settledWithinBound: false as const,
          outcome: undefined,
        })),
      ]);

      if (!settled) {
        await releaseBlockedFifo(trackedPath, 2_000);
        await inspection;
      }

      expect(observation).toEqual({
        settledWithinBound: true,
        outcome: {
          kind: "rejected",
          message: expect.stringMatching(/tracked worktree|regular file|type/i),
        },
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects owner-execute drift hidden by a group-execute bit",
    async () => {
      const { root, base } = createRepository();
      const trackedPath = join(root, "tracked.txt");
      chmodSync(trackedPath, 0o755);
      git(root, ["add", "--", "tracked.txt"]);
      git(root, ["commit", "-q", "-m", "make tracked executable"]);
      expect(git(root, ["ls-files", "--stage", "--", "tracked.txt"])).toMatch(
        /^100755 /,
      );
      const trackedBytes = readFileSync(trackedPath);

      chmodSync(trackedPath, 0o410);

      expect(readFileSync(trackedPath)).toEqual(trackedBytes);
      expect(statSync(trackedPath).mode & 0o777).toBe(0o410);
      expect(git(root, ["status", "--porcelain=v1", "--untracked-files=no"])).toBe(
        "M tracked.txt",
      );
      await expect(inspectCccCampaignLocalGit({
        targetRoot: root,
        expectedBaseObject: base,
      })).rejects.toThrow(/mode|tracked worktree|dirty/i);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a tracked regular file reached through an ignored intermediate symlink",
    async () => {
      const { root, base } = createRepository();
      const directoryPath = join(root, "dir");
      const alternatePath = join(root, "alt");
      const trackedPath = join(directoryPath, "item");
      mkdirSync(directoryPath);
      writeFileSync(trackedPath, "nested regular\n");
      writeFileSync(join(root, ".gitignore"), "/alt/\n/dir\n");
      git(root, ["add", ".gitignore"]);
      git(root, ["add", "-f", "--", "dir/item"]);
      git(root, ["commit", "-q", "-m", "add nested regular"]);

      mkdirSync(alternatePath);
      writeFileSync(join(alternatePath, "item"), readFileSync(trackedPath));
      rmSync(directoryPath, { recursive: true });
      symlinkSync("alt", directoryPath, "dir");

      expect(lstatSync(directoryPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(alternatePath, "item"))).toEqual(
        Buffer.from("nested regular\n", "utf8"),
      );
      expect(git(root, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(
        "D dir/item",
      );
      expect(git(root, ["ls-files", "--others", "--exclude-standard"])).toBe("");
      await expect(inspectCccCampaignLocalGit({
        targetRoot: root,
        expectedBaseObject: base,
      })).rejects.toThrow(/canonical path|intermediate symlink|physical path/i);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects an indexed symlink reached through an ignored intermediate symlink",
    async () => {
      const { root, base } = createRepository();
      const directoryPath = join(root, "dir");
      const alternatePath = join(root, "alt");
      const trackedPath = join(directoryPath, "item");
      mkdirSync(directoryPath);
      symlinkSync("payload-target", trackedPath);
      writeFileSync(join(root, ".gitignore"), "/alt/\n/dir\n");
      git(root, ["add", ".gitignore"]);
      git(root, ["add", "-f", "--", "dir/item"]);
      git(root, ["commit", "-q", "-m", "add nested symlink"]);

      mkdirSync(alternatePath);
      symlinkSync(readlinkSync(trackedPath), join(alternatePath, "item"));
      rmSync(directoryPath, { recursive: true });
      symlinkSync("alt", directoryPath, "dir");

      expect(lstatSync(directoryPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(alternatePath, "item"))).toBe("payload-target");
      expect(git(root, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(
        "D dir/item",
      );
      expect(git(root, ["ls-files", "--others", "--exclude-standard"])).toBe("");
      await expect(inspectCccCampaignLocalGit({
        targetRoot: root,
        expectedBaseObject: base,
      })).rejects.toThrow(/canonical path|intermediate symlink|physical path/i);
    },
  );

  it("refuses tracked drift without executing a repository clean filter", async () => {
    const { root, base } = createRepository();
    const trackedPath = join(root, "tracked.txt");
    writeFileSync(join(root, ".gitattributes"), "tracked.txt filter=reviewprobe\n");
    git(root, ["add", ".gitattributes"]);
    git(root, ["commit", "-q", "-m", "add filter attribute"]);
    const racyTime = new Date(Date.now() + 5_000);
    utimesSync(trackedPath, racyTime, racyTime);
    git(root, ["update-index", "--really-refresh", "--", "tracked.txt"]);
    const indexedStat = statSync(trackedPath);

    const probeRoot = track(mkdtempSync(join(tmpdir(), "ccc-campaign-clean-filter-")));
    const markerPath = join(probeRoot, "executed");
    const filterPath = join(probeRoot, "clean-filter");
    writeFileSync(
      filterPath,
      [
        "#!/bin/sh",
        `: > ${shellSingleQuote(markerPath)}`,
        "exec /usr/bin/false",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    git(root, ["config", "filter.reviewprobe.clean", filterPath]);
    git(root, ["config", "filter.reviewprobe.required", "true"]);
    writeFileSync(trackedPath, "evil\n");
    utimesSync(trackedPath, indexedStat.atime, indexedStat.mtime);

    let rejected = false;
    try {
      await inspectCccCampaignLocalGit({
        targetRoot: root,
        expectedBaseObject: base,
      });
    } catch {
      rejected = true;
    }
    expect({
      rejected,
      repositoryFilterExecuted: existsSync(markerPath),
    }).toEqual({
      rejected: true,
      repositoryFilterExecuted: false,
    });
  });

  it("refuses a tracked submodule entry in the exact HEAD tree", async () => {
    const { root, base } = createRepository();
    git(root, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${base},submodule`,
    ]);
    git(root, ["commit", "-q", "-m", "add gitlink"]);

    await expect(inspectCccCampaignLocalGit({
      targetRoot: root,
      expectedBaseObject: base,
    })).rejects.toThrow(/submodule/i);
  });

  it.each([
    ["assume-unchanged", ["--assume-unchanged"], "h"],
    ["skip-worktree", ["--skip-worktree"], "S"],
    ["both hidden flags", ["--assume-unchanged", "--skip-worktree"], "s"],
  ])("refuses hidden tracked changes under %s", async (_kind, flags, expectedTag) => {
    const { root, base } = createRepository();
    for (const flag of flags) {
      git(root, ["update-index", flag, "tracked.txt"]);
    }
    expect(git(root, ["ls-files", "-v", "tracked.txt"]).slice(0, 1)).toBe(expectedTag);
    writeFileSync(join(root, "tracked.txt"), "hidden tracked change\n");

    await expect(inspectCccCampaignLocalGit({
      targetRoot: root,
      expectedBaseObject: base,
    })).rejects.toThrow(/index flag/i);
  });

  it("binds linked worktrees to their exact physical root and git directory", async () => {
    const { root, base } = createRepository();
    const linkedParent = track(mkdtempSync(join(tmpdir(), "ccc-campaign-linked-parent-")));
    const linkedRoot = join(linkedParent, "linked");
    git(root, ["worktree", "add", "-q", "-b", "linked", linkedRoot, "HEAD"]);

    const primary = await inspectCccCampaignLocalGit({ targetRoot: root, expectedBaseObject: base });
    const linked = await inspectCccCampaignLocalGit({ targetRoot: linkedRoot, expectedBaseObject: base });

    expect(linked.targetRoot).toBe(realpathSync(linkedRoot));
    expect(linked.gitCommonDir).toBe(primary.gitCommonDir);
    expect(linked.gitDir).not.toBe(primary.gitDir);
    expect(linked.targetRoot).not.toBe(primary.targetRoot);
  });

  it("rejects a bare repository", async () => {
    const bare = track(mkdtempSync(join(tmpdir(), "ccc-campaign-bare-")));
    git(bare, ["init", "-q", "--bare"]);

    await expect(inspectCccCampaignLocalGit({
      targetRoot: bare,
      expectedBaseObject: "0".repeat(40),
    })).rejects.toThrow(/bare|worktree/i);
  });

  it("canonicalizes a symlink alias to the physical target root", async () => {
    const { root, base } = createRepository();
    const aliasParent = track(mkdtempSync(join(tmpdir(), "ccc-campaign-alias-parent-")));
    const alias = join(aliasParent, "repo-alias");
    symlinkSync(root, alias, "dir");

    const snapshot = await inspectCccCampaignLocalGit({
      targetRoot: alias,
      expectedBaseObject: base,
    });

    expect(snapshot.targetRoot).toBe(root);
  });

  it("accepts a clean detached HEAD at the expected base", async () => {
    const { root, base } = createRepository();
    git(root, ["switch", "-q", "--detach", base]);

    await expect(inspectCccCampaignLocalGit({
      targetRoot: root,
      expectedBaseObject: base,
    })).resolves.toMatchObject({ head: base, dirty: false });
  });

  it("scrubs inherited repository and config redirection", async () => {
    const { root, base } = createRepository();
    const keys = [
      "GIT_DIR",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
    ] as const;
    const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.GIT_DIR = join(root, "missing-git-dir");
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.bare";
    process.env.GIT_CONFIG_VALUE_0 = "true";
    try {
      await expect(inspectCccCampaignLocalGit({
        targetRoot: root,
        expectedBaseObject: base,
      })).resolves.toMatchObject({ targetRoot: root, dirty: false });
    } finally {
      for (const key of keys) {
        const value = prior[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("ignores an invalid global Git config from ambient HOME", async () => {
    const { root, base } = createRepository();
    await inspectCccCampaignLocalGit({ targetRoot: root, expectedBaseObject: base });
    const hostileHome = track(mkdtempSync(join(tmpdir(), "ccc-campaign-hostile-home-")));
    writeFileSync(join(hostileHome, ".gitconfig"), "[invalid global config\n");
    const priorHome = process.env.HOME;
    process.env.HOME = hostileHome;
    try {
      await expect(inspectCccCampaignLocalGit({
        targetRoot: root,
        expectedBaseObject: base,
      })).resolves.toMatchObject({ targetRoot: root, dirty: false });
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });

  it("fails closed when the trusted catalog has no absolute executable file", async () => {
    const { root, base } = createRepository();
    gitBinaryCatalogOverride.paths = [
      "git",
      root,
      join(root, "missing-git"),
    ];

    await expect(inspectCccCampaignLocalGit({
      targetRoot: root,
      expectedBaseObject: base,
    })).rejects.toThrow(/could not pin Git to an executable physical path/i);
  });

  it.skipIf(process.platform === "win32")(
    "controls the environment of the first Git process selected from the trusted catalog",
    async () => {
      const { root, base } = createRepository();
      const preflight = await inspectCccCampaignLocalGit({
        targetRoot: root,
        expectedBaseObject: base,
      });

      const probeRoot = track(mkdtempSync(join(tmpdir(), "ccc-campaign-git-env-probe-")));
      const wrapperPath = join(probeRoot, "git");
      const environmentProbePath = join(probeRoot, "first-child.env");
      const argumentsProbePath = join(probeRoot, "first-child.args");
      writeFileSync(join(probeRoot, "ambient-global.gitconfig"), "[invalid global config\n");
      writeFileSync(join(probeRoot, "ambient-system.gitconfig"), "[invalid system config\n");
      writeFileSync(
        wrapperPath,
        [
          "#!/bin/sh",
          `if [ ! -e ${shellSingleQuote(environmentProbePath)} ]; then`,
          `  /usr/bin/env > ${shellSingleQuote(environmentProbePath)}`,
          `  printf '%s\\n' "$@" > ${shellSingleQuote(argumentsProbePath)}`,
          "fi",
          `exec ${shellSingleQuote(preflight.gitBinary)} "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      gitBinaryCatalogOverride.paths = [wrapperPath, preflight.gitBinary];

      const inheritedKeys = [
        "AWS_PROFILE",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GIT_ASKPASS",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "SSH_ASKPASS",
        "SSH_AUTH_SOCK",
      ] as const;
      const hostileEnvironment: Record<string, string> = {
        PATH: probeRoot,
        HOME: probeRoot,
        GIT_CONFIG_GLOBAL: join(probeRoot, "ambient-global.gitconfig"),
        GIT_CONFIG_NOSYSTEM: "0",
        GIT_CONFIG_SYSTEM: join(probeRoot, "ambient-system.gitconfig"),
        AWS_PROFILE: "ambient-provider",
        GH_TOKEN: "ambient-credential",
        GITHUB_TOKEN: "ambient-credential",
        GIT_ASKPASS: "/ambient/askpass",
        GIT_SSH: "/ambient/ssh",
        GIT_SSH_COMMAND: "ambient-ssh-command",
        SSH_ASKPASS: "/ambient/ssh-askpass",
        SSH_AUTH_SOCK: "/ambient/ssh-agent.sock",
      };
      const priorEnvironment = Object.fromEntries(
        Object.keys(hostileEnvironment).map((key) => [key, process.env[key]]),
      );
      let pinnedGitBinary = "";
      try {
        Object.assign(process.env, hostileEnvironment);
        pinnedGitBinary = (await inspectCccCampaignLocalGit({
          targetRoot: root,
          expectedBaseObject: base,
        })).gitBinary;
      } finally {
        for (const [key, value] of Object.entries(priorEnvironment)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }

      const firstEnvironment = readRecordedEnvironment(environmentProbePath);
      const firstArguments = readFileSync(argumentsProbePath, "utf8")
        .trim()
        .split("\n");
      expect({
        firstArguments,
        HOME: firstEnvironment.HOME,
        USERPROFILE: firstEnvironment.USERPROFILE,
        XDG_CONFIG_HOME: firstEnvironment.XDG_CONFIG_HOME,
        PATH: firstEnvironment.PATH,
        GIT_CONFIG_GLOBAL: firstEnvironment.GIT_CONFIG_GLOBAL,
        GIT_CONFIG_NOSYSTEM: firstEnvironment.GIT_CONFIG_NOSYSTEM,
        GIT_CONFIG_SYSTEM: firstEnvironment.GIT_CONFIG_SYSTEM,
        inheritedSensitiveKeys: inheritedKeys.filter((key) => key in firstEnvironment),
        pinnedGitBinary,
      }).toEqual({
        firstArguments: [
          "-c",
          "core.fsmonitor=false",
          "-c",
          `core.hooksPath=${devNull}`,
          "-C",
          root,
          "rev-parse",
          "--is-inside-work-tree",
        ],
        HOME: root,
        USERPROFILE: root,
        XDG_CONFIG_HOME: join(root, ".ccc-git-no-config"),
        PATH: [dirname(realpathSync(wrapperPath)), "/usr/bin", "/bin"].join(delimiter),
        GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: devNull,
        inheritedSensitiveKeys: [],
        pinnedGitBinary: realpathSync(wrapperPath),
      });
    },
  );

  it("recheck uses the originally pinned physical Git binary after PATH changes", async () => {
    const { root, base } = createRepository();
    const snapshot = await inspectCccCampaignLocalGit({
      targetRoot: root,
      expectedBaseObject: base,
    });
    const priorPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(recheckCccCampaignLocalGit(snapshot)).resolves.toEqual(snapshot);
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
  });

  it.skipIf(process.platform === "win32")(
    "bounds timeout and reaps a SIGTERM-ignoring selected executable tree",
    async () => {
      const { root, base } = createRepository();
      const probeRoot = track(mkdtempSync(join(tmpdir(), "ccc-campaign-timeout-probe-")));
      const pidPath = join(probeRoot, "pids.json");
      const wrapperPath = join(probeRoot, "git");
      writeFileSync(
        wrapperPath,
        [
          `#!${process.execPath}`,
          'const { spawn } = require("node:child_process");',
          'const { writeFileSync } = require("node:fs");',
          'process.on("SIGTERM", () => {});',
          'if (process.argv[2] === "__ccc_descendant__") {',
          "  setInterval(() => {}, 1_000);",
          "} else {",
          "  const descendant = spawn(process.execPath, [__filename, \"__ccc_descendant__\"], { stdio: \"ignore\" });",
          `  writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ parent: process.pid, descendant: descendant.pid }));`,
          "  setInterval(() => {}, 1_000);",
          "}",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      gitBinaryCatalogOverride.paths = [wrapperPath];
      let settled = false;
      const inspection = inspectCccCampaignLocalGit({
        targetRoot: root,
        expectedBaseObject: base,
      }).then(
        () => {
          settled = true;
          return { kind: "resolved" as const, message: "" };
        },
        (error: unknown) => {
          settled = true;
          return {
            kind: "rejected" as const,
            message: error instanceof Error ? error.message : String(error),
          };
        },
      );

      let pids: { parent: number; descendant: number } | undefined;
      let observation: {
        settledBeforeExternalCleanup: boolean;
        parentAlive: boolean;
        descendantAlive: boolean;
      } | undefined;
      try {
        expect(await waitForPath(pidPath, 1_000)).toBe(true);
        pids = JSON.parse(readFileSync(pidPath, "utf8")) as {
          parent: number;
          descendant: number;
        };
        // The production timeout plus TERM/KILL confirmation budget is 6s.
        // Poll for the actual settled signal with bounded scheduler headroom
        // instead of assuming one fixed sleep always resumes on time under a
        // concurrent suite.
        const inspectionDeadline = Date.now() + 8_000;
        while (!settled && Date.now() < inspectionDeadline) {
          await delay(10);
        }
        observation = {
          settledBeforeExternalCleanup: settled,
          parentAlive: isProcessAlive(pids.parent),
          descendantAlive: isProcessAlive(pids.descendant),
        };
      } finally {
        for (const pid of [pids?.descendant, pids?.parent]) {
          if (pid !== undefined && isProcessAlive(pid)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // The exact scratch process may have exited between probe and cleanup.
            }
          }
        }
        const cleanupDeadline = Date.now() + 1_000;
        while (
          pids
          && (isProcessAlive(pids.parent) || isProcessAlive(pids.descendant))
          && Date.now() < cleanupDeadline
        ) {
          await delay(10);
        }
      }

      const outcome = await inspection;
      expect(observation).toEqual({
        settledBeforeExternalCleanup: true,
        parentAlive: false,
        descendantAlive: false,
      });
      expect(outcome).toEqual({
        kind: "rejected",
        message: expect.stringMatching(/timed out/i),
      });
    },
  );

  it("rechecks the exact observed HEAD and refuses later descendant or dirty state", async () => {
    const first = createRepository();
    const descendantSnapshot = await inspectCccCampaignLocalGit({
      targetRoot: first.root,
      expectedBaseObject: first.base,
    });
    commitDescendant(first.root);
    await expect(recheckCccCampaignLocalGit(descendantSnapshot)).rejects.toThrow(/HEAD changed/i);

    const second = createRepository();
    const dirtySnapshot = await inspectCccCampaignLocalGit({
      targetRoot: second.root,
      expectedBaseObject: second.base,
    });
    writeFileSync(join(second.root, "tracked.txt"), "dirty after snapshot\n");
    await expect(recheckCccCampaignLocalGit(dirtySnapshot)).rejects.toThrow(
      /dirty|tracked worktree/i,
    );
  });

  it("recheck refuses a same-path whole-checkout replacement with identical clean Git bytes", async () => {
    const { root, base } = createRepository();
    const snapshot = await inspectCccCampaignLocalGit({
      targetRoot: root,
      expectedBaseObject: base,
    });
    const replacementParent = track(mkdtempSync(join(tmpdir(), "ccc-campaign-replacement-")));
    const replacement = join(replacementParent, "replacement");
    cpSync(root, replacement, { recursive: true });
    const displaced = track(`${root}-displaced`);
    renameSync(root, displaced);
    renameSync(replacement, root);

    await expect(recheckCccCampaignLocalGit(snapshot)).rejects.toThrow(/physical identity/i);
  });

  it("recheck refuses a same-path Git control-directory replacement", async () => {
    const { root, base } = createRepository();
    const snapshot = await inspectCccCampaignLocalGit({
      targetRoot: root,
      expectedBaseObject: base,
    });
    const replacementParent = track(mkdtempSync(join(tmpdir(), "ccc-campaign-gitdir-replacement-")));
    const replacement = join(replacementParent, "replacement.git");
    const displaced = join(replacementParent, "displaced.git");
    cpSync(join(root, ".git"), replacement, { recursive: true });
    renameSync(join(root, ".git"), displaced);
    renameSync(replacement, join(root, ".git"));

    await expect(recheckCccCampaignLocalGit(snapshot)).rejects.toThrow(/physical identity/i);
  });

  it("honors an already-aborted signal", async () => {
    const { root, base } = createRepository();
    const controller = new AbortController();
    controller.abort();

    await expect(inspectCccCampaignLocalGit({
      targetRoot: root,
      expectedBaseObject: base,
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses a missing promisor object without lazy-fetching or mutating the object store", async () => {
    const source = createRepository();
    commitDescendant(source.root);
    const targetParent = track(mkdtempSync(join(tmpdir(), "ccc-campaign-promisor-parent-")));
    const targetRoot = join(targetParent, "target");
    cpSync(source.root, targetRoot, { recursive: true });
    git(targetRoot, ["remote", "add", "origin", source.root]);
    git(targetRoot, ["config", "core.repositoryformatversion", "1"]);
    git(targetRoot, ["config", "extensions.partialClone", "origin"]);
    git(targetRoot, ["config", "remote.origin.promisor", "true"]);
    git(targetRoot, ["config", "remote.origin.partialclonefilter", "blob:none"]);
    const missingObject = join(
      targetRoot,
      ".git",
      "objects",
      source.base.slice(0, 2),
      source.base.slice(2),
    );
    rmSync(missingObject);
    const before = objectStoreFiles(targetRoot);
    const priorNoLazyFetch = process.env.GIT_NO_LAZY_FETCH;
    delete process.env.GIT_NO_LAZY_FETCH;
    let rejected = false;
    try {
      await inspectCccCampaignLocalGit({
        targetRoot,
        expectedBaseObject: source.base,
      });
    } catch {
      rejected = true;
    } finally {
      if (priorNoLazyFetch === undefined) delete process.env.GIT_NO_LAZY_FETCH;
      else process.env.GIT_NO_LAZY_FETCH = priorNoLazyFetch;
    }

    expect({
      rejected,
      objectStoreChanged: objectStoreFiles(targetRoot).join("\n") !== before.join("\n"),
    }).toEqual({ rejected: true, objectStoreChanged: false });
  });
});
