/*
FNXC:CccPlanningInstalledRuntime 2026-10-14-21:13:
Card IP installed lane (CONTRACT-v3.3 section 3.2 IP, section 4.2 step 0, D48, 0.25, challenge 15; errata E9 IP items 2 and 4). PARENT-RUN and NOT in the runner inventory: it builds the CLI package, packs it, and `npm install`s the tarball with `--ignore-scripts` into a scratch root, so it takes minutes, rewrites `packages/cli/package.json` for the duration of `pnpm pack`, and needs either a warm npm cache or a read-only fetch of public packages from the public registry (the section 5 npm ruling). It installs nothing globally, runs no lifecycle script and edits nothing in the installed tree.

Why it is not in `cards/ip.mjs`: the D50 offline network guard wraps every runner mode, so the registry fallback a cold cache needs is refused there (E9 IP item 2). The parent runs it directly, first, at section 4.2 step 0 and again in card LV: `PI_OFFLINE=1 node --test scripts/__tests__/ccc-planning-installed-keepalive.test.mjs`.

The set-up tries the offline cache first (`--offline`) and goes to the registry only when the cache cannot satisfy the install (ENOTCACHED). `CCC_PLANNING_INSTALLED_NPM_MODE=offline` forbids the fallback: the run then fails at set-up with the npm error instead of fetching.

A loopback fake OmniRoute (127.0.0.1, port 0) emits keepalive chunks that carry a placeholder model, then a content chunk and a finish chunk that carry the upstream model, then the trailing route SSE comments and `[DONE]`:
- Arm A drives the sibling bundle `dist/ccc-route-receipt-adapter.js` of the packed install, as the existing publish smoke test does, and must report the true route. It is not the `bin.js` that fn runs: tsup builds with `splitting: false`, so `bin.js` carries its own inlined copy of the adapter and of the D48 provider selection in `pi.ts` and never imports the sibling entry. Arm A therefore exercises neither the code fn runs nor the provider selection, and RED (A) is NOT satisfied by it.
- The fn-path arm of RED (A) (a session whose custom provider equals defaultProvider, receipt adapter `terminal-route-sse-comments.v1`, run through the packed and npm-installed fn) is deferred to card LV (wave W9). The packaged CLI exports no session factory and this card may not add a tsup entry. The third test below checks two strings in `bin.js` and nothing more; the engine tests cover the selection itself.
- Arm B drives the INSTALLED `@earendil-works/pi-ai` `openai-completions` stream directly, the path a route without the adapter would take. With the registry copy (no pnpm patch) it reports the placeholder, which is why the adapter, not the patch, carries the rule. The receipt's `piAi.workspacePatch` is read from the installed file bytes; this test checks that reading against what arm B actually did, in both directions, so a patched registry copy is recorded as `carried` instead of failing.
Arm A passing is only meaningful because arm B shows the placeholder is real; the fourth test pins the static fact the live run relies on (pi-ai ships external and pinned).

Not measured: the section 4.2 step 0 duration (this file was never run by the card: the npm cache lacks the CLI's dependencies and the card may not fetch). Its set-up hook gives up at 3,000,000 ms, which is a hang bound, not a measurement.
*/
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { packAndInstallFusionCli } from "../lib/ccc-installed-cli.mjs";
import {
  classifyCccPiAiWorkspacePatch,
  deriveCccPiAiReceiptBlock,
  parseCccCliNoExternalRules,
} from "../lib/ccc-planning-installed-runtime.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliRoot = path.join(repoRoot, "packages/cli");
const NPM_MODE = process.env.CCC_PLANNING_INSTALLED_NPM_MODE === "offline" ? "offline" : "offline-first";
const PLACEHOLDER_MODEL = "keepalive-placeholder-model";
const UPSTREAM_MODEL_ID = "upstream/true-model";
const ROUTE_PROVIDER = "upstream";
const ROUTE_MODEL = "true-model";
const REQUESTED_MODEL = "requested-model";

/** The one place the real pack and install happens. */
async function installTheRealCli(scratch) {
  const realHome = homedir();
  const corepackHome = process.env.COREPACK_HOME ?? path.join(realHome, ".cache", "node", "corepack");
  return packAndInstallFusionCli({
    root: scratch,
    cliRoot,
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string")),
    npmMode: NPM_MODE,
    toolCaches: {
      npmCache: process.env.npm_config_cache ?? path.join(realHome, ".npm"),
      ...(existsSync(corepackHome) ? { corepackHome } : {}),
    },
  });
}

