/*
FNXC:CccResearchFetch 2026-10-15-00:36:
Controller-side research fetch for request-to-code planning (PRD v3, card C5, CONTRACT-v3.5 section 2.14, D28, ADR C Q4). A researcher-class model gets its public-web reading through `ccc_research_fetch`, and the source verifier reads the same bytes back through `ccc_citation_read`. The tool runs in the controller process, outside any command sandbox, so everything the model could aim it at is decided here and nowhere else:
- Only `https:` URLs whose host is exactly an allowlisted host (the URL's own `host`, so a port, a trailing dot, a sub-domain or userinfo never matches) and whose path starts with an allowlisted prefix for that host. There are no wildcards in I2.
- Every hop (the first URL and each redirect) is resolved with the injected `lookup` as `{ all: true }`. Any one blocked answer (`address-blocklist.ts`) refuses the hop, and the first answer is then pinned for the connection through the `lookup` option of `https.request`, so a second, different DNS answer can never be used. The pin answers synchronously, from the address that was just checked.
- Redirects are followed by hand, at most `policy.maxRedirects`, each target re-checked against the allowlist and re-resolved. Headers are fixed (`User-Agent`, `Accept`, `Accept-Encoding: identity`), `agent: false`, no cookies, no `Authorization`, no proxy environment, default CA verification, TLS 1.2 or newer.
- The content type is checked before the body is read. The body streams under the raw-byte cap (`policy.maxRawBytesPerFetch`) and is cut when it overflows (`truncated: true`); one overall timeout covers DNS, every hop and the body.
- The citation records the exact raw bytes' sha256, never the extracted text's, and the stored bytes are what `ccc_citation_read` serves back.
The grant cap belongs to L1, not to this file: `ccc_research_fetch` reserves through the `CccResearchGrantPort` before any DNS or network I/O and settles in every outcome with the bytes actually read. The per-node and per-run counts, the byte budget and the run state are L1's `reserveCccPlanningResearchFetch` and `settleCccPlanningResearchFetch` (`task-store/ccc-planning-ops.ts`), which the port is bound to together with the node's fence by the caller; the type pin at the end of this file makes the compiler refuse a drift between the two shapes. The only grant error this file translates is L1's `CCC_PLANNING_RESEARCH_GRANT_EXHAUSTED`, which becomes the `grant-exhausted` refusal; a pending control request, a deadline or a database error is passed through unchanged. Citation publication is the injected `storeCitation` port; the stage that owns the artifact (kind `citation`, stage `research`, slot = the first 20 hex characters of the citation id) supplies it.
Outcome classes for the settlement: `fetched`; `refused` for a policy refusal (scheme, host, path, address, redirect, mime); `failed` for everything else, a timeout included.
*/
import { createHash } from "node:crypto";
import dns from "node:dns";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { canonicalCccPrdJson } from "@fusion/core";
import type { CccPlanningWorkItemFence, reserveCccPlanningResearchFetch, settleCccPlanningResearchFetch } from "@fusion/core";
import { isCccResearchAddressBlocked } from "./address-blocklist.js";

export type CccResearchSourcePolicy = Readonly<{
  policyId: string;
  policySha256: string;
  allow: readonly Readonly<{ host: string; pathPrefix: string }>[];   // https only
  maxFetchesPerNode: number;
  maxRawBytesPerFetch: number;
  maxRawBytesPerRun: number;
  timeoutMs: number;
  maxRedirects: 0 | 1 | 2 | 3;
  mimeTypes: readonly ("text/html" | "text/plain" | "text/markdown" | "application/json")[];
}>;

export type CccResearchCitation = Readonly<{
  citationId: string;               // sha256(canonical({requestedUrl, finalUrl, rawSha256, retrievedAt})).slice(0, 32)
  requestedUrl: string;
  finalUrl: string;
  redirectChain: readonly string[];
  resolvedAddress: string;
  status: number;
  contentType: string;
  rawBytes: number;
  rawSha256: string;
  truncated: boolean;
  retrievedAt: string;              // controller clock, ISO
  policySha256: string;
}>;

