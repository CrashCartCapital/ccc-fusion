/*
FNXC:CccPlanningProofInventory 2026-10-15-00:44:
Proof inventory for request-to-code v3 card C5 (controller-side HTTPS research fetch: allowlisted https hosts with DNS address blocking and pinning, manual redirects with a re-check per hop, a streamed raw-byte cap, one overall timeout, a citation id over the exact bytes, and the ccc_research_fetch and ccc_citation_read tools; CONTRACT-v3.5 section 2.14, D28, ADR C Q4). Card C5 owns exactly this module; the inventory index (card P0) loads every cards/*.mjs in sorted order and rejects duplicate command ids.

TARGETED is file-closed over the card's one check file. OFFLINE is name-closed over the same file: the names below are exactly its tests, built the way `assertionName` in `scripts/run-ccc-pg-proof.mjs` builds them (ancestor titles and the title joined by " > "), so a skipped, renamed, missing or extra test fails the command instead of passing quietly. The engine command is pinned to `engine-default`, whose aliases point @fusion/core at source, so no build runs. The file needs no PostgreSQL (`needsPostgres` is false) and opens no connection outside the loopback interface: a spy on `tls.connect` routes every dial to a local TLS stub on port 0 whose certificate is built in memory, and `dns.lookup` is injected or spied, so there is no real egress and the offline network guard has nothing to report. Nothing in it is platform specific, so `platform` is any. The names stay ASCII so they compare byte for byte.

Measured on the M5 Max with other agents running suites (1 minute load average 9.1): 25 tests, 0 failed, 0 skipped, 3.2 to 4.0 s wall for the whole Vitest command and 2.6 to 3.3 s of Vitest time (about 0.6 to 0.7 s in the tests themselves) over three runs. The 120 s command timeout is a hang bound at about 30 times the slowest wall; no test timeout is raised anywhere.
*/

const FILE = "src/__tests__/ccc-research-fetch.test.ts";
const BLOCKLIST = "ccc research address blocklist";
const SOURCE = "ccc research fetch source";
const TOOLS = "ccc research fetch tools";

const COMMAND = Object.freeze({
  packageFilter: "@fusion/engine",
  project: "engine-default",
  config: null,
  files: Object.freeze([FILE]),
  platform: "any",
  needsPostgres: false,
  timeoutMs: 120_000,
});

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const TARGETED = Object.freeze([
  Object.freeze({ id: "c5-research-fetch", ...COMMAND, closure: "files", expectedNames: Object.freeze([]) }),
]);

/** @type {readonly import("../../ccc-closed-vitest-results.mjs").ClosedSuiteCommand[]} */
export const OFFLINE = Object.freeze([
  Object.freeze({
    id: "c5-research-fetch-names",
    ...COMMAND,
    closure: "names",
    expectedNames: Object.freeze([
      `${BLOCKLIST} > refuses 198.18.0.1, 224.0.0.1, 240.0.0.1, ::, ff02::1, 64:ff9b::7f00:1 and ::ffff:7f00:1, each of which the legacy web-fetch check accepts`,
      `${BLOCKLIST} > covers loopback, link-local, private, CGNAT, multicast, TEST-NET and IPv6 forms and passes the public twin at every range boundary`,
      `${BLOCKLIST} > refuses what it cannot parse, so an unknown spelling is never admitted`,
      `${SOURCE} > refuses an allowlisted host whose injected DNS answer is 127.0.0.1 as blocked-address while a live loopback listener sees 0 connections; the twin with a public answer is fetched`,
      `${SOURCE} > refuses the whole lookup when any one answer is blocked and pins the first address of an all-public answer set, IPv6 included`,
      `${SOURCE} > pins the first DNS answer for the connection, so a rebinding second answer of 127.0.0.1 never reaches the loopback listener`,
      `${SOURCE} > refuses a redirect to a non-allowlisted host and the second server sees 0 requests; the twins that redirect to an allowlisted host and an allowlisted path are followed`,
      `${SOURCE} > re-checks every redirect hop: a non-allowlisted path, an http: target, a missing Location and an allowlisted host that now resolves to loopback are all refused`,
      `${SOURCE} > follows at most maxRedirects redirects and refuses the next one as too-many-redirects without a further request`,
      `${SOURCE} > refuses an http: URL, any other scheme and an unparsable URL as scheme before any DNS lookup or connection; the https twin is fetched`,
      `${SOURCE} > matches the allowlist on the exact host and the path prefix: look-alike hosts, ports, userinfo and traversal are refused, normalised spellings of an allowed URL are fetched`,
      `${SOURCE} > checks the content type before reading the body: other types are refused as mime, the four allowed types are fetched with the header kept verbatim`,
      `${SOURCE} > treats an HTTP error status and an unexpected Content-Encoding as failures that are not refusals, and a clean 200 twin is fetched`,
      `${SOURCE} > times out as timeout when the server never answers and rethrows an external abort as itself; a signal that is already aborted does no lookup`,
      `${SOURCE} > streams the raw-byte cap: a 10 MiB body under a 64 KiB cap is cut near the cap with truncated true, while an uncapped client drains all 10 MiB`,
      `${SOURCE} > sends exactly the fixed header set and never reads a proxy, cookie jar or Authorization from the environment`,
      `${SOURCE} > keeps default certificate verification on: an untrusted stub certificate fails the fetch before any request, and the twin with the CA injected is fetched`,
      `${SOURCE} > hashes the exact server bytes and derives the citation id from them; the extracted text differs from the bytes and is bounded to 64 KiB without splitting a character`,
      `${SOURCE} > refuses a malformed source policy before any lookup, and the same fetch under a sound policy succeeds`,
      `${TOOLS} > allows the 24th fetch of a run and refuses the 25th as grant-exhausted before any lookup, dial or request; a 9th fetch of one node attempt is refused the same way`,
      `${TOOLS} > reserves the grant before any DNS, dial or request and settles after them; an exhausted grant leaves the server at 0 requests and the open-grant twin at 1`,
      `${TOOLS} > reserves with the policy's per-fetch cap and settles exactly once with the bytes read and fetched, refused or failed, even when the store or the settlement throws`,
      `${TOOLS} > passes every other grant error through unchanged and maps only the exhausted grant to grant-exhausted, never touching the network`,
      `${TOOLS} > offers ccc_research_fetch and ccc_citation_read under the names of the researcher toolset, stores the citation before returning it, and reports the citation id and bounded text`,
      `${TOOLS} > serves the stored bytes unchanged to the verifier: the fetch tool's citation is read back byte for byte, and a tampered, mislabelled or malformed request is refused`,
    ]),
  }),
]);
