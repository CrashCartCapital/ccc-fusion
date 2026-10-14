/*
FNXC:CccPlanningProof 2026-10-14-08:15:
Proof for the offline network tripwire (CONTRACT-v2 D50, section 2.20). Every case runs the guard in a CHILD node process, because the guard patches process-global modules and must never be loaded into the test runner itself.

Non-vacuity: a refused connect is checked by its coded error, by the exact report line, and by the fact that the same child performs a loopback connect that must still succeed under the guard, so a guard that blocks everything cannot pass. The TEST-NET-1 target (192.0.2.1, RFC 5737) has no listener anywhere, so without the guard its connect ends in a socket error or timeout and never in the guard's code or report line; the guard refuses before any socket is opened, so these tests send no packet. No case here uses the real network.
*/
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The guard patches process-global modules the moment it is evaluated, so this file never imports it. It only names it by path, and every check runs in a child process.
const CCC_PLANNING_OFFLINE_GUARD_REPORT_ENV = "CCC_PLANNING_OFFLINE_GUARD_REPORT";
const CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT = "CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT";

const here = path.dirname(fileURLToPath(import.meta.url));
const guardPath = path.resolve(here, "..", "lib", "ccc-planning-offline-network-guard.mjs");

let workDir;
let caseCounter = 0;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "ccc-planning-guard-test-"));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Runs `source` as an ES module child, with the guard preloaded the way the runner does it (NODE_OPTIONS). */
function runChild(source, { guarded = true, extraEnv = {} } = {}) {
  caseCounter += 1;
  const scriptPath = path.join(workDir, `case-${caseCounter}.mjs`);
  const reportPath = path.join(workDir, `case-${caseCounter}.report.jsonl`);
  writeFileSync(scriptPath, source);
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    [CCC_PLANNING_OFFLINE_GUARD_REPORT_ENV]: reportPath,
    ...extraEnv,
  };
  if (guarded) env.NODE_OPTIONS = `--import ${guardPath}`;
  const result = spawnSync(process.execPath, [scriptPath], { env, encoding: "utf8", timeout: 30_000 });
  const reportLines = existsSync(reportPath)
    ? readFileSync(reportPath, "utf8").split("\n").filter((line) => line.length > 0)
    : [];
  const stdoutLines = result.stdout.split("\n").filter((line) => line.startsWith("{"));
  return {
    status: result.status,
    stderr: result.stderr,
    outcome: stdoutLines.length > 0 ? JSON.parse(stdoutLines[stdoutLines.length - 1]) : null,
    reportLines,
    report: reportLines.map((line) => JSON.parse(line)),
  };
}

const settle = `
const done = (value) => { console.log(JSON.stringify(value)); process.exit(0); };
`;

describe("offline network guard: loopback classification", () => {
  /** Evaluates the guard's exported classifier inside a child, because evaluating the guard installs it. */
  function classify(hosts) {
    const entries = hosts.map((host) => (host === undefined ? { missing: true } : { value: host }));
    const result = runChild(
      `
import { isCccPlanningLoopbackHost } from ${JSON.stringify(guardPath)};
const entries = ${JSON.stringify(entries)};
console.log(JSON.stringify({ answers: entries.map((entry) => isCccPlanningLoopbackHost(entry.missing ? undefined : entry.value)) }));
`,
      { guarded: false },
    );
    return result.outcome.answers;
  }

  it("accepts only loopback names and addresses", () => {
    const hosts = ["127.0.0.1", "127.255.255.254", "::1", "[::1]", "localhost", "LOCALHOST", "localhost.", "::ffff:127.0.0.1", undefined, null, ""];
    assert.deepEqual(classify(hosts), hosts.map(() => true));
  });

  it("refuses every other destination, including lookalikes of loopback", () => {
    const hosts = ["192.0.2.1", "10.0.0.1", "0.0.0.0", "128.0.0.1", "example.com", "127.0.0.1.evil.example", "localhost.evil.example", "::", "::ffff:10.0.0.1", "1270.0.0.1", "127.0.0"];
    assert.deepEqual(classify(hosts), hosts.map(() => false));
  });
});

