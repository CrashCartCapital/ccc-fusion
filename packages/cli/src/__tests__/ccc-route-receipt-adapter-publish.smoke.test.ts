import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

const cliRoot = join(__dirname, "..", "..");
const shouldRun = ["1", "true"].includes(
  process.env.FUSION_TEST_CCC_ROUTE_RECEIPT_PACK ?? "",
);

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
}

describe.skipIf(!shouldRun)("CCC route receipt adapter packed runtime", () => {
  it("builds, packs, clean-installs, and executes the exact adapter artifact", async () => {
    run("pnpm", ["run", "build"], cliRoot);

    const smokeDir = mkdtempSync(join(tmpdir(), "fusion-route-receipt-pack-"));
    try {
      const packDir = join(smokeDir, "tarballs");
      const installDir = join(smokeDir, "install");
      mkdirSync(packDir, { recursive: true });
      mkdirSync(installDir, { recursive: true });

      run("pnpm", ["pack", "--pack-destination", packDir], cliRoot);
      const tarball = readdirSync(packDir).find(
        (file) => file.startsWith("runfusion-fusion-") && file.endsWith(".tgz"),
      );
      expect(tarball, "pnpm pack must produce the @runfusion/fusion tarball").toBeDefined();

      writeFileSync(
        join(installDir, "package.json"),
        JSON.stringify({ name: "fusion-route-receipt-pack-smoke", version: "0.0.0", private: true }),
      );
      run(
        "npm",
        ["install", "--no-audit", "--no-fund", "--ignore-scripts", join(packDir, tarball!)],
        installDir,
      );

      const installedAdapter = join(
        installDir,
        "node_modules",
        "@runfusion",
        "fusion",
        "dist",
        "ccc-route-receipt-adapter.js",
      );
      expect(existsSync(installedAdapter), "packed CLI must ship the named adapter runtime").toBe(true);
      const installedPiTransport = join(
        installDir,
        "node_modules",
        "@earendil-works",
        "pi-ai",
        "dist",
        "api",
        "openai-completions.js",
      );
      const installedPiTransportSource = readFileSync(installedPiTransport, "utf8");
      expect(installedPiTransportSource).not.toContain("isOmniRouteModel");
      expect(installedPiTransportSource).not.toContain("captureOmniRouteSseComments");

      const adapter = await import(`${pathToFileURL(installedAdapter).href}?proof=${Date.now()}`) as {
        CCC_TERMINAL_ROUTE_RECEIPT_API: string;
        createCccTerminalRouteSseCommentParser: () => {
          push: (chunk: Uint8Array) => void;
          finish: () => { provider: string; model: string };
        };
        streamCccTerminalRouteReceipt: (
          model: unknown,
          context: unknown,
          options: unknown,
        ) => { result: () => Promise<Record<string, unknown>> };
      };
      expect(adapter.CCC_TERMINAL_ROUTE_RECEIPT_API).toBe("ccc-terminal-route-receipt.v1");

      const parser = adapter.createCccTerminalRouteSseCommentParser();
      parser.push(new TextEncoder().encode(
        ": x-omniroute-provider=upstream\n: x-omniroute-model=model-a\ndata: [DONE]\n\n",
      ));
      expect(parser.finish()).toEqual({ provider: "upstream", model: "model-a" });

      const server = createServer((request, response) => {
        request.resume();
        request.once("end", () => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            "data: {\"id\":\"installed-receipt\",\"model\":\"upstream/model-a\","
            + "\"choices\":[{\"delta\":{\"content\":\"installed-ok\"},\"finish_reason\":null}]}\n\n",
          );
          response.write(
            "data: {\"id\":\"installed-receipt\",\"model\":\"upstream/model-a\","
            + "\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],"
            + "\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\n\n",
          );
          response.end(
            ": x-omniroute-provider=upstream\n: x-omniroute-model=model-a\ndata: [DONE]\n\n",
          );
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address() as AddressInfo;
        const result = await adapter.streamCccTerminalRouteReceipt({
          provider: "arbitrary-gateway",
          id: "upstream/model-a",
          api: adapter.CCC_TERMINAL_ROUTE_RECEIPT_API,
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          headers: {},
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 16_384,
        }, {
          messages: [{ role: "user", content: "prove installed adapter", timestamp: Date.now() }],
        }, {
          apiKey: "fixture-key",
          maxRetries: 0,
        }).result();

        expect(result).toMatchObject({
          stopReason: "stop",
          content: [{ type: "text", text: "installed-ok" }],
          omniRoute: { provider: "upstream", model: "model-a" },
          usage: { input: 2, output: 1, totalTokens: 3 },
        });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve()));
      }
    } finally {
      rmSync(smokeDir, { recursive: true, force: true });
    }
  }, 300_000);
});
