import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

type EventName = string | symbol;

const originalSpawn = childProcess.spawn;
childProcess.spawn = (() => {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stderr: EventEmitter;
  };
  child.pid = 999_999_998;
  child.stderr = new EventEmitter();
  process.nextTick(() => child.emit("close", 1, null));
  return child;
}) as unknown as typeof childProcess.spawn;
syncBuiltinESMExports();

const lifecycleModule = await import("../../../postgres/embedded-lifecycle.js");
const dataDir = mkdtempSync(join(tmpdir(), "fusion-listener-custody-"));
writeFileSync(join(dataDir, "PG_VERSION"), "15\n");
const dependencyEvents = ["exit", "beforeExit", "SIGHUP", "SIGINT", "SIGTERM", "SIGBREAK", "message"] as const;
const symbolEvent = Symbol("host-listener-custody");
const hostListener = () => {};

for (const eventName of dependencyEvents) {
  process.on(eventName, hostListener);
  process.once(eventName, hostListener);
  process.on(eventName, hostListener);
}
process.on(symbolEvent, hostListener);

function snapshot(): Map<EventName, Function[]> {
  return new Map(process.eventNames().map((eventName) => [eventName, process.rawListeners(eventName)]));
}

const before = snapshot();
try {
  const lifecycle = new lifecycleModule.EmbeddedPostgresLifecycle({
    dataDir,
    database: "fusion",
    user: "postgres",
    password: "password",
    startTimeoutMs: 0,
    installShutdownHooks: false,
  });
  await lifecycle.start().catch(() => undefined);

  const after = snapshot();
  assert.deepStrictEqual([...after.keys()], [...before.keys()]);
  for (const [eventName, listeners] of before) {
    assert.deepStrictEqual(after.get(eventName), listeners, `listener drift for ${String(eventName)}`);
  }

  process.stdout.write(JSON.stringify({ listenersPreserved: true }));
} finally {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  rmSync(dataDir, { recursive: true, force: true });
}

process.exit(0);
