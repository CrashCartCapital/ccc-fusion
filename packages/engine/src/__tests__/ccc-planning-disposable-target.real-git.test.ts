import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CCC_PLANNING_ROLE_POLICY_FULL_V2, customProviderRegistryKey } from "@fusion/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateCccLoopbackHttpUrl } from "../ccc-loopback-policy.js";
import {
  CCC_PLANNING_DISPOSABLE_TARGET_CHECKS,
  assertCccPlanningOwnedDisposableTarget,
  type CccPlanningDisposableTargetReceipt,
  type CccPlanningOwnedDisposableTargetInput,
} from "../ccc-planning/disposable-target.js";

/*
FNXC:CccPlanningDisposableTarget 2026-10-15-00:43:
Card AU4 (D24, PRD section 7:213-215, ADR D Q3 and Q4, CONTRACT-v3.5 section 2.18 G0 step 10 and section 4.1). Real git, no mocks of git: every repository is built by the card's own builder (`scripts/lib/ccc-planning-disposable-target.mjs`) under its own directory below os.tmpdir(), HOME is a temp directory, GIT_CONFIG_NOSYSTEM is 1, and nothing touches the network or PostgreSQL. The one directory the file creates is removed in afterAll by fs.rm on that exact path.

Every refusal is a flip on the same fixture: the owned control repository is admitted first, exactly one fact is changed, and the same call is refused with the named check. The control repository itself is the positive control for the whole file, so a refusal cannot come from a fixture that never reached the check, and a stub that admits everything fails every flip. The file closes on a coverage test that every named check refused at least once, so a check that was removed from the implementation but kept in the list fails there.

The builder is covered here too (ADR D behavioural RED 7: its repository has zero remotes, a 40-hex baseline, a clean tree and a marker whose digest it reports, and the assertion admits it). PostgreSQL provisioning is tested by its argv and by a fake runner only: a test never starts a server.
*/

const execFile = promisify(execFileCallback);

type Report = {
  schema: string;
  scratchRoot: string;
  repositoryRealpath: string;
  branch: string;
  baseCommit: string;
  baseTree: string;
  remotes: string[];
  ownershipMarker: { path: string; sha256: string };
  request: { path: string; sha256: string; byteLength: number };
  settings: {
    path: string;
    sha256: string;
    omniRouteBaseUrl: string;
    providerIds: { glm53: string; glm53Flash: string; minimaxM3: string };
    models: { glm53: string; glm53Flash: string; minimaxM3: string };
  };
  directories: Record<string, string>;
  postgres: null | { dataDir: string; logPath: string; port: number; databaseUrl: string; pgBinDir: string };
};
type Pins = { glm53: string; glm53Flash: string; minimaxM3: string };
type PostgresCommand = { file: string; args: string[] };
type Builder = {
  buildCccPlanningDisposableTarget: (options: Record<string, unknown>) => Promise<Report>;
  loadCccPlanningModelPins: (options?: Record<string, unknown>) => Promise<Pins>;
  validateCccPlanningOmniRouteBaseUrl: (raw: unknown) => { ok: boolean; reason?: string };
  cccPlanningDisposablePostgresCommands: (input: { pgBinDir: string; dataDir: string; logPath: string; port: number }) =>
    Record<"initdb" | "start" | "ready" | "createdb" | "stop", PostgresCommand>;
  pickCccPlanningFreeLoopbackPort: () => Promise<number>;
  CCC_PLANNING_SEALED_REQUEST: string;
  CCC_PLANNING_DISPOSABLE_TARGET_PROVIDER_IDS: Pins;
};

const builder = (await import("../../../../scripts/lib/ccc-planning-disposable-target.mjs")) as unknown as Builder;

const OMNIROUTE_URL = "http://127.0.0.1:20128/v1";
const NOT_DISPOSABLE = "CCC_PLANNING_TARGET_NOT_DISPOSABLE";
const CHECKS = CCC_PLANNING_DISPOSABLE_TARGET_CHECKS;
const ADMITTED = { ok: true } as const;

/** The three pins as K1's role policy names them (section 2.7), not typed here. */
function modelOf(roleId: string): string {
  const role = CCC_PLANNING_ROLE_POLICY_FULL_V2.roles.find((candidate) => candidate.roleId === roleId);
  if (role === undefined) throw new Error(`K1 policy has no role ${roleId}`);
  return role.modelId;
}
const PINS: Pins = {
  glm53: modelOf("intent-assessor"),
  glm53Flash: modelOf("implementation-writer"),
  minimaxM3: modelOf("acceptance-reviewer"),
};

let base = "";
let gitHome = "";
let sequence = 0;
/** Every check name that refused at least once in this file (see the closing coverage test). */
const observedChecks = new Set<string>();

function gitEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", HOME: gitHome, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

/** The shape of the supervised git runner the assertion takes: the real git exit code, never a throw. */
async function realGit(args: readonly string[], cwd: string): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFile("git", [...args], { cwd, env: gitEnvironment(), encoding: "utf8", maxBuffer: 1024 * 1024 });
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown };
    return { code: typeof failure.code === "number" ? failure.code : -1, stdout: typeof failure.stdout === "string" ? failure.stdout : "" };
  }
}

/** Fixture-side git: throws on failure and returns trimmed stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, env: gitEnvironment(), encoding: "utf8", maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Control = { holder: string; root: string; repo: string; report: Report };

/** An owned control target built by the card's builder under its own holder directory. */
async function control(label: string): Promise<Control> {
  sequence += 1;
  const holder = join(base, `${String(sequence).padStart(2, "0")}-${label}`);
  await mkdir(holder);
  const report = await builder.buildCccPlanningDisposableTarget({
    root: join(holder, `ccc-planning-i2-${label}`),
    omniRouteBaseUrl: OMNIROUTE_URL,
    pins: PINS,
  });
  return { holder, root: report.scratchRoot, repo: report.repositoryRealpath, report };
}

type MutableTarget = { -readonly [K in keyof CccPlanningDisposableTargetReceipt["target"]]: CccPlanningDisposableTargetReceipt["target"][K] };

