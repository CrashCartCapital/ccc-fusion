import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
export const FUSION_PG_TEST_AVAILABLE_ENV = "FUSION_PG_TEST_AVAILABLE";

function sleepMsSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * PostgreSQL-backed tests shell out to `psql` in several legacy fixtures, so
 * a TCP listener alone is insufficient. The client must be executable through
 * the current PATH.
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
  maxAttempts = 3,
  retryDelayMs = 100,
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

  const attempts = Math.max(1, Math.floor(maxAttempts));
  for (let attempt = 1; attempt <= attempts; attempt++) {
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

    if (result.status === 0 && result.error === undefined) {
      return true;
    }

    if (attempt < attempts) {
      sleepMsSync(retryDelayMs);
    }
  }

  return false;
}

/**
 * Canonical PostgreSQL test availability decision. All four conditions must
 * hold: no explicit skip, a target URL, an executable psql client, and a
 * successful non-interactive read-only query. The query is stronger than a
 * separate TCP probe because it proves network, server, authentication, and
 * query readiness together.
 */
export function isPgTestAvailable(
  baseUrl = PG_TEST_URL_BASE,
  pathValue = process.env.PATH ?? "",
): boolean {
  if (process.env.FUSION_PG_TEST_SKIP === "1") return false;
  if (!baseUrl) return false;
  if (!hasPsqlClient(pathValue)) return false;
  return probePsqlReady(baseUrl, pathValue);
}
