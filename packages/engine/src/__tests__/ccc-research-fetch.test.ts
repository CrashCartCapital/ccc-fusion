import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import dns from "node:dns";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer, get as httpsGet, type Server as HttpsServer } from "node:https";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  canonicalCccPrdJson,
  CCC_PLANNING_SOURCE_POLICY_I2,
  CCC_PLANNING_TOOLSETS,
  CccPlanningRefusal,
  cccPlanningSourcePolicySha256,
  reserveCccPlanningResearchFetch,
  settleCccPlanningResearchFetch,
} from "@fusion/core";
import { assertSafeUrl } from "../web-fetch.js";
import { buildCccResearchAddressBlocklist, isCccResearchAddressBlocked } from "../ccc-research/address-blocklist.js";
import {
  CccResearchFetchRefusedError,
  createCccCitationReadTool,
  createCccResearchFetchTool,
  fetchCccResearchSource,
  type CccResearchCitation,
  type CccResearchGrantPort,
  type CccResearchSourcePolicy,
} from "../ccc-research/research-fetch.js";

/*
FNXC:CccResearchFetch 2026-10-15-00:44:
Card C5 proof (request-to-code PRD v3, CONTRACT-v3.5 section 2.14, D28, ADR C Q4). The controller-side research fetch is the only egress a planning model has, so every refusal here has a twin on the same fixture that must be fetched, and every network path is local or injected:
- DNS is injected (`deps.lookup`; the tool tests spy on `dns.promises.lookup` because the frozen tool input carries no lookup). The answers are public-looking addresses that only exist as keys of a fake network.
- The fake network is a spy on `tls.connect`, which `https.request` calls for every connection. It reads the address the fetcher's own pinned `lookup` hands to the socket, routes that address to a TLS stub bound to 127.0.0.1 on port 0, and injects the stub's in-memory certificate as the CA. Nothing in the fetcher knows about it, the default certificate verification stays on, and a dial to an unrouted address fails the test. No real egress happens, so the P0 offline guard has nothing to report.
- The TLS stub certificate is made in memory by `makeSelfSignedCertificate` (ECDSA P-256, one day, SANs for the three test host names). No key or certificate is written to disk or committed.
- The grant cap (24 per run, 8 per node attempt) is L1's. The fake port mirrors L1's exact refusal (`CccPlanningRefusal` with `CCC_PLANNING_RESEARCH_GRANT_EXHAUSTED`) and a drift pin below ties its constants to L1's; the fetcher never re-implements the cap.
Positive controls: the 24th fetch is allowed, an allowlisted fixture over the local TLS stub with an injected public address is fetched, and every refusal has its twin.
*/

const API_URL = "https://nodejs.org/docs/latest-v24.x/api/fs.html";
const MDN_URL = "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide";
const PUBLIC_NODEJS = "93.184.216.34";
const PUBLIC_MDN = "151.101.65.69";
const PUBLIC_EVIL = "185.199.108.153";
const PUBLIC_V6 = "2606:4700:4700::1111";
const LOOPBACK = "127.0.0.1";
const RUN_ID = "ccc-plan:0123456789abcdef01234567";
const FIXED_NOW = new Date("2026-10-15T00:00:00.000Z");
const TEN_MIB = 10 * 1024 * 1024;

// ---------------------------------------------------------------- in-memory certificate

