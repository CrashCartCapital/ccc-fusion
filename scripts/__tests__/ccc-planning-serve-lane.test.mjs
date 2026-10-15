/*
FNXC:CccPlanningServeLane 2026-10-14-18:47:
Card IP (CONTRACT-v3.3 section 4.2 step 5a, D26), serve-lane half. No real `fn serve` is ever launched here and nothing binds port 4040. The proofs are:
- the log parser turns the lines `fn serve` really prints (`[serve] HTTP layer bound to project ...`, `[serve] Auto-registered project ...`, the `-> http://host:port` banner) into the four coded liveness verdicts;
- the launch builder produces a Pueue command whose payload is `env -i` with a sealed environment, `PI_OFFLINE=1`, `--port 0`, `--host 127.0.0.1`, `--no-auto-register`, the target as the working directory and no `PORT=`; the payload is really executed through `sh -c` against a fake `fn` that prints what it saw, and a copy of it with `env -i` removed is executed too, to show the credential canaries would have leaked (the canary assertion has teeth);
- the lane start and stop code is driven through a fake Pueue, `lsof` and `pgrep`, so the sequence of commands, the single `pueue kill <task id>`, and the refusals are asserted without any real daemon.
Every refusal has the clean twin that must pass.
*/
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
  CccPlanningServeLaneError,
  buildCccPlanningServeLaunch,
  parseCccPlanningServeLog,
  parseCccPlanningServePid,
  startCccPlanningServeLane,
  startOwnedPostgres,
  stopCccPlanningServeLane,
} from "../lib/ccc-planning-serve-lane.mjs";

const PROJECT_ID = "proj_r2cfixture01";
const BOUND = `[serve] HTTP layer bound to project ccc-r2c-i2 (${PROJECT_ID}) [source: --project]`;
const banner = (port, host = "127.0.0.1") => ["", "  Fusion Node", "  ────────────────────────", `  → http://${host}:${port}`, "", "  Health:     GET /api/health", ""].join("\n");
const BOOT = ["[serve] hybrid executor gate: enabled=false reason=none", "[plugins] Loaded 3 plugins (0 errors)"].join("\n");
const cleanLog = (port = 55123) => [BOOT, BOUND, banner(port)].join("\n");