export interface CccResearchGrantPort {
  reserve(i: Readonly<{ runId: string; nodeId: string; nodeAttempt: number; maxRawBytes: number }>): Promise<Readonly<{ grantKey: string }>>;
  settle(i: Readonly<{ grantKey: string; rawBytes: number; outcome: "fetched" | "refused" | "failed" }>): Promise<void>;
}

export class CccResearchFetchRefusedError extends Error {
  readonly code = "CCC_RESEARCH_FETCH_REFUSED" as const;
  readonly reason: "scheme" | "host-not-allowlisted" | "path-not-allowlisted" | "blocked-address"
    | "redirect-not-allowlisted" | "too-many-redirects" | "mime" | "grant-exhausted" | "timeout";

  constructor(reason: CccResearchFetchRefusedError["reason"], detail: string, options?: { cause?: unknown }) {
    super(`CCC_RESEARCH_FETCH_REFUSED (${reason}): ${detail}`, options);
    this.name = "CccResearchFetchRefusedError";
    this.reason = reason;
  }
}

type RefusalReason = CccResearchFetchRefusedError["reason"];
type LookupFunction = typeof dns.promises.lookup;
type Progress = { rawBytes: number };
type Pinned = Readonly<{ address: string; family: 4 | 6 }>;
type FetchResult = Readonly<{ citation: CccResearchCitation; raw: Uint8Array; text: string; textTruncated: boolean }>;
type FetchDeps = Readonly<{ lookup: LookupFunction; now: () => Date; signal: AbortSignal }>;

const USER_AGENT = "ccc-fusion-research-fetch/1";
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const ALLOWED_MIME_TYPES: readonly string[] = ["text/html", "text/plain", "text/markdown", "application/json"];
const TEXT_MAX_BYTES = 65_536;
const DETAIL_MAX_CHARS = 200;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const CITATION_ID_PATTERN = /^[0-9a-f]{32}$/;

const brief = (value: string): string => (value.length > DETAIL_MAX_CHARS ? `${value.slice(0, DETAIL_MAX_CHARS)}...` : value);
const sha256Hex = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

function refuse(reason: RefusalReason, detail: string): never {
  throw new CccResearchFetchRefusedError(reason, detail);
}

// ---------------------------------------------------------------- policy

function assertPolicy(policy: CccResearchSourcePolicy): void {
  const invalid = (why: string): never => {
    throw new Error(`ccc research source policy is invalid: ${why}`);
  };
  if (!Array.isArray(policy.allow)) invalid("allow must be a list");
  for (const entry of policy.allow) {
    if (typeof entry?.host !== "string" || !HOST_PATTERN.test(entry.host)) invalid(`allow host ${JSON.stringify(entry?.host)} must be a lower-case host name without port or wildcard`);
    if (typeof entry.pathPrefix !== "string" || !entry.pathPrefix.startsWith("/")) invalid(`allow path prefix ${JSON.stringify(entry.pathPrefix)} must start with /`);
  }
  if (!Number.isSafeInteger(policy.maxRawBytesPerFetch) || policy.maxRawBytesPerFetch < 1) invalid("maxRawBytesPerFetch must be a positive integer");
  if (!Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs < 1) invalid("timeoutMs must be a positive integer");
  if (!Number.isInteger(policy.maxRedirects) || policy.maxRedirects < 0 || policy.maxRedirects > 3) invalid("maxRedirects must be 0 to 3");
  if (!Array.isArray(policy.mimeTypes) || policy.mimeTypes.length === 0 || policy.mimeTypes.some((type) => !ALLOWED_MIME_TYPES.includes(type))) {
    invalid("mimeTypes must be a non-empty subset of text/html, text/plain, text/markdown and application/json");
  }
}

// ---------------------------------------------------------------- allowlist

type TargetFailure = Readonly<{ reason: "scheme" | "host-not-allowlisted" | "path-not-allowlisted"; detail: string }>;

