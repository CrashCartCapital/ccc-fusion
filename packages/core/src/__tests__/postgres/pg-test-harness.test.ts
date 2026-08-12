/**
 * FNXC:TestMigrationTail 2026-06-24-16:30:
 * Tests for the reusable createTaskStoreForTest() PG fixture helper.
 * Verifies the helper creates a working PG-backed TaskStore, applies the
 * schema, and tears down cleanly.
 */

import { once } from "node:events";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import {
  hasPsqlClient,
  isPgTestAvailable,
  probePsqlReady,
} from "../../__test-utils__/pg-test-availability.js";
import {
  ensurePgGateTarget,
  PgGateSetupError,
  type PgGateProvisionedServer,
} from "../../__test-utils__/pg-gate-global-setup.js";
import {
  createTaskStoreForTest,
  PG_AVAILABLE,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { insertTaskRow } from "../../task-store/async-persistence.js";

const testDescribe = PG_AVAILABLE ? describe : describe.skip;

describe("PostgreSQL test availability", () => {
  it("requires an executable psql client on PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-psql-client-"));
    const executableName = process.platform === "win32" ? "psql.exe" : "psql";
    const executablePath = join(root, executableName);

    try {
      await writeFile(executablePath, "");
      if (process.platform !== "win32") {
        await chmod(executablePath, 0o755);
      }

      expect(hasPsqlClient(root)).toBe(true);
      expect(hasPsqlClient(join(root, "missing"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const readinessIt = process.platform === "win32" ? it.skip : it;
  readinessIt("requires psql to reach a usable test database", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-psql-ready-"));
    const executablePath = join(root, "psql");

    try {
      await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
      await chmod(executablePath, 0o755);
      expect(probePsqlReady("postgresql://localhost:5432", root)).toBe(true);

      await writeFile(executablePath, "#!/bin/sh\nexit 1\n");
      expect(probePsqlReady("postgresql://localhost:5432", root)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  readinessIt("retries a transient psql readiness failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-psql-retry-"));
    const executablePath = join(root, "psql");

    try {
      await writeFile(
        executablePath,
        [
          "#!/bin/sh",
          'marker="$0.marker"',
          'if [ ! -e "$marker" ]; then',
          '  : > "$marker"',
          "  exit 1",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
      );
      await chmod(executablePath, 0o755);

      // The per-attempt subprocess budget must not be the thing under test.
      // `undefined` inherits probePsqlReady's own default, so this follows the
      // production value instead of pinning a second one. A hardcoded 500ms
      // failed here: spawning a freshly written shim out of a vitest fork
      // worker costs 500-1300ms on macOS, so BOTH attempts died with ETIMEDOUT
      // and the retry path this test exists to cover never ran.
      expect(
        probePsqlReady(
          "postgresql://127.0.0.1:1",
          root,
          undefined,
          2,
          0,
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  readinessIt(
    "uses the successful psql query as the server readiness proof",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "fusion-psql-canonical-"));
      const executablePath = join(root, "psql");
      const originalSkip = process.env.FUSION_PG_TEST_SKIP;

      try {
        await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
        await chmod(executablePath, 0o755);
        delete process.env.FUSION_PG_TEST_SKIP;

        expect(
          isPgTestAvailable("postgresql://127.0.0.1:1", root),
        ).toBe(true);
      } finally {
        if (originalSkip === undefined) {
          delete process.env.FUSION_PG_TEST_SKIP;
        } else {
          process.env.FUSION_PG_TEST_SKIP = originalSkip;
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  readinessIt(
    "is unavailable without psql even when the target port is listening",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "fusion-pg-availability-"));
      const missingBin = join(root, "missing-bin");
      const server = createServer();
      const originalSkip = process.env.FUSION_PG_TEST_SKIP;

      try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("expected a TCP listener address");
        }

        delete process.env.FUSION_PG_TEST_SKIP;
        expect(
          isPgTestAvailable(
            `postgresql://127.0.0.1:${address.port}`,
            missingBin,
          ),
        ).toBe(false);
      } finally {
        if (originalSkip === undefined) {
          delete process.env.FUSION_PG_TEST_SKIP;
        } else {
          process.env.FUSION_PG_TEST_SKIP = originalSkip;
        }
        server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

/*
 * FNXC:PgHonestGate 2026-08-11:
 * The merge gate's PostgreSQL lanes (vitest.pg.config.ts) must never go green
 * while silently skipping their tests. ensurePgGateTarget is the single
 * decision point: it either proves a usable target, provisions a disposable
 * embedded PostgreSQL, or fails loudly with an actionable message. These unit
 * tests drive the decision matrix with injected fakes; the real embedded boot
 * is proven by running `pnpm test:gate` without a local PostgreSQL.
 */
describe("PostgreSQL gate setup (no-silent-skip contract)", () => {
  function fakeServer(urlBase: string): PgGateProvisionedServer & {
    shutdownCalls: number;
  } {
    const server = {
      urlBase,
      shutdownCalls: 0,
      async shutdown() {
        server.shutdownCalls += 1;
      },
    };
    return server;
  }

  it("refuses FUSION_PG_TEST_SKIP=1 instead of skipping gate coverage", async () => {
    let provisionCalls = 0;
    await expect(
      ensurePgGateTarget(
        { FUSION_PG_TEST_SKIP: "1" },
        {
          hasPsql: () => true,
          probe: () => true,
          provisionEmbedded: async () => {
            provisionCalls += 1;
            return fakeServer("postgresql://unused");
          },
        },
      ),
    ).rejects.toThrow(PgGateSetupError);
    await expect(
      ensurePgGateTarget({ FUSION_PG_TEST_SKIP: "1" }, { hasPsql: () => true, probe: () => true }),
    ).rejects.toThrow(/FUSION_PG_TEST_SKIP/);
    expect(provisionCalls).toBe(0);
  });

  it("refuses to run without a psql client and names the remedy", async () => {
    let provisionCalls = 0;
    await expect(
      ensurePgGateTarget(
        {},
        {
          hasPsql: () => false,
          probe: () => true,
          provisionEmbedded: async () => {
            provisionCalls += 1;
            return fakeServer("postgresql://unused");
          },
        },
      ),
    ).rejects.toThrow(/psql/);
    expect(provisionCalls).toBe(0);
  });

  it("uses a usable configured target without provisioning", async () => {
    const env: NodeJS.ProcessEnv = {
      FUSION_PG_TEST_URL_BASE: "postgresql://postgres:postgres@configured:5433",
    };
    const probedUrls: string[] = [];
    let provisionCalls = 0;
    const result = await ensurePgGateTarget(env, {
      hasPsql: () => true,
      probe: (baseUrl) => {
        probedUrls.push(baseUrl);
        return true;
      },
      provisionEmbedded: async () => {
        provisionCalls += 1;
        return fakeServer("postgresql://unused");
      },
    });
    expect(result.provisioned).toBeNull();
    expect(env.FUSION_PG_TEST_URL_BASE).toBe(
      "postgresql://postgres:postgres@configured:5433",
    );
    expect(probedUrls).toEqual(["postgresql://postgres:postgres@configured:5433"]);
    expect(provisionCalls).toBe(0);
  });

  it("refuses an explicitly configured but unusable target instead of substituting a server", async () => {
    let provisionCalls = 0;
    await expect(
      ensurePgGateTarget(
        { FUSION_PG_TEST_URL_BASE: "postgresql://postgres@configured:5433" },
        {
          hasPsql: () => true,
          probe: () => false,
          provisionEmbedded: async () => {
            provisionCalls += 1;
            return fakeServer("postgresql://unused");
          },
        },
      ),
    ).rejects.toThrow(/FUSION_PG_TEST_URL_BASE/);
    expect(provisionCalls).toBe(0);
  });

  it("provisions embedded PostgreSQL when the default target is unusable", async () => {
    const env: NodeJS.ProcessEnv = {};
    const embedded = fakeServer("postgresql://postgres:password@localhost:54329");
    const probedUrls: string[] = [];
    const result = await ensurePgGateTarget(env, {
      hasPsql: () => true,
      probe: (baseUrl) => {
        probedUrls.push(baseUrl);
        return baseUrl === embedded.urlBase;
      },
      provisionEmbedded: async () => embedded,
    });
    expect(result.provisioned).toBe(embedded);
    expect(env.FUSION_PG_TEST_URL_BASE).toBe(embedded.urlBase);
    expect(probedUrls).toEqual([
      "postgresql://localhost:5432",
      embedded.urlBase,
    ]);
    expect(embedded.shutdownCalls).toBe(0);
  });

  it("shuts down and fails loudly when the provisioned server is still unusable", async () => {
    const embedded = fakeServer("postgresql://postgres:password@localhost:54329");
    await expect(
      ensurePgGateTarget(
        {},
        {
          hasPsql: () => true,
          probe: () => false,
          provisionEmbedded: async () => embedded,
        },
      ),
    ).rejects.toThrow(/embedded/i);
    expect(embedded.shutdownCalls).toBe(1);
  });

  it("wraps a provisioning failure in an actionable message", async () => {
    await expect(
      ensurePgGateTarget(
        {},
        {
          hasPsql: () => true,
          probe: () => false,
          provisionEmbedded: async () => {
            throw new Error("initdb exploded");
          },
        },
      ),
    ).rejects.toThrow(
      /initdb exploded[\s\S]*(start a local PostgreSQL|FUSION_PG_TEST_URL_BASE)/i,
    );
  });
});

testDescribe("createTaskStoreForTest (PG fixture helper)", () => {
  let harness: PgTestHarness | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.teardown();
      harness = null;
    }
  });

  it("creates a PG-backed TaskStore in backend mode", async () => {
    harness = await createTaskStoreForTest();
    expect(harness.store.isBackendMode()).toBe(true);
    expect(harness.store.getAsyncLayer()).not.toBeNull();
  });

  it("applies the schema baseline so tasks can be created", async () => {
    harness = await createTaskStoreForTest();
    const task = await harness.store.createTask({ description: "fixture test" });
    expect(task.id).toBeTruthy();
    const fetched = await harness.store.getTask(task.id);
    expect(fetched.description).toBe("fixture test");
  });

  it("tears down cleanly (drops database, closes connections)", async () => {
    const h = await createTaskStoreForTest();
    await h.teardown();
    // After teardown, calling it again is a no-op (idempotent).
    await h.teardown();
  });

  it("exposes the adminDb for direct row seeding", async () => {
    harness = await createTaskStoreForTest();
    const now = new Date().toISOString();
    await insertTaskRow(
      harness.layer,
      {
        id: "FIX-001",
        description: "seeded via helper",
        column: "todo",
        currentStep: 0,
        createdAt: now,
        updatedAt: now,
      },
      { lineageId: null },
    );
    const tasks = await harness.store.listTasks();
    expect(tasks.some((t) => t.id === "FIX-001")).toBe(true);
  });

  it("supports a custom prefix for database naming", async () => {
    harness = await createTaskStoreForTest({ prefix: "custom_prefix" });
    expect(harness.dbName.startsWith("custom_prefix")).toBe(true);
  });

  it("Wave 4 RED: preserves an earlier teardown failure packet before root cleanup", async () => {
    const h = await createTaskStoreForTest({ teardownFault: "store-close" });
    harness = null;

    await expect(h.teardown()).rejects.toThrow("teardown failed at store-close");
    await expect(access(h.rootDir)).resolves.toBeUndefined();
    const packet = JSON.parse(await readFile(join(h.rootDir, "pg-teardown-diagnostic.json"), "utf8"));
    expect(packet).toEqual(expect.objectContaining({ stage: "store-close" }));
    expect(JSON.stringify(packet)).not.toContain(h.testUrl);
  });

  it("Wave 4 RED: packet-write failure preserves the original teardown stage", async () => {
    const h = await createTaskStoreForTest({ teardownFault: "store-close", diagnosticWriteFault: true });
    harness = null;

    await expect(h.teardown()).rejects.toThrow("teardown failed at store-close");
    await expect(access(h.rootDir)).resolves.toBeUndefined();
  });
});
