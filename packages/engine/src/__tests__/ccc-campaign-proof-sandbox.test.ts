import { realpathSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCccSemanticProofDarwinProfile,
  runCccSemanticProofSandboxedProcess,
} from "../ccc-campaign-proof-sandbox.js";

const scratchRoots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ccc-semantic-proof-sandbox-test-"));
  scratchRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map(async (root) => {
    await chmod(join(root, "proof"), 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }));
});

describe("CCC semantic-proof sandbox", () => {
  it("RED-R1-python-semantic-v2-sandbox: exposes only sealed Python runtime files and denies their original roots", async () => {
    const root = await fixtureRoot();
    const proofRoot = join(root, "proof");
    const scratchRoot = join(root, "scratch");
    const sealedRuntimeRoot = join(root, "sealed-runtime");
    const originalRuntimeRoot = join(root, "original-runtime");
    const pythonExecutable = join(sealedRuntimeRoot, "bin/python3");
    const pythonStdlib = join(sealedRuntimeRoot, "lib/python3.12/os.py");
    await Promise.all([
      mkdir(proofRoot),
      mkdir(scratchRoot),
      mkdir(dirname(pythonExecutable), { recursive: true }),
      mkdir(dirname(pythonStdlib), { recursive: true }),
      mkdir(originalRuntimeRoot),
    ]);
    await Promise.all([
      writeFile(pythonExecutable, "#!/bin/sh\n", { mode: 0o755 }),
      writeFile(pythonStdlib, "# sealed\n"),
    ]);

    const profile = await buildCccSemanticProofDarwinProfile({
      proofRoot,
      scratchRoot,
      taskExecutable: "/opt/homebrew/bin/task",
      nodeExecutable: process.execPath,
      deniedReadRoots: [originalRuntimeRoot],
      pythonExecutable,
      pythonRuntimeFiles: [pythonStdlib],
    } as any);

    expect(profile).toContain(`(literal "${realpathSync(pythonExecutable)}")`);
    expect(profile).toContain(`(allow file-read* (literal "${realpathSync(pythonStdlib)}"))`);
    expect(profile).toContain(`(deny file-read* (subpath "${realpathSync(originalRuntimeRoot)}"))`);
  });

  it("RED-S5-darwin-proof-sandbox: grants only proof reads and scratch writes while denying repositories and network", async () => {
    const root = await fixtureRoot();
    const proofRoot = join(root, "proof");
    const scratchRoot = join(root, "scratch");
    const targetRepository = join(root, "target-repository");
    const engineRepository = join(root, "engine-repository");
    await Promise.all([
      mkdir(proofRoot),
      mkdir(scratchRoot),
      mkdir(targetRepository),
      mkdir(engineRepository),
    ]);

    const profile = await buildCccSemanticProofDarwinProfile({
      proofRoot,
      scratchRoot,
      taskExecutable: "/opt/homebrew/bin/task",
      nodeExecutable: process.execPath,
      deniedReadRoots: [targetRepository, engineRepository],
    });

    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(deny network*)");
    expect(profile.split("\n")).not.toContain("(allow file-read*)");
    expect(profile.split("\n")).not.toContain("(allow process*)");
    expect(profile).toContain(`(allow file-read* (subpath "${realpathSync(proofRoot)}"))`);
    expect(profile).toContain(realpathSync(scratchRoot));
    expect(profile).toContain(realpathSync(targetRepository));
    expect(profile).toContain(realpathSync(engineRepository));
  });

  it("RED-G2-node-loopback-profile: grants only one controller-selected IPv4 loopback port", async () => {
    const root = await fixtureRoot();
    const proofRoot = join(root, "proof");
    const scratchRoot = join(root, "scratch");
    const deniedRoot = join(root, "denied-repository");
    await Promise.all([mkdir(proofRoot), mkdir(scratchRoot), mkdir(deniedRoot)]);

    const profile = await buildCccSemanticProofDarwinProfile({
      proofRoot,
      scratchRoot,
      taskExecutable: "/opt/homebrew/bin/task",
      nodeExecutable: process.execPath,
      deniedReadRoots: [deniedRoot],
      loopbackPort: 43_219,
    } as never);

    expect(profile).toContain("(deny network*)");
    expect(profile).toContain('(allow network-bind (local tcp "localhost:43219"))');
    expect(profile).toContain('(allow network-inbound (local tcp "localhost:43219"))');
    expect(profile).toContain('(allow network-outbound (remote tcp "localhost:43219"))');
    expect(profile).toContain("(allow signal (target children))");
    expect(profile).not.toContain('localhost:43220');
    expect(profile.split("\n")).not.toContain("(allow network-outbound)");

    await expect(buildCccSemanticProofDarwinProfile({
      proofRoot,
      scratchRoot,
      taskExecutable: "/opt/homebrew/bin/task",
      nodeExecutable: process.execPath,
      deniedReadRoots: [deniedRoot],
      loopbackPort: 4_040,
    } as never)).rejects.toThrow(/loopback.*4040|4040.*reserved/iu);
  });

  it.skipIf(process.platform !== "darwin")(
    "RED-G2-node-loopback-profile: injects its controller port and permits a self-contained loopback exchange",
    async () => {
      const root = await fixtureRoot();
      const proofRoot = join(root, "proof");
      const scratchRoot = join(root, "scratch");
      const deniedRoot = join(root, "denied-repository");
      await Promise.all([mkdir(proofRoot), mkdir(scratchRoot), mkdir(deniedRoot)]);
      const reservation = createServer();
      await new Promise<void>((resolve, reject) => {
        reservation.once("error", reject);
        reservation.listen(0, "127.0.0.1", resolve);
      });
      const address = reservation.address();
      if (!address || typeof address === "string") throw new Error("loopback fixture did not reserve a port");
      const loopbackPort = address.port;
      await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
      await writeFile(join(proofRoot, "loopback.mjs"), [
        'import { spawn } from "node:child_process";',
        'import { createConnection, createServer } from "node:net";',
        'const port = Number(process.env.CCC_PROOF_LOOPBACK_PORT);',
        'if (!Number.isSafeInteger(port) || port <= 0) throw new Error("missing controller loopback port");',
        'const server = createServer((socket) => socket.end("ok"));',
        'await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });',
        'const received = await new Promise((resolve, reject) => {',
        '  const socket = createConnection(port, "127.0.0.1");',
        '  let text = "";',
        '  socket.on("data", (chunk) => { text += String(chunk); });',
        '  socket.once("end", () => resolve(text));',
        '  socket.once("error", reject);',
        '});',
        'await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));',
        'const adjacent = createServer();',
        'const adjacentPort = port === 65535 ? port - 1 : port + 1;',
        'const adjacentResult = await new Promise((resolve) => {',
        '  adjacent.once("error", (error) => resolve(error.code ?? "ERROR"));',
        '  adjacent.listen(adjacentPort, "127.0.0.1", () => adjacent.close(() => resolve("ALLOWED")));',
        '});',
        'const childSource = "const {createServer}=require(\\"node:net\\");const server=createServer((socket)=>socket.end(\\"child-ok\\"));server.listen(Number(process.env.PORT),\\"127.0.0.1\\",()=>process.stdout.write(\\"ready\\\\n\\"));";',
        'const child = spawn(process.execPath, ["-e", childSource], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });',
        'await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("exit", (code, signal) => reject(new Error(`child server exited before ready: ${code}/${signal}`))); });',
        'const childReceived = await new Promise((resolve, reject) => {',
        '  const socket = createConnection(port, "127.0.0.1");',
        '  let text = "";',
        '  socket.on("data", (chunk) => { text += String(chunk); });',
        '  socket.once("end", () => resolve(text));',
        '  socket.once("error", reject);',
        '});',
        'const signalSent = child.kill("SIGTERM");',
        'const childSignal = await new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));',
        'process.stdout.write(JSON.stringify({ port, received, adjacentResult, childReceived, signalSent, childSignal }));',
      ].join("\n"));
      await writeFile(join(proofRoot, "Taskfile.yml"), [
        "version: '3'",
        "tasks:",
        "  loopback:",
        "    cmds:",
        "      - node loopback.mjs",
        "",
      ].join("\n"));

      const result = await runCccSemanticProofSandboxedProcess({
        proofRoot,
        scratchRoot,
        taskExecutable: "/opt/homebrew/bin/task",
        nodeExecutable: process.execPath,
        deniedReadRoots: [deniedRoot],
        loopbackPort,
        executable: "/opt/homebrew/bin/task",
        args: ["loopback"],
        timeoutMs: 10_000,
        maxOutputBytes: 16_384,
      } as never);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        port: loopbackPort,
        received: "ok",
        adjacentResult: "EPERM",
        childReceived: "child-ok",
        signalSent: true,
        childSignal: "SIGTERM",
      });
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "RED-S5-darwin-proof-sandbox: functionally denies original-repository reads and proof-root writes",
    async () => {
      const root = await fixtureRoot();
      const proofRoot = join(root, "proof");
      const scratchRoot = join(root, "scratch");
      const targetRepository = join(root, "target-repository");
      const engineRepository = join(root, "engine-repository");
      const operatorHome = await mkdtemp(join(homedir(), ".ccc-semantic-proof-home-test-"));
      scratchRoots.push(operatorHome);
      await Promise.all([
        mkdir(proofRoot),
        mkdir(scratchRoot),
        mkdir(targetRepository),
        mkdir(engineRepository),
      ]);
      await Promise.all([
        writeFile(join(proofRoot, "allowed.txt"), "proof\n"),
        writeFile(join(targetRepository, "secret.txt"), "target-secret\n"),
        writeFile(join(engineRepository, "secret.txt"), "engine-secret\n"),
        writeFile(join(root, "operator-secret.txt"), "operator-secret\n"),
        writeFile(join(operatorHome, "secret.txt"), "home-secret\n"),
      ]);
      const probePath = join(proofRoot, "probe.mjs");
      const server = createServer((socket) => socket.end());
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("network fixture did not bind");
      await writeFile(probePath, [
        'import { readFile, writeFile } from "node:fs/promises";',
        'import { spawnSync } from "node:child_process";',
        'import { connect } from "node:net";',
        "const [proof, scratch, target, engine, operatorSecret, homeSecret, port] = process.argv.slice(2);",
        "const attempt = async (fn) => { try { await fn(); return true; } catch { return false; } };",
        "const network = () => new Promise((resolve, reject) => {",
        "  const socket = connect(Number(port), '127.0.0.1');",
        "  socket.once('connect', () => { socket.destroy(); resolve(true); });",
        "  socket.once('error', reject);",
        "  setTimeout(() => { socket.destroy(); reject(new Error('network timeout')); }, 1000).unref();",
        "});",
        "const result = {",
        '  proofRead: await attempt(() => readFile(`${proof}/allowed.txt`, "utf8")),',
        '  scratchWrite: await attempt(() => writeFile(`${scratch}/result.txt`, "ok\\n")),',
        '  targetRead: await attempt(() => readFile(`${target}/secret.txt`, "utf8")),',
        '  engineRead: await attempt(() => readFile(`${engine}/secret.txt`, "utf8")),',
        '  operatorRead: await attempt(() => readFile(operatorSecret, "utf8")),',
        '  homeRead: await attempt(() => readFile(homeSecret, "utf8")),',
        '  proofWrite: await attempt(() => writeFile(`${proof}/forbidden.txt`, "bad\\n")),',
        '  foreignExec: spawnSync("/usr/bin/env", [], { stdio: "ignore" }).status === 0,',
        "  network: await attempt(network),",
        "};",
        "process.stdout.write(JSON.stringify(result));",
      ].join("\n"));
      await chmod(proofRoot, 0o555);

      let result;
      try {
        result = await runCccSemanticProofSandboxedProcess({
          proofRoot,
          scratchRoot,
          taskExecutable: "/opt/homebrew/bin/task",
          nodeExecutable: process.execPath,
          deniedReadRoots: [targetRepository, engineRepository],
          executable: process.execPath,
          args: [
            "probe.mjs",
            realpathSync(proofRoot),
            realpathSync(scratchRoot),
            realpathSync(targetRepository),
            realpathSync(engineRepository),
            realpathSync(join(root, "operator-secret.txt")),
            realpathSync(join(operatorHome, "secret.txt")),
            String(address.port),
          ],
          timeoutMs: 10_000,
          maxOutputBytes: 16_384,
        });
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (
          error ? reject(error) : resolve()
        )));
      }

      if (result.exitCode !== 0) {
        throw new Error(`sandbox probe failed signal=${result.signal ?? "none"} stderr=${result.stderr}`);
      }
      expect(result).toMatchObject({ timedOut: false, outputOverLimit: false, exitCode: 0 });
      expect(JSON.parse(result.stdout)).toEqual({
        proofRead: true,
        scratchWrite: true,
        targetRead: false,
        engineRead: false,
        operatorRead: false,
        homeRead: false,
        proofWrite: false,
        foreignExec: false,
        network: false,
      });
      await expect(readFile(join(scratchRoot, "result.txt"), "utf8")).resolves.toBe("ok\n");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "RED-S5-controller-environment: passes only validated controller proof identity variables",
    async () => {
      const root = await fixtureRoot();
      const proofRoot = join(root, "proof");
      const scratchRoot = join(root, "scratch");
      const deniedRoot = join(root, "denied-repository");
      await Promise.all([mkdir(proofRoot), mkdir(scratchRoot), mkdir(deniedRoot)]);
      const probePath = join(proofRoot, "environment.mjs");
      await writeFile(probePath, [
        "process.stdout.write(JSON.stringify({",
        "  proofId: process.env.CCC_PROOF_ID,",
        "  phase: process.env.CCC_PROOF_PHASE,",
        "  sourceCommit: process.env.CCC_PROOF_SOURCE_COMMIT,",
        "  sourceTree: process.env.CCC_PROOF_SOURCE_TREE,",
        "  ambientSecret: process.env.CCC_AMBIENT_SECRET,",
        "  ambientLoopbackPort: process.env.CCC_PROOF_LOOPBACK_PORT,",
        "}));",
      ].join("\n"));
      await chmod(proofRoot, 0o555);
      process.env.CCC_AMBIENT_SECRET = "must-not-leak";
      process.env.CCC_PROOF_LOOPBACK_PORT = "54321";
      try {
        const result = await runCccSemanticProofSandboxedProcess({
          proofRoot,
          scratchRoot,
          taskExecutable: "/opt/homebrew/bin/task",
          nodeExecutable: process.execPath,
          deniedReadRoots: [deniedRoot],
          executable: process.execPath,
          args: ["environment.mjs"],
          proofEnvironment: {
            CCC_PROOF_ID: "PROOF-slugify",
            CCC_PROOF_PHASE: "task",
            CCC_PROOF_SOURCE_COMMIT: "a".repeat(40),
            CCC_PROOF_SOURCE_TREE: "b".repeat(40),
          },
          timeoutMs: 10_000,
          maxOutputBytes: 16_384,
        });
        expect(JSON.parse(result.stdout)).toEqual({
          proofId: "PROOF-slugify",
          phase: "task",
          sourceCommit: "a".repeat(40),
          sourceTree: "b".repeat(40),
        });
      } finally {
        delete process.env.CCC_AMBIENT_SECRET;
        delete process.env.CCC_PROOF_LOOPBACK_PORT;
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "RED-S5-sealed-node-resolution: Task cannot select a conflicting node earlier in its own directory",
    async () => {
      const root = await fixtureRoot();
      const proofRoot = join(root, "proof");
      const scratchRoot = join(root, "scratch");
      const taskBin = join(root, "a-task-bin");
      const nodeBin = join(root, "z-node-bin");
      const deniedRoot = join(root, "denied-repository");
      await Promise.all([
        mkdir(proofRoot),
        mkdir(scratchRoot),
        mkdir(taskBin),
        mkdir(nodeBin),
        mkdir(deniedRoot),
      ]);
      const taskExecutable = join(taskBin, "task");
      const conflictingNode = join(taskBin, "node");
      const sealedNode = join(nodeBin, "node");
      await Promise.all([
        writeFile(taskExecutable, "#!/bin/sh\nnode --version\n"),
        writeFile(conflictingNode, "#!/bin/sh\nprintf 'foreign-node\\n'\n"),
        writeFile(sealedNode, "#!/bin/sh\nprintf 'sealed-node\\n'\n"),
      ]);
      await Promise.all([
        chmod(taskExecutable, 0o755),
        chmod(conflictingNode, 0o755),
        chmod(sealedNode, 0o755),
      ]);

      const result = await runCccSemanticProofSandboxedProcess({
        proofRoot,
        scratchRoot,
        taskExecutable,
        nodeExecutable: sealedNode,
        deniedReadRoots: [deniedRoot],
        executable: taskExecutable,
        args: [],
        timeoutMs: 10_000,
        maxOutputBytes: 16_384,
      });

      if (result.exitCode !== 0) {
        throw new Error(`sealed-node probe failed signal=${result.signal ?? "none"} stderr=${result.stderr}`);
      }

      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "sealed-node\n",
        timedOut: false,
        outputOverLimit: false,
      });
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "RED-S5-real-task-toolchain: runs the admitted Task target with only the sealed Node and controller identity",
    async () => {
      const root = await fixtureRoot();
      const proofRoot = join(root, "proof");
      const scratchRoot = join(root, "scratch");
      const deniedRoot = join(root, "denied-repository");
      await Promise.all([mkdir(proofRoot), mkdir(scratchRoot), mkdir(deniedRoot)]);
      await writeFile(join(proofRoot, "Taskfile.yml"), [
        "version: '3'",
        "tasks:",
        "  verify:probe:",
        "    cmds:",
        "      - node harness.mjs",
        "",
      ].join("\n"));
      await writeFile(
        join(proofRoot, "harness.mjs"),
        "process.stdout.write(`${process.execPath} ${process.env.CCC_PROOF_ID}\\n`);\n",
      );
      await chmod(proofRoot, 0o555);

      const result = await runCccSemanticProofSandboxedProcess({
        proofRoot,
        scratchRoot,
        taskExecutable: "/opt/homebrew/bin/task",
        nodeExecutable: process.execPath,
        deniedReadRoots: [deniedRoot],
        executable: "/opt/homebrew/bin/task",
        args: ["--taskfile", "Taskfile.yml", "verify:probe"],
        proofEnvironment: {
          CCC_PROOF_ID: "PROOF-task-probe",
          CCC_PROOF_PHASE: "task",
          CCC_PROOF_SOURCE_COMMIT: "a".repeat(40),
          CCC_PROOF_SOURCE_TREE: "b".repeat(40),
        },
        timeoutMs: 10_000,
        maxOutputBytes: 16_384,
      });

      if (result.exitCode !== 0) {
        throw new Error(`real Task probe failed signal=${result.signal ?? "none"} stderr=${result.stderr}`);
      }
      expect(result.stdout).toBe(`${realpathSync(process.execPath)} PROOF-task-probe\n`);
      expect(result.stderr).toContain("task: [verify:probe] node harness.mjs");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "RED-GOLDEN-nested-node: an admitted Node verifier can execute the same sealed Node",
    async () => {
      const root = await fixtureRoot();
      const proofRoot = join(root, "proof");
      const scratchRoot = join(root, "scratch");
      const deniedRoot = join(root, "denied-repository");
      await Promise.all([mkdir(proofRoot), mkdir(scratchRoot), mkdir(deniedRoot)]);
      await writeFile(join(proofRoot, "child.mjs"), "process.stdout.write('child-ok\\n');\n");
      await writeFile(join(proofRoot, "parent.mjs"), [
        'import { spawnSync } from "node:child_process";',
        'const child = spawnSync(process.execPath, ["child.mjs"], { encoding: "utf8", env: { PATH: process.env.PATH, OPENSSL_CONF: process.env.OPENSSL_CONF } });',
        'process.stdout.write(JSON.stringify({ status: child.status, signal: child.signal, error: child.error?.message, stdout: child.stdout, stderr: child.stderr }));',
        'process.exitCode = child.status === 0 && child.stdout === "child-ok\\n" ? 0 : 23;',
      ].join("\n"));
      await chmod(proofRoot, 0o555);

      const result = await runCccSemanticProofSandboxedProcess({
        proofRoot,
        scratchRoot,
        taskExecutable: "/opt/homebrew/bin/task",
        nodeExecutable: process.execPath,
        deniedReadRoots: [deniedRoot],
        executable: process.execPath,
        args: ["parent.mjs"],
        timeoutMs: 10_000,
        maxOutputBytes: 16_384,
      });

      expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0, timedOut: false, outputOverLimit: false });
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 0, stdout: "child-ok\n", stderr: "" });
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "RED-S5-evidence-exactness: refuses bounded output overflow instead of truncating semantic evidence",
    async () => {
      const root = await fixtureRoot();
      const proofRoot = join(root, "proof");
      const scratchRoot = join(root, "scratch");
      await Promise.all([mkdir(proofRoot), mkdir(scratchRoot)]);
      const deniedRoot = join(root, "denied-repository");
      await mkdir(deniedRoot);
      const probePath = join(proofRoot, "overflow.mjs");
      await writeFile(probePath, 'process.stdout.write("x".repeat(4097));\n');
      await chmod(proofRoot, 0o555);

      const result = await runCccSemanticProofSandboxedProcess({
        proofRoot,
        scratchRoot,
        taskExecutable: "/opt/homebrew/bin/task",
        nodeExecutable: process.execPath,
        deniedReadRoots: [deniedRoot],
        executable: process.execPath,
        args: ["overflow.mjs"],
        timeoutMs: 10_000,
        maxOutputBytes: 4096,
      });

      expect(result.outputOverLimit).toBe(true);
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4096);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "RED-S5-undeclared-helper: a sealed harness cannot import an undeclared helper from the denied target repository",
    async () => {
      const root = await fixtureRoot();
      const proofRoot = join(root, "proof");
      const scratchRoot = join(root, "scratch");
      const targetRepository = join(root, "target-repository");
      const engineRepository = join(root, "engine-repository");
      await Promise.all([
        mkdir(proofRoot),
        mkdir(scratchRoot),
        mkdir(targetRepository),
        mkdir(engineRepository),
      ]);
      const helperPath = join(targetRepository, "model-owned-helper.mjs");
      await writeFile(helperPath, "export const verdict = true;\n");
      const harnessPath = join(proofRoot, "harness.mjs");
      await writeFile(harnessPath, [
        "try {",
        "  await import(process.argv[2]);",
        "  process.stdout.write('bypass');",
        "  process.exitCode = 0;",
        "} catch {",
        "  process.stdout.write('refused');",
        "  process.exitCode = 23;",
        "}",
      ].join("\n"));
      await chmod(proofRoot, 0o555);

      const result = await runCccSemanticProofSandboxedProcess({
        proofRoot,
        scratchRoot,
        taskExecutable: "/opt/homebrew/bin/task",
        nodeExecutable: process.execPath,
        deniedReadRoots: [targetRepository, engineRepository],
        executable: process.execPath,
        args: ["harness.mjs", helperPath],
        timeoutMs: 10_000,
        maxOutputBytes: 16_384,
      });

      expect(result).toMatchObject({
        exitCode: 23,
        stdout: "refused",
        timedOut: false,
        outputOverLimit: false,
      });
    },
  );
});