/** The allowlist rule for one URL: https only, the exact host, and a path inside a prefix listed for that host. */
function targetFailure(url: URL, policy: CccResearchSourcePolicy): TargetFailure | null {
  if (url.protocol !== "https:") return { reason: "scheme", detail: `${brief(url.protocol)} is not https:` };
  if (url.username !== "" || url.password !== "") return { reason: "host-not-allowlisted", detail: "a URL that carries credentials is never allowlisted" };
  const entries = policy.allow.filter((entry) => entry.host === url.host);
  if (entries.length === 0) return { reason: "host-not-allowlisted", detail: `host ${brief(url.host)} is not on the allowlist` };
  if (!entries.some((entry) => url.pathname.startsWith(entry.pathPrefix))) {
    return { reason: "path-not-allowlisted", detail: `path ${brief(url.pathname)} is outside the allowlisted prefixes of ${url.host}` };
  }
  return null;
}

function initialTarget(rawUrl: string, policy: CccResearchSourcePolicy): URL {
  let url: URL;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return refuse("scheme", `${JSON.stringify(brief(String(rawUrl)))} is not an absolute https: URL`);
  }
  const failure = targetFailure(url, policy);
  if (failure !== null) refuse(failure.reason, failure.detail);
  url.hash = "";
  return url;
}

function redirectTarget(location: string | undefined, from: URL, policy: CccResearchSourcePolicy): URL {
  if (typeof location !== "string" || location === "") refuse("redirect-not-allowlisted", `the redirect from ${brief(from.href)} carries no Location`);
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    return refuse("redirect-not-allowlisted", `the redirect target ${JSON.stringify(brief(location))} is not a URL`);
  }
  const failure = targetFailure(next, policy);
  if (failure !== null) refuse("redirect-not-allowlisted", `redirect to ${brief(next.href)}: ${failure.detail}`);
  next.hash = "";
  return next;
}

// ---------------------------------------------------------------- DNS, pinning and the request

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/** Resolves every answer, refuses the hop when any one is blocked, and pins the first answer. */
async function resolvePinned(hostname: string, lookup: LookupFunction, signal: AbortSignal): Promise<Pinned> {
  const answers = await raceAbort(Promise.resolve(lookup(hostname, { all: true, verbatim: true })), signal);
  if (!Array.isArray(answers) || answers.length === 0) throw new Error(`DNS gave no address for ${brief(hostname)}`);
  for (const answer of answers) {
    const address: unknown = typeof answer === "object" && answer !== null ? (answer as { address?: unknown }).address : undefined;
    if (typeof address !== "string" || isCccResearchAddressBlocked(address)) {
      refuse("blocked-address", `${brief(hostname)} resolves to ${JSON.stringify(brief(String(address)))}, which is not a public address`);
    }
  }
  const address = (answers[0] as { address: string }).address;
  return { address, family: isIP(address) === 6 ? 6 : 4 };
}

/** A `lookup` for one connection: it answers the pinned address, synchronously, for the one host of this hop and nothing else. */
function pinnedLookup(hostname: string, pinned: Pinned) {
  return (requested: string, options: unknown, callback?: unknown): void => {
    const done = (typeof options === "function" ? options : callback) as (...args: unknown[]) => void;
    const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
    if (requested !== hostname) {
      done(Object.assign(new Error(`the pinned lookup for ${hostname} was asked for ${requested}`), { code: "ERR_CCC_RESEARCH_PIN" }));
      return;
    }
    if (all) done(null, [{ address: pinned.address, family: pinned.family }]);
    else done(null, pinned.address, pinned.family);
  };
}

function sendRequest(url: URL, pinned: Pinned, policy: CccResearchSourcePolicy, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    let answered = false;
    const request = httpsRequest({
      method: "GET",
      protocol: "https:",
      host: hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      headers: { "User-Agent": USER_AGENT, Accept: policy.mimeTypes.join(", "), "Accept-Encoding": "identity" },
      agent: false,
      lookup: pinnedLookup(hostname, pinned) as never,
      minVersion: "TLSv1.2",
      signal,
      ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
    }, (response) => {
      answered = true;
      response.on("error", () => {});
      resolve(response);
    });
    request.on("error", (error) => {
      if (!answered) reject(error);
    });
    request.end();
  });
}

