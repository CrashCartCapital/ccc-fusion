/**
 * FNXC:PgHonestGate 2026-08-11:
 * Vitest globalSetup for the merge gate's PostgreSQL lanes (vitest.pg.config.ts:
 * `test:pg-gate` and the `test:ccc-prd-safety` PostgreSQL step).
 *
 * The 2026-08-11 top-down audit reproduced `pnpm test:gate` passing on a
 * machine with nothing listening on localhost:5432 while silently SKIPPING all
 * 17 gate-owned PostgreSQL tests (pgDescribe collapsed to describe.skip). A
 * gate that goes green without running its tests is dishonest, so this setup
 * makes skipping impossible for the gate lanes:
 *
 *   1. `FUSION_PG_TEST_SKIP=1` is refused loudly — the gate cannot be told to
 *      skip its own required coverage.
 *   2. A usable target (canonical psql-backed probe) is used as-is.
 *   3. An explicitly configured `FUSION_PG_TEST_URL_BASE` that is NOT usable is
 *      refused loudly — the gate never silently substitutes a different server
 *      for the one the operator named (CI infrastructure regressions must stay
 *      visible).
 *   4. Otherwise a disposable embedded PostgreSQL is provisioned on a free
 *      port, `FUSION_PG_TEST_URL_BASE` is pointed at it, and it is stopped and
 *      removed on teardown. Zero skips, green AND honest, no developer
 *      friction.
 *
 * The embedded server runs in a small supervisor CHILD process (the same
 * architecture as scripts/run-ccc-pg-proof.mjs) rather than in the vitest main
 * process: embedded-postgres@15 registers an async-exit-hook at module load
 * that misbehaves under Node 24 after an already-completed explicit stop (see
 * the FNXC note in run-ccc-pg-proof.mjs). The supervisor can `process.exit`
 * explicitly after stopping PostgreSQL; the vitest main process cannot. The
 * supervisor also stops PostgreSQL when its stdin closes, so a crashed vitest
 * main process cannot leak a postmaster.
 *
 * Non-gate lanes (the default core vitest.config.ts) keep their existing
 * gate-safe skip behavior — this module is wired only into vitest.pg.config.ts.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasPsqlClient,
  isPgTestAvailable,
} from "./pg-test-availability.js";
import runBaseGlobalSetup from "./vitest-teardown.js";

/** The default probe target when no FUSION_PG_TEST_URL_BASE is configured. */
export const PG_GATE_DEFAULT_URL_BASE = "postgresql://localhost:5432";

/** Budget for the full embedded start (initdb + pg_ctl start + ensureDatabase).
 * EmbeddedPostgresLifecycle's own DEFAULT_START_TIMEOUT_MS is 120s; add margin
 * for the supervisor child's tsx bootstrap. */
const PROVISION_START_BUDGET_MS = 150_000;

/** Budget for the supervisor to stop PostgreSQL and exit after stdin closes. */
const SUPERVISOR_STOP_BUDGET_MS = 15_000;

/** Grace between SIGTERM and SIGKILL escalation on a stuck supervisor. */
const SUPERVISOR_KILL_GRACE_MS = 5_000;

export class PgGateSetupError extends Error {}

export interface PgGateProvisionedServer {
  /** postgresql://user:pass@host:port base URL (no database path). */
  readonly urlBase: string;
  /** Stop the embedded server and remove its disposable data directory. */
  shutdown(): Promise<void>;
}

export interface EnsurePgGateTargetDeps {
  readonly hasPsql?: () => boolean;
  readonly probe?: (baseUrl: string) => boolean;
  readonly provisionEmbedded?: () => Promise<PgGateProvisionedServer>;
}

function redactPgDiagnostic(value: unknown): string {
  return String(value)
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-postgresql-url]")
    .replace(/password=[^\s&]+/gi, "password=[redacted]");
}

/**
 * The single availability decision for the gate's PostgreSQL lanes. Returns
 * the provisioned embedded server (or null when an existing target is usable)
 * and mutates `env.FUSION_PG_TEST_URL_BASE` to point at the provisioned
 * server. Every refusal is a thrown PgGateSetupError with an actionable
 * message — there is no path that results in a skip.
 */