describe("offline network guard: refusals", () => {
  it("refuses net.connect to TEST-NET-1 with the coded error and writes exactly one report line", () => {
    const result = runChild(`${settle}
import net from "node:net";
try {
  const socket = net.connect({ host: "192.0.2.1", port: 9 });
  socket.on("error", () => {});
  socket.destroy();
  done({ outcome: "returned" });
} catch (error) {
  done({ outcome: "threw", code: error.code, name: error.name });
}
`);
    assert.deepEqual(result.outcome, { outcome: "threw", code: CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT, name: "Error" });
    assert.equal(result.reportLines.length, 1, `one report line expected, got: ${result.reportLines.join(" | ")}`);
    assert.equal(result.report[0].code, CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT);
    assert.equal(result.report[0].api, "net.connect");
    assert.equal(result.report[0].host, "192.0.2.1");
    assert.equal(result.report[0].port, 9);
    assert.equal(typeof result.report[0].pid, "number");
  });

  it("refuses net.createConnection and a bare Socket.prototype.connect call", () => {
    const result = runChild(`${settle}
import net from "node:net";
const outcomes = [];
for (const attempt of [
  () => net.createConnection(9, "192.0.2.1"),
  () => new net.Socket().connect(9, "192.0.2.1"),
  () => net.connect("9", "192.0.2.1"),
]) {
  try { attempt().on("error", () => {}).destroy(); outcomes.push("returned"); } catch (error) { outcomes.push(error.code); }
}
done({ outcomes });
`);
    assert.deepEqual(result.outcome.outcomes, Array(3).fill(CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT));
    assert.equal(result.reportLines.length, 3);
    assert.deepEqual(result.report.map((line) => line.api), ["net.createConnection", "net.Socket.prototype.connect", "net.connect"]);
  });

  it("refuses tls.connect to a non-loopback host once, not once per layer", () => {
    const result = runChild(`${settle}
import tls from "node:tls";
try {
  tls.connect({ host: "192.0.2.1", port: 443 }).on("error", () => {}).destroy();
  done({ outcome: "returned" });
} catch (error) {
  done({ outcome: "threw", code: error.code });
}
`);
    assert.deepEqual(result.outcome, { outcome: "threw", code: CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT });
    assert.equal(result.reportLines.length, 1);
    assert.equal(result.report[0].api, "tls.connect");
  });

  it("refuses dns.lookup and dns.promises.lookup of a non-loopback hostname through their normal error paths", () => {
    const result = runChild(`${settle}
import dns from "node:dns";
const viaCallback = await new Promise((resolve) => dns.lookup("example.invalid", (error) => resolve(error ? error.code : "resolved")));
let viaPromise;
try { await dns.promises.lookup("example.invalid"); viaPromise = "resolved"; } catch (error) { viaPromise = error.code; }
done({ viaCallback, viaPromise });
`);
    assert.deepEqual(result.outcome, {
      viaCallback: CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT,
      viaPromise: CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT,
    });
    assert.deepEqual(result.report.map((line) => line.api), ["dns.lookup", "dns.promises.lookup"]);
    assert.deepEqual(result.report.map((line) => line.host), ["example.invalid", "example.invalid"]);
  });

  it("refuses when the destination is reached through the named-import form of the module", () => {
    const result = runChild(`${settle}
import { connect } from "node:net";
try { connect({ host: "192.0.2.1", port: 9 }).on("error", () => {}).destroy(); done({ outcome: "returned" }); }
catch (error) { done({ outcome: "threw", code: error.code }); }
`);
    assert.deepEqual(result.outcome, { outcome: "threw", code: CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT });
    assert.equal(result.reportLines.length, 1);
  });

  it("refuses inside a worker thread that inherits the preload", () => {
    const result = runChild(`${settle}
import { Worker, isMainThread } from "node:worker_threads";
const source = \`
import net from "node:net";
import { parentPort } from "node:worker_threads";
try { net.connect({ host: "192.0.2.1", port: 9 }).on("error", () => {}).destroy(); parentPort.postMessage("returned"); }
catch (error) { parentPort.postMessage(error.code); }
\`;
const worker = new Worker(source, { eval: true });
worker.once("message", (code) => done({ code }));
worker.once("error", (error) => done({ code: "worker-error:" + error.message }));
`);
    assert.deepEqual(result.outcome, { code: CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT });
    assert.equal(result.reportLines.length, 1);
  });

  it("still refuses and reports on stderr when no report file is configured", () => {
    caseCounter += 1;
    const scriptPath = path.join(workDir, `case-${caseCounter}.mjs`);
    writeFileSync(
      scriptPath,
      `import net from "node:net";\ntry { net.connect(9, "192.0.2.1").on("error", () => {}).destroy(); console.log("returned"); } catch (error) { console.log(error.code); }\n`,
    );
    const result = spawnSync(process.execPath, ["--import", guardPath, scriptPath], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.stdout.trim(), CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT);
    assert.match(result.stderr, new RegExp(CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT));
  });
});