/** Reads at most `cap` bytes; on overflow keeps exactly `cap`, destroys the connection and reports `truncated`. */
function readBody(response: IncomingMessage, cap: number, progress: Progress): Promise<Readonly<{ bytes: Buffer; truncated: boolean }>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };
    response.on("data", (chunk: Buffer) => {
      if (settled) return;
      const room = cap - total;
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        total += Math.max(room, 0);
        progress.rawBytes = total;
        finish(() => {
          response.destroy();
          resolve({ bytes: Buffer.concat(chunks), truncated: true });
        });
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
      progress.rawBytes = total;
    });
    response.on("end", () => finish(() => resolve({ bytes: Buffer.concat(chunks), truncated: false })));
    response.on("error", (error) => finish(() => reject(error)));
    response.on("close", () => finish(() => reject(new Error("the research response closed before its body ended"))));
  });
}

// ---------------------------------------------------------------- text extraction

const SKIPPED_ELEMENTS: ReadonlySet<string> = new Set(["script", "style", "noscript", "template", "svg"]);
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tr", "ul",
]);
const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** One linear pass over the markup: drops comments, tags and the contents of script-like elements, and keeps the text. */
function htmlToText(html: string): string {
  const pieces: string[] = [];
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      pieces.push(html.slice(index));
      break;
    }
    if (open > index) pieces.push(html.slice(index, open));
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      index = close === -1 ? html.length : close + 3;
      continue;
    }
    const end = html.indexOf(">", open + 1);
    if (end === -1) break;
    const tag = /^(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(open + 1, Math.min(end, open + 64)));
    index = end + 1;
    if (tag === null) continue;
    const name = tag[2]!.toLowerCase();
    if (tag[1] === "" && SKIPPED_ELEMENTS.has(name)) {
      let cursor = index;
      let resumed = html.length;
      while (cursor < html.length) {
        const candidate = html.indexOf("</", cursor);
        if (candidate === -1) break;
        if (html.slice(candidate + 2, candidate + 2 + name.length).toLowerCase() === name) {
          const closeEnd = html.indexOf(">", candidate);
          resumed = closeEnd === -1 ? html.length : closeEnd + 1;
          break;
        }
        cursor = candidate + 2;
      }
      index = resumed;
      continue;
    }
    if (BLOCK_ELEMENTS.has(name)) pieces.push("\n");
  }
  return pieces.join("");
}

function tidy(text: string): string {
  return text.replace(/[ \t\f\v\r]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Cuts to at most 64 KiB of UTF-8, backing off to a character boundary so a multi-byte character is never split. */
function boundText(text: string): Readonly<{ text: string; textTruncated: boolean }> {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= TEXT_MAX_BYTES) return { text, textTruncated: false };
  let cut = TEXT_MAX_BYTES;
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut -= 1;
  return { text: bytes.subarray(0, cut).toString("utf8"), textTruncated: true };
}

function extractText(mimeType: string, bytes: Buffer): Readonly<{ text: string; textTruncated: boolean }> {
  const raw = bytes.toString("utf8");
  if (mimeType === "text/html") return boundText(tidy(decodeEntities(htmlToText(raw))));
  if (mimeType === "application/json") {
    try {
      return boundText(JSON.stringify(JSON.parse(raw), null, 2));
    } catch {
      return boundText(raw);
    }
  }
  return boundText(raw);
}

// ---------------------------------------------------------------- the fetch

async function runFetch(rawUrl: string, policy: CccResearchSourcePolicy, deps: FetchDeps, progress: Progress): Promise<FetchResult> {
  assertPolicy(policy);
  const timeoutSignal = AbortSignal.timeout(policy.timeoutMs);
  const signal = AbortSignal.any([deps.signal, timeoutSignal]);
  try {
    signal.throwIfAborted();
    let url = initialTarget(rawUrl, policy);
    const redirectChain: string[] = [];
    for (;;) {
      const pinned = await resolvePinned(url.hostname, deps.lookup, signal);
      const response = await sendRequest(url, pinned, policy, signal);
      const status = response.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status)) {
        response.destroy();
        if (redirectChain.length >= policy.maxRedirects) {
          refuse("too-many-redirects", `${brief(rawUrl)} redirected more than ${policy.maxRedirects} times`);
        }
        const next = redirectTarget(response.headers.location, url, policy);
        redirectChain.push(url.href);
        url = next;
        continue;
      }
      if (status < 200 || status > 299) {
        response.destroy();
        throw new Error(`research fetch of ${brief(url.href)} answered HTTP ${status}`);
      }
      const encoding = String(response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
      if (encoding !== "" && encoding !== "identity") {
        response.destroy();
        throw new Error(`research fetch of ${brief(url.href)} answered with Content-Encoding ${JSON.stringify(brief(encoding))}, which was not requested`);
      }
      const contentType = String(response.headers["content-type"] ?? "").trim();
      const mimeType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
      if (!(policy.mimeTypes as readonly string[]).includes(mimeType)) {
        response.destroy();
        refuse("mime", `content type ${JSON.stringify(brief(contentType))} is not on the research list`);
      }
      const { bytes, truncated } = await readBody(response, policy.maxRawBytesPerFetch, progress);
      const retrievedAt = deps.now().toISOString();
      const rawSha256 = sha256Hex(bytes);
      const citationId = sha256Hex(canonicalCccPrdJson({ requestedUrl: rawUrl, finalUrl: url.href, rawSha256, retrievedAt })).slice(0, 32);
      const citation: CccResearchCitation = Object.freeze({
        citationId, requestedUrl: rawUrl, finalUrl: url.href, redirectChain: Object.freeze([...redirectChain]),
        resolvedAddress: pinned.address, status, contentType, rawBytes: bytes.length, rawSha256, truncated, retrievedAt,
        policySha256: policy.policySha256,
      });
      return { citation, raw: new Uint8Array(bytes), ...extractText(mimeType, bytes) };
    }
  } catch (error) {
    if (error instanceof CccResearchFetchRefusedError) throw error;
    if (timeoutSignal.aborted && !deps.signal.aborted) {
      throw new CccResearchFetchRefusedError("timeout", `no complete answer within ${policy.timeoutMs} ms`, { cause: error });
    }
    throw error;
  }
}