function receiptOf(report: Report, change?: (target: MutableTarget) => void): CccPlanningDisposableTargetReceipt {
  const target: MutableTarget = {
    class: "owned_disposable",
    scratchRoot: report.scratchRoot,
    repositoryRealpath: report.repositoryRealpath,
    baseCommit: report.baseCommit,
    baseTree: report.baseTree,
    ownershipMarker: { ...report.ownershipMarker },
    remotes: [],
  };
  change?.(target);
  return { target };
}

function inputOf(c: Control, overrides: Partial<CccPlanningOwnedDisposableTargetInput> = {}): CccPlanningOwnedDisposableTargetInput {
  return {
    receipt: receiptOf(c.report),
    registeredProjectPath: c.repo,
    git: realGit,
    readFile: (path) => readFile(path),
    realpath: (path) => realpath(path),
    ...overrides,
  };
}

async function run(input: CccPlanningOwnedDisposableTargetInput) {
  const result = await assertCccPlanningOwnedDisposableTarget(input);
  if (!result.ok) observedChecks.add(result.check);
  return result;
}

function refusal(check: string) {
  return { ok: false, code: NOT_DISPOSABLE, check } as const;
}

/** A git runner that answers one command with a canned result and delegates every other command to real git. */
function gitAnswering(matches: (args: readonly string[]) => boolean, answer: () => { code: number; stdout: string } | Promise<never>) {
  return async (args: readonly string[], cwd: string) => (matches(args) ? answer() : realGit(args, cwd));
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "ccc-planning-au4-")));
  gitHome = join(base, "git-home");
  await mkdir(gitHome);
});

afterAll(async () => {
  if (base !== "") await rm(base, { recursive: true, force: true });
});

