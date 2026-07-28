import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { Worker } from "node:worker_threads";

export const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";

function parseProbeTarget(url: string): { host: string; port: number } {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname || "localhost";
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : 5432;
    return { host, port: Number.isFinite(port) ? port : 5432 };
  } catch {
    return { host: "localhost", port: 5432 };
  }
}

function probeTcpReachable(
  host: string,
  port: number,
  timeoutMs = 1_500,
): boolean {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  view[0] = 0;

  let worker: Worker | null = null;
  try {
    const workerCode = `
      const { parentPort } = require("node:worker_threads");
      const { Socket } = require("node:net");
      parentPort.on("message", (msg) => {
        const { host, port, timeoutMs, buf } = msg;
        const view = new Int32Array(buf);
        const socket = new Socket();
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => { view[0] = 1; Atomics.notify(view, 0); socket.destroy(); });
        const fail = () => { if (view[0] === 0) { view[0] = 2; Atomics.notify(view, 0); } socket.destroy(); };
        socket.once("error", fail);
        socket.once("timeout", fail);
        socket.connect(port, host);
      });
    `;
    worker = new Worker(workerCode, { eval: true });
    worker.postMessage({ host, port, timeoutMs, buf: shared });
  } catch {
    return false;
  }

  const deadline = Date.now() + timeoutMs + 500;
  while (view[0] === 0 && Date.now() < deadline) {
    Atomics.wait(view, 0, 0, 100);
  }

  void worker.terminate().catch(() => {});
  return view[0] === 1;
}

/**
 * PostgreSQL-backed tests may shell out to `psql`, so a TCP listener alone is
 * insufficient. The client must be executable through the current PATH.
 */
export function hasPsqlClient(pathValue = process.env.PATH ?? ""): boolean {
  const executableNames =
    process.platform === "win32"
      ? [
          "psql",
          ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
            .split(";")
            .filter(Boolean)
            .map((extension) => `psql${extension.toLowerCase()}`),
        ]
      : ["psql"];
  const accessMode =
    process.platform === "win32" ? constants.F_OK : constants.X_OK;

  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const executableName of executableNames) {
      try {
        accessSync(join(directory, executableName), accessMode);
        return true;
      } catch {
        // Keep searching PATH.
      }
    }
  }

  return false;
}

/**
 * Verify that the configured target is a usable PostgreSQL test server, not
 * merely a process accepting TCP connections. `-w` makes missing credentials
 * fail immediately, and `SELECT 1` is read-only.
 */
export function probePsqlReady(
  baseUrl: string,
  pathValue = process.env.PATH ?? "",
  timeoutMs = 3_000,
): boolean {
  let maintenanceUrl: string;
  try {
    const parsed = new URL(baseUrl);
    parsed.pathname = "/postgres";
    parsed.search = "";
    parsed.hash = "";
    maintenanceUrl = parsed.toString();
  } catch {
    return false;
  }

  const result = spawnSync(
    "psql",
    [
      "-X",
      "-w",
      maintenanceUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-qAt",
      "-c",
      "SELECT 1",
    ],
    {
      env: {
        ...process.env,
        PATH: pathValue,
        PGCONNECT_TIMEOUT: String(Math.max(1, Math.ceil(timeoutMs / 1_000))),
      },
      stdio: "ignore",
      timeout: timeoutMs,
    },
  );

  return result.status === 0 && result.error === undefined;
}

/**
 * Canonical PostgreSQL test availability decision. All five conditions must
 * hold: no explicit skip, a target URL, an executable psql client, a TCP
 * listener, and a successful non-interactive read-only query.
 */
export function isPgTestAvailable(baseUrl = PG_TEST_URL_BASE): boolean {
  if (process.env.FUSION_PG_TEST_SKIP === "1") return false;
  if (!baseUrl) return false;
  if (!hasPsqlClient()) return false;
  const { host, port } = parseProbeTarget(baseUrl);
  if (!probeTcpReachable(host, port)) return false;
  return probePsqlReady(baseUrl);
}