async function withScratch(prefix, body) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function rejectsLane(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CccPlanningServeLaneError, `expected a CccPlanningServeLaneError, got ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

describe("serve log liveness", () => {
  test("accepts a clean log with one bound line and one listening banner and returns the port", () => {
    assert.deepEqual(parseCccPlanningServeLog(cleanLog(55123), PROJECT_ID), { ok: true, port: 55123 });
    assert.deepEqual(parseCccPlanningServeLog(cleanLog(55124).replaceAll("\n", "\r\n"), PROJECT_ID), { ok: true, port: 55124 });
  });

  test("gives CCC_PLANNING_SERVE_NOT_BOUND for an empty log, a bound line for another project, a missing banner and a non-loopback banner", () => {
    const code = (log) => {
      const verdict = parseCccPlanningServeLog(log, PROJECT_ID);
      assert.equal(verdict.ok, false, log);
      return verdict.code;
    };
    assert.equal(code(""), "CCC_PLANNING_SERVE_NOT_BOUND");
    assert.equal(code(BOOT), "CCC_PLANNING_SERVE_NOT_BOUND");
    assert.equal(code([BOOT, BOUND.replace(PROJECT_ID, "proj_someoneelse"), banner(55123)].join("\n")), "CCC_PLANNING_SERVE_NOT_BOUND");
    assert.equal(code([BOOT, BOUND].join("\n")), "CCC_PLANNING_SERVE_NOT_BOUND", "the bound line is printed before the port is listening");
    assert.equal(code([BOOT, BOUND, banner(55123, "0.0.0.0")].join("\n")), "CCC_PLANNING_SERVE_NOT_BOUND");
    assert.deepEqual(parseCccPlanningServeLog(cleanLog(), PROJECT_ID), { ok: true, port: 55123 }, "the clean twin passes");
  });

  test("gives CCC_PLANNING_SERVE_AUTO_REGISTERED when an Auto-registered line is present, even beside a clean bound line", () => {
    const auto = `[serve] Auto-registered project "target" at /scratch/target`;
    const verdict = parseCccPlanningServeLog([BOOT, auto, BOUND, banner(55123)].join("\n"), PROJECT_ID);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "CCC_PLANNING_SERVE_AUTO_REGISTERED");
    assert.equal(parseCccPlanningServeLog([BOOT, auto].join("\n"), PROJECT_ID).code, "CCC_PLANNING_SERVE_AUTO_REGISTERED", "also before anything is bound");
    assert.deepEqual(parseCccPlanningServeLog([BOOT, BOUND, banner(55123)].join("\n"), PROJECT_ID), { ok: true, port: 55123 }, "the same log without the line passes");
  });

  test("gives CCC_PLANNING_SERVE_PORT_FORBIDDEN for a 4040 binding and accepts the neighbouring ports", () => {
    const verdict = parseCccPlanningServeLog([BOOT, BOUND, banner(4040)].join("\n"), PROJECT_ID);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "CCC_PLANNING_SERVE_PORT_FORBIDDEN");
    assert.equal(parseCccPlanningServeLog([BOUND, banner(0)].join("\n"), PROJECT_ID).code, "CCC_PLANNING_SERVE_PORT_FORBIDDEN", "port 0 in a banner is a bug, not a binding");
    for (const port of [4039, 4041, 55123]) assert.deepEqual(parseCccPlanningServeLog([BOUND, banner(port)].join("\n"), PROJECT_ID), { ok: true, port });
  });

  test("gives CCC_PLANNING_SERVE_MULTIPLE_BINDINGS for two bound lines and for two banners", () => {
    assert.equal(parseCccPlanningServeLog([BOUND, BOUND, banner(55123)].join("\n"), PROJECT_ID).code, "CCC_PLANNING_SERVE_MULTIPLE_BINDINGS");
    assert.equal(parseCccPlanningServeLog([BOUND, banner(55123), banner(55124)].join("\n"), PROJECT_ID).code, "CCC_PLANNING_SERVE_MULTIPLE_BINDINGS");
    assert.deepEqual(parseCccPlanningServeLog([BOUND, banner(55123)].join("\n"), PROJECT_ID), { ok: true, port: 55123 });
  });

  test("reads the child pid the launch script prints before it execs, and nothing else", () => {
    assert.equal(parseCccPlanningServePid(`ccc-planning-serve-lane pid=4242\n${cleanLog()}`), 4242);
    assert.equal(parseCccPlanningServePid(cleanLog()), null);
    assert.equal(parseCccPlanningServePid("ccc-planning-serve-lane pid=0\n"), null);
    assert.equal(parseCccPlanningServePid("ccc-planning-serve-lane pid=12abc\n"), null);
    assert.equal(parseCccPlanningServePid("ccc-planning-serve-lane pid=11\nccc-planning-serve-lane pid=12\n"), null, "two pid lines are ambiguous");
  });
});

describe("serve launch builder", () => {
  const baseInput = (root) => ({
    executablePath: path.join(root, "install/node_modules/.bin/fn"),
    targetDir: path.join(root, "target"),
    home: path.join(root, "home"),
    databaseUrl: "postgresql://postgres@127.0.0.1:55432/fusion",
    projectId: PROJECT_ID,
    pathEnv: "/usr/bin:/bin",
    tmpDir: path.join(root, "tmp"),
    group: "ccc-r2c-i2",
    label: "ccc-planning-serve-test",
  });

  test("puts env -i, PI_OFFLINE=1, --port 0, --host 127.0.0.1 and --no-auto-register in the Pueue payload, with the target as cwd and no PORT=", () => {
    const input = baseInput("/scratch/root");
    const launch = buildCccPlanningServeLaunch(input);
    assert.equal(launch.cwd, input.targetDir);
    assert.deepEqual(launch.argv.slice(0, 10), ["pueue", "add", "--group", "ccc-r2c-i2", "--label", "ccc-planning-serve-test", "--working-directory", input.targetDir, "--print-task-id", "--"]);
    assert.equal(launch.argv.length, 11, "the whole payload is one shell command string");
    const payload = launch.argv.at(-1);
    const joined = launch.argv.join(" ");
    for (const required of ["/usr/bin/env -i", "PI_OFFLINE=1", "--port 0", "--host 127.0.0.1", "--no-auto-register", `--project ${PROJECT_ID}`, "NO_COLOR=1", "serve"]) {
      assert.ok(joined.includes(required), `argv holds ${required}`);
    }
    assert.ok(payload.includes(`cd '${input.targetDir}' && exec /usr/bin/env -i`), "cd to the target, then exec the scrubbed command");
    assert.ok(payload.startsWith('echo "ccc-planning-serve-lane pid=$$"; '), "the pid is announced before exec");
    assert.doesNotMatch(joined, /(^|[\s'"])PORT=/u, "no PORT= anywhere");
    assert.ok(payload.includes(`HOME='${input.home}'`) && payload.includes(`FUSION_HOME='${input.home}/.fusion'`));
    assert.ok(payload.includes(`DATABASE_URL='${input.databaseUrl}'`));
    assert.equal(launch.argv.some((arg) => /OMNIROUTE|ANTHROPIC|OPENAI|_API_KEY|_TOKEN/u.test(arg)), false);
  });

  test("refuses a relative path, an unsafe group or label, a project id with shell characters, and a database url that is shared, remote or carries a password", () => {
    const valid = baseInput("/scratch/root");
    assert.doesNotThrow(() => buildCccPlanningServeLaunch(valid));
    const bad = [
      ["executablePath", { executablePath: "relative/fn" }],
      ["targetDir", { targetDir: "target" }],
      ["home", { home: "home" }],
      ["tmpDir", { tmpDir: "tmp" }],
      ["pathEnv", { pathEnv: "" }],
      ["pathEnv", { pathEnv: "/usr/bin\n/bin" }],
      ["group", { group: "bad group" }],
      ["group", { group: "x;rm" }],
      ["label", { label: "$(id)" }],
      ["projectId", { projectId: "proj_1; echo hi" }],
      ["databaseUrl", { databaseUrl: "postgresql://postgres@127.0.0.1:5432/fusion" }],
      ["databaseUrl", { databaseUrl: "postgresql://postgres@localhost:5432/fusion" }],
      ["databaseUrl", { databaseUrl: "postgresql://postgres@127.0.0.1/fusion" }],
      ["databaseUrl", { databaseUrl: "postgresql://postgres@10.0.0.7:55432/fusion" }],
      ["databaseUrl", { databaseUrl: "postgresql://postgres:secret@127.0.0.1:55432/fusion" }],
      ["databaseUrl", { databaseUrl: "postgresql://postgres@127.0.0.1:4040/fusion" }],
      ["databaseUrl", { databaseUrl: "http://127.0.0.1:55432/fusion" }],
      ["databaseUrl", { databaseUrl: "not a url" }],
    ];
    for (const [field, change] of bad) {
      assert.throws(
        () => buildCccPlanningServeLaunch({ ...valid, ...change }),
        (error) => error instanceof CccPlanningServeLaneError && error.code === "CCC_PLANNING_SERVE_LAUNCH_INVALID" && error.field === field,
        `${field} ${JSON.stringify(change)}`,
      );
    }
  });

  test("executes through sh with a sealed environment: the fake fn sees the exact argv, the target as cwd, the isolated home and none of the parent's canaries", async () => {
    await withScratch("ccc-ip-launch-", async (scratch) => {
      const root = path.join(scratch, "it's a root");
      const input = baseInput(root);
      input.home = path.join(root, "my home");
      input.pathEnv = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
      await mkdir(input.targetDir, { recursive: true });
      await mkdir(path.dirname(input.executablePath), { recursive: true });
      await writeFile(input.executablePath, [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, pid: process.pid }));",
        "",
      ].join("\n"));
      await chmod(input.executablePath, 0o755);
      const launch = buildCccPlanningServeLaunch(input);
      const canaries = { OMNIROUTE_API_KEY: "canary-1", ANTHROPIC_API_KEY: "canary-2", GH_TOKEN: "canary-3", PORT: "4040", NODE_OPTIONS: "--no-warnings" };
      const execute = (command) => {
        const result = spawnSync("sh", ["-c", command], { cwd: scratch, encoding: "utf8", env: { ...process.env, ...canaries }, timeout: 30_000 });
        assert.equal(result.status, 0, result.stderr);
        const [pidLine, jsonLine] = result.stdout.trim().split("\n");
        return { pid: parseCccPlanningServePid(`${pidLine}\n`), seen: JSON.parse(jsonLine) };
      };

      const { pid, seen } = execute(launch.argv.at(-1));
      assert.deepEqual(seen.argv, ["serve", "--port", "0", "--host", "127.0.0.1", "--no-auto-register", "--project", PROJECT_ID]);
      assert.equal(seen.cwd, await realpath(input.targetDir), "the working directory is the target");
      assert.equal(seen.pid, pid, "the announced pid survives the exec chain, so it is the serve process");
      for (const name of Object.keys(canaries)) assert.equal(seen.env[name], undefined, `${name} must not reach serve`);
      assert.equal(seen.env.HOME, input.home);
      assert.equal(seen.env.FUSION_HOME, path.join(input.home, ".fusion"));
      assert.equal(seen.env.DATABASE_URL, input.databaseUrl);
      assert.equal(seen.env.TMPDIR, input.tmpDir);
      assert.equal(seen.env.PI_OFFLINE, "1");
      assert.equal(seen.env.NO_COLOR, "1");
      assert.equal(seen.env.PATH, input.pathEnv);
      assert.equal(seen.env.LANG, "en_US.UTF-8");
      const names = Object.keys(seen.env).filter((name) => name !== "__CF_USER_TEXT_ENCODING").sort();
      assert.deepEqual(names, ["DATABASE_URL", "FUSION_HOME", "HOME", "LANG", "NO_COLOR", "PATH", "PI_OFFLINE", "TMPDIR"]);

      const broken = launch.argv.at(-1).replace("/usr/bin/env -i ", "/usr/bin/env ");
      assert.notEqual(broken, launch.argv.at(-1), "the mutation applied");
      const leaked = execute(broken).seen.env;
      assert.equal(leaked.OMNIROUTE_API_KEY, "canary-1", "without env -i the canary leaks, so the assertion above has teeth");
      assert.equal(leaked.PORT, "4040");
    });
  });
});

describe("owned PostgreSQL", () => {
  const recorder = () => {
    const calls = [];
    return { calls, run: async (argv) => { calls.push(argv); return { exitCode: 0, stdout: "", stderr: "" }; } };
  };

  test("runs initdb, pg_ctl start and createdb with loopback-only arguments on a free port that is neither 5432 nor 4040, then stops once", async () => {
    await withScratch("ccc-ip-pg-", async (root) => {
      const { calls, run } = recorder();
      const dataDir = path.join(root, "pg");
      const logPath = path.join(root, "pg.log");
      const pg = await startOwnedPostgres({ dataDir, pgBin: "/opt/pg/bin", logPath }, { run });
      assert.ok(Number.isInteger(pg.port) && pg.port > 1023 && pg.port !== 5432 && pg.port !== 4040, `port ${pg.port}`);
      assert.equal(pg.databaseUrl, `postgresql://postgres@127.0.0.1:${pg.port}/fusion`);
      assert.deepEqual(calls[0], ["/opt/pg/bin/initdb", "-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale"]);
      const start = calls[1];
      assert.deepEqual(start.slice(0, 6), ["/opt/pg/bin/pg_ctl", "-D", dataDir, "-l", logPath, "-w"]);
      const options = start[start.indexOf("-o") + 1];
      assert.equal(options, `-c unix_socket_directories= -c listen_addresses=127.0.0.1 -c max_connections=200 -p ${pg.port}`);
      assert.equal(start.at(-1), "start");
      assert.deepEqual(calls[2], ["/opt/pg/bin/createdb", "-h", "127.0.0.1", "-p", String(pg.port), "-U", "postgres", "fusion"]);
      assert.equal(calls.length, 3);
      await pg.stop();
      assert.deepEqual(calls[3], ["/opt/pg/bin/pg_ctl", "-D", dataDir, "-m", "fast", "-w", "stop"]);
      await pg.stop();
      assert.equal(calls.length, 4, "a second stop is a no-op");
    });
  });

  test("refuses a picked port of 5432 or 4040 before running anything, and a data directory that already holds files", async () => {
    await withScratch("ccc-ip-pg-refuse-", async (root) => {
      for (const forbidden of [5432, 4040, 80]) {
        const { calls, run } = recorder();
        await rejectsLane(startOwnedPostgres({ dataDir: path.join(root, `pg-${forbidden}`), pgBin: "/opt/pg/bin", logPath: path.join(root, "pg.log") }, { run, pickPort: async () => forbidden }), "CCC_PLANNING_SERVE_PG_FAILED");
        assert.deepEqual(calls, [], `port ${forbidden}: nothing ran`);
      }
      const busy = path.join(root, "busy");
      await mkdir(busy);
      await writeFile(path.join(busy, "PG_VERSION"), "15\n");
      const { calls, run } = recorder();
      await rejectsLane(startOwnedPostgres({ dataDir: busy, pgBin: "/opt/pg/bin", logPath: path.join(root, "pg.log") }, { run }), "CCC_PLANNING_SERVE_PG_FAILED");
      assert.deepEqual(calls, []);
      await startOwnedPostgres({ dataDir: path.join(root, "fresh"), pgBin: "/opt/pg/bin", logPath: path.join(root, "pg.log") }, { run: recorder().run, pickPort: async () => 55432 });
    });
  });

  test("really executes the binaries it is given when no run function is injected", async () => {
    await withScratch("ccc-ip-pg-real-", async (root) => {
      const bin = path.join(root, "bin");
      await mkdir(bin);
      for (const name of ["initdb", "pg_ctl", "createdb"]) {
        await writeFile(path.join(bin, name), `#!/bin/sh\necho "${name} $@" >> ${JSON.stringify(path.join(root, "calls.txt"))}\nenv > ${JSON.stringify(path.join(root, `env-${name}.txt`))}\nexit 0\n`);
        await chmod(path.join(bin, name), 0o755);
      }
      const previous = process.env.OMNIROUTE_API_KEY;
      process.env.OMNIROUTE_API_KEY = "canary-pg";
      let pg;
      try {
        pg = await startOwnedPostgres({ dataDir: path.join(root, "pg"), pgBin: bin, logPath: path.join(root, "pg.log") });
        await pg.stop();
      } finally {
        if (previous === undefined) delete process.env.OMNIROUTE_API_KEY;
        else process.env.OMNIROUTE_API_KEY = previous;
      }
      const lines = (await readFile(path.join(root, "calls.txt"), "utf8")).trim().split("\n");
      assert.deepEqual(lines.map((line) => line.split(" ")[0]), ["initdb", "pg_ctl", "createdb", "pg_ctl"]);
      assert.match(lines[1], /listen_addresses=127\.0\.0\.1/u);
      const seen = await readFile(path.join(root, "env-initdb.txt"), "utf8");
      assert.match(seen, /^PATH=/mu, "the cluster tools still get a PATH");
      assert.doesNotMatch(seen, /canary-pg|OMNIROUTE_API_KEY/u, "no credential of the caller reaches the cluster tools");
    });
  });
});

