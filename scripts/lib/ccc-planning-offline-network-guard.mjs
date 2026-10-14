/*
FNXC:CccPlanningProof 2026-10-14-09:10:
Offline network tripwire for the request-to-code planning proof (card P0; CONTRACT-v2 D50, section 2.20). The proof runner preloads this file into every proof child with `NODE_OPTIONS=--import <this file>` next to `PI_OFFLINE=1`, so a planning suite that tries to leave the machine fails loudly at the first attempt instead of passing because the network happened to work.

What it does: it wraps `net.connect`, `net.createConnection`, `net.Socket.prototype.connect`, `tls.connect`, `dns.lookup` and `dns.promises.lookup`. A destination whose host is loopback (127.0.0.0/8, ::1, ::ffff:127.x, `localhost`, or no host at all, which Node reads as `localhost`) passes straight through to the real function. Anything else is refused BEFORE a socket is opened or a name is resolved: the call throws (or rejects, or calls back with) an Error whose `code` is CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT, and one JSON line is appended to the file named by CCC_PLANNING_OFFLINE_GUARD_REPORT (stderr when that variable is absent or unwritable). The runner reads that file after the child exits, so even a test that swallows the thrown error still fails the run.

What it is NOT: a sandbox. It is a tripwire in the child's own JavaScript, so it does not see UDP (`dgram`), `dns.resolve*`, native addons, or a grandchild process that drops NODE_OPTIONS. Unix-socket paths and IP-literal `dns.lookup` calls are allowed because they open no route off the machine. Real isolation, where a lane needs it, is the Darwin proof sandbox's job; this file only makes the common mistake impossible to miss.

Idempotent: a marker on globalThis stops a second evaluation (under another module URL, or via a worker that also preloads it) from wrapping the wrappers, so one refused attempt is one report line. The module is meant to be loaded by `--import`; tests that need to read its exports do so in a child process, because merely importing it installs the patches.
*/
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";

export const CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT = "CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT";
export const CCC_PLANNING_OFFLINE_GUARD_REPORT_ENV = "CCC_PLANNING_OFFLINE_GUARD_REPORT";

const INSTALLED = Symbol.for("ccc-planning.offline-network-guard.installed");

const originalIsIPv4 = net.isIPv4.bind(net);
const originalIsIP = net.isIP.bind(net);

/**
 * True for a destination that cannot leave this machine. An absent host counts as loopback because Node connects to `localhost` when no host is given.
 * @param {unknown} host
 * @returns {boolean}
 */
export function isCccPlanningLoopbackHost(host) {
  if (host === undefined || host === null || host === "") return true;
  if (typeof host !== "string") return false;
  let name = host.toLowerCase();
  if (name.startsWith("[") && name.endsWith("]")) name = name.slice(1, -1);
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (name === "localhost" || name === "::1") return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(name);
  if (mapped !== null) name = mapped[1];
  return originalIsIPv4(name) && name.startsWith("127.");
}

function normalizePort(port) {
  if (typeof port === "string" && port.trim() !== "" && Number.isFinite(Number(port))) return Number(port);
  return port === undefined ? null : port;
}

/**
 * Mirrors the argument forms Node accepts for a connect call: (options[, cb]), (path[, cb]), (port[, host][, cb]) and the pre-normalised [options, cb] array a Socket receives from net.connect. For tls.connect a trailing options object is merged over the positional ones, as `_tls_wrap` does.
 * @returns {{ local: boolean, host: unknown, port: unknown }}
 */
function connectTarget(args, mergeTrailingOptions) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  let options;
  if (first !== null && typeof first === "object") {
    options = first;
  } else if (typeof first === "string" && !(Number(first) >= 0)) {
    options = { path: first };
  } else {
    options = { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
    if (mergeTrailingOptions) {
      const last = args[args.length - 1];
      if (last !== null && typeof last === "object" && last !== first) options = { ...options, ...last };
    }
  }
  if (typeof options.path === "string" && options.path !== "") return { local: true, host: undefined, port: undefined };
  if (options.socket !== undefined && options.socket !== null) return { local: true, host: undefined, port: undefined };
  return { local: false, host: options.host, port: options.port };
}

function record(api, host, port) {
  const line = JSON.stringify({
    code: CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT,
    api,
    host: host === undefined ? null : host,
    port: normalizePort(port),
    pid: process.pid,
    at: new Date().toISOString(),
  });
  const reportPath = process.env[CCC_PLANNING_OFFLINE_GUARD_REPORT_ENV];
  if (reportPath) {
    try {
      appendFileSync(reportPath, `${line}\n`);
      return;
    } catch {
      // Falls through to stderr: an unwritable report file must not turn a refusal into silence.
    }
  }
  process.stderr.write(`${line}\n`);
}

function refusal(api, host, port) {
  record(api, host, port);
  const target = port === undefined || port === null ? String(host) : `${host}:${port}`;
  const error = new Error(`${CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT}: ${api} to ${target} refused; the offline planning proof reaches loopback only`);
  error.code = CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT;
  return error;
}

function install() {
  if (globalThis[INSTALLED] === true) return;
  globalThis[INSTALLED] = true;

  const originalConnect = net.connect;
  const originalCreateConnection = net.createConnection;
  const originalSocketConnect = net.Socket.prototype.connect;
  const originalTlsConnect = tls.connect;
  const originalLookup = dns.lookup;
  const originalPromiseLookup = dns.promises.lookup;

  function guardedConnect(api, original, mergeTrailingOptions) {
    return function guarded(...args) {
      const target = connectTarget(args, mergeTrailingOptions);
      if (!target.local && !isCccPlanningLoopbackHost(target.host)) throw refusal(api, target.host, target.port);
      return Reflect.apply(original, this, args);
    };
  }

  net.connect = guardedConnect("net.connect", originalConnect, false);
  net.createConnection = guardedConnect("net.createConnection", originalCreateConnection, false);
  net.Socket.prototype.connect = guardedConnect("net.Socket.prototype.connect", originalSocketConnect, false);
  tls.connect = guardedConnect("tls.connect", originalTlsConnect, true);

  function refusesLookup(hostname) {
    return typeof hostname === "string" && originalIsIP(hostname) === 0 && !isCccPlanningLoopbackHost(hostname);
  }

  dns.lookup = function guardedLookup(hostname, ...rest) {
    if (refusesLookup(hostname)) {
      const callback = rest[rest.length - 1];
      const error = refusal("dns.lookup", hostname, undefined);
      if (typeof callback !== "function") throw error;
      process.nextTick(callback, error);
      return {};
    }
    return Reflect.apply(originalLookup, this, [hostname, ...rest]);
  };
  dns.promises.lookup = async function guardedPromiseLookup(hostname, ...rest) {
    if (refusesLookup(hostname)) throw refusal("dns.promises.lookup", hostname, undefined);
    return Reflect.apply(originalPromiseLookup, this, [hostname, ...rest]);
  };

  // Builtin ES module namespaces (`import { connect } from "node:net"`) are snapshots of the CommonJS exports; re-sync them so the named-import form sees the wrappers too.
  syncBuiltinESMExports();
}

install();