export async function fetchCccResearchSource(
  url: string,
  policy: CccResearchSourcePolicy,
  deps: Readonly<{ lookup: typeof import("node:dns").promises.lookup; now: () => Date; signal: AbortSignal }>,
): Promise<Readonly<{ citation: CccResearchCitation; raw: Uint8Array; text: string }>> {
  const { citation, raw, text } = await runFetch(url, policy, deps, { rawBytes: 0 });
  return { citation, raw, text };
}

// ---------------------------------------------------------------- the tools

const defaultLookup = ((host: string, options?: unknown) => dns.promises.lookup(host, options as never)) as LookupFunction;

function settlementOutcome(error: unknown): "refused" | "failed" {
  return error instanceof CccResearchFetchRefusedError && error.reason !== "timeout" ? "refused" : "failed";
}

/** Only L1's exhausted-grant refusal is translated; every other error from the port reaches the caller as it is. */
function grantError(error: unknown): unknown {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "CCC_PLANNING_RESEARCH_GRANT_EXHAUSTED") {
    return new CccResearchFetchRefusedError("grant-exhausted", error instanceof Error ? brief(error.message) : "the research grant is exhausted", { cause: error });
  }
  return error;
}

export function createCccResearchFetchTool(input: Readonly<{
  policy: CccResearchSourcePolicy;
  grant: CccResearchGrantPort;
  storeCitation: (citation: CccResearchCitation, raw: Uint8Array) => Promise<void>;
  runId: string; nodeId: string; nodeAttempt: number;
}>): ToolDefinition {
  const parameters = Type.Object({
    url: Type.String({ description: "The https URL to read. It must be on the research source allowlist." }),
  });
  return {
    name: "ccc_research_fetch",
    label: "Research fetch",
    description: "Fetch one public web page from the research source allowlist. Returns a citation id and the page text (at most 64 KiB). Cite the citation id for every claim that rests on the page.",
    parameters,
    execute: async (_toolCallId: string, params: Static<typeof parameters>, signal?: AbortSignal) => {
      let grantKey: string;
      try {
        ({ grantKey } = await input.grant.reserve({
          runId: input.runId, nodeId: input.nodeId, nodeAttempt: input.nodeAttempt, maxRawBytes: input.policy.maxRawBytesPerFetch,
        }));
      } catch (error) {
        throw grantError(error);
      }
      const progress: Progress = { rawBytes: 0 };
      let outcome: "fetched" | "refused" | "failed" = "failed";
      let failure: { error: unknown } | null = null;
      let fetched: FetchResult | null = null;
      try {
        fetched = await runFetch(params.url, input.policy, { lookup: defaultLookup, now: () => new Date(), signal: signal ?? new AbortController().signal }, progress);
        await input.storeCitation(fetched.citation, fetched.raw);
        outcome = "fetched";
      } catch (error) {
        failure = { error };
        outcome = settlementOutcome(error);
      }
      try {
        await input.grant.settle({ grantKey, rawBytes: Math.min(progress.rawBytes, input.policy.maxRawBytesPerFetch), outcome });
      } catch (settleError) {
        if (failure === null) throw settleError;
      }
      if (failure !== null) throw failure.error;
      const { citation, text, textTruncated } = fetched!;
      const header = `[ccc_research_fetch] citationId=${citation.citationId} url=${citation.finalUrl} status=${citation.status} contentType=${citation.contentType} `
        + `rawBytes=${citation.rawBytes} rawSha256=${citation.rawSha256} truncated=${citation.truncated} retrievedAt=${citation.retrievedAt}`;
      return {
        content: [{ type: "text" as const, text: `${header}\n---\n${text}` }],
        details: { citation, textTruncated },
      };
    },
  };
}