/** A fake Pueue, lsof and pgrep. Every command the lane runs goes through here and is recorded. */
function fakeHost(options = {}) {
  const state = {
    groups: options.groups ?? { default: { status: "Paused", parallel_tasks: 2 } },
    nextId: options.nextId ?? 41,
    snapshots: options.snapshots ?? [`ccc-planning-serve-lane pid=4242\n${cleanLog(55123)}`],
    taskStatus: options.taskStatus ?? "Running",
    listeners: options.listeners ?? [options.listener ?? "127.0.0.1:55123"],
    descendants: options.descendants ?? [],
    calls: [],
    envs: [],
    kills: [],
    polls: 0,
    clock: 0,
    sleeps: 0,
  };
  const reply = (stdout = "", exitCode = 0, stderr = "") => ({ exitCode, stdout, stderr });
  state.deps = {
    now: () => state.clock,
    sleep: async (ms) => { state.clock += ms; state.sleeps += 1; },
    run: async (argv, runOptions = {}) => {
      state.calls.push(argv);
      state.envs.push(runOptions.env);
      const [tool, sub] = argv;
      if (tool === "pueue" && sub === "group" && argv[2] === "--json") return reply(JSON.stringify(state.groups));
      if (tool === "pueue" && sub === "group" && argv[2] === "add") { state.groups[argv[3]] = { status: "Running", parallel_tasks: 1 }; return reply(); }
      if (tool === "pueue" && sub === "parallel") return reply();
      if (tool === "pueue" && sub === "add") { state.added = argv; return reply(`${state.nextId}\n`); }
      if (tool === "pueue" && sub === "log") {
        const index = Math.min(state.polls, state.snapshots.length - 1);
        state.polls += 1;
        const status = state.taskStatus === "Running" ? { Running: { enqueued_at: "x", start: "y" } } : { Done: { result: "Success" } };
        return reply(JSON.stringify({ [String(argv.at(-1))]: { task: { id: Number(argv.at(-1)), status }, output: state.snapshots[index] } }));
      }
      if (tool === "pueue" && sub === "kill") { state.kills.push(argv); state.taskStatus = "Done"; return reply(); }
      if (tool === "lsof") return reply(`p4242\n${state.listeners.map((address) => `n${address}`).join("\n")}\n`);
      if (tool === "pgrep") return state.descendants.length ? reply(`${state.descendants.join("\n")}\n`) : reply("", 1);
      return reply("", 127, `unexpected command ${argv.join(" ")}`);
    },
  };
  return state;
}

