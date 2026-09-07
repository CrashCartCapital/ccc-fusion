import { execFileSync, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FUSION_SOURCE_CHECKOUT_IDENTITY_CONFLICT,
  FUSION_SOURCE_CHECKOUT_IDENTITY_INCOMPLETE,
  FUSION_SOURCE_CHECKOUT_PROBE_ERROR,
  FUSION_SOURCE_CHECKOUT_PROJECT_REFUSED,
  FUSION_SOURCE_MARKER_CONTENT,
  detectFusionSourceCheckout,
} from "../fusion-source-checkout.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

describeIfGit("detectFusionSourceCheckout (real git)", { timeout: 30_000 }, () => {
  const repos: string[] = [];

  afterEach(async () => {
    await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })));
  });

  async function setupRepo(options: {
    packageName?: string;
    privatePackage?: boolean;
    omitPackageJson?: boolean;
    marker?: "tracked-exact" | "tracked-wrong" | "untracked-exact";
  } = {}): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "fusion-source-checkout-"));
    repos.push(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Fusion Test"]);
    const initialFile = options.omitPackageJson ? "README.md" : "package.json";
    await writeFile(
      join(repo, initialFile),
      options.omitPackageJson
        ? "generic repository\n"
        : `${JSON.stringify({
          name: options.packageName ?? "fusion-workspace",
          private: options.privatePackage ?? true,
        }, null, 2)}\n`,
      "utf8",
    );
    git(repo, ["add", initialFile]);
    git(repo, ["commit", "-m", "init"]);

    if (options.marker) {
      await writeFile(
        join(repo, ".fusion-source"),
        options.marker === "tracked-wrong" ? "wrong-source-marker\n" : FUSION_SOURCE_MARKER_CONTENT,
        "utf8",
      );
      if (options.marker !== "untracked-exact") {
        git(repo, ["add", ".fusion-source"]);
        git(repo, ["commit", "-m", "add source marker"]);
      }
    }

    return repo;
  }

  async function setupEmptyRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "fusion-source-empty-"));
    repos.push(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Fusion Test"]);
    return repo;
  }

  it("recognizes the source checkout from its root and a nested directory", async () => {
    const repo = await setupRepo({ marker: "tracked-exact" });
    const canonicalRepo = await realpath(repo);
    const nested = join(repo, "packages", "engine");
    await mkdir(nested, { recursive: true });

    const rootResult = await detectFusionSourceCheckout(repo);
    const nestedResult = await detectFusionSourceCheckout(nested);

    expect(rootResult).toMatchObject({
      kind: "source",
      reason: FUSION_SOURCE_CHECKOUT_PROJECT_REFUSED,
      rootPath: canonicalRepo,
      identity: { matches: true },
      marker: {
        exact: true,
        tracked: true,
        committed: true,
        headExact: true,
        indexExact: true,
        worktreeExact: true,
        diverged: false,
      },
    });
    expect(nestedResult).toMatchObject({
      kind: "source",
      reason: FUSION_SOURCE_CHECKOUT_PROJECT_REFUSED,
      rootPath: canonicalRepo,
    });
  });

  it("leaves a normal repository alone when neither source signal is present", async () => {
    const repo = await setupRepo({ packageName: "ordinary-project", privatePackage: false });
    const canonicalRepo = await realpath(repo);
    const before = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);

    const result = await detectFusionSourceCheckout(repo);

    expect(result).toMatchObject({
      kind: "normal",
      reason: "NORMAL_PROJECT",
      rootPath: canonicalRepo,
      identity: { matches: false },
      marker: { exact: false, tracked: false },
    });
    expect(git(repo, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(before);
  });

  it("does not treat an untracked exact marker as source identity proof", async () => {
    const repo = await setupRepo({ marker: "untracked-exact" });

    const result = await detectFusionSourceCheckout(repo);

    expect(result).toMatchObject({
      kind: "incomplete",
      reason: FUSION_SOURCE_CHECKOUT_IDENTITY_INCOMPLETE,
      identity: { matches: true },
      marker: { exact: true, tracked: false, state: "untracked" },
    });
    expect(() => git(repo, ["ls-files", "--error-unmatch", "--", ".fusion-source"])).toThrow();
  });

  it("classifies a source identity without its marker as incomplete", async () => {
    const repo = await setupRepo();

    const result = await detectFusionSourceCheckout(repo);

    expect(result).toMatchObject({
      kind: "incomplete",
      reason: FUSION_SOURCE_CHECKOUT_IDENTITY_INCOMPLETE,
      identity: { matches: true },
      marker: { exact: false, tracked: false, state: "missing" },
    });
  });

  it("classifies a tracked but wrong marker as incomplete for the source identity", async () => {
    const repo = await setupRepo({ marker: "tracked-wrong" });

    const result = await detectFusionSourceCheckout(repo);

    expect(result).toMatchObject({
      kind: "incomplete",
      reason: FUSION_SOURCE_CHECKOUT_IDENTITY_INCOMPLETE,
      identity: { matches: true },
      marker: { exact: false, tracked: true, state: "wrong" },
    });
  });

  it("treats a generic repository without package.json or a marker as normal", async () => {
    const repo = await setupRepo({ omitPackageJson: true });

    const result = await detectFusionSourceCheckout(repo);

    expect(result).toMatchObject({
      kind: "normal",
      reason: "NORMAL_PROJECT",
      identity: { name: null, private: null, matches: false },
      marker: { exact: false, tracked: false, committed: false, state: "missing" },
    });
  });

  it("treats an empty no-HEAD repository without a marker as normal", async () => {
    const repo = await setupEmptyRepo();

    const result = await detectFusionSourceCheckout(repo);

    expect(result).toMatchObject({
      kind: "normal",
      reason: "NORMAL_PROJECT",
      identity: { name: null, private: null, matches: false },
      marker: { exact: false, tracked: false, committed: false, state: "missing" },
    });
  });

  it("does not recognize an exact marker staged without a committed HEAD marker", async () => {
    const repo = await setupRepo();
    await writeFile(join(repo, ".fusion-source"), FUSION_SOURCE_MARKER_CONTENT, "utf8");
    git(repo, ["add", ".fusion-source"]);

    const result = await detectFusionSourceCheckout(repo);

    expect(result).toMatchObject({
      kind: "incomplete",
      reason: FUSION_SOURCE_CHECKOUT_IDENTITY_INCOMPLETE,
      identity: { matches: true },
      marker: { exact: true, tracked: true, committed: false, state: "staged" },
    });
  });

  it("leaves a normal identity normal when only a lookalike marker is staged", async () => {
    const repo = await setupRepo({ packageName: "ordinary-project", privatePackage: false });
    await writeFile(join(repo, ".fusion-source"), FUSION_SOURCE_MARKER_CONTENT, "utf8");
    git(repo, ["add", ".fusion-source"]);

    const result = await detectFusionSourceCheckout(repo);

    expect(result).toMatchObject({
      kind: "normal",
      reason: "NORMAL_PROJECT",
      identity: { matches: false },
      marker: { exact: true, tracked: true, committed: false, state: "staged" },
    });
  });

  it("refuses a different project that carries the committed exact marker", async () => {
    const repo = await setupRepo({ packageName: "ordinary-project", privatePackage: false, marker: "tracked-exact" });

    const result = await detectFusionSourceCheckout(repo);

    expect(result).toMatchObject({
      kind: "conflict",
      reason: FUSION_SOURCE_CHECKOUT_IDENTITY_CONFLICT,
      identity: { matches: false },
      marker: { exact: true, tracked: true },
    });
  });

  it("leaves a different project with a tracked wrong marker as normal", async () => {
    const repo = await setupRepo({ packageName: "ordinary-project", privatePackage: false, marker: "tracked-wrong" });

    const result = await detectFusionSourceCheckout(repo);

    expect(result).toMatchObject({
      kind: "normal",
      reason: "NORMAL_PROJECT",
      identity: { matches: false },
      marker: { exact: false, tracked: true, state: "wrong" },
    });
  });

  it("refuses to treat a committed marker with an index mismatch as a stable source", async () => {
    const repo = await setupRepo({ marker: "tracked-exact" });
    await writeFile(join(repo, ".fusion-source"), "wrong-source-marker\n", "utf8");
    git(repo, ["add", ".fusion-source"]);
    await writeFile(join(repo, ".fusion-source"), FUSION_SOURCE_MARKER_CONTENT, "utf8");

    const result = await detectFusionSourceCheckout(repo);

    expect(result).toMatchObject({
      kind: "incomplete",
      reason: FUSION_SOURCE_CHECKOUT_IDENTITY_INCOMPLETE,
      identity: { matches: true },
      marker: {
        exact: true,
        tracked: true,
        committed: true,
        diverged: true,
        state: "diverged",
      },
    });
  });

  it("retains conflict when a committed marker is removed from the index", async () => {
    const repo = await setupRepo({ packageName: "ordinary-project", privatePackage: false, marker: "tracked-exact" });
    git(repo, ["rm", "--cached", ".fusion-source"]);

    const result = await detectFusionSourceCheckout(repo);

    expect(result).toMatchObject({
      kind: "conflict",
      reason: FUSION_SOURCE_CHECKOUT_IDENTITY_CONFLICT,
      identity: { matches: false },
      marker: {
        exact: true,
        tracked: false,
        committed: true,
        diverged: true,
        state: "diverged",
      },
    });
  });

  it("reports a Git toplevel probe error when the path is outside a repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fusion-source-not-git-"));
    repos.push(directory);

    const result = await detectFusionSourceCheckout(directory);

    expect(result).toMatchObject({
      kind: "error",
      reason: FUSION_SOURCE_CHECKOUT_PROBE_ERROR,
      error: { stage: "git-toplevel" },
    });
  });

  it("maps a marker filesystem probe error to incomplete after source identity", async () => {
    const repo = await setupRepo({ marker: "tracked-exact" });
    await unlink(join(repo, ".fusion-source"));
    await symlink(join(repo, "missing-marker-target"), join(repo, ".fusion-source"));

    const result = await detectFusionSourceCheckout(repo);

    expect(result).toMatchObject({
      kind: "incomplete",
      reason: FUSION_SOURCE_CHECKOUT_IDENTITY_INCOMPLETE,
      marker: { state: "probe-error", tracked: true, exact: false },
      error: { stage: "marker-file" },
    });
    const markerStats = await lstat(join(repo, ".fusion-source"));
    expect(markerStats.isSymbolicLink()).toBe(true);
  });

  it("maps a package probe error to conflict after an exact tracked marker", async () => {
    const repo = await setupRepo({ packageName: "ordinary-project", privatePackage: false, marker: "tracked-exact" });
    await unlink(join(repo, "package.json"));
    await mkdir(join(repo, "package.json"));

    const result = await detectFusionSourceCheckout(repo);

    expect(result).toMatchObject({
      kind: "conflict",
      reason: FUSION_SOURCE_CHECKOUT_IDENTITY_CONFLICT,
      marker: { exact: true, tracked: true },
      error: { stage: "package-file" },
    });
  });

  it("reports malformed package metadata as an unclassified probe error", async () => {
    const repo = await setupRepo({ packageName: "ordinary-project", privatePackage: false });
    await writeFile(join(repo, "package.json"), "{ malformed\n", "utf8");

    const result = await detectFusionSourceCheckout(repo);

    expect(result).toMatchObject({
      kind: "error",
      reason: FUSION_SOURCE_CHECKOUT_PROBE_ERROR,
      error: { stage: "package-json" },
    });
  });

  it("maps a Git index failure to conflict after a committed marker signal", async () => {
    const repo = await setupRepo({ packageName: "ordinary-project", privatePackage: false, marker: "tracked-exact" });
    await writeFile(join(repo, ".git", "index"), "corrupt-index\n", "utf8");

    const result = await detectFusionSourceCheckout(repo);

    expect(result).toMatchObject({
      kind: "conflict",
      reason: FUSION_SOURCE_CHECKOUT_IDENTITY_CONFLICT,
      identity: { matches: false },
      marker: { committed: true, state: "probe-error" },
      error: { stage: "marker-tracking" },
    });
  });

  it("does not create project state while probing", async () => {
    const repo = await setupRepo({ marker: "tracked-exact" });
    const before = await readFile(join(repo, ".fusion-source"), "utf8");

    await detectFusionSourceCheckout(repo);

    expect(await readFile(join(repo, ".fusion-source"), "utf8")).toBe(before);
  });
});
