import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const files = new Map([
  ["src/contract.ts", `export type TelemetryEvent = Readonly<{
  id: string;
  type: string;
  observedAt: string;
  payload: Record<string, unknown>;
}>;

const expectedFields = ["id", "observedAt", "payload", "type"];

export function parseTelemetryEvent(value: unknown): TelemetryEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("event must be an object");
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedFields)) throw new Error("event fields are not exact");
  if (typeof record.id !== "string" || record.id.length === 0) throw new Error("id is required");
  if (typeof record.type !== "string" || record.type.length === 0) throw new Error("type is required");
  if (typeof record.observedAt !== "string" || Number.isNaN(Date.parse(record.observedAt))) throw new Error("observedAt is invalid");
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) throw new Error("payload is invalid");
  return {
    id: record.id,
    type: record.type,
    observedAt: record.observedAt,
    payload: record.payload as Record<string, unknown>,
  };
}
`],
  ["src/audit.ts", `import { appendFile, readFile } from "node:fs/promises";
import type { TelemetryEvent } from "./contract.ts";

export class AuditStore {
  readonly #path: string;
  readonly #events: TelemetryEvent[];
  readonly #ids: Set<string>;

  private constructor(filePath: string, events: TelemetryEvent[]) {
    this.#path = filePath;
    this.#events = events;
    this.#ids = new Set(events.map(({ id }) => id));
  }

  static async open(filePath: string): Promise<AuditStore> {
    let source = "";
    try {
      source = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const events = source.trim().length === 0
      ? []
      : source.trim().split("\\n").map((line) => JSON.parse(line) as TelemetryEvent);
    return new AuditStore(filePath, events);
  }

  async append(event: TelemetryEvent): Promise<boolean> {
    if (this.#ids.has(event.id)) return false;
    await appendFile(this.#path, JSON.stringify(event) + "\\n", "utf8");
    this.#ids.add(event.id);
    this.#events.push(event);
    return true;
  }

  async readAll(): Promise<TelemetryEvent[]> {
    return [...this.#events];
  }
}
`],
  ["src/broadcast.ts", `import type { TelemetryEvent } from "./contract.ts";

type Subscriber = {
  queue: string[];
  waiting?: (result: IteratorResult<string>) => void;
  closed: boolean;
};

export class SseHub {
  readonly #subscribers = new Set<Subscriber>();

  subscribe(): AsyncIterable<string> {
    const subscriber: Subscriber = { queue: [], closed: false };
    this.#subscribers.add(subscriber);
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          const queued = subscriber.queue.shift();
          if (queued !== undefined) return { done: false, value: queued };
          if (subscriber.closed) return { done: true, value: undefined };
          return new Promise<IteratorResult<string>>((resolve) => {
            subscriber.waiting = resolve;
          });
        },
        return: async () => {
          subscriber.closed = true;
          this.#subscribers.delete(subscriber);
          subscriber.waiting?.({ done: true, value: undefined });
          return { done: true, value: undefined };
        },
      }),
    };
  }

  publish(event: TelemetryEvent): void {
    const frame = "data: " + JSON.stringify(event) + "\\n\\n";
    for (const subscriber of this.#subscribers) {
      if (subscriber.waiting) {
        const resolve = subscriber.waiting;
        subscriber.waiting = undefined;
        resolve({ done: false, value: frame });
      } else {
        subscriber.queue.push(frame);
      }
    }
  }
}
`],
  ["src/ingest.ts", `import { parseTelemetryEvent } from "./contract.ts";
import type { TelemetryEvent } from "./contract.ts";

export type IngestDependencies = Readonly<{
  audit: { append(event: TelemetryEvent): Promise<boolean> };
  broadcast: { publish(event: TelemetryEvent): void };
}>;

export async function handleIngest(value: unknown, dependencies: IngestDependencies): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  try {
    const event = parseTelemetryEvent(value);
    const appended = await dependencies.audit.append(event);
    if (appended) dependencies.broadcast.publish(event);
    return { status: appended ? 202 : 200, body: { accepted: true, duplicate: !appended, id: event.id } };
  } catch (error) {
    return {
      status: 400,
      body: { accepted: false, error: error instanceof Error ? error.message : "invalid event" },
    };
  }
}
`],
  ["src/health-cli.ts", `import { pathToFileURL } from "node:url";

export async function probeHealth(
  fetchFn: typeof fetch,
  baseUrl: string,
): Promise<number> {
  try {
    const response = await fetchFn(new URL("/health", baseUrl));
    if (!response.ok) return 1;
    const body = await response.json().catch(() => null) as { status?: unknown } | null;
    return body?.status === "healthy" ? 0 : 1;
  } catch {
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseUrl = process.argv[2];
  if (!baseUrl) process.exit(2);
  process.exit(await probeHealth(fetch, baseUrl));
}
`],
  ["src/app.ts", `import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { AuditStore } from "./audit.ts";
import { SseHub } from "./broadcast.ts";
import { handleIngest } from "./ingest.ts";

export async function createApp(options: { auditPath: string }): Promise<{
  audit: AuditStore;
  hub: SseHub;
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}> {
  const audit = await AuditStore.open(options.auditPath);
  const hub = new SseHub();
  return {
    audit,
    hub,
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ status: "healthy" });
      }
      if (request.method === "POST" && url.pathname === "/events") {
        const result = await handleIngest(await request.json(), { audit, broadcast: hub });
        return Response.json(result.body, { status: result.status });
      }
      if (request.method === "GET" && url.pathname === "/stream") {
        const iterator = hub.subscribe()[Symbol.asyncIterator]();
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await iterator.next();
            if (next.done) controller.close();
            else controller.enqueue(new TextEncoder().encode(next.value));
          },
          async cancel() { await iterator.return?.(); },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response("", { status: 404 });
    },
    async close(): Promise<void> {},
  };
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error("missing " + name);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createApp({ auditPath: argument("--audit") });
  const port = Number(argument("--port"));
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
    const handled = await app.handle(new Request("http://127.0.0.1" + (request.url ?? "/"), {
      method: request.method,
      headers: request.headers as HeadersInit,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
    }));
    response.writeHead(handled.status, Object.fromEntries(handled.headers.entries()));
    response.flushHeaders();
    if (!handled.body) { response.end(); return; }
    const reader = handled.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      response.write(next.value);
    }
    response.end();
  });
  server.listen(port, "127.0.0.1");
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}
`],
  ["tests/telemetry.test.ts", `import assert from "node:assert/strict";
import test from "node:test";
import { parseTelemetryEvent } from "../src/contract.ts";

test("contract accepts exact events and rejects unknown fields", () => {
  const event = { id: "evt-test", type: "test", observedAt: "2026-09-01T12:00:00Z", payload: { ok: true } };
  assert.deepEqual(parseTelemetryEvent(event), event);
  assert.throws(() => parseTelemetryEvent({ ...event, extra: true }));
});
`],
  ["README.md", `# Gate 2 Telemetry Service

## Quickstart

Run \`node --experimental-strip-types src/app.ts --port 4317 --audit data/events.jsonl\`.

## Architecture

The in-process app handles health checks, event ingest, and SSE stream registration. The guarded executable wraps that handler in a local HTTP server.

## Persistence and recovery

Restart with the same audit path. Existing event IDs are loaded and duplicate submissions do not append a second record.

## Verification

Run \`task verify:integrated\` for the baseline-owned behavioral proof and project tests.
`],
]);

export async function writeGate2TelemetryCandidate(root) {
  for (const [relativePath, source] of files) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, source);
  }
}