export async function ensurePgGateTarget(
  env: NodeJS.ProcessEnv = process.env,
  deps: EnsurePgGateTargetDeps = {},
): Promise<{ readonly provisioned: PgGateProvisionedServer | null }> {
  const hasPsql = deps.hasPsql ?? (() => hasPsqlClient(env.PATH ?? ""));
  const probe =
    deps.probe ?? ((baseUrl: string) => isPgTestAvailable(baseUrl, env.PATH ?? ""));
  const provisionEmbedded =
    deps.provisionEmbedded ?? (() => provisionEmbeddedPgForGate(env));

  if (env.FUSION_PG_TEST_SKIP === "1") {
    throw new PgGateSetupError(
      "PostgreSQL gate tests must run: FUSION_PG_TEST_SKIP=1 would silently skip required merge-gate coverage. " +
        "Unset FUSION_PG_TEST_SKIP for gate lanes (non-gate lanes may still honor it).",
    );
  }

  if (!hasPsql()) {
    throw new PgGateSetupError(
      "PostgreSQL gate tests must run but no executable `psql` client was found on PATH. " +
        "Install a PostgreSQL client (e.g. `brew install libpq` / postgresql) or add its bin directory to PATH.",
    );
  }

  const configured = env.FUSION_PG_TEST_URL_BASE?.trim();
  const explicitlyConfigured = typeof configured === "string" && configured.length > 0;
  const baseUrl = explicitlyConfigured ? configured : PG_GATE_DEFAULT_URL_BASE;

  if (probe(baseUrl)) {
    return { provisioned: null };
  }

  if (explicitlyConfigured) {
    throw new PgGateSetupError(
      "PostgreSQL gate tests must run but the explicitly configured FUSION_PG_TEST_URL_BASE target is not usable. " +
        "Start that PostgreSQL server, or unset FUSION_PG_TEST_URL_BASE to let the gate provision a disposable embedded server.",
    );
  }

  let provisioned: PgGateProvisionedServer;
  try {
    provisioned = await provisionEmbedded();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new PgGateSetupError(
      "PostgreSQL gate tests must run: no usable PostgreSQL target exists and embedded provisioning failed: " +
        `${redactPgDiagnostic(cause)}. Start a local PostgreSQL on localhost:5432 or set FUSION_PG_TEST_URL_BASE to a usable server.`,
    );
  }

  env.FUSION_PG_TEST_URL_BASE = provisioned.urlBase;

  if (!probe(provisioned.urlBase)) {
    await provisioned.shutdown().catch(() => {});
    throw new PgGateSetupError(
      "PostgreSQL gate tests must run: an embedded PostgreSQL was provisioned but the canonical availability probe " +
        "still failed against it. This usually means the psql client cannot reach localhost loopback; " +
        "start a local PostgreSQL on localhost:5432 or set FUSION_PG_TEST_URL_BASE to a usable server.",
    );
  }

  return { provisioned };
}

const SUPERVISOR_READY_MARKER = "FUSION_PG_GATE_SUPERVISOR_READY=";

/**
 * Source for the supervisor child (run via `node --import tsx -e`). It boots a
 * disposable embedded PostgreSQL, prints the ready marker with the base URL,
 * then waits for stdin to close (or SIGTERM/SIGINT) before stopping the server
 * and exiting explicitly — see the module FNXC note for why a child process.
 */