describe("offline network guard: what must keep working", () => {
  let listener;
  let listenerPort;

  before(async () => {
    // The test thread blocks inside spawnSync while the child connects, so the listener never accepts; the kernel still completes the handshake, which is all a connect needs.
    listener = net.createServer((socket) => {
      socket.destroy();
    });
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    listenerPort = listener.address().port;
  });

  after(async () => {
    await new Promise((resolve) => listener.close(resolve));
  });

  it("lets a loopback connect to a listener the test opened succeed under the guard, and records nothing", () => {
    const result = runChild(`${settle}
import net from "node:net";
const socket = net.connect({ host: "127.0.0.1", port: ${listenerPort} });
socket.on("connect", () => done({ outcome: "connected" }));
socket.on("error", (error) => done({ outcome: "error", code: error.code }));
setTimeout(() => done({ outcome: "timeout" }), 5000);
`);
    assert.deepEqual(result.outcome, { outcome: "connected" });
    assert.deepEqual(result.reportLines, []);
  });

  it("lets localhost resolve and lets the default host (port only) connect", () => {
    const result = runChild(`${settle}
import dns from "node:dns";
import net from "node:net";
const address = await new Promise((resolve) => dns.lookup("localhost", (error, value) => resolve(error ? "error:" + error.code : "ok:" + typeof value)));
const connected = await new Promise((resolve) => {
  const socket = net.connect(${listenerPort});
  socket.on("connect", () => { socket.destroy(); resolve("connected"); });
  socket.on("error", (error) => resolve("error:" + error.code));
  setTimeout(() => resolve("timeout"), 5000);
});
done({ address, connected });
`);
    assert.deepEqual(result.outcome, { address: "ok:string", connected: "connected" });
    assert.deepEqual(result.reportLines, []);
  });

  it("does not block a unix-socket path or an IP-literal lookup, which open no outside route", () => {
    // A short absolute path in a directory that does not exist: the proof runner points TMPDIR at a long scratch path, and a unix-socket path over ~100 bytes fails with ENAMETOOLONG instead of ENOENT.
    const missingSocket = "/ccc-planning-no-such-dir/no-such.sock";
    const result = runChild(`${settle}
import dns from "node:dns";
import net from "node:net";
const ipc = await new Promise((resolve) => {
  const socket = net.connect({ path: ${JSON.stringify(missingSocket)} });
  socket.on("error", (error) => resolve(error.code));
  socket.on("connect", () => resolve("connected"));
});
const literal = await new Promise((resolve) => dns.lookup("192.0.2.1", (error, address) => resolve(error ? error.code : address)));
done({ ipc, literal });
`);
    assert.deepEqual(result.outcome, { ipc: "ENOENT", literal: "192.0.2.1" });
    assert.deepEqual(result.reportLines, []);
  });

  it("is idempotent when evaluated a second time under a different module URL, so one refusal is one report line", () => {
    const result = runChild(`${settle}
import net from "node:net";
await import(${JSON.stringify(`${guardPath}?second-evaluation`)});
try { net.connect(9, "192.0.2.1").on("error", () => {}).destroy(); done({ outcome: "returned" }); }
catch (error) { done({ outcome: "threw", code: error.code }); }
`);
    assert.deepEqual(result.outcome, { outcome: "threw", code: CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT });
    assert.equal(result.reportLines.length, 1);
  });
});