describe("ccc planning disposable target builder", () => {
  it("builds the sealed layout, a one-commit B0 baseline without a remote, and reports the receipt facts", async () => {
    const c = await control("layout");
    const { report } = c;
    expect(report.schema).toBe("ccc-planning.disposable-target-report.v1");
    expect(report.scratchRoot).toBe(join(c.holder, "ccc-planning-i2-layout"));
    expect(report.repositoryRealpath).toBe(join(report.scratchRoot, "target"));
    for (const name of ["home", "install", "pg", "tmp", "request", "authority", "evidence", "target"]) {
      expect((await stat(join(c.root, name))).isDirectory()).toBe(true);
    }
    expect((await stat(join(c.repo, ".git"))).isDirectory()).toBe(true);

    expect(await git(c.repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(await git(c.repo, "remote")).toBe("");
    expect(await git(c.repo, "config", "--get-regexp", "^remote\\.").catch(() => "none")).toBe("none");
    expect(report.baseCommit).toMatch(/^[0-9a-f]{40}$/u);
    expect(await git(c.repo, "rev-parse", "HEAD")).toBe(report.baseCommit);
    expect(await git(c.repo, "rev-parse", "HEAD^{tree}")).toBe(report.baseTree);
    expect(await git(c.repo, "rev-list", "--count", "HEAD")).toBe("1");
    expect((await git(c.repo, "ls-tree", "-r", "--name-only", "HEAD")).split("\n").sort()).toEqual([".gitignore", "README.md", "Taskfile.yml", "package.json"]);
    expect(await git(c.repo, "status", "--porcelain", "-uall")).toBe("");
    expect(await git(c.repo, "config", "--local", "--get", "user.name")).not.toBe("");
    expect(await git(c.repo, "config", "--local", "--get", "user.email")).not.toBe("");

    expect(JSON.parse(await readFile(join(c.repo, "package.json"), "utf8"))).toEqual({
      name: "text-stats", version: "0.0.0", private: true, type: "module", engines: { node: ">=20" }, scripts: { test: "node --test" },
    });
    expect(await readFile(join(c.repo, ".gitignore"), "utf8")).toBe("node_modules/\n");
    expect(await readFile(join(c.repo, "Taskfile.yml"), "utf8")).toMatch(/^tasks:\n {2}test:\n(?: {4}.*\n)*? {6}- node --test\n/mu);

    expect(report.ownershipMarker.path).toBe(join(report.scratchRoot, "owner.json"));
    const ownerBytes = await readFile(report.ownershipMarker.path);
    expect(sha256(ownerBytes)).toBe(report.ownershipMarker.sha256);
    const owner = JSON.parse(ownerBytes.toString("utf8")) as Record<string, unknown>;
    expect(Object.keys(owner).sort()).toEqual(["createdAt", "nonce", "repositoryRealpath", "schema"]);
    expect(owner.schema).toBe("ccc-planning.disposable-target-owner.v1");
    expect(owner.repositoryRealpath).toBe(report.repositoryRealpath);
    expect(owner.nonce).toMatch(/^[0-9a-f]{32}$/u);
    expect(new Date(String(owner.createdAt)).toISOString()).toBe(owner.createdAt);

    const requestBytes = await readFile(report.request.path);
    expect(report.request.path).toBe(join(report.scratchRoot, "request", "request.md"));
    expect(sha256(requestBytes)).toBe(report.request.sha256);
    expect(requestBytes.length).toBe(report.request.byteLength);
    const request = requestBytes.toString("utf8");
    expect(request).toBe(builder.CCC_PLANNING_SEALED_REQUEST);
    expect(request.startsWith("Add a small text statistics library and command-line tool to this repository.\n\n1. A shared tokenizer.")).toBe(true);
    for (const part of ["`src/tokenize.mjs`", "`src/word-frequency.mjs`", "`src/reading-time.mjs`", "`bin/text-stats.mjs`", "exits with code 2"]) {
      expect(request).toContain(part);
    }
    expect(request.endsWith("do not change `package.json`, and do not use the network.\n")).toBe(true);
    expect(report.postgres).toBeNull();
    expect(await readdir(join(c.root, "pg"))).toEqual([]);

    // ADR D RED 7: the assertion admits what the builder built.
    expect(await run(inputOf(c))).toEqual(ADMITTED);
  });

  it("writes home settings with three pinned providers, modelSync disabled, the no-cache header and no credential", async () => {
    const c = await control("settings");
    const text = await readFile(c.report.settings.path, "utf8");
    expect(c.report.settings.path).toBe(join(c.root, "home", ".fusion", "settings.json"));
    expect(sha256(text)).toBe(c.report.settings.sha256);
    const settings = JSON.parse(text) as { customProviders: Array<Record<string, unknown>> } & Record<string, unknown>;
    expect(Object.keys(settings).sort()).toEqual(["customProviders", "opencodeGoModelSync", "openrouterModelSync"]);
    expect(settings.openrouterModelSync).toBe(false);
    expect(settings.opencodeGoModelSync).toBe(false);
    expect(settings.customProviders).toHaveLength(3);
    const providers = settings.customProviders as Array<{
      id: string; name: string; apiType: string; baseUrl: string; headers: Record<string, string>; modelSync: string;
      models: Array<Record<string, string>>;
    }>;
    expect(providers.map((provider) => provider.models.map((model) => model.id))).toEqual([[PINS.glm53], [PINS.glm53Flash], [PINS.minimaxM3]]);
    for (const provider of providers) {
      expect(Object.keys(provider).sort()).toEqual(["apiType", "baseUrl", "headers", "id", "modelSync", "models", "name"]);
      expect(provider.apiType).toBe("openai-compatible");
      expect(provider.baseUrl).toBe(OMNIROUTE_URL);
      expect(provider.headers).toEqual({ "X-OmniRoute-No-Cache": "true" });
      expect(provider.modelSync).toBe("disabled");
      expect(provider.models).toHaveLength(1);
      expect(Object.keys(provider.models[0]!).sort()).toEqual(["id", "name"]);
    }
    // The receipt's providerIds are Fusion's registry keys for these providers, so each name must be its own key.
    const customProviders = providers as unknown as Parameters<typeof customProviderRegistryKey>[1];
    const keys = customProviders.map((provider) => customProviderRegistryKey(provider, customProviders));
    expect(keys).toEqual([c.report.settings.providerIds.glm53, c.report.settings.providerIds.glm53Flash, c.report.settings.providerIds.minimaxM3]);
    expect(new Set(keys).size).toBe(3);
    expect(c.report.settings.models).toEqual(PINS);
    expect(text).not.toMatch(/api[-_]?key|secret|token|password|authorization|bearer/iu);
  });

  it("reads the three model pins from the K1 role policy in core, and refuses a policy that disagrees", async () => {
    expect(await builder.loadCccPlanningModelPins()).toEqual(PINS);
    const roles = CCC_PLANNING_ROLE_POLICY_FULL_V2.roles;
    const classify = (modelId: string) => ({ admitted: PINS.glm53 === modelId || PINS.glm53Flash === modelId || PINS.minimaxM3 === modelId });
    // Control: the real roles through an injected policy module.
    expect(await builder.loadCccPlanningModelPins({ policy: { CCC_PLANNING_ROLE_POLICY_FULL_V2: { roles }, classifyCccModelIdentity: classify } })).toEqual(PINS);
    // A fourth model in the policy, and a pin that does not classify as admitted, are each refused.
    const withFourth = [...roles, { ...roles[0]!, roleId: "extra", modelId: "glm/glm-5.2" }];
    await expect(builder.loadCccPlanningModelPins({ policy: { CCC_PLANNING_ROLE_POLICY_FULL_V2: { roles: withFourth }, classifyCccModelIdentity: () => ({ admitted: true }) } }))
      .rejects.toMatchObject({ code: "CCC_PLANNING_DISPOSABLE_TARGET_POLICY_UNAVAILABLE" });
    await expect(builder.loadCccPlanningModelPins({ policy: { CCC_PLANNING_ROLE_POLICY_FULL_V2: { roles }, classifyCccModelIdentity: () => ({ admitted: false }) } }))
      .rejects.toMatchObject({ code: "CCC_PLANNING_DISPOSABLE_TARGET_POLICY_UNAVAILABLE" });
  });

  it("accepts exactly the OmniRoute base URLs the engine loopback policy accepts, and refuses port 4040 as well", () => {
    const urls = [
      OMNIROUTE_URL, "http://127.0.0.1:8092/v1", "http://localhost:20128/v1", "http://127.0.0.1/v1", "https://127.0.0.1:20128/v1",
      "http://127.0.0.1:20128", "http://user@127.0.0.1:20128/v1", "http://127.0.0.1:20128/v1?x=1", "http://127.0.0.1:70000/v1", "http://[::1]:20128/v1",
      "http://127.0.0.1:0/v1",
    ];
    for (const url of urls) {
      expect({ url, ok: builder.validateCccPlanningOmniRouteBaseUrl(url).ok }).toEqual({ url, ok: validateCccLoopbackHttpUrl(url).ok });
    }
    expect(builder.validateCccPlanningOmniRouteBaseUrl(OMNIROUTE_URL).ok).toBe(true);
    // Port 4040 is reserved: the engine's shape check admits it, the builder does not.
    expect(validateCccLoopbackHttpUrl("http://127.0.0.1:4040/v1").ok).toBe(true);
    expect(builder.validateCccPlanningOmniRouteBaseUrl("http://127.0.0.1:4040/v1").ok).toBe(false);
    expect(builder.validateCccPlanningOmniRouteBaseUrl(undefined).ok).toBe(false);
  });

  it("refuses a bad base URL, a root with another name and a relative root before writing anything; the control builds", async () => {
    sequence += 1;
    const holder = join(base, `${String(sequence).padStart(2, "0")}-refusals`);
    await mkdir(holder);
    const root = join(holder, "ccc-planning-i2-ok");
    for (const bad of ["http://localhost:20128/v1", "http://127.0.0.1:4040/v1", "https://example.com/v1"]) {
      await expect(builder.buildCccPlanningDisposableTarget({ root, omniRouteBaseUrl: bad, pins: PINS }))
        .rejects.toMatchObject({ code: "CCC_PLANNING_DISPOSABLE_TARGET_OMNIROUTE_URL_INVALID" });
    }
    for (const badRoot of [join(holder, "not-the-sealed-name"), join(holder, "ccc-planning-i2-"), "ccc-planning-i2-relative"]) {
      await expect(builder.buildCccPlanningDisposableTarget({ root: badRoot, omniRouteBaseUrl: OMNIROUTE_URL, pins: PINS }))
        .rejects.toMatchObject({ code: "CCC_PLANNING_DISPOSABLE_TARGET_ROOT_INVALID" });
    }
    expect(await readdir(holder)).toEqual([]);
    const report = await builder.buildCccPlanningDisposableTarget({ root, omniRouteBaseUrl: OMNIROUTE_URL, pins: PINS });
    expect(report.baseCommit).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("refuses to build over an existing target or inside another repository, without writing; a second target gets a fresh nonce", async () => {
    const c = await control("existing");
    const ownerBefore = await readFile(c.report.ownershipMarker.path);
    await expect(builder.buildCccPlanningDisposableTarget({ root: c.root, omniRouteBaseUrl: OMNIROUTE_URL, pins: PINS }))
      .rejects.toMatchObject({ code: "CCC_PLANNING_DISPOSABLE_TARGET_EXISTS" });
    expect((await readFile(c.report.ownershipMarker.path)).equals(ownerBefore)).toBe(true);
    expect(await git(c.repo, "rev-parse", "HEAD")).toBe(c.report.baseCommit);

    sequence += 1;
    const holder = join(base, `${String(sequence).padStart(2, "0")}-inside-repo`);
    await mkdir(holder);
    await git(holder, "init", "-b", "main");
    const nestedRoot = join(holder, "ccc-planning-i2-nested");
    await expect(builder.buildCccPlanningDisposableTarget({ root: nestedRoot, omniRouteBaseUrl: OMNIROUTE_URL, pins: PINS }))
      .rejects.toMatchObject({ code: "CCC_PLANNING_DISPOSABLE_TARGET_NESTED" });
    await expect(stat(nestedRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const second = await control("second");
    const nonceOf = async (report: Report) => (JSON.parse(await readFile(report.ownershipMarker.path, "utf8")) as { nonce: string }).nonce;
    expect(await nonceOf(second.report)).toMatch(/^[0-9a-f]{32}$/u);
    expect(await nonceOf(second.report)).not.toBe(await nonceOf(c.report));
  });

  it("builds beside the install, evidence and home directories that step 1 already filled, and leaves them as they were", async () => {
    sequence += 1;
    const holder = join(base, `${String(sequence).padStart(2, "0")}-step1`);
    const root = join(holder, "ccc-planning-i2-step1");
    const earlier = { "install/node_modules/.bin/fn": "#!/bin/sh\n", "evidence/installed-runtime.json": "{\"schema\":\"ccc-planning.installed-runtime.v1\"}\n", "home/.npm/_cacache/x": "cached\n" };
    for (const [relative, content] of Object.entries(earlier)) {
      await mkdir(join(root, relative, ".."), { recursive: true });
      await writeFile(join(root, relative), content, "utf8");
    }
    const report = await builder.buildCccPlanningDisposableTarget({ root, omniRouteBaseUrl: OMNIROUTE_URL, pins: PINS });
    for (const [relative, content] of Object.entries(earlier)) {
      expect(await readFile(join(report.scratchRoot, relative), "utf8")).toBe(content);
    }
    expect(await readFile(join(report.scratchRoot, "home", ".fusion", "settings.json"), "utf8")).toContain("customProviders");
    expect(await git(report.repositoryRealpath, "status", "--porcelain", "-uall")).toBe("");
    // A settings file that is already there is never overwritten.
    sequence += 1;
    const rootWithSettings = join(base, `${String(sequence).padStart(2, "0")}-settings`, "ccc-planning-i2-settings");
    await mkdir(join(rootWithSettings, "home", ".fusion"), { recursive: true });
    await writeFile(join(rootWithSettings, "home", ".fusion", "settings.json"), "{}\n", "utf8");
    await expect(builder.buildCccPlanningDisposableTarget({ root: rootWithSettings, omniRouteBaseUrl: OMNIROUTE_URL, pins: PINS }))
      .rejects.toMatchObject({ code: "CCC_PLANNING_DISPOSABLE_TARGET_EXISTS" });
    expect(await readFile(join(rootWithSettings, "home", ".fusion", "settings.json"), "utf8")).toBe("{}\n");
  });

  it("builds PostgreSQL commands that bind 127.0.0.1 only, with no Unix socket, and refuses ports 5432 and 4040", () => {
    const input = { pgBinDir: "/pg/bin", dataDir: "/root/pg", logPath: "/root/evidence/pg.log", port: 55123 };
    const commands = builder.cccPlanningDisposablePostgresCommands(input);
    expect(commands.initdb).toEqual({ file: "/pg/bin/initdb", args: ["-D", "/root/pg", "-U", "postgres", "-A", "trust", "--no-locale", "-E", "UTF8"] });
    expect(commands.start).toEqual({
      file: "/pg/bin/pg_ctl",
      args: ["-D", "/root/pg", "-o", "-p 55123 -c listen_addresses=127.0.0.1 -c unix_socket_directories=", "-l", "/root/evidence/pg.log", "start"],
    });
    expect(commands.ready).toEqual({ file: "/pg/bin/pg_isready", args: ["-h", "127.0.0.1", "-p", "55123", "-U", "postgres"] });
    expect(commands.createdb).toEqual({ file: "/pg/bin/createdb", args: ["-h", "127.0.0.1", "-p", "55123", "-U", "postgres", "fusion"] });
    expect(commands.stop).toEqual({ file: "/pg/bin/pg_ctl", args: ["-D", "/root/pg", "-m", "fast", "stop"] });
    expect(JSON.stringify(commands)).not.toMatch(/\b5432\b|\b4040\b/u);
    for (const port of [5432, 4040, 0, 80, 65_536, 5432.5, Number.NaN]) {
      expect(() => builder.cccPlanningDisposablePostgresCommands({ ...input, port }), `port ${String(port)}`)
        .toThrow(/CCC_PLANNING_DISPOSABLE_TARGET_PORT_FORBIDDEN/u);
    }
  });

  it("picks a free loopback port that is neither 5432 nor 4040 and can really be bound", async () => {
    const port = await builder.pickCccPlanningFreeLoopbackPort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect([4040, 5432]).not.toContain(port);
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
    });
  });

  it("runs no PostgreSQL command unless asked, and runs initdb, start, ready, createdb in order when asked; a failure stops the server it started", async () => {
    const calls: Array<[string, string[]]> = [];
    const fake = async (file: string, args: string[]) => {
      calls.push([file, args]);
      return { stdout: "", stderr: "" };
    };
    const postgres = { pgBinDir: "/pg/bin", run: fake, pickPort: async () => 55123, sleep: async () => undefined, binariesPresent: async () => null };

    const off = await control("pg-off");
    expect(off.report.postgres).toBeNull();
    sequence += 1;
    const holder = join(base, `${String(sequence).padStart(2, "0")}-pg-off`);
    await mkdir(holder);
    const quiet = await builder.buildCccPlanningDisposableTarget({ root: join(holder, "ccc-planning-i2-quiet"), omniRouteBaseUrl: OMNIROUTE_URL, pins: PINS, postgres });
    expect(quiet.postgres).toBeNull();
    expect(calls).toEqual([]);

    sequence += 1;
    const holderOn = join(base, `${String(sequence).padStart(2, "0")}-pg-on`);
    await mkdir(holderOn);
    const on = await builder.buildCccPlanningDisposableTarget({
      root: join(holderOn, "ccc-planning-i2-pgon"), omniRouteBaseUrl: OMNIROUTE_URL, pins: PINS, provisionPostgres: true, postgres,
    });
    expect(calls.map(([file]) => file)).toEqual(["/pg/bin/initdb", "/pg/bin/pg_ctl", "/pg/bin/pg_isready", "/pg/bin/createdb"]);
    expect(calls[0]![1]).toContain(join(on.scratchRoot, "pg"));
    expect(calls[1]![1]).toContain("-p 55123 -c listen_addresses=127.0.0.1 -c unix_socket_directories=");
    expect(on.postgres).toEqual({
      dataDir: join(on.scratchRoot, "pg"), logPath: join(on.scratchRoot, "evidence", "pg.log"), port: 55123,
      databaseUrl: "postgresql://postgres@127.0.0.1:55123/fusion", pgBinDir: "/pg/bin",
    });

    calls.length = 0;
    sequence += 1;
    const holderFail = join(base, `${String(sequence).padStart(2, "0")}-pg-fail`);
    await mkdir(holderFail);
    const failing = async (file: string, args: string[]) => {
      calls.push([file, args]);
      if (file.endsWith("createdb")) throw new Error("createdb failed");
      return { stdout: "", stderr: "" };
    };
    await expect(builder.buildCccPlanningDisposableTarget({
      root: join(holderFail, "ccc-planning-i2-pgfail"), omniRouteBaseUrl: OMNIROUTE_URL, pins: PINS, provisionPostgres: true, postgres: { ...postgres, run: failing },
    })).rejects.toThrow("createdb failed");
    expect(calls.map(([file]) => file.split("/").pop())).toEqual(["initdb", "pg_ctl", "pg_isready", "createdb", "pg_ctl"]);
    expect(calls.at(-1)![1]).toEqual(["-D", expect.stringContaining("pg"), "-m", "fast", "stop"]);
  });

  it("refuses existing layout symlinks before writing any target or following an external directory", async () => {
    for (const relative of [".", "home", "home/.fusion", "install", "pg", "tmp", "request", "authority", "evidence"]) {
      sequence += 1;
      const holder = join(base, `${sequence}-symlink-layout`);
      const root = join(holder, "ccc-planning-i2-symlink");
      const outside = join(holder, "outside");
      await mkdir(outside, { recursive: true });
      const link = relative === "." ? root : join(root, relative);
      await mkdir(join(link, ".."), { recursive: true });
      await symlink(outside, link);
      const before = await readdir(root);
      await expect(builder.buildCccPlanningDisposableTarget({ root, omniRouteBaseUrl: OMNIROUTE_URL, pins: PINS }))
        .rejects.toMatchObject({ code: "CCC_PLANNING_DISPOSABLE_TARGET_ROOT_INVALID" });
      expect(await readdir(root)).toEqual(before);
      expect(await readdir(outside)).toEqual([]);
    }
    expect(await run(inputOf(await control("symlink-control")))).toEqual(ADMITTED);
  });

  it("keeps PostgreSQL inside the builder root even when PostgreSQL options name another root", async () => {
    sequence += 1;
    const root = join(base, `${sequence}-pg-root`, "ccc-planning-i2-pg-root");
    const calls: Array<{ file: string; args: string[] }> = [];
    const report = await builder.buildCccPlanningDisposableTarget({
      root, omniRouteBaseUrl: OMNIROUTE_URL, pins: PINS, provisionPostgres: true,
      postgres: {
        root: join(base, "foreign-pg-root"), pgBinDir: "/pg/bin", pickPort: async () => 55123,
        binariesPresent: async () => null,
        run: async (file: string, args: string[]) => { calls.push({ file, args }); return { stdout: "", stderr: "" }; },
      },
    });
    expect(report.postgres?.dataDir).toBe(join(report.scratchRoot, "pg"));
    expect(calls[0]?.args).toContain(join(report.scratchRoot, "pg"));
    expect(JSON.stringify(calls)).not.toContain("foreign-pg-root");
  });

  it("attempts exact owned PostgreSQL teardown when start fails and preserves a teardown failure", async () => {
    for (const stopFails of [false, true]) {
      sequence += 1;
      const root = join(base, `${sequence}-pg-start`, "ccc-planning-i2-pg-start");
      const calls: Array<{ file: string; args: string[] }> = [];
      const failure = await builder.buildCccPlanningDisposableTarget({
        root, omniRouteBaseUrl: OMNIROUTE_URL, pins: PINS, provisionPostgres: true,
        postgres: {
          pgBinDir: "/pg/bin", pickPort: async () => 55123, binariesPresent: async () => null,
          run: async (file: string, args: string[]) => {
            calls.push({ file, args });
            if (args.at(-1) === "start") throw new Error("start reported failure");
            if (args.at(-1) === "stop" && stopFails) throw new Error("stop reported failure");
            return { stdout: "", stderr: "" };
          },
        },
      }).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("start reported failure");
      expect(calls.map(({ file }) => file.split("/").at(-1))).toEqual(["initdb", "pg_ctl", "pg_ctl"]);
      expect(calls.at(-1)?.args).toEqual(["-D", join(await realpath(root), "pg"), "-m", "fast", "stop"]);
      if (stopFails) expect(String(failure)).toContain("stop reported failure");
      await expect(stat(join(root, "owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("stops owned PostgreSQL when sealing fails after startup and preserves a teardown failure", async () => {
    for (const stopFails of [false, true]) {
      sequence += 1;
      const root = join(base, `${sequence}-pg-seal`, "ccc-planning-i2-pg-seal");
      const calls: Array<{ file: string; args: string[] }> = [];
      const failure = await builder.buildCccPlanningDisposableTarget({
        root, omniRouteBaseUrl: OMNIROUTE_URL, pins: PINS, provisionPostgres: true,
        clock: () => { throw new Error("owner seal failed"); },
        postgres: {
          pgBinDir: "/pg/bin", pickPort: async () => 55123, binariesPresent: async () => null,
          run: async (file: string, args: string[]) => {
            calls.push({ file, args });
            if (args.at(-1) === "stop" && stopFails) throw new Error("stop reported failure");
            return { stdout: "", stderr: "" };
          },
        },
      }).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("owner seal failed");
      expect(calls.map(({ file }) => file.split("/").at(-1))).toEqual(["initdb", "pg_ctl", "pg_isready", "createdb", "pg_ctl"]);
      expect(calls.at(-1)?.args).toEqual(["-D", join(await realpath(root), "pg"), "-m", "fast", "stop"]);
      if (stopFails) expect(String(failure)).toContain("stop reported failure");
      await expect(stat(join(root, "owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

describe("assertCccPlanningOwnedDisposableTarget", () => {
  it("admits the owned control repository and runs the git checks in order, each in the right directory", async () => {
    const c = await control("control");
    const calls: Array<{ args: string; cwd: string }> = [];
    const result = await run(inputOf(c, {
      git: async (args, cwd) => {
        calls.push({ args: args.join(" "), cwd });
        return realGit(args, cwd);
      },
    }));
    expect(result).toEqual(ADMITTED);
    expect(calls).toEqual([
      { args: "remote", cwd: c.repo },
      { args: "config --get-regexp ^remote\\.", cwd: c.repo },
      { args: "rev-parse HEAD", cwd: c.repo },
      { args: "rev-parse HEAD^{tree}", cwd: c.repo },
      { args: "-c core.fsmonitor=false status --porcelain -uall", cwd: c.repo },
      { args: "rev-parse --show-toplevel", cwd: c.root },
    ]);
  });

  it("refuses a repository with a remote, and admits the same repository before the remote is added", async () => {
    const c = await control("remote");
    expect(await run(inputOf(c))).toEqual(ADMITTED);
    await git(c.repo, "remote", "add", "origin", join(base, "elsewhere.git"));
    expect(await run(inputOf(c))).toEqual(refusal(CHECKS.noRemote));
  });

  it("refuses remote config that git remote does not list, so the second remote probe is not redundant", async () => {
    const c = await control("remote-config");
    expect(await run(inputOf(c))).toEqual(ADMITTED);
    await git(c.repo, "config", "remote.pushDefault", "origin");
    expect(await git(c.repo, "remote")).toBe("");
    expect(await run(inputOf(c))).toEqual(refusal(CHECKS.noRemoteConfig));
  });

  it("refuses an owner.json with a different digest, whether the file or the receipt changed", async () => {
    const c = await control("digest");
    const original = await readFile(c.report.ownershipMarker.path);
    expect(await run(inputOf(c))).toEqual(ADMITTED);
    // The receipt names another digest.
    const other = receiptOf(c.report, (target) => { target.ownershipMarker = { path: target.ownershipMarker.path, sha256: "0".repeat(64) }; });
    expect(await run(inputOf(c, { receipt: other }))).toEqual(refusal(CHECKS.ownerMarkerDigest));
    // The file changes by one byte and still parses; the receipt keeps the digest it was issued with.
    await writeFile(c.report.ownershipMarker.path, Buffer.concat([original, Buffer.from(" ")]));
    expect(await run(inputOf(c))).toEqual(refusal(CHECKS.ownerMarkerDigest));
    // The same fixture is admitted again once the original bytes are back.
    await writeFile(c.report.ownershipMarker.path, original);
    expect(await run(inputOf(c))).toEqual(ADMITTED);
  });

  it("refuses a missing owner.json, an unreadable or foreign marker, and a marker that names another repository", async () => {
    const c = await control("marker");
    const original = await readFile(c.report.ownershipMarker.path);
    const owner = JSON.parse(original.toString("utf8")) as Record<string, unknown>;
    /** Writes `text` as owner.json and issues a receipt whose digest matches it, so only the marker's content can refuse. */
    const sealed = async (text: string) => {
      await writeFile(c.report.ownershipMarker.path, text, "utf8");
      return inputOf(c, { receipt: receiptOf(c.report, (target) => { target.ownershipMarker = { path: target.ownershipMarker.path, sha256: sha256(text) }; }) });
    };
    expect(await run(inputOf(c))).toEqual(ADMITTED);
    expect(await run(await sealed(JSON.stringify(owner)))).toEqual(ADMITTED);
    expect(await run(await sealed("this is not json"))).toEqual(refusal(CHECKS.ownerMarkerInvalid));
    expect(await run(await sealed(JSON.stringify({ ...owner, schema: "ccc-planning.disposable-target-owner.v2" })))).toEqual(refusal(CHECKS.ownerMarkerInvalid));
    expect(await run(await sealed(JSON.stringify({ ...owner, nonce: "abc123" })))).toEqual(refusal(CHECKS.ownerMarkerInvalid));
    expect(await run(await sealed(JSON.stringify([owner])))).toEqual(refusal(CHECKS.ownerMarkerInvalid));
    expect(await run(await sealed(JSON.stringify({ ...owner, repositoryRealpath: join(c.root, "other") })))).toEqual(refusal(CHECKS.ownerMarkerRepository));
    await rm(c.report.ownershipMarker.path);
    expect(await run(inputOf(c))).toEqual(refusal(CHECKS.ownerMarkerMissing));
    await writeFile(c.report.ownershipMarker.path, original);
    expect(await run(inputOf(c))).toEqual(ADMITTED);
  });

  it("refuses an ownership marker path other than <scratchRoot>/owner.json even when its bytes match the digest", async () => {
    const c = await control("marker-path");
    const bytes = await readFile(c.report.ownershipMarker.path);
    expect(await run(inputOf(c))).toEqual(ADMITTED);
    for (const copy of [join(c.root, "evidence", "owner.json"), join(c.repo, "owner.json")]) {
      await writeFile(copy, bytes);
      const receipt = receiptOf(c.report, (target) => { target.ownershipMarker = { path: copy, sha256: sha256(bytes) }; });
      expect(await run(inputOf(c, { receipt }))).toEqual(refusal(CHECKS.ownerMarkerPath));
    }
  });

  it("refuses a repository that is not a direct child of scratchRoot, whether the receipt or the disk puts it deeper", async () => {
    const c = await control("child");
    expect(await run(inputOf(c))).toEqual(ADMITTED);
    // The receipt's scratch root is the parent of the real one.
    const parentReceipt = receiptOf(c.report, (target) => { target.scratchRoot = c.holder; });
    expect(await run(inputOf(c, { receipt: parentReceipt }))).toEqual(refusal(CHECKS.directChild));
    // The repository itself moves one level down; the marker is rewritten and re-sealed, so only the depth is wrong.
    const deeper = join(c.root, "nested", "target");
    await mkdir(join(c.root, "nested"));
    await rename(c.repo, deeper);
    const owner = JSON.parse(await readFile(c.report.ownershipMarker.path, "utf8")) as Record<string, unknown>;
    const text = `${JSON.stringify({ ...owner, repositoryRealpath: deeper }, null, 2)}\n`;
    await writeFile(c.report.ownershipMarker.path, text, "utf8");
    const moved = receiptOf(c.report, (target) => {
      target.repositoryRealpath = deeper;
      target.ownershipMarker = { path: target.ownershipMarker.path, sha256: sha256(text) };
    });
    expect(await run(inputOf(c, { receipt: moved, registeredProjectPath: deeper }))).toEqual(refusal(CHECKS.directChild));
  });

  it("refuses a baseCommit that is not HEAD, and a baseTree that is not its tree", async () => {
    const c = await control("head");
    expect(await run(inputOf(c))).toEqual(ADMITTED);
    // The receipt names a tree HEAD does not have (the commit still matches).
    const wrongTree = receiptOf(c.report, (target) => { target.baseTree = "1".repeat(40); });
    expect(await run(inputOf(c, { receipt: wrongTree }))).toEqual(refusal(CHECKS.headTree));
    // The receipt names a commit HEAD is not at.
    const wrongCommit = receiptOf(c.report, (target) => { target.baseCommit = "2".repeat(40); });
    expect(await run(inputOf(c, { receipt: wrongCommit }))).toEqual(refusal(CHECKS.headCommit));
    // HEAD moves on by an empty commit: the tree is unchanged and clean, but HEAD is no longer the receipt's baseCommit.
    await git(c.repo, "commit", "--allow-empty", "-m", "moves HEAD");
    expect(await git(c.repo, "rev-parse", "HEAD^{tree}")).toBe(c.report.baseTree);
    expect(await git(c.repo, "status", "--porcelain", "-uall")).toBe("");
    expect(await run(inputOf(c))).toEqual(refusal(CHECKS.headCommit));
    // The same fixture is admitted against a receipt for the new HEAD.
    const movedHead = await git(c.repo, "rev-parse", "HEAD");
    const advanced = receiptOf(c.report, (target) => { target.baseCommit = movedHead; });
    expect(await run(inputOf(c, { receipt: advanced }))).toEqual(ADMITTED);
  });

  it("refuses a dirty tracked file, an untracked file and a staged file, each admitted again once undone", async () => {
    const c = await control("dirty");
    expect(await run(inputOf(c))).toEqual(ADMITTED);
    await writeFile(join(c.repo, "README.md"), "changed\n", "utf8");
    expect(await run(inputOf(c))).toEqual(refusal(CHECKS.cleanWorktree));
    await git(c.repo, "restore", "README.md");
    expect(await run(inputOf(c))).toEqual(ADMITTED);
    await writeFile(join(c.repo, "stray.txt"), "stray\n", "utf8");
    expect(await run(inputOf(c))).toEqual(refusal(CHECKS.cleanWorktree));
    await git(c.repo, "add", "stray.txt");
    expect(await run(inputOf(c))).toEqual(refusal(CHECKS.cleanWorktree));
    await git(c.repo, "rm", "--cached", "-q", "stray.txt");
    await rm(join(c.repo, "stray.txt"));
    expect(await run(inputOf(c))).toEqual(ADMITTED);
  });

  it("refuses a scratch root that sits inside another repository, and admits it before that repository exists", async () => {
    const c = await control("nested");
    expect(await run(inputOf(c))).toEqual(ADMITTED);
    await git(c.holder, "init", "-b", "main");
    expect(await git(c.root, "rev-parse", "--show-toplevel")).toBe(await realpath(c.holder));
    expect(await run(inputOf(c))).toEqual(refusal(CHECKS.notNested));
  });

  it("compares realpaths: a symlink to the repository is the registered project, a different directory is not", async () => {
    const c = await control("registered");
    await symlink(c.repo, join(c.holder, "repo-link"));
    await mkdir(join(c.holder, "elsewhere"));
    expect(await run(inputOf(c))).toEqual(ADMITTED);
    expect(await run(inputOf(c, { registeredProjectPath: join(c.holder, "repo-link") }))).toEqual(ADMITTED);
    expect(await run(inputOf(c, { registeredProjectPath: join(c.holder, "elsewhere") }))).toEqual(refusal(CHECKS.registeredProjectPath));
    expect(await run(inputOf(c, { registeredProjectPath: join(c.holder, "does-not-exist") }))).toEqual(refusal(CHECKS.registeredProjectPath));
  });

  it("refuses a receipt that spells the scratch root or the repository through a symlink instead of its realpath", async () => {
    const c = await control("alias");
    expect(await run(inputOf(c))).toEqual(ADMITTED);
    await symlink(c.root, join(c.holder, "root-alias"));
    await symlink(c.repo, join(c.root, "target-alias"));
    const rootAlias = receiptOf(c.report, (target) => { target.scratchRoot = join(c.holder, "root-alias"); });
    expect(await run(inputOf(c, { receipt: rootAlias }))).toEqual(refusal(CHECKS.scratchRootRealpath));
    const repoAlias = receiptOf(c.report, (target) => { target.repositoryRealpath = join(c.root, "target-alias"); });
    expect(await run(inputOf(c, { receipt: repoAlias }))).toEqual(refusal(CHECKS.repositoryRealpath));
  });

  it("refuses a receipt that is not an owned disposable target without remotes, or whose fields are not what the check reads", async () => {
    const c = await control("receipt");
    expect(await run(inputOf(c))).toEqual(ADMITTED);
    expect(await run(inputOf(c, { receipt: receiptOf(c.report, (target) => { target.class = "admitted_repository"; }) }))).toEqual(refusal(CHECKS.targetClass));
    expect(await run(inputOf(c, { receipt: receiptOf(c.report, (target) => { target.remotes = ["origin"]; }) }))).toEqual(refusal(CHECKS.receiptRemotes));
    const broken = (change: (target: Record<string, unknown>) => void): CccPlanningDisposableTargetReceipt => {
      const receipt = JSON.parse(JSON.stringify(receiptOf(c.report))) as { target: Record<string, unknown> };
      change(receipt.target);
      return receipt as unknown as CccPlanningDisposableTargetReceipt;
    };
    expect(await run(inputOf(c, { receipt: broken((target) => { target.baseCommit = 5; }) }))).toEqual(refusal(CHECKS.receiptShape));
    expect(await run(inputOf(c, { receipt: broken((target) => { target.ownershipMarker = { path: String(target.scratchRoot), sha256: "not-hex" }; }) }))).toEqual(refusal(CHECKS.receiptShape));
    expect(await run(inputOf(c, { receipt: broken((target) => { target.remotes = "none"; }) }))).toEqual(refusal(CHECKS.receiptShape));
    expect(await run(inputOf(c, { receipt: {} as unknown as CccPlanningDisposableTargetReceipt }))).toEqual(refusal(CHECKS.receiptShape));
  });

  it("refuses instead of throwing when git, readFile or realpath fail, and when a git failure proves nothing", async () => {
    const c = await control("failing");
    expect(await run(inputOf(c))).toEqual(ADMITTED);
    const throwing = () => Promise.reject(new Error("git exploded"));
    expect(await run(inputOf(c, { git: gitAnswering((args) => args[0] === "remote", throwing) }))).toEqual(refusal(CHECKS.noRemote));
    expect(await run(inputOf(c, { git: gitAnswering((args) => args[0] === "remote", () => ({ code: 128, stdout: "" })) }))).toEqual(refusal(CHECKS.noRemote));
    expect(await run(inputOf(c, { git: gitAnswering((args) => args[0] === "config", () => ({ code: 2, stdout: "" })) }))).toEqual(refusal(CHECKS.noRemoteConfig));
    expect(await run(inputOf(c, { git: gitAnswering((args) => args[0] === "config", () => ({ code: 0, stdout: "remote.origin.url x\n" })) }))).toEqual(refusal(CHECKS.noRemoteConfig));
    expect(await run(inputOf(c, { git: gitAnswering((args) => args[0] === "rev-parse" && args[1] === "HEAD", throwing) }))).toEqual(refusal(CHECKS.headCommit));
    expect(await run(inputOf(c, { git: gitAnswering((args) => args.includes("status"), () => ({ code: 128, stdout: "" })) }))).toEqual(refusal(CHECKS.cleanWorktree));
    // "Not nested" needs git's own not-a-repository exit code (128); any other failure proves nothing.
    expect(await run(inputOf(c, { git: gitAnswering((args) => args.includes("--show-toplevel"), () => ({ code: 1, stdout: "" })) }))).toEqual(refusal(CHECKS.notNested));
    expect(await run(inputOf(c, { git: gitAnswering((args) => args.includes("--show-toplevel"), () => ({ code: 0, stdout: `${c.holder}\n` })) }))).toEqual(refusal(CHECKS.notNested));
    expect(await run(inputOf(c, { realpath: () => Promise.reject(new Error("realpath exploded")) }))).toEqual(refusal(CHECKS.scratchRootRealpath));
    expect(await run(inputOf(c, { readFile: () => Promise.reject(new Error("readFile exploded")) }))).toEqual(refusal(CHECKS.ownerMarkerMissing));
    expect(await run(inputOf(c, { readFile: async () => "a string, not bytes" as unknown as Uint8Array }))).toEqual(refusal(CHECKS.ownerMarkerMissing));
  });

  it("runs no git command until the ownership marker matches its digest", async () => {
    const c = await control("order");
    const calls: string[] = [];
    const spy = async (args: readonly string[], cwd: string) => {
      calls.push(args.join(" "));
      return realGit(args, cwd);
    };
    const wrongDigest = receiptOf(c.report, (target) => { target.ownershipMarker = { path: target.ownershipMarker.path, sha256: "f".repeat(64) }; });
    expect(await run(inputOf(c, { receipt: wrongDigest, git: spy }))).toEqual(refusal(CHECKS.ownerMarkerDigest));
    expect(calls).toEqual([]);
    expect(await run(inputOf(c, { git: spy }))).toEqual(ADMITTED);
    expect(calls).toHaveLength(6);
  });

  it("runs git status with core.fsmonitor off, so a repository config cannot make git run a program", async () => {
    const c = await control("fsmonitor");
    const ran = join(c.holder, "fsmonitor-ran");
    const hook = join(c.holder, "fsmonitor-hook.sh");
    await writeFile(hook, `#!/bin/sh\necho ran > "${ran}"\n`, "utf8");
    await chmod(hook, 0o755);
    await git(c.repo, "config", "core.fsmonitor", hook);
    // Control: a plain git status in this repository does run the configured program, so the hook is live.
    await git(c.repo, "status", "--porcelain");
    expect(await stat(ran).then(() => true, () => false)).toBe(true);
    await rm(ran);
    // The assertion's own status call does not run it (and it really does run a status: the stub that admits everything would not).
    const commands: string[] = [];
    const spy = async (args: readonly string[], cwd: string) => {
      commands.push(args.join(" "));
      return realGit(args, cwd);
    };
    expect(await run(inputOf(c, { git: spy }))).toEqual(ADMITTED);
    expect(commands.filter((command) => command.includes(" status "))).toEqual(["-c core.fsmonitor=false status --porcelain -uall"]);
    expect(await stat(ran).then(() => true, () => false)).toBe(false);
  });

  it("has refused with every named check at least once in this file", () => {
    expect([...observedChecks].sort()).toEqual(Object.values(CCC_PLANNING_DISPOSABLE_TARGET_CHECKS).sort());
  });
});