function buildSupervisorSource(embeddedLifecyclePath: string): string {
  return `
  import { EmbeddedPostgresLifecycle } from ${JSON.stringify(embeddedLifecyclePath)};
  const lifecycle = new EmbeddedPostgresLifecycle({
    dataDir: process.env.FUSION_PG_GATE_DATA_DIR,
    // The vitest globalSetup owns this child's lifetime; explicit stop below.
    installShutdownHooks: false,
    throwOnStopError: true,
  });
  const shutdownRequested = new Promise((resolveWait) => {
    process.once("SIGTERM", () => resolveWait("SIGTERM"));
    process.once("SIGINT", () => resolveWait("SIGINT"));
    process.stdin.resume();
    process.stdin.once("end", () => resolveWait("stdin-end"));
    process.stdin.once("close", () => resolveWait("stdin-close"));
  });
  await lifecycle.start();
  const url = new URL(lifecycle.getConnectionUrl());
  url.pathname = "/";
  process.stdout.write(${JSON.stringify(SUPERVISOR_READY_MARKER)} + JSON.stringify({ urlBase: url.href.slice(0, -1) }) + "\\n");
  await shutdownRequested;
  let exitCode = 0;
  try {
    await Promise.race([
      lifecycle.stop(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("embedded PostgreSQL stop timed out")), ${SUPERVISOR_STOP_BUDGET_MS - 5_000})),
    ]);
  } catch (error) {
    exitCode = 1;
    process.stderr.write(String(error instanceof Error ? error.message : error) + "\\n");
  }
  // embedded-postgres@15 registers an async-exit-hook that misbehaves under
  // Node 24 after an already-completed explicit stop; exit explicitly.
  process.exit(exitCode);
  `;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null) {
      resolveExit(child.exitCode);
      return;
    }
    child.once("exit", (code) => resolveExit(code));
    // A spawn-level failure (e.g. EMFILE) may never emit "exit"; surface it as
    // a nonzero exit so the ready-wait fails fast instead of burning the full
    // start budget.
    child.once("error", () => resolveExit(child.exitCode ?? -1));
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PgGateSetupError(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Boot a disposable embedded PostgreSQL in a supervisor child process and
 * return its base URL plus a bounded shutdown. On shutdown failure the data
 * directory is retained for diagnosis (repo convention for failed fixtures).
 */
export async function provisionEmbeddedPgForGate(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PgGateProvisionedServer> {
  const testUtilsDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(testUtilsDir, "..", "..", "..", "..");
  const embeddedLifecyclePath = resolve(testUtilsDir, "..", "postgres", "embedded-lifecycle.ts");
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-pg-gate-embedded-"));

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", buildSupervisorSource(embeddedLifecyclePath)],
    {
      cwd: repoRoot,
      env: { ...env, FUSION_PG_GATE_DATA_DIR: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const exited = waitForExit(child);
  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-8_192);
  });

  const ready = new Promise<string>((resolveReady, rejectReady) => {
    let stdoutBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const markerIndex = stdoutBuffer.indexOf(SUPERVISOR_READY_MARKER);
      if (markerIndex === -1) return;
      const lineEnd = stdoutBuffer.indexOf("\n", markerIndex);
      if (lineEnd === -1) return;
      const payload = stdoutBuffer.slice(markerIndex + SUPERVISOR_READY_MARKER.length, lineEnd);
      try {
        const parsed = JSON.parse(payload) as { urlBase?: unknown };
        if (typeof parsed.urlBase !== "string" || parsed.urlBase.length === 0) {
          throw new Error("supervisor ready marker carried no urlBase");
        }
        resolveReady(parsed.urlBase);
      } catch (error) {
        rejectReady(
          new PgGateSetupError(
            `embedded PostgreSQL supervisor emitted an invalid ready marker: ${redactPgDiagnostic(error instanceof Error ? error.message : error)}`,
          ),
        );
      }
    });
    void exited.then((code) => {
      rejectReady(
        new PgGateSetupError(
          `embedded PostgreSQL supervisor exited with code ${code} before becoming ready: ${redactPgDiagnostic(stderrTail.trim())}`,
        ),
      );
    });
  });

  let urlBase: string;
  try {
    urlBase = await withTimeout(ready, PROVISION_START_BUDGET_MS, "embedded PostgreSQL start");
  } catch (error) {
    child.kill("SIGKILL");
    // Startup failed before the cluster was usable; retain the data dir only
    // when the supervisor itself reported an error (diagnosis), otherwise a
    // timeout kill leaves it for the same reason. Never remove on failure.
    throw error;
  }

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      if (child.exitCode === null) {
        child.stdin.end();
        let code: number | null;
        try {
          code = await withTimeout(exited, SUPERVISOR_STOP_BUDGET_MS, "embedded PostgreSQL stop");
        } catch {
          child.kill("SIGTERM");
          try {
            code = await withTimeout(exited, SUPERVISOR_KILL_GRACE_MS, "embedded PostgreSQL SIGTERM stop");
          } catch {
            child.kill("SIGKILL");
            code = await exited;
          }
        }
        if (code !== 0) {
          throw new PgGateSetupError(
            `embedded PostgreSQL supervisor exited with code ${code} during shutdown; ` +
              `data dir retained for diagnosis at ${dataDir}: ${redactPgDiagnostic(stderrTail.trim())}`,
          );
        }
      } else if (child.exitCode !== 0) {
        throw new PgGateSetupError(
          `embedded PostgreSQL supervisor already exited with code ${child.exitCode}; ` +
            `data dir retained for diagnosis at ${dataDir}: ${redactPgDiagnostic(stderrTail.trim())}`,
        );
      }
      rmSync(dataDir, { recursive: true, force: true });
    })();
    return shutdownPromise;
  };

  return { urlBase, shutdown };
}

/**
 * Default export consumed by vitest.pg.config.ts. Runs the no-silent-skip
 * decision FIRST (so the base setup's canonical availability publication sees
 * the final FUSION_PG_TEST_URL_BASE), then delegates to the shared
 * vitest-teardown globalSetup. Teardown runs the base teardown before
 * stopping the embedded server so workers are done with it.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const { provisioned } = await ensurePgGateTarget(process.env);
  let baseTeardown: () => Promise<void>;
  try {
    baseTeardown = runBaseGlobalSetup();
  } catch (error) {
    await provisioned?.shutdown().catch(() => {});
    throw error;
  }
  return async function teardown(): Promise<void> {
    try {
      await baseTeardown();
    } finally {
      await provisioned?.shutdown();
    }
  };
}