function derLength(length: number): Buffer {
  if (length < 128) return Buffer.from([length]);
  if (length < 256) return Buffer.from([0x81, length]);
  return Buffer.from([0x82, length >> 8, length & 0xff]);
}
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}
const derSequence = (...parts: Buffer[]) => der(0x30, ...parts);
const derSet = (...parts: Buffer[]) => der(0x31, ...parts);
const derOid = (bytes: readonly number[]) => der(0x06, Buffer.from(bytes));
function derUtcTime(date: Date): Buffer {
  const two = (value: number) => String(value).padStart(2, "0");
  const text = `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(text, "ascii"));
}

/** A one-day self-signed ECDSA P-256 certificate with the given DNS names, built in memory. Test-only; it protects nothing. */
function makeSelfSignedCertificate(dnsNames: readonly string[]): { certPem: string; keyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signatureAlgorithm = derSequence(derOid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
  const name = derSequence(derSet(derSequence(derOid([0x55, 0x04, 0x03]), der(0x0c, Buffer.from("ccc-research-test", "ascii")))));
  const subjectAltName = der(0x04, derSequence(...dnsNames.map((dnsName) => der(0x82, Buffer.from(dnsName, "ascii")))));
  const extensions = der(0xa3, derSequence(
    derSequence(derOid([0x55, 0x1d, 0x11]), subjectAltName),
    derSequence(derOid([0x55, 0x1d, 0x13]), der(0x01, Buffer.from([0xff])), der(0x04, derSequence(der(0x01, Buffer.from([0xff]))))),
  ));
  const now = Date.now();
  const toBeSigned = derSequence(
    Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02]),
    der(0x02, Buffer.from([0x01])),
    signatureAlgorithm,
    name,
    derSequence(derUtcTime(new Date(now - 86_400_000)), derUtcTime(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = signBytes("sha256", toBeSigned, { key: privateKey, dsaEncoding: "der" });
  const certificate = derSequence(toBeSigned, signatureAlgorithm, der(0x03, Buffer.concat([Buffer.from([0x00]), signature])));
  const lines = certificate.toString("base64").match(/.{1,64}/g) ?? [];
  return {
    certPem: `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`,
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

// ---------------------------------------------------------------- TLS stubs

type Handler = (req: IncomingMessage, res: ServerResponse, stub: Stub) => void;
type RecordedRequest = Readonly<{ method: string; url: string; headers: IncomingMessage["headers"]; headerNames: readonly string[] }>;
type Stub = {
  readonly name: string;
  port: number;
  server: HttpsServer;
  connections: number;
  requests: RecordedRequest[];
  handler: Handler;
  sockets: Set<net.Socket>;
  bytesWritten: number;
  lastClosed: Promise<void> | null;
};

function okHtml(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<html><head><title>Fixture</title></head><body><main><p>ok</p></main></body></html>");
}

async function startStub(name: string, credentials: { key: string; cert: string }): Promise<Stub> {
  const stub: Stub = {
    name, port: 0, server: undefined as unknown as HttpsServer, connections: 0, requests: [], handler: okHtml,
    sockets: new Set(), bytesWritten: 0, lastClosed: null,
  };
  stub.server = createHttpsServer(credentials, (req, res) => {
    stub.requests.push({
      method: req.method ?? "", url: req.url ?? "", headers: req.headers,
      headerNames: req.rawHeaders.filter((_value, index) => index % 2 === 0).map((header) => header.toLowerCase()),
    });
    stub.lastClosed = new Promise<void>((resolve) => res.once("close", () => resolve()));
    res.on("error", () => {});
    stub.handler(req, res, stub);
  });
  stub.server.on("connection", (socket) => {
    stub.connections += 1;
    stub.sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => stub.sockets.delete(socket));
  });
  stub.server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  stub.port = (stub.server.address() as AddressInfo).port;
  return stub;
}

function resetStub(stub: Stub): void {
  for (const socket of stub.sockets) socket.destroy();
  stub.sockets.clear();
  stub.connections = 0;
  stub.requests = [];
  stub.handler = okHtml;
  stub.bytesWritten = 0;
  stub.lastClosed = null;
}

async function stopStub(stub: Stub): Promise<void> {
  for (const socket of stub.sockets) socket.destroy();
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
}

function respond(res: ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer = ""): void {
  res.writeHead(status, headers);
  res.end(body);
}

/** Streams `total` bytes in 16 KiB writes that honour backpressure, counting what the server handed to the socket. */
function streamBody(total: number, contentType = "text/plain"): Handler {
  return (_req, res, stub) => {
    res.writeHead(200, { "content-type": contentType });
    const chunk = Buffer.alloc(16 * 1024, 0x61);
    let sent = 0;
    const pump = (): void => {
      while (sent < total && !res.destroyed) {
        const accepted = res.write(chunk);
        sent += chunk.length;
        stub.bytesWritten = sent;
        if (!accepted) {
          res.once("drain", pump);
          return;
        }
      }
      if (!res.destroyed) res.end();
    };
    pump();
  };
}

// ---------------------------------------------------------------- the fake network

type Dial = Readonly<{ host: string; servername: string | undefined; address: string }>;
const network = {
  routes: new Map<string, number>(),
  dials: [] as Dial[],
  unrouted: [] as string[],
  trustCa: true,
  certPem: "",
};

/** Routes every `tls.connect` by the address the caller's own pinned lookup answers, then dials the local stub. */
function installNetwork(): void {
  const realConnect = tls.connect;
  vi.spyOn(tls, "connect").mockImplementation(function (this: unknown, ...args: unknown[]) {
    const options = args[0] as (tls.ConnectionOptions & { lookup?: unknown; host?: string }) | undefined;
    if (typeof options !== "object" || options === null || typeof options.lookup !== "function") {
      throw new Error("test network: a connection arrived without a pinned lookup");
    }
    const slot: { address: string | null } = { address: null };
    (options.lookup as (host: string, opts: object, cb: (error: Error | null, address?: string) => void) => void)(
      String(options.host), { all: false }, (error, address) => { if (!error && typeof address === "string") slot.address = address; },
    );
    if (slot.address === null) throw new Error("test network: the pinned lookup did not answer one address synchronously");
    network.dials.push({ host: String(options.host), servername: options.servername, address: slot.address });
    const port = network.routes.get(slot.address);
    if (port === undefined) {
      network.unrouted.push(slot.address);
      throw new Error(`test network: no route to ${slot.address}`);
    }
    return (realConnect as (...rest: unknown[]) => tls.TLSSocket).call(tls, {
      ...options, host: LOOPBACK, port, lookup: undefined, ...(network.trustCa ? { ca: [network.certPem] } : {}),
    });
  } as never);
}

/** A client that dials `host` with a lookup that answers `address`, through the same fake network. */
function dialThroughNetwork(host: string, address: string, bodyBytes?: { count: number }): Promise<number> {
  return new Promise((resolve, reject) => {
    const lookup = ((_host: string, options: { all?: boolean }, callback: (...rest: unknown[]) => void) => {
      if (options.all === true) callback(null, [{ address, family: address.includes(":") ? 6 : 4 }]);
      else callback(null, address, address.includes(":") ? 6 : 4);
    }) as never;
    const request = httpsGet({ host, port: 443, path: "/probe", agent: false, servername: host, lookup }, (res) => {
      res.on("data", (chunk: Buffer) => { if (bodyBytes) bodyBytes.count += chunk.length; });
      res.on("end", () => resolve(res.statusCode ?? 0));
      res.on("error", reject);
    });
    request.on("error", reject);
  });
}

// ---------------------------------------------------------------- injected DNS and fixtures

function makeLookup(table: Readonly<Record<string, readonly string[]>> | ((host: string, call: number) => readonly string[])): {
  lookup: typeof dns.promises.lookup; calls: string[];
} {
  const calls: string[] = [];
  const lookup = async (host: string, options?: { all?: boolean }) => {
    calls.push(host);
    const answers = typeof table === "function" ? table(host, calls.length) : table[host];
    if (answers === undefined) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    const list = answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    return options?.all === true ? list : list[0];
  };
  return { lookup: lookup as unknown as typeof dns.promises.lookup, calls };
}

const DEFAULT_TABLE = {
  "nodejs.org": [PUBLIC_NODEJS],
  "developer.mozilla.org": [PUBLIC_MDN],
  "evil.example.test": [PUBLIC_EVIL],
} as const;

function depsFor(lookup: typeof dns.promises.lookup, signal: AbortSignal = new AbortController().signal) {
  return { lookup, now: () => FIXED_NOW, signal };
}

function i2Policy(overrides: Partial<CccResearchSourcePolicy> = {}): CccResearchSourcePolicy {
  const policy = CCC_PLANNING_SOURCE_POLICY_I2;
  return {
    policyId: policy.policyId, policySha256: cccPlanningSourcePolicySha256(), allow: policy.allow,
    maxFetchesPerNode: policy.maxFetchesPerNode, maxRawBytesPerFetch: policy.maxRawBytesPerFetch,
    maxRawBytesPerRun: policy.maxRawBytesPerRun, timeoutMs: policy.timeoutMs, maxRedirects: policy.maxRedirects,
    mimeTypes: policy.mimeTypes, ...overrides,
  };
}

async function refusalOf(promise: Promise<unknown>): Promise<CccResearchFetchRefusedError> {
  let outcome: { value: unknown } | { error: unknown };
  try {
    outcome = { value: await promise };
  } catch (error) {
    outcome = { error };
  }
  if ("value" in outcome) expect.unreachable("expected a CccResearchFetchRefusedError, but the call resolved");
  expect(outcome.error).toBeInstanceOf(CccResearchFetchRefusedError);
  const refusal = outcome.error as CccResearchFetchRefusedError;
  expect(refusal.code).toBe("CCC_RESEARCH_FETCH_REFUSED");
  return refusal;
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  let outcome: { value: unknown } | { error: unknown };
  try {
    outcome = { value: await promise };
  } catch (error) {
    outcome = { error };
  }
  if ("value" in outcome) expect.unreachable("expected the call to fail, but it resolved");
  expect(outcome.error).toBeInstanceOf(Error);
  return outcome.error as Error;
}

const sha256Hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------- the grant port: L1's refusal, mirrored

function exhausted(detail: string): CccPlanningRefusal {
  return new CccPlanningRefusal("CCC_PLANNING_RESEARCH_GRANT_EXHAUSTED", detail);
}

/** Mirrors reserveCccPlanningResearchFetch and settleCccPlanningResearchFetch (task-store/ccc-planning-ops.ts), minus the fence and the database. */
function createL1MirrorGrantPort() {
  const policy = CCC_PLANNING_SOURCE_POLICY_I2;
  const fetches = new Map<string, { nodeId: string; nodeAttempt: number; maxRawBytes: number; settled: { rawBytes: number; outcome: string } | null }>();
  const reserved: Array<Parameters<CccResearchGrantPort["reserve"]>[0]> = [];
  const settled: Array<Parameters<CccResearchGrantPort["settle"]>[0]> = [];
  let fetchSpent = 0;
  let bytesSpent = 0;
  const port: CccResearchGrantPort = {
    async reserve(input) {
      reserved.push(input);
      if (typeof input.nodeId !== "string" || input.nodeId.length === 0 || !Number.isSafeInteger(input.nodeAttempt) || input.nodeAttempt < 1
        || !Number.isSafeInteger(input.maxRawBytes) || input.maxRawBytes < 1 || input.maxRawBytes > policy.maxRawBytesPerFetch) {
        throw new CccPlanningRefusal("CCC_PLANNING_INTERNAL_ERROR", "fetch needs a node id, a node attempt >= 1 and 1..1 MiB of raw bytes");
      }
      const open = [...fetches.entries()].find(([, fetch]) => fetch.settled === null);
      if (open) throw exhausted(`fetch ${open[0]} is unsettled`);
      if (fetchSpent >= policy.maxFetchesPerRun) throw exhausted(`fetch allocation ${policy.maxFetchesPerRun} is spent`);
      const sameNode = [...fetches.values()].filter((fetch) => fetch.nodeId === input.nodeId && fetch.nodeAttempt === input.nodeAttempt).length;
      if (sameNode >= policy.maxFetchesPerNode) throw exhausted(`node ${input.nodeId} attempt ${input.nodeAttempt} used ${policy.maxFetchesPerNode} fetches`);
      if (bytesSpent + policy.maxRawBytesPerFetch > policy.maxRawBytesPerRun) throw exhausted("remaining research bytes do not cover one more fetch");
      fetchSpent += 1;
      const grantKey = `${RUN_ID}:f${fetchSpent}`;
      fetches.set(grantKey, { nodeId: input.nodeId, nodeAttempt: input.nodeAttempt, maxRawBytes: input.maxRawBytes, settled: null });
      return { grantKey };
    },
    async settle(input) {
      settled.push(input);
      const fetch = fetches.get(input.grantKey);
      if (!fetch) throw new CccPlanningRefusal("CCC_PLANNING_INTERNAL_ERROR", `grant ${input.grantKey} was never reserved`);
      if (!Number.isSafeInteger(input.rawBytes) || input.rawBytes < 0 || input.rawBytes > fetch.maxRawBytes) {
        throw new CccPlanningRefusal("CCC_PLANNING_INTERNAL_ERROR", `rawBytes must be 0..${fetch.maxRawBytes}`);
      }
      if (fetch.settled === null) bytesSpent += input.rawBytes;
      fetch.settled = { rawBytes: input.rawBytes, outcome: input.outcome };
    },
  };
  return { port, reserved, settled, state: () => ({ fetchSpent, bytesSpent }) };
}

// ---------------------------------------------------------------- tool plumbing

type ToolResult = { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> };
async function runTool(tool: ToolDefinition, params: unknown, signal?: AbortSignal): Promise<ToolResult> {
  return (await tool.execute("call-1", params as never, signal, undefined, undefined as never)) as unknown as ToolResult;
}
const textOf = (result: ToolResult) => result.content.map((block) => block.text ?? "").join("");

function makeStore() {
  const store = new Map<string, { citation: CccResearchCitation; raw: Uint8Array }>();
  const order: string[] = [];
  return {
    store, order,
    storeCitation: async (citation: CccResearchCitation, raw: Uint8Array) => {
      order.push(`store:${citation.citationId}`);
      store.set(citation.citationId, { citation, raw });
    },
  };
}

function fetchToolFor(grant: CccResearchGrantPort, storeCitation: (c: CccResearchCitation, r: Uint8Array) => Promise<void>, policy = i2Policy(), nodeId = "researcher") {
  return createCccResearchFetchTool({ policy, grant, storeCitation, runId: RUN_ID, nodeId, nodeAttempt: 1 });
}

// ---------------------------------------------------------------- suite state

let stubNodejs: Stub;
let stubMdn: Stub;
let stubEvil: Stub;
let listener: Stub;
const scratch: { dir: string | null } = { dir: null };

beforeAll(async () => {
  const names = ["nodejs.org", "developer.mozilla.org", "evil.example.test"];
  const { certPem, keyPem } = makeSelfSignedCertificate(names);
  network.certPem = certPem;
  const credentials = { key: keyPem, cert: certPem };
  stubNodejs = await startStub("nodejs", credentials);
  stubMdn = await startStub("mdn", credentials);
  stubEvil = await startStub("evil", credentials);
  listener = await startStub("loopback-listener", credentials);
});

afterAll(async () => {
  await Promise.all([stubNodejs, stubMdn, stubEvil, listener].map((stub) => stopStub(stub)));
});

beforeEach(() => {
  for (const stub of [stubNodejs, stubMdn, stubEvil, listener]) resetStub(stub);
  network.routes = new Map([[PUBLIC_NODEJS, stubNodejs.port], [PUBLIC_MDN, stubMdn.port], [PUBLIC_EVIL, stubEvil.port], [PUBLIC_V6, stubNodejs.port], [LOOPBACK, listener.port]]);
  network.dials = [];
  network.unrouted = [];
  network.trustCa = true;
  installNetwork();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (scratch.dir !== null) {
    rmSync(scratch.dir, { recursive: true, force: true });
    scratch.dir = null;
  }
  expect(network.unrouted).toEqual([]);
});

// ================================================================ blocklist

describe("ccc research address blocklist", () => {
  it("refuses 198.18.0.1, 224.0.0.1, 240.0.0.1, ::, ff02::1, 64:ff9b::7f00:1 and ::ffff:7f00:1, each of which the legacy web-fetch check accepts", async () => {
    const refused = ["198.18.0.1", "224.0.0.1", "240.0.0.1", "::", "ff02::1", "64:ff9b::7f00:1", "::ffff:7f00:1"];
    for (const address of refused) {
      expect(isCccResearchAddressBlocked(address), address).toBe(true);
      const literal = address.includes(":") ? `[${address}]` : address;
      await expect(assertSafeUrl(`https://${literal}/`), `legacy check for ${address}`).resolves.toBeUndefined();
    }
    // Positive control: the legacy check is live, it refuses a plain loopback literal.
    await expect(assertSafeUrl("https://127.0.0.1/")).rejects.toMatchObject({ code: "blocked-host" });
  });

  it("covers loopback, link-local, private, CGNAT, multicast, TEST-NET and IPv6 forms and passes the public twin at every range boundary", () => {
    const blocked = [
      "0.0.0.0", "0.255.255.255", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254",
      "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1",
      "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
      "::1", "::", "::5", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1", "fec0::1", "ff02::1", "2001:db8::1", "2001::1",
      "2001:1ff:ffff::1", "2002:7f00:1::", "64:ff9b::808:808", "64:ff9b:1::1", "100::1", "3fff::1",
      "::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:169.254.169.254", "::FFFF:7F00:1", "fe80::1%en0",
    ];
    const open = [
      "1.1.1.1", "8.8.8.8", "93.184.216.34", "11.0.0.1", "100.63.255.255", "100.128.0.1", "126.255.255.255", "128.0.0.1",
      "169.253.255.255", "169.255.0.1", "172.15.255.255", "172.32.0.1", "192.0.1.1", "192.167.255.255", "192.169.0.1",
      "198.17.255.255", "198.20.0.1", "223.255.255.255",
      "2606:4700:4700::1111", "2001:4860:4860::8888", "2001:200::1", "2a00:1450:4001:81b::200e", "64:ff9a::1",
      "::ffff:8.8.8.8", "::ffff:808:808",
    ];
    for (const address of blocked) expect(isCccResearchAddressBlocked(address), `blocked ${address}`).toBe(true);
    for (const address of open) expect(isCccResearchAddressBlocked(address), `open ${address}`).toBe(false);
    const list = buildCccResearchAddressBlocklist();
    expect(list.check("10.1.2.3", "ipv4")).toBe(true);
    expect(list.check("8.8.8.8", "ipv4")).toBe(false);
    expect(list.check("fd00::1", "ipv6")).toBe(true);
    expect(list.check(PUBLIC_V6, "ipv6")).toBe(false);
  });

  it("refuses what it cannot parse, so an unknown spelling is never admitted", () => {
    const unparsable = ["", "localhost", "1.2.3", "256.1.1.1", "::g", "1.2.3.4.5", "0177.0.0.1", " 8.8.8.8", "8.8.8.8 ", "[::1]", "1::2::3", "::ffff:300.1.1.1"];
    for (const address of unparsable) expect(isCccResearchAddressBlocked(address), JSON.stringify(address)).toBe(true);
    expect(isCccResearchAddressBlocked(undefined as unknown as string)).toBe(true);
    expect(isCccResearchAddressBlocked(8 as unknown as string)).toBe(true);
  });
});