const laneInput = (extra = {}) => ({
  executablePath: "/scratch/root/install/node_modules/.bin/fn",
  targetDir: "/scratch/root/target",
  home: "/scratch/root/home",
  databaseUrl: "postgresql://postgres@127.0.0.1:55432/fusion",
  projectId: PROJECT_ID,
  pathEnv: "/usr/bin:/bin",
  tmpDir: "/scratch/root/tmp",
  group: "ccc-r2c-i2",
  label: "ccc-planning-serve-test",
  ...extra,
});

describe("serve lane start and stop through a fake Pueue", () => {
  test("creates the group when absent, caps it to one task, adds the task, reads the bound port and checks the listener belongs to the pid", async () => {
    const host = fakeHost();
    const lane = await startCccPlanningServeLane(laneInput(), host.deps);
    assert.deepEqual(lane, { pueueTaskId: 41, port: 55123, pid: 4242 });
    const commands = host.calls.map((argv) => argv.slice(0, 4).join(" "));
    assert.ok(commands.includes("pueue group add ccc-r2c-i2"), "the missing group is created");
    assert.ok(host.calls.some((argv) => argv.join(" ") === "pueue parallel 1 --group ccc-r2c-i2"));
    assert.ok(commands.indexOf("pueue group add ccc-r2c-i2") < commands.findIndex((c) => c.startsWith("pueue add")), "group first, task second");
    assert.deepEqual(host.added, buildCccPlanningServeLaunch(laneInput()).argv, "the task is exactly the built launch");
    const lsof = host.calls.find((argv) => argv[0] === "lsof");
    assert.deepEqual(lsof, ["lsof", "-b", "-nP", "-a", "-p", "4242", "-iTCP", "-sTCP:LISTEN", "-Fn"], "the listener is asked about that pid only");
    assert.equal(host.kills.length, 0, "a healthy start kills nothing");
  });

  test("leaves an existing group alone and keeps polling until the bound line and banner appear", async () => {
    const host = fakeHost({
      groups: { default: { status: "Paused", parallel_tasks: 2 }, "ccc-r2c-i2": { status: "Running", parallel_tasks: 1 } },
      snapshots: [
        "ccc-planning-serve-lane pid=4242\n[serve] hybrid executor gate: enabled=false reason=none",
        `ccc-planning-serve-lane pid=4242\n${BOOT}\n${BOUND}`,
        `ccc-planning-serve-lane pid=4242\n${cleanLog(55123)}`,
      ],
    });
    const lane = await startCccPlanningServeLane(laneInput(), host.deps);
    assert.equal(lane.port, 55123);
    assert.ok(!host.calls.some((argv) => argv.join(" ") === "pueue group add ccc-r2c-i2"), "no group add for an existing group");
    assert.equal(host.polls, 3);
    assert.equal(host.sleeps, 2);
  });

  test("hands Pueue a scrubbed client environment, so no credential is stored in the task", async () => {
    const host = fakeHost();
    const names = ["OMNIROUTE_API_KEY", "ANTHROPIC_API_KEY", "GH_TOKEN", "PORT"];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, { OMNIROUTE_API_KEY: "canary-1", ANTHROPIC_API_KEY: "canary-2", GH_TOKEN: "canary-3", PORT: "4040" });
    try {
      await startCccPlanningServeLane(laneInput(), host.deps);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    const pueueEnvs = host.calls.map((argv, index) => [argv, host.envs[index]]).filter(([argv]) => argv[0] === "pueue");
    assert.ok(pueueEnvs.length >= 4);
    for (const [argv, env] of pueueEnvs) {
      assert.ok(env && typeof env === "object", `${argv.slice(0, 3).join(" ")} gets an explicit environment`);
      for (const name of names) assert.equal(env[name], undefined, `${name} must not reach pueue (${argv.slice(0, 3).join(" ")})`);
      assert.ok(env.PATH && env.HOME, "pueue still finds its own config through HOME");
    }
  });

  test("kills only its own task and throws the coded error for an Auto-registered line, a 4040 binding and a doubled binding", async () => {
    const cases = [
      ["CCC_PLANNING_SERVE_AUTO_REGISTERED", `ccc-planning-serve-lane pid=4242\n[serve] Auto-registered project "target" at /x\n${cleanLog()}`],
      ["CCC_PLANNING_SERVE_PORT_FORBIDDEN", `ccc-planning-serve-lane pid=4242\n${BOUND}\n${banner(4040)}`],
      ["CCC_PLANNING_SERVE_MULTIPLE_BINDINGS", `ccc-planning-serve-lane pid=4242\n${BOUND}\n${BOUND}\n${banner(55123)}`],
    ];
    for (const [code, log] of cases) {
      const host = fakeHost({ snapshots: [log] });
      await rejectsLane(startCccPlanningServeLane(laneInput(), host.deps), code);
      assert.deepEqual(host.kills, [["pueue", "kill", "41"]], `${code}: exactly one kill, of this task id`);
    }
    const clean = fakeHost();
    await startCccPlanningServeLane(laneInput(), clean.deps);
    assert.deepEqual(clean.kills, [], "the clean twin kills nothing");
  });

  test("refuses a listener that is not the announced port, and kills the task", async () => {
    const mismatch = fakeHost({ listener: "127.0.0.1:55999" });
    await rejectsLane(startCccPlanningServeLane(laneInput(), mismatch.deps), "CCC_PLANNING_SERVE_LISTENER_MISMATCH");
    assert.deepEqual(mismatch.kills, [["pueue", "kill", "41"]]);
    const foreign = fakeHost({ listener: "0.0.0.0:55123" });
    await rejectsLane(startCccPlanningServeLane(laneInput(), foreign.deps), "CCC_PLANNING_SERVE_LISTENER_MISMATCH");
    const ok = fakeHost({ listener: "127.0.0.1:55123" });
    assert.equal((await startCccPlanningServeLane(laneInput(), ok.deps)).port, 55123);
  });

  /*
  FNXC:CccPlanningServeLane 2026-10-14-21:13:
  E9 IP item 5 (mutant S25): the module header promises that a serve pid listening on the announced loopback port AND on any other non-loopback address is refused. The earlier test only covered a single foreign listener, so removing the `every loopback` half survived.
  */
  test("refuses a serve pid that listens on the announced loopback port and also on a non-loopback address, with one kill", async () => {
    for (const extra of ["*:55124", "0.0.0.0:55124", "192.168.1.20:55124"]) {
      const wide = fakeHost({ listeners: ["127.0.0.1:55123", extra] });
      await rejectsLane(startCccPlanningServeLane(laneInput(), wide.deps), "CCC_PLANNING_SERVE_LISTENER_MISMATCH");
      assert.deepEqual(wide.kills, [["pueue", "kill", "41"]], `${extra}: exactly one kill, of this task id`);
      assert.equal(wide.calls.filter((argv) => argv[0] === "lsof").length, 1, `${extra}: one listener question`);
    }
    const loopbackOnly = fakeHost({ listeners: ["127.0.0.1:55123", "[::1]:55124"] });
    assert.equal((await startCccPlanningServeLane(laneInput(), loopbackOnly.deps)).port, 55123, "a second loopback listener is fine");
    assert.deepEqual(loopbackOnly.kills, []);
  });

  /*
  FNXC:CccPlanningServeLane 2026-10-14-21:13:
  E9 IP item 5 (mutant S26): a clean bound log without exactly one pid line cannot be tied to the Pueue task, so the lane refuses before it asks lsof anything. The earlier fake lsof answered for any pid, so removing the refusal survived.
  */
  test("refuses a clean bound log that carries no single pid line, without asking lsof, with one kill", async () => {
    const pidLine = (pid) => `ccc-planning-serve-lane pid=${pid}`;
    const unusable = {
      "no pid line": cleanLog(55123),
      "two pid lines": `${pidLine(4242)}\n${pidLine(4243)}\n${cleanLog(55123)}`,
      "a malformed pid line": `ccc-planning-serve-lane pid=12abc\n${cleanLog(55123)}`,
    };
    for (const [label, log] of Object.entries(unusable)) {
      const host = fakeHost({ snapshots: [log] });
      await rejectsLane(startCccPlanningServeLane(laneInput(), host.deps), "CCC_PLANNING_SERVE_TASK_FAILED");
      assert.ok(!host.calls.some((argv) => argv[0] === "lsof"), `${label}: lsof was never asked`);
      assert.deepEqual(host.kills, [["pueue", "kill", "41"]], `${label}: exactly one kill, of this task id`);
    }
    const withPid = fakeHost({ snapshots: [`${pidLine(4242)}\n${cleanLog(55123)}`] });
    assert.deepEqual(await startCccPlanningServeLane(laneInput(), withPid.deps), { pueueTaskId: 41, port: 55123, pid: 4242 });
    assert.deepEqual(withPid.kills, []);
  });

  test("times out with CCC_PLANNING_SERVE_NOT_BOUND and kills the task, and reports a task that ended early", async () => {
    const silent = fakeHost({ snapshots: ["ccc-planning-serve-lane pid=4242\n[serve] hybrid executor gate: enabled=false reason=none"] });
    await rejectsLane(startCccPlanningServeLane(laneInput({ timeoutMs: 5_000, pollIntervalMs: 1_000 }), silent.deps), "CCC_PLANNING_SERVE_NOT_BOUND");
    assert.deepEqual(silent.kills, [["pueue", "kill", "41"]]);
    assert.ok(silent.clock >= 5_000 && silent.clock < 7_000, `the fake clock stopped at the deadline (${silent.clock})`);
    const ended = fakeHost({ snapshots: ["ccc-planning-serve-lane pid=4242\n[serve] No engines started — registry empty or all engines failed to start. Exiting."], taskStatus: "Done" });
    await rejectsLane(startCccPlanningServeLane(laneInput({ timeoutMs: 5_000, pollIntervalMs: 1_000 }), ended.deps), "CCC_PLANNING_SERVE_TASK_FAILED");
  });

  test("refuses an existing group that is paused before adding any task, and re-caps an existing group that is not at one task", async () => {
    const paused = fakeHost({ groups: { "ccc-r2c-i2": { status: "Paused", parallel_tasks: 1 } } });
    await rejectsLane(startCccPlanningServeLane(laneInput(), paused.deps), "CCC_PLANNING_SERVE_LAUNCH_INVALID");
    assert.ok(!paused.calls.some((argv) => argv[1] === "add" && argv[0] === "pueue"), "no task was added to a paused group");
    const wide = fakeHost({ groups: { "ccc-r2c-i2": { status: "Running", parallel_tasks: 3 } } });
    await startCccPlanningServeLane(laneInput(), wide.deps);
    assert.ok(wide.calls.some((argv) => argv.join(" ") === "pueue parallel 1 --group ccc-r2c-i2"), "an existing group is capped to one task");
    const exact = fakeHost({ groups: { "ccc-r2c-i2": { status: "Running", parallel_tasks: 1 } } });
    await startCccPlanningServeLane(laneInput(), exact.deps);
    assert.ok(!exact.calls.some((argv) => argv[1] === "parallel"), "a group already at one task is left alone");
  });

  test("stops by killing only the named task, then confirms no process of its group remains", async () => {
    const host = fakeHost({ taskStatus: "Running" });
    const stopped = await stopCccPlanningServeLane({ pueueTaskId: 41, pid: 4242 }, host.deps);
    assert.deepEqual(stopped, { stopped: true, descendantsRemaining: 0 });
    assert.deepEqual(host.kills, [["pueue", "kill", "41"]]);
    assert.ok(host.calls.some((argv) => argv.join(" ") === "pgrep -g 4242"), "descendants are looked up by the task's process group");
    const killIndex = host.calls.findIndex((argv) => argv[1] === "kill");
    const groupIndex = host.calls.findIndex((argv) => argv[0] === "pgrep");
    assert.ok(killIndex >= 0 && groupIndex > killIndex, "kill first, then the group check");
  });

  test("refuses with CCC_PLANNING_SERVE_DESCENDANTS_REMAIN when a process of the group survives, and sends no second signal", async () => {
    const host = fakeHost({ descendants: [4301, 4302] });
    await rejectsLane(stopCccPlanningServeLane({ pueueTaskId: 41, pid: 4242 }, host.deps), "CCC_PLANNING_SERVE_DESCENDANTS_REMAIN");
    assert.equal(host.kills.length, 1, "one kill of the named task and nothing else");
    for (const bad of [{ pueueTaskId: 0, pid: 4242 }, { pueueTaskId: 41, pid: 0 }, { pueueTaskId: 41.5, pid: 4242 }, { pueueTaskId: 41, pid: 1 }]) {
      const quiet = fakeHost();
      await rejectsLane(stopCccPlanningServeLane(bad, quiet.deps), "CCC_PLANNING_SERVE_LAUNCH_INVALID");
      assert.deepEqual(quiet.calls, [], `${JSON.stringify(bad)}: nothing ran`);
    }
  });
});