function sse(chunks, trailer) {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}${trailer}`;
}

async function startFakeOmniRoute() {
  const requests = [];
  const server = createServer((request, response) => {
    const body = [];
    request.on("data", (piece) => body.push(piece));
    request.once("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(Buffer.concat(body).toString("utf8"));
      } catch {
        parsed = null;
      }
      requests.push({ url: request.url, method: request.method, model: parsed?.model ?? null });
      const keepalive = { id: "chatcmpl-keepalive", object: "chat.completion.chunk", model: PLACEHOLDER_MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] };
      const content = { id: "chatcmpl-1", object: "chat.completion.chunk", model: UPSTREAM_MODEL_ID, choices: [{ index: 0, delta: { content: "installed-ok" }, finish_reason: null }] };
      const finish = { id: "chatcmpl-1", object: "chat.completion.chunk", model: UPSTREAM_MODEL_ID, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse([keepalive, keepalive, content, finish], `: x-omniroute-provider=${ROUTE_PROVIDER}\n: x-omniroute-model=${ROUTE_MODEL}\ndata: [DONE]\n\n`));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

const context = () => ({ messages: [{ role: "user", content: "prove the installed keepalive rule", timestamp: Date.now() }] });
const baseModel = (api, provider, baseUrl) => ({
  provider,
  id: REQUESTED_MODEL,
  api,
  baseUrl,
  headers: {},
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
});

describe("installed keepalive model rule", () => {
  let scratch;
  let installed;
  let omniRoute;
  let piAiRoot;
  let completionsPath;
  let armA;
  let armB;

  before(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "ccc-ip-installed-keepalive-"));
    installed = await installTheRealCli(scratch);
    omniRoute = await startFakeOmniRoute();
    const nodeModules = path.dirname(path.dirname(installed.installedRoot));
    piAiRoot = [path.join(installed.installedRoot, "node_modules/@earendil-works/pi-ai"), path.join(nodeModules, "@earendil-works/pi-ai")].find((candidate) => existsSync(path.join(candidate, "package.json")));
    assert.ok(piAiRoot, "the packed install brings @earendil-works/pi-ai");
    completionsPath = path.join(piAiRoot, "dist/api/openai-completions.js");

    const adapter = await import(`${pathToFileURL(path.join(installed.installedRoot, "dist/ccc-route-receipt-adapter.js")).href}?installed=${Date.now()}`);
    const resultA = await adapter.streamCccTerminalRouteReceipt(
      baseModel(adapter.CCC_TERMINAL_ROUTE_RECEIPT_API, "omniroute-fixture", omniRoute.baseUrl),
      context(),
      { apiKey: "fixture-key", maxRetries: 0 },
    ).result();
    armA = { api: adapter.CCC_TERMINAL_ROUTE_RECEIPT_API, result: resultA };

    const piAiCompletions = await import(`${pathToFileURL(completionsPath).href}?installed=${Date.now()}`);
    const resultB = await piAiCompletions.stream(
      baseModel("openai-completions", "omniroute-fixture", omniRoute.baseUrl),
      context(),
      { apiKey: "fixture-key", maxRetries: 0 },
    ).result();
    armB = { result: resultB };
  }, { timeout: 3_000_000 });

  after(async () => {
    if (omniRoute) await omniRoute.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  test("arm A (sibling bundle dist/ccc-route-receipt-adapter.js, not the fn path): the packed receipt adapter reports the true model although the keepalive chunks carry a placeholder", () => {
    assert.equal(armA.api, "ccc-terminal-route-receipt.v1");
    assert.equal(armA.result.stopReason, "stop", armA.result.errorMessage);
    assert.deepEqual(armA.result.omniRoute, { provider: ROUTE_PROVIDER, model: ROUTE_MODEL }, "the route comes from the trailing comments");
    assert.notEqual(armA.result.responseModel, PLACEHOLDER_MODEL, "the placeholder is never taken as the response identity");
    assert.equal(armA.result.responseModel, UPSTREAM_MODEL_ID, "the substantive chunk's model is kept");
    assert.deepEqual(armA.result.content, [{ type: "text", text: "installed-ok" }]);
    assert.equal(omniRoute.requests.filter((request) => request.model === REQUESTED_MODEL).length, 2, "one request per arm, both for the requested model");
  });

  test("arm B: the installed pi-ai stream agrees with the bytes of its own file, so workspacePatch is written from what it did", async () => {
    const bytes = await readFile(completionsPath, "utf8");
    const classified = classifyCccPiAiWorkspacePatch(bytes);
    const observedPlaceholder = armB.result.responseModel === PLACEHOLDER_MODEL;
    const observedTrueModel = armB.result.responseModel === UPSTREAM_MODEL_ID;
    assert.ok(observedPlaceholder || observedTrueModel, `unexpected response model ${armB.result.responseModel}`);
    assert.equal(armB.result.stopReason, "stop", armB.result.errorMessage);
    assert.equal(classified, observedPlaceholder ? "not_carried" : "carried", "the byte reading and the behaviour must agree");
    const block = await deriveCccPiAiReceiptBlock({ installedRoot: installed.installedRoot, noExternal: parseCccCliNoExternalRules(await readFile(path.join(cliRoot, "tsup.config.ts"), "utf8")) });
    assert.equal(block.workspacePatch, observedPlaceholder ? "not_carried" : "carried", "the receipt block repeats the observation");
  });

  test("the packed dist ships the adapter entry, and bin.js carries the adapter id and api name strings (string presence only)", async () => {
    const bin = await readFile(path.join(installed.installedRoot, "dist/bin.js"), "utf8");
    assert.ok(bin.includes("terminal-route-sse-comments.v1"), "bin.js carries the receipt adapter id");
    assert.ok(bin.includes("ccc-terminal-route-receipt.v1"), "bin.js carries the adapter api name");
    assert.ok(existsSync(path.join(installed.installedRoot, "dist/ccc-route-receipt-adapter.js")), "the adapter entry is packed");
  });

  test("the installed pi-ai ships external, pinned at 0.81.1, with the adapter named as the keepalive source", async () => {
    const block = await deriveCccPiAiReceiptBlock({ installedRoot: installed.installedRoot, noExternal: parseCccCliNoExternalRules(await readFile(path.join(cliRoot, "tsup.config.ts"), "utf8")) });
    assert.equal(block.version, "0.81.1");
    assert.equal(block.shipping, "external");
    assert.equal(block.keepaliveModelSource, "fusion-receipt-adapter");
    assert.match(block.openaiCompletionsSha256, /^[a-f0-9]{64}$/u);
  });
});