// ================================================================ fetchCccResearchSource

describe("ccc research fetch source", () => {
  it("refuses an allowlisted host whose injected DNS answer is 127.0.0.1 as blocked-address while a live loopback listener sees 0 connections; the twin with a public answer is fetched", async () => {
    // Non-vacuity: the route to the loopback listener is live, so a connect without the check would succeed.
    expect(await dialThroughNetwork("nodejs.org", LOOPBACK)).toBe(200);
    expect(listener.connections).toBe(1);
    expect(listener.requests).toHaveLength(1);
    resetStub(listener);
    network.dials = [];

    const blocked = makeLookup({ "nodejs.org": [LOOPBACK] });
    const refusal = await refusalOf(fetchCccResearchSource(API_URL, i2Policy(), depsFor(blocked.lookup)));
    expect(refusal.reason).toBe("blocked-address");
    expect(blocked.calls).toEqual(["nodejs.org"]);
    expect(listener.connections).toBe(0);
    expect(listener.requests).toHaveLength(0);
    expect(network.dials).toEqual([]);

    // Positive control: the same allowlisted URL with a public answer is fetched over the local TLS stub.
    const open = makeLookup(DEFAULT_TABLE);
    const fetched = await fetchCccResearchSource(API_URL, i2Policy(), depsFor(open.lookup));
    expect(fetched.citation.resolvedAddress).toBe(PUBLIC_NODEJS);
    expect(fetched.citation.status).toBe(200);
    expect(stubNodejs.requests).toHaveLength(1);
    expect(listener.connections).toBe(0);
  });

  it("refuses the whole lookup when any one answer is blocked and pins the first address of an all-public answer set, IPv6 included", async () => {
    for (const answers of [[PUBLIC_NODEJS, LOOPBACK], [LOOPBACK, PUBLIC_NODEJS], [PUBLIC_NODEJS, "10.0.0.5"], [PUBLIC_NODEJS, "::ffff:7f00:1"]]) {
      const mixed = makeLookup({ "nodejs.org": answers });
      const refusal = await refusalOf(fetchCccResearchSource(API_URL, i2Policy(), depsFor(mixed.lookup)));
      expect(refusal.reason, answers.join(",")).toBe("blocked-address");
    }
    expect(stubNodejs.connections).toBe(0);
    expect(listener.connections).toBe(0);
    expect(network.dials).toEqual([]);

    const pair = makeLookup({ "nodejs.org": [PUBLIC_NODEJS, PUBLIC_MDN] });
    const first = await fetchCccResearchSource(API_URL, i2Policy(), depsFor(pair.lookup));
    expect(first.citation.resolvedAddress).toBe(PUBLIC_NODEJS);
    expect(network.dials.map((dial) => dial.address)).toEqual([PUBLIC_NODEJS]);
    expect(stubMdn.connections).toBe(0);

    const v6 = makeLookup({ "nodejs.org": [PUBLIC_V6] });
    const viaV6 = await fetchCccResearchSource(API_URL, i2Policy(), depsFor(v6.lookup));
    expect(viaV6.citation.resolvedAddress).toBe(PUBLIC_V6);
    expect(network.dials.map((dial) => dial.address)).toEqual([PUBLIC_NODEJS, PUBLIC_V6]);
  });

  it("pins the first DNS answer for the connection, so a rebinding second answer of 127.0.0.1 never reaches the loopback listener", async () => {
    const rebinding = makeLookup((_host, call) => (call === 1 ? [PUBLIC_NODEJS] : [LOOPBACK]));
    const result = await fetchCccResearchSource(API_URL, i2Policy(), depsFor(rebinding.lookup));
    expect(result.citation.resolvedAddress).toBe(PUBLIC_NODEJS);
    // The socket is asked for the allowlisted name (Host and SNI) and answered the pinned address; it is never asked for the address itself.
    expect(network.dials).toEqual([{ host: "nodejs.org", servername: "nodejs.org", address: PUBLIC_NODEJS }]);
    expect(rebinding.calls).toEqual(["nodejs.org"]);
    expect(stubNodejs.requests).toHaveLength(1);
    expect(listener.connections).toBe(0);

    // Control: a client that resolves again at connect time gets the rebound answer and does reach the listener.
    const naive = makeLookup((_host, call) => (call === 1 ? [PUBLIC_NODEJS] : [LOOPBACK]));
    await naive.lookup("nodejs.org", { all: true });
    const second = await naive.lookup("nodejs.org", { all: true });
    expect(await dialThroughNetwork("nodejs.org", second[0]!.address)).toBe(200);
    expect(listener.connections).toBe(1);
  });

  it("refuses a redirect to a non-allowlisted host and the second server sees 0 requests; the twins that redirect to an allowlisted host and an allowlisted path are followed", async () => {
    const lookup = makeLookup(DEFAULT_TABLE);
    stubNodejs.handler = (_req, res) => respond(res, 302, { location: "https://evil.example.test/steal" });
    const refusal = await refusalOf(fetchCccResearchSource(API_URL, i2Policy(), depsFor(lookup.lookup)));
    expect(refusal.reason).toBe("redirect-not-allowlisted");
    expect(stubNodejs.requests).toHaveLength(1);
    expect(stubEvil.connections).toBe(0);
    expect(stubEvil.requests).toHaveLength(0);
    expect(lookup.calls).toEqual(["nodejs.org"]);

    // Twin 1: the same redirect to another allowlisted host is followed and re-resolved.
    resetStub(stubNodejs);
    stubNodejs.handler = (_req, res) => respond(res, 302, { location: MDN_URL });
    const lookupTwin = makeLookup(DEFAULT_TABLE);
    const followed = await fetchCccResearchSource(API_URL, i2Policy(), depsFor(lookupTwin.lookup));
    expect(followed.citation.finalUrl).toBe(MDN_URL);
    expect(followed.citation.redirectChain).toEqual([API_URL]);
    expect(followed.citation.requestedUrl).toBe(API_URL);
    expect(followed.citation.resolvedAddress).toBe(PUBLIC_MDN);
    expect(stubMdn.requests).toHaveLength(1);
    expect(lookupTwin.calls).toEqual(["nodejs.org", "developer.mozilla.org"]);

    // Twin 2: a relative Location to an allowlisted path of the same host is followed.
    resetStub(stubNodejs);
    stubNodejs.handler = (req, res) => {
      if (req.url === "/docs/latest-v24.x/api/fs.html") respond(res, 301, { location: "/docs/latest-v24.x/api/path.html" });
      else okHtml(req, res);
    };
    const relative = await fetchCccResearchSource(API_URL, i2Policy(), depsFor(makeLookup(DEFAULT_TABLE).lookup));
    expect(relative.citation.finalUrl).toBe("https://nodejs.org/docs/latest-v24.x/api/path.html");
    expect(stubNodejs.requests.map((request) => request.url)).toEqual(["/docs/latest-v24.x/api/fs.html", "/docs/latest-v24.x/api/path.html"]);
  });

  it("re-checks every redirect hop: a non-allowlisted path, an http: target, a missing Location and an allowlisted host that now resolves to loopback are all refused", async () => {
    const cases: Array<{ label: string; location: string | null; table?: Record<string, readonly string[]>; reason: string }> = [
      { label: "non-allowlisted path on an allowlisted host", location: "https://developer.mozilla.org/secret", reason: "redirect-not-allowlisted" },
      { label: "http: target", location: "http://nodejs.org/docs/latest-v24.x/api/x.html", reason: "redirect-not-allowlisted" },
      { label: "port on the target", location: "https://nodejs.org:8443/docs/latest-v24.x/api/x.html", reason: "redirect-not-allowlisted" },
      { label: "missing Location", location: null, reason: "redirect-not-allowlisted" },
      { label: "allowlisted host re-resolved to loopback", location: MDN_URL, table: { ...DEFAULT_TABLE, "developer.mozilla.org": [LOOPBACK] }, reason: "blocked-address" },
    ];
    for (const entry of cases) {
      resetStub(stubNodejs);
      stubNodejs.handler = (_req, res) => respond(res, 302, entry.location === null ? {} : { location: entry.location });
      const lookup = makeLookup(entry.table ?? DEFAULT_TABLE);
      const refusal = await refusalOf(fetchCccResearchSource(API_URL, i2Policy(), depsFor(lookup.lookup)));
      expect(refusal.reason, entry.label).toBe(entry.reason);
    }
    expect(stubMdn.connections).toBe(0);
    expect(listener.connections).toBe(0);
  });

  it("follows at most maxRedirects redirects and refuses the next one as too-many-redirects without a further request", async () => {
    const table: Array<{ max: 0 | 1 | 2 | 3; redirects: number; fetched: boolean }> = [
      { max: 3, redirects: 3, fetched: true },
      { max: 3, redirects: 4, fetched: false },
      { max: 0, redirects: 0, fetched: true },
      { max: 0, redirects: 1, fetched: false },
      { max: 1, redirects: 1, fetched: true },
      { max: 2, redirects: 3, fetched: false },
    ];
    for (const entry of table) {
      resetStub(stubNodejs);
      stubNodejs.handler = (req, res) => {
        const hop = Number(/\/r(\d+)$/.exec(req.url ?? "")?.[1] ?? "0");
        if (hop < entry.redirects) respond(res, 302, { location: `/docs/latest-v24.x/api/r${hop + 1}` });
        else okHtml(req, res);
      };
      const lookup = makeLookup(DEFAULT_TABLE);
      const attempt = fetchCccResearchSource("https://nodejs.org/docs/latest-v24.x/api/r0", i2Policy({ maxRedirects: entry.max }), depsFor(lookup.lookup));
      if (entry.fetched) {
        const result = await attempt;
        expect(result.citation.redirectChain, `max ${entry.max} redirects ${entry.redirects}`).toHaveLength(entry.redirects);
        expect(stubNodejs.requests).toHaveLength(entry.redirects + 1);
      } else {
        const refusal = await refusalOf(attempt);
        expect(refusal.reason, `max ${entry.max} redirects ${entry.redirects}`).toBe("too-many-redirects");
        expect(stubNodejs.requests).toHaveLength(entry.max + 1);
      }
    }
  });

  it("refuses an http: URL, any other scheme and an unparsable URL as scheme before any DNS lookup or connection; the https twin is fetched", async () => {
    const lookup = makeLookup(DEFAULT_TABLE);
    const refused = [
      "http://nodejs.org/docs/latest-v24.x/api/fs.html", "ftp://nodejs.org/docs/latest-v24.x/api/fs.html", "file:///etc/passwd",
      "javascript:alert(1)", "nodejs.org/docs/latest-v24.x/api/fs.html", "//nodejs.org/docs/latest-v24.x/api/fs.html", "",
    ];
    for (const url of refused) {
      const refusal = await refusalOf(fetchCccResearchSource(url, i2Policy(), depsFor(lookup.lookup)));
      expect(refusal.reason, JSON.stringify(url)).toBe("scheme");
    }
    expect(lookup.calls).toEqual([]);
    expect(network.dials).toEqual([]);
    expect(stubNodejs.connections).toBe(0);

    const twin = await fetchCccResearchSource(API_URL, i2Policy(), depsFor(lookup.lookup));
    expect(twin.citation.status).toBe(200);
    expect(stubNodejs.requests).toHaveLength(1);
  });

  it("matches the allowlist on the exact host and the path prefix: look-alike hosts, ports, userinfo and traversal are refused, normalised spellings of an allowed URL are fetched", async () => {
    const lookup = makeLookup(DEFAULT_TABLE);
    const hostRefused = [
      "https://evil.example.test/docs/latest-v24.x/api/x", "https://nodejs.org.evil.example.test/docs/latest-v24.x/api/x",
      "https://sub.nodejs.org/docs/latest-v24.x/api/x", "https://nodejs.org:8443/docs/latest-v24.x/api/x",
      "https://user:pw@nodejs.org/docs/latest-v24.x/api/x", "https://nodejs.org./docs/latest-v24.x/api/x", "https://127.0.0.1/docs/latest-v24.x/api/x",
    ];
    for (const url of hostRefused) {
      const refusal = await refusalOf(fetchCccResearchSource(url, i2Policy(), depsFor(lookup.lookup)));
      expect(refusal.reason, url).toBe("host-not-allowlisted");
    }
    const pathRefused = [
      "https://nodejs.org/", "https://nodejs.org/docs/latest-v24.x/api", "https://nodejs.org/docs/latest-v22.x/api/fs.html",
      "https://nodejs.org/docs/latest-v24.x/api/../../secret", "https://nodejs.org/docs/latest-v24.x/api/%2e%2e/%2e%2e/secret",
      "https://developer.mozilla.org/en-US/docs/Web/JavaScript", "https://developer.mozilla.org/en-US/docs/Web/CSS/color",
    ];
    for (const url of pathRefused) {
      const refusal = await refusalOf(fetchCccResearchSource(url, i2Policy(), depsFor(lookup.lookup)));
      expect(refusal.reason, url).toBe("path-not-allowlisted");
    }
    expect(lookup.calls).toEqual([]);
    expect(network.dials).toEqual([]);

    // Controls: the query goes to the server, the fragment does not, and the host spelling is normalised before the exact match.
    const withQuery = await fetchCccResearchSource(`${API_URL}?v=1#section`, i2Policy(), depsFor(lookup.lookup));
    expect(withQuery.citation.requestedUrl).toBe(`${API_URL}?v=1#section`);
    expect(withQuery.citation.finalUrl).toBe(`${API_URL}?v=1`);
    const upper = await fetchCccResearchSource("https://NODEJS.ORG/docs/latest-v24.x/api/fs.html", i2Policy(), depsFor(lookup.lookup));
    expect(upper.citation.finalUrl).toBe(API_URL);
    expect(stubNodejs.requests.map((request) => request.url)).toEqual(["/docs/latest-v24.x/api/fs.html?v=1", "/docs/latest-v24.x/api/fs.html"]);
  });

  it("checks the content type before reading the body: other types are refused as mime, the four allowed types are fetched with the header kept verbatim", async () => {
    const lookup = makeLookup(DEFAULT_TABLE);
    const refusedTypes: Array<string | null> = ["application/octet-stream", "image/png", "application/xhtml+xml", "text/css", "text/html-evil", "application/pdf", null];
    for (const type of refusedTypes) {
      resetStub(stubNodejs);
      stubNodejs.handler = (_req, res) => respond(res, 200, type === null ? {} : { "content-type": type }, "payload");
      const refusal = await refusalOf(fetchCccResearchSource(API_URL, i2Policy(), depsFor(lookup.lookup)));
      expect(refusal.reason, String(type)).toBe("mime");
    }
    const accepted = ["text/html; charset=utf-8", "text/plain", "text/markdown", "application/json; charset=UTF-8", "TEXT/PLAIN"];
    for (const type of accepted) {
      resetStub(stubNodejs);
      stubNodejs.handler = (_req, res) => respond(res, 200, { "content-type": type }, "{\"ok\":true}");
      const result = await fetchCccResearchSource(API_URL, i2Policy(), depsFor(lookup.lookup));
      expect(result.citation.contentType).toBe(type);
    }
    // A policy that allows only text/plain turns the same text/html fixture into a mime refusal.
    resetStub(stubNodejs);
    const narrow = await refusalOf(fetchCccResearchSource(API_URL, i2Policy({ mimeTypes: ["text/plain"] }), depsFor(lookup.lookup)));
    expect(narrow.reason).toBe("mime");
  });

  it("treats an HTTP error status and an unexpected Content-Encoding as failures that are not refusals, and a clean 200 twin is fetched", async () => {
    const lookup = makeLookup(DEFAULT_TABLE);
    for (const status of [404, 500, 304]) {
      resetStub(stubNodejs);
      stubNodejs.handler = (_req, res) => respond(res, status, { "content-type": "text/html" }, "nope");
      const failure = await failureOf(fetchCccResearchSource(API_URL, i2Policy(), depsFor(lookup.lookup)));
      expect(failure).not.toBeInstanceOf(CccResearchFetchRefusedError);
      expect(failure.message).toContain(String(status));
    }
    resetStub(stubNodejs);
    stubNodejs.handler = (_req, res) => respond(res, 200, { "content-type": "text/html", "content-encoding": "gzip" }, "not really gzip");
    const encoded = await failureOf(fetchCccResearchSource(API_URL, i2Policy(), depsFor(lookup.lookup)));
    expect(encoded).not.toBeInstanceOf(CccResearchFetchRefusedError);
    expect(encoded.message).toContain("Content-Encoding");
    resetStub(stubNodejs);
    stubNodejs.handler = (_req, res) => respond(res, 200, { "content-type": "text/html", "content-encoding": "identity" }, "plain");
    expect((await fetchCccResearchSource(API_URL, i2Policy(), depsFor(lookup.lookup))).citation.status).toBe(200);
  });

  it("times out as timeout when the server never answers and rethrows an external abort as itself; a signal that is already aborted does no lookup", async () => {
    const lookup = makeLookup(DEFAULT_TABLE);
    stubNodejs.handler = () => {};
    const refusal = await refusalOf(fetchCccResearchSource(API_URL, i2Policy({ timeoutMs: 150 }), depsFor(lookup.lookup)));
    expect(refusal.reason).toBe("timeout");
    expect(stubNodejs.requests).toHaveLength(1);

    resetStub(stubNodejs);
    stubNodejs.handler = () => {};
    const controller = new AbortController();
    const pending = fetchCccResearchSource(API_URL, i2Policy(), depsFor(lookup.lookup, controller.signal));
    setTimeout(() => controller.abort(), 100);
    const aborted = await failureOf(pending);
    expect(aborted).not.toBeInstanceOf(CccResearchFetchRefusedError);
    expect(aborted.name).toBe("AbortError");

    const before = lookup.calls.length;
    const early = new AbortController();
    early.abort();
    const never = await failureOf(fetchCccResearchSource(API_URL, i2Policy(), depsFor(lookup.lookup, early.signal)));
    expect(never.name).toBe("AbortError");
    expect(lookup.calls.length).toBe(before);
  });

  it("streams the raw-byte cap: a 10 MiB body under a 64 KiB cap is cut near the cap with truncated true, while an uncapped client drains all 10 MiB", async () => {
    // Control: the same server and route, read to the end by a client with no cap, writes the whole 10 MiB.
    stubNodejs.handler = streamBody(TEN_MIB);
    const drained = { count: 0 };
    expect(await dialThroughNetwork("nodejs.org", PUBLIC_NODEJS, drained)).toBe(200);
    await stubNodejs.lastClosed;
    expect(drained.count).toBe(TEN_MIB);
    expect(stubNodejs.bytesWritten).toBe(TEN_MIB);
    resetStub(stubNodejs);
    network.dials = [];

    const sockets: tls.TLSSocket[] = [];
    const connectSpy = vi.mocked(tls.connect);
    const wrapped = connectSpy.getMockImplementation() as (...rest: unknown[]) => tls.TLSSocket;
    connectSpy.mockImplementation(((...rest: unknown[]) => {
      const socket = wrapped(...rest);
      sockets.push(socket);
      return socket;
    }) as never);

    stubNodejs.handler = streamBody(TEN_MIB);
    const cap = 64 * 1024;
    const lookup = makeLookup(DEFAULT_TABLE);
    const result = await fetchCccResearchSource(API_URL, i2Policy({ maxRawBytesPerFetch: cap }), depsFor(lookup.lookup));
    await stubNodejs.lastClosed;
    expect(result.citation.truncated).toBe(true);
    expect(result.citation.rawBytes).toBe(cap);
    expect(result.raw.byteLength).toBe(cap);
    expect(result.citation.rawSha256).toBe(sha256Hex(Buffer.alloc(cap, 0x61)));
    expect(sockets).toHaveLength(1);
    // Received by the client: the cap plus what one or two reads can carry, nowhere near 10 MiB.
    expect(sockets[0]!.bytesRead).toBeLessThanOrEqual(cap + 512 * 1024);
    // Sent by the server before the client closed the socket.
    expect(stubNodejs.bytesWritten).toBeLessThan(TEN_MIB / 2);
  });

  it("sends exactly the fixed header set and never reads a proxy, cookie jar or Authorization from the environment", async () => {
    const proxy = net.createServer((socket) => {
      proxyConnections.count += 1;
      socket.destroy();
    });
    const proxyConnections = { count: 0 };
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      scratch.dir = mkdtempSync(path.join(tmpdir(), "ccc-research-env-"));
      const jar = path.join(scratch.dir, "cookies.txt");
      writeFileSync(jar, "nodejs.org\tFALSE\t/\tTRUE\t0\tsession\tnot-a-real-session\n");
      vi.stubEnv("HTTPS_PROXY", proxyUrl);
      vi.stubEnv("https_proxy", proxyUrl);
      vi.stubEnv("ALL_PROXY", proxyUrl);
      vi.stubEnv("NODE_USE_ENV_PROXY", "1");
      vi.stubEnv("COOKIE_JAR_FILE", jar);
      vi.stubEnv("AUTHORIZATION", "Bearer ccc-test-placeholder-not-a-credential");

      const result = await fetchCccResearchSource(API_URL, i2Policy(), depsFor(makeLookup(DEFAULT_TABLE).lookup));
      expect(result.citation.status).toBe(200);
      expect(stubNodejs.requests).toHaveLength(1);
      const request = stubNodejs.requests[0]!;
      expect([...request.headerNames].sort()).toEqual(["accept", "accept-encoding", "connection", "host", "user-agent"]);
      expect(request.headers["accept-encoding"]).toBe("identity");
      expect(request.headers.host).toBe("nodejs.org");
      expect(request.headers.connection).toBe("close");
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers["proxy-authorization"]).toBeUndefined();
      expect(proxyConnections.count).toBe(0);

      // Non-vacuity: the environment values are present and the proxy listener counts a client that honours them.
      expect(process.env.HTTPS_PROXY).toBe(proxyUrl);
      expect(process.env.AUTHORIZATION).toContain("Bearer");
      const viaProxy = net.connect(Number(new URL(String(process.env.HTTPS_PROXY)).port), LOOPBACK);
      await new Promise<void>((resolve) => viaProxy.once("close", () => resolve()));
      expect(proxyConnections.count).toBe(1);
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("keeps default certificate verification on: an untrusted stub certificate fails the fetch before any request, and the twin with the CA injected is fetched", async () => {
    network.trustCa = false;
    const lookup = makeLookup(DEFAULT_TABLE);
    const failure = await failureOf(fetchCccResearchSource(API_URL, i2Policy(), depsFor(lookup.lookup)));
    expect(failure).not.toBeInstanceOf(CccResearchFetchRefusedError);
    expect((failure as Error & { code?: string }).code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    expect(stubNodejs.requests).toHaveLength(0);
    expect(stubNodejs.connections).toBe(1);

    network.trustCa = true;
    const twin = await fetchCccResearchSource(API_URL, i2Policy(), depsFor(lookup.lookup));
    expect(twin.citation.status).toBe(200);
    expect(stubNodejs.requests).toHaveLength(1);
  });

  it("hashes the exact server bytes and derives the citation id from them; the extracted text differs from the bytes and is bounded to 64 KiB without splitting a character", async () => {
    const html = "﻿<!doctype html>\r\n<html><head><title>T &amp; U</title><script>var secret = '<b>';</script><style>p{color:red}</style></head>"
      + "<body><nav>menu</nav><main><p>café &lt;ok&gt;&nbsp;done &#x263A; &#9731;</p><!-- hidden --></main></body></html>\r\n";
    const serverBytes = Buffer.from(html, "utf8");
    stubNodejs.handler = (_req, res) => respond(res, 200, { "content-type": "text/html; charset=utf-8" }, serverBytes);
    const result = await fetchCccResearchSource(API_URL, i2Policy(), depsFor(makeLookup(DEFAULT_TABLE).lookup));
    const citation = result.citation;
    expect(citation.rawSha256).toBe(sha256Hex(serverBytes));
    expect(Buffer.from(result.raw).equals(serverBytes)).toBe(true);
    expect(citation.rawBytes).toBe(serverBytes.byteLength);
    expect(citation.truncated).toBe(false);
    expect(citation.status).toBe(200);
    expect(citation.requestedUrl).toBe(API_URL);
    expect(citation.finalUrl).toBe(API_URL);
    expect(citation.redirectChain).toEqual([]);
    expect(citation.resolvedAddress).toBe(PUBLIC_NODEJS);
    expect(citation.contentType).toBe("text/html; charset=utf-8");
    expect(citation.retrievedAt).toBe(FIXED_NOW.toISOString());
    expect(citation.policySha256).toBe(cccPlanningSourcePolicySha256());
    const expectedId = sha256Hex(canonicalCccPrdJson({
      requestedUrl: citation.requestedUrl, finalUrl: citation.finalUrl, rawSha256: citation.rawSha256, retrievedAt: citation.retrievedAt,
    })).slice(0, 32);
    expect(citation.citationId).toBe(expectedId);
    expect(citation.citationId).toMatch(/^[0-9a-f]{32}$/);

    // Non-vacuity: extraction alters the bytes, so hashing the extracted text would not give the digest.
    expect(result.text).toContain("T & U");
    expect(result.text).toContain("café <ok>");
    expect(result.text).toContain("☺");
    expect(result.text).not.toContain("secret");
    expect(result.text).not.toContain("hidden");
    expect(result.text).not.toContain("color:red");
    expect(result.text).not.toMatch(/<\/?(p|main|nav|body|html|head|title|script|style)\b/);
    expect(sha256Hex(result.text)).not.toBe(citation.rawSha256);

    // The bound: a 200 KiB body of three-byte characters is cut at 65536 bytes inside a character, and the cut backs off to a boundary.
    const euro = "€".repeat(70_000);
    stubNodejs.handler = (_req, res) => respond(res, 200, { "content-type": "text/plain; charset=utf-8" }, Buffer.from(euro, "utf8"));
    const big = await fetchCccResearchSource(API_URL, i2Policy(), depsFor(makeLookup(DEFAULT_TABLE).lookup));
    expect(big.citation.rawBytes).toBe(210_000);
    expect(big.citation.truncated).toBe(false);
    expect(Buffer.byteLength(big.text, "utf8")).toBeLessThanOrEqual(65_536);
    expect(Buffer.byteLength(big.text, "utf8")).toBeGreaterThan(65_536 - 4);
    expect(big.text).not.toContain("�");
    expect(euro.startsWith(big.text)).toBe(true);
  });

  it("refuses a malformed source policy before any lookup, and the same fetch under a sound policy succeeds", async () => {
    const lookup = makeLookup(DEFAULT_TABLE);
    const bad: Array<Partial<CccResearchSourcePolicy>> = [
      { allow: [{ host: "nodejs.org", pathPrefix: "" }] },
      { allow: [{ host: "nodejs.org", pathPrefix: "docs/" }] },
      { allow: [{ host: "Nodejs.org", pathPrefix: "/docs/" }] },
      { allow: [{ host: "nodejs.org:443", pathPrefix: "/docs/" }] },
      { allow: [{ host: "*.nodejs.org", pathPrefix: "/docs/" }] },
      { maxRawBytesPerFetch: 0 },
      { timeoutMs: Number.NaN },
      { maxRedirects: 4 as unknown as 3 },
      { mimeTypes: ["image/png"] as unknown as CccResearchSourcePolicy["mimeTypes"] },
      { mimeTypes: [] },
    ];
    for (const override of bad) {
      const failure = await failureOf(fetchCccResearchSource(API_URL, i2Policy(override), depsFor(lookup.lookup)));
      expect(failure).not.toBeInstanceOf(CccResearchFetchRefusedError);
      expect(failure.message, JSON.stringify(override)).toContain("source policy");
    }
    expect(lookup.calls).toEqual([]);
    expect((await fetchCccResearchSource(API_URL, i2Policy(), depsFor(lookup.lookup))).citation.status).toBe(200);
  });
});

// ================================================================ the tools

describe("ccc research fetch tools", () => {
  it("allows the 24th fetch of a run and refuses the 25th as grant-exhausted before any lookup, dial or request; a 9th fetch of one node attempt is refused the same way", async () => {
    const mirror = createL1MirrorGrantPort();
    const lookup = makeLookup(DEFAULT_TABLE);
    vi.spyOn(dns.promises, "lookup").mockImplementation(lookup.lookup as never);
    const { storeCitation } = makeStore();
    const tools = [1, 2, 3, 4].map((leaf) => fetchToolFor(mirror.port, storeCitation, i2Policy(), `research:leaf-${leaf}`));

    let last: ToolResult | null = null;
    for (let node = 0; node < 3; node += 1) {
      for (let call = 0; call < 8; call += 1) last = await runTool(tools[node]!, { url: API_URL });
      if (node === 0) {
        const ninth = await refusalOf(runTool(tools[0]!, { url: API_URL }));
        expect(ninth.reason).toBe("grant-exhausted");
        expect(stubNodejs.requests).toHaveLength(8);
      }
    }
    // Positive control: the 24th fetch is allowed and really reached the server.
    expect(textOf(last!)).toContain("citationId=");
    expect(stubNodejs.requests).toHaveLength(24);
    expect(mirror.state().fetchSpent).toBe(24);

    const lookupsBefore = lookup.calls.length;
    const dialsBefore = network.dials.length;
    const connectionsBefore = stubNodejs.connections;
    const refusal = await refusalOf(runTool(tools[3]!, { url: API_URL }));
    expect(refusal.reason).toBe("grant-exhausted");
    expect(refusal.cause).toBeInstanceOf(CccPlanningRefusal);
    expect((refusal.cause as CccPlanningRefusal).code).toBe("CCC_PLANNING_RESEARCH_GRANT_EXHAUSTED");
    expect(stubNodejs.requests).toHaveLength(24);
    expect(stubNodejs.connections).toBe(connectionsBefore);
    expect(lookup.calls.length).toBe(lookupsBefore);
    expect(network.dials.length).toBe(dialsBefore);
    expect(mirror.state().fetchSpent).toBe(24);
    expect(mirror.settled).toHaveLength(24);
  });

  it("reserves the grant before any DNS, dial or request and settles after them; an exhausted grant leaves the server at 0 requests and the open-grant twin at 1", async () => {
    const events: string[] = [];
    const lookup = makeLookup(DEFAULT_TABLE);
    vi.spyOn(dns.promises, "lookup").mockImplementation((async (host: string, options?: { all?: boolean }) => {
      events.push("lookup");
      return lookup.lookup(host, options as never);
    }) as never);
    const realDial = vi.mocked(tls.connect).getMockImplementation() as (...rest: unknown[]) => tls.TLSSocket;
    vi.mocked(tls.connect).mockImplementation(((...rest: unknown[]) => {
      events.push("dial");
      return realDial(...rest);
    }) as never);
    const { storeCitation } = makeStore();

    const closed: CccResearchGrantPort = {
      reserve: async () => {
        events.push("reserve-refused");
        throw exhausted("closed for the test");
      },
      settle: async () => {
        events.push("settle");
      },
    };
    const refusal = await refusalOf(runTool(fetchToolFor(closed, storeCitation), { url: API_URL }));
    expect(refusal.reason).toBe("grant-exhausted");
    expect(events).toEqual(["reserve-refused"]);
    expect(stubNodejs.connections).toBe(0);
    expect(stubNodejs.requests).toHaveLength(0);

    events.length = 0;
    const open: CccResearchGrantPort = {
      reserve: async () => {
        events.push("reserve");
        return { grantKey: `${RUN_ID}:f1` };
      },
      settle: async () => {
        events.push("settle");
      },
    };
    const result = await runTool(fetchToolFor(open, storeCitation), { url: API_URL });
    expect(textOf(result)).toContain("citationId=");
    expect(events).toEqual(["reserve", "lookup", "dial", "settle"]);
    expect(stubNodejs.requests).toHaveLength(1);
  });

  it("reserves with the policy's per-fetch cap and settles exactly once with the bytes read and fetched, refused or failed, even when the store or the settlement throws", async () => {
    const lookup = makeLookup(DEFAULT_TABLE);
    vi.spyOn(dns.promises, "lookup").mockImplementation(lookup.lookup as never);
    const { storeCitation } = makeStore();
    const mirror = createL1MirrorGrantPort();
    const tool = fetchToolFor(mirror.port, storeCitation, i2Policy({ maxRawBytesPerFetch: 4096 }));
    const settledOf = () => mirror.settled.map(({ outcome, rawBytes }) => ({ outcome, rawBytes }));

    // fetched: the bytes actually read.
    stubNodejs.handler = (_req, res) => respond(res, 200, { "content-type": "text/plain" }, "x".repeat(1234));
    await runTool(tool, { url: API_URL });
    expect(mirror.reserved[0]).toEqual({ runId: RUN_ID, nodeId: "researcher", nodeAttempt: 1, maxRawBytes: 4096 });
    // fetched and truncated: exactly the cap.
    stubNodejs.handler = (_req, res) => respond(res, 200, { "content-type": "text/plain" }, "y".repeat(9000));
    await runTool(tool, { url: API_URL });
    // refused before I/O (host), refused after the headers (mime): no body bytes.
    await refusalOf(runTool(tool, { url: "https://evil.example.test/docs/latest-v24.x/api/x" }));
    stubNodejs.handler = (_req, res) => respond(res, 200, { "content-type": "image/png" }, "z".repeat(3000));
    await refusalOf(runTool(tool, { url: API_URL }));
    // a timeout is a failure, not a refusal of the grant.
    stubNodejs.handler = () => {};
    const slow = fetchToolFor(mirror.port, storeCitation, i2Policy({ timeoutMs: 150 }));
    expect((await refusalOf(runTool(slow, { url: API_URL }))).reason).toBe("timeout");
    // an HTTP error is a failure.
    stubNodejs.handler = (_req, res) => respond(res, 404, { "content-type": "text/plain" }, "gone");
    await failureOf(runTool(tool, { url: API_URL }));
    // a body cut short keeps the bytes that did arrive.
    stubNodejs.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "10000" });
      res.write(Buffer.alloc(3000, 0x62), () => res.socket?.end());
    };
    await failureOf(runTool(tool, { url: API_URL }));
    expect(settledOf()).toEqual([
      { outcome: "fetched", rawBytes: 1234 },
      { outcome: "fetched", rawBytes: 4096 },
      { outcome: "refused", rawBytes: 0 },
      { outcome: "refused", rawBytes: 0 },
      { outcome: "failed", rawBytes: 0 },
      { outcome: "failed", rawBytes: 0 },
      { outcome: "failed", rawBytes: 3000 },
    ]);
    expect(mirror.reserved).toHaveLength(7);

    // A store that throws after a good fetch fails the call, keeps the bytes in the settlement and surfaces the store's error.
    stubNodejs.handler = (_req, res) => respond(res, 200, { "content-type": "text/plain" }, "w".repeat(500));
    const storeError = new Error("store is down");
    const failingStore = fetchToolFor(mirror.port, async () => { throw storeError; }, i2Policy());
    expect(await failureOf(runTool(failingStore, { url: API_URL }))).toBe(storeError);
    expect(settledOf().at(-1)).toEqual({ outcome: "failed", rawBytes: 500 });

    // A settlement that throws does not hide the fetch's own error, and does surface after a good fetch.
    const brokenSettle: CccResearchGrantPort = {
      reserve: async () => ({ grantKey: `${RUN_ID}:f9` }),
      settle: async () => { throw new Error("settle is down"); },
    };
    const original = await refusalOf(runTool(fetchToolFor(brokenSettle, storeCitation), { url: "http://nodejs.org/docs/latest-v24.x/api/fs.html" }));
    expect(original.reason).toBe("scheme");
    expect((await failureOf(runTool(fetchToolFor(brokenSettle, storeCitation), { url: API_URL }))).message).toBe("settle is down");
  });

  it("passes every other grant error through unchanged and maps only the exhausted grant to grant-exhausted, never touching the network", async () => {
    const { storeCitation } = makeStore();
    const control = new CccPlanningRefusal("CCC_PLANNING_CONTROL_PENDING", "run has a pending cancel");
    const deadline = new CccPlanningRefusal("CCC_PLANNING_DEADLINE", "deadline is within the launch headroom");
    const plain = new Error("database unreachable");
    const already = new CccResearchFetchRefusedError("grant-exhausted", "refused upstream");
    for (const error of [control, deadline, plain, already]) {
      const port: CccResearchGrantPort = { reserve: async () => { throw error; }, settle: async () => { throw new Error("must not settle"); } };
      expect(await failureOf(runTool(fetchToolFor(port, storeCitation), { url: API_URL }))).toBe(error);
    }
    expect(stubNodejs.connections).toBe(0);
    expect(network.dials).toEqual([]);

    // L1's exhaustion code is the one this mapping reads: pin it against the real reserve function and the fake's constants.
    expect(reserveCccPlanningResearchFetch.toString()).toContain("CCC_PLANNING_RESEARCH_GRANT_EXHAUSTED");
    expect(settleCccPlanningResearchFetch.length).toBe(2);
    expect(CCC_PLANNING_SOURCE_POLICY_I2.maxFetchesPerRun).toBe(24);
    expect(CCC_PLANNING_SOURCE_POLICY_I2.maxFetchesPerNode).toBe(8);
    expect(CCC_PLANNING_SOURCE_POLICY_I2.maxRawBytesPerFetch).toBe(1_048_576);
  });

  it("offers ccc_research_fetch and ccc_citation_read under the names of the researcher toolset, stores the citation before returning it, and reports the citation id and bounded text", async () => {
    const lookup = makeLookup(DEFAULT_TABLE);
    vi.spyOn(dns.promises, "lookup").mockImplementation(lookup.lookup as never);
    const { storeCitation, store, order } = makeStore();
    const mirror = createL1MirrorGrantPort();
    const fetchTool = fetchToolFor(mirror.port, async (citation, raw) => {
      order.push("store-begin");
      await storeCitation(citation, raw);
    });
    const readTool = createCccCitationReadTool({ load: async (id) => store.get(id)! });
    expect(fetchTool.name).toBe("ccc_research_fetch");
    expect(readTool.name).toBe("ccc_citation_read");
    expect(CCC_PLANNING_TOOLSETS.researcher).toContain(fetchTool.name);
    expect(CCC_PLANNING_TOOLSETS.researcher).toContain(readTool.name);
    expect(JSON.stringify(fetchTool.parameters)).toContain("\"url\"");
    expect(JSON.stringify(readTool.parameters)).toContain("\"citationId\"");

    const result = await runTool(fetchTool, { url: API_URL });
    const stored = [...store.values()];
    expect(stored).toHaveLength(1);
    const citation = stored[0]!.citation;
    expect(order[0]).toBe("store-begin");
    expect(textOf(result)).toContain(`citationId=${citation.citationId}`);
    expect(textOf(result)).toContain(`rawSha256=${citation.rawSha256}`);
    expect(textOf(result)).toContain("ok");
    expect(result.details?.citation).toEqual(citation);
    expect(result.details?.textTruncated).toBe(false);

    // A page whose text is over 64 KiB is reported as cut, and the citation still holds every raw byte.
    stubNodejs.handler = (_req, res) => respond(res, 200, { "content-type": "text/plain" }, "t".repeat(100_000));
    const long = await runTool(fetchTool, { url: API_URL });
    expect(long.details?.textTruncated).toBe(true);
    expect((long.details?.citation as CccResearchCitation).rawBytes).toBe(100_000);
    expect(textOf(long).length).toBeLessThan(65_536 + 1_000);
  });

  it("serves the stored bytes unchanged to the verifier: the fetch tool's citation is read back byte for byte, and a tampered, mislabelled or malformed request is refused", async () => {
    const lookup = makeLookup(DEFAULT_TABLE);
    vi.spyOn(dns.promises, "lookup").mockImplementation(lookup.lookup as never);
    const { storeCitation, store } = makeStore();
    const body = Buffer.from("﻿<html><script>x</script><p>café &amp; tea</p></html>\r\n", "utf8");
    stubNodejs.handler = (_req, res) => respond(res, 200, { "content-type": "text/html" }, body);
    const fetchTool = fetchToolFor(createL1MirrorGrantPort().port, storeCitation);
    const fetched = await runTool(fetchTool, { url: API_URL });
    expect(store.size).toBe(1);
    const citation = [...store.values()][0]!.citation;
    expect(textOf(fetched)).not.toBe(body.toString("utf8"));

    const loads: string[] = [];
    const readTool = createCccCitationReadTool({ load: async (id) => { loads.push(id); return store.get(id)!; } });
    const served = await runTool(readTool, { citationId: citation.citationId });
    expect(Buffer.from(textOf(served), "utf8").equals(body)).toBe(true);
    expect(sha256Hex(Buffer.from(textOf(served), "utf8"))).toBe(citation.rawSha256);
    expect(served.details?.citation).toEqual(citation);
    expect(loads).toEqual([citation.citationId]);

    const tampered = createCccCitationReadTool({ load: async () => ({ citation, raw: Buffer.from("tampered bytes") }) });
    expect((await failureOf(runTool(tampered, { citationId: citation.citationId }))).message).toContain("digest");
    const mislabelled = createCccCitationReadTool({ load: async () => ({ citation: { ...citation, citationId: "f".repeat(32) }, raw: body }) });
    expect((await failureOf(runTool(mislabelled, { citationId: citation.citationId }))).message).toContain("citation id");
    const missing = new Error("no such citation");
    const absent = createCccCitationReadTool({ load: async () => { throw missing; } });
    expect(await failureOf(runTool(absent, { citationId: "a".repeat(32) }))).toBe(missing);
    for (const bad of ["../etc/passwd", "a".repeat(31), "A".repeat(32), "g".repeat(32), "", "a".repeat(33)]) {
      expect((await failureOf(runTool(readTool, { citationId: bad }))).message, JSON.stringify(bad)).toContain("32 lowercase hex");
    }
    expect(loads).toEqual([citation.citationId]);
  });
});
