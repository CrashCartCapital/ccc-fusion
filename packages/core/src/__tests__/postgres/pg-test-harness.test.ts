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

      expect(
        probePsqlReady(
          "postgresql://127.0.0.1:1",
          root,
          500,
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

      try {
        await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
        await chmod(executablePath, 0o755);

        expect(
          isPgTestAvailable("postgresql://127.0.0.1:1", root),
        ).toBe(true);
      } finally {
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