export function createCccCitationReadTool(input: Readonly<{ load: (citationId: string) => Promise<Readonly<{ citation: CccResearchCitation; raw: Uint8Array }>> }>): ToolDefinition {
  const parameters = Type.Object({
    citationId: Type.String({ description: "The 32 lowercase hex characters of a citation id returned by ccc_research_fetch." }),
  });
  return {
    name: "ccc_citation_read",
    label: "Citation read",
    description: "Read back the exact stored bytes of one citation, as UTF-8 text, so a claim can be checked against what was fetched. Nothing is fetched again.",
    parameters,
    execute: async (_toolCallId: string, params: Static<typeof parameters>) => {
      const citationId = params.citationId;
      if (typeof citationId !== "string" || !CITATION_ID_PATTERN.test(citationId)) {
        throw new Error("citationId must be 32 lowercase hex characters");
      }
      const { citation, raw } = await input.load(citationId);
      if (citation.citationId !== citationId) throw new Error(`the store answered citation id ${brief(String(citation.citationId))} for ${citationId}`);
      if (raw.byteLength !== citation.rawBytes || sha256Hex(raw) !== citation.rawSha256) {
        throw new Error(`the stored bytes of citation ${citationId} do not match their recorded digest`);
      }
      const text = Buffer.from(raw).toString("utf8");
      return {
        content: [{ type: "text" as const, text }],
        details: { citation, utf8Exact: Buffer.byteLength(text, "utf8") === raw.byteLength && Buffer.from(text, "utf8").equals(raw) },
      };
    },
  };
}

// ---------------------------------------------------------------- type pin to L1

type MustBeAssignable<From extends To, To> = readonly [From, To];
type L1ReserveInput = Parameters<typeof reserveCccPlanningResearchFetch>[1];
type L1SettleInput = Parameters<typeof settleCccPlanningResearchFetch>[1];
type PortReserve = CccResearchGrantPort["reserve"];
type PortSettle = CccResearchGrantPort["settle"];

/**
 * Compile-time pin: the port is L1's reserve and settle minus the layer and the node's fence. If either side changes shape the
 * engine build fails here, which a vitest file could not catch because the engine tsconfig excludes `__tests__`.
 */
export type CccResearchGrantPortL1Pin = readonly [
  MustBeAssignable<Parameters<PortReserve>[0] & { fence: CccPlanningWorkItemFence }, L1ReserveInput>,
  MustBeAssignable<Omit<L1ReserveInput, "fence">, Parameters<PortReserve>[0]>,
  MustBeAssignable<Awaited<ReturnType<typeof reserveCccPlanningResearchFetch>>, Awaited<ReturnType<PortReserve>>>,
  MustBeAssignable<Awaited<ReturnType<PortReserve>>, Awaited<ReturnType<typeof reserveCccPlanningResearchFetch>>>,
  MustBeAssignable<Parameters<PortSettle>[0], L1SettleInput>,
  MustBeAssignable<L1SettleInput, Parameters<PortSettle>[0]>,
];
