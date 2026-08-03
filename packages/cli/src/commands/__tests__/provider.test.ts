import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { customProviderRegistryKey, type CustomProvider } from "@fusion/core";
/*
`readCustomProviders` and `validateCccLoopbackHttpUrl` are not on the
`@fusion/engine` public surface (its package `exports` map only exposes `.`),
so the round-trip and policy-parity assertions reach the engine sources
directly. Test files are excluded from the CLI tsconfig, so this deep relative
import never enters the `tsc`/`tsup` program -- the same seam
`ccc-native-proof-host.test.ts` already uses.
*/
import { readCustomProviders } from "../../../../engine/src/custom-providers.js";
import { validateCccLoopbackHttpUrl } from "../../../../engine/src/ccc-loopback-policy.js";
import { runProviderCommand, validateProviderBaseUrl } from "../provider.js";

/** Obviously fake, never a real credential. */
const FAKE_API_KEY = "sk-fake-provider-test-key-do-not-use-0000";
/** The dashboard's mask sentinel; a pasted masked value must be refused. */
const MASKED_API_KEY = `sk-${"\u2022".repeat(5)}0000`;

const LOOPBACK_BASE_URL = "http://127.0.0.1:11434/v1";

let home: string;
let globalDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

/** Everything the command printed, on either stream. */
function output(): string {
  const lines: string[] = [];
  for (const call of logSpy.mock.calls) lines.push(call.map(String).join(" "));
  for (const call of errorSpy.mock.calls) lines.push(call.map(String).join(" "));
  return lines.join("\n");
}

function run(args: string[], stdinLine?: string): Promise<number> {
  return runProviderCommand(args, {
    globalDir,
    readStdinLine: async () => {
      if (stdinLine === undefined) {
        throw new Error("test did not provide stdin");
      }
      return stdinLine;
    },
  });
}

function seedProviders(providers: CustomProvider[]): void {
  writeFileSync(
    join(globalDir, "settings.json"),
    JSON.stringify({ customProviders: providers }, null, 2),
  );
}

function persisted(): CustomProvider[] {
  return readCustomProviders(home);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fn-provider-"));
  globalDir = join(home, ".fusion");
  mkdirSync(globalDir, { recursive: true });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

describe("fn provider add -- loopback egress policy", () => {
  const refused = [
    "http://localhost:1/v1",
    "https://127.0.0.1:1/v1",
    "http://127.0.0.1:0/v1",
    "http://127.0.0.1:1",
    "http://127.0.0.1:1/",
  ];

  it.each(refused)("refuses %s and quotes the loopback-policy reason", async (baseUrl) => {
    const policy = validateCccLoopbackHttpUrl(baseUrl);
    expect(policy.ok).toBe(false);

    const code = await run(["add", "--name", "Probe", "--base-url", baseUrl]);

    expect(code).toBe(1);
    expect(output()).toContain((policy as { ok: false; reason: string }).reason);
    expect(persisted()).toEqual([]);
  });

  it("accepts an admitted loopback base URL", async () => {
    const code = await run(["add", "--name", "Local Llama", "--base-url", LOOPBACK_BASE_URL]);

    expect(code).toBe(0);
    expect(persisted()).toHaveLength(1);
    expect(persisted()[0]!.baseUrl).toBe(LOOPBACK_BASE_URL);
  });

  it("agrees with the engine loopback policy on every verdict and reason", () => {
    const cases = [
      ...refused,
      LOOPBACK_BASE_URL,
      "http://127.0.0.1:65535/v1",
      "http://127.0.0.1:65536/v1",
      "http://127.0.0.1:8080/v1?x=1",
      "http://127.0.0.1:8080/v1#frag",
      "http://user:pass@127.0.0.1:8080/v1",
      "http://127.0.0.1:8080//v1",
      "http://[::1]:8080/v1",
      "http://127.0.0.1/v1",
      "https://api.example.com/v1",
      42,
      undefined,
    ];

    for (const value of cases) {
      expect(validateProviderBaseUrl(value)).toEqual(validateCccLoopbackHttpUrl(value));
    }
  });

  it("admits a remote base URL under --allow-remote and warns that CCC authoring refuses it", async () => {
    const code = await run([
      "add",
      "--name", "Remote Gateway",
      "--base-url", "https://api.example.com/v1",
      "--allow-remote",
    ]);

    expect(code).toBe(0);
    expect(persisted()[0]!.baseUrl).toBe("https://api.example.com/v1");

    const printed = output();
    expect(printed).toContain("CCC PRD authoring");
    expect(printed).toContain("refuse");
    expect(printed).toContain("loopback");
  });
});

describe("fn provider add -- registry key echo", () => {
  it("prints the derived registry key and names the --provider flag", async () => {
    await run(["add", "--name", "Local Llama", "--base-url", LOOPBACK_BASE_URL]);

    const providers = persisted();
    const key = customProviderRegistryKey(providers[0]!, providers);

    expect(key).toBe("local-llama");
    expect(output()).toContain(`registry key: ${key}`);
    expect(output()).toContain("--provider");
  });

  it("refuses a duplicate name instead of silently forking a -N registry key", async () => {
    /*
    Task #8: customProviderRegistryKey()'s -N suffix exists to disambiguate an
    already-persisted collision (e.g. hand-edited settings.json) when
    *listing*, not to bless creating a second one. `fn provider add` used to
    accept a second "Local Llama" silently, forking a distinct
    "local-llama-2" provider the operator likely never intended.
    */
    await run(["add", "--name", "Local Llama", "--base-url", LOOPBACK_BASE_URL]);
    logSpy.mockClear();
    errorSpy.mockClear();
    const code = await run(["add", "--name", "Local Llama", "--base-url", "http://127.0.0.1:11435/v1"]);

    expect(code).toBe(1);
    expect(output()).toContain("already exists");
    expect(output()).toContain("fn provider remove");

    const providers = persisted();
    expect(providers).toHaveLength(1);
    expect(providers[0]!.baseUrl).toBe(LOOPBACK_BASE_URL);
  });

  it("assigns a generated uuid id", async () => {
    await run(["add", "--name", "Local Llama", "--base-url", LOOPBACK_BASE_URL]);

    const providers = persisted();
    expect(providers).toHaveLength(1);
    expect(providers[0]!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("refuses an operator-supplied --id instead of silently ignoring it", async () => {
    const code = await run([
      "add",
      "--name", "Local Llama",
      "--base-url", LOOPBACK_BASE_URL,
      "--id", "operator-chosen-id",
    ]);

    expect(code).toBe(1);
    expect(output()).toContain("--id");
    expect(persisted()).toEqual([]);
  });
});

describe("fn provider -- api key handling", () => {
  it("never accepts an inline --api-key value", async () => {
    const code = await run([
      "add",
      "--name", "Local Llama",
      "--base-url", LOOPBACK_BASE_URL,
      "--api-key", FAKE_API_KEY,
    ]);

    expect(code).toBe(1);
    expect(output()).toContain("--api-key-stdin");
    expect(output()).not.toContain(FAKE_API_KEY);
    expect(persisted()).toEqual([]);
  });

  it("never accepts the --api-key=VALUE form either", async () => {
    const code = await run([
      "add",
      "--name", "Local Llama",
      "--base-url", LOOPBACK_BASE_URL,
      `--api-key=${FAKE_API_KEY}`,
    ]);

    expect(code).toBe(1);
    expect(output()).toContain("--api-key-stdin");
    expect(output()).not.toContain(FAKE_API_KEY);
    expect(persisted()).toEqual([]);
  });

  it("reads the key from stdin and never echoes its bytes on add or list", async () => {
    const addCode = await run(
      ["add", "--name", "Local Llama", "--base-url", LOOPBACK_BASE_URL, "--api-key-stdin"],
      `${FAKE_API_KEY}\n`,
    );

    expect(addCode).toBe(0);
    expect(persisted()[0]!.apiKey).toBe(FAKE_API_KEY);
    expect(output()).not.toContain(FAKE_API_KEY);
    expect(output()).toContain("apiKey: set (masked)");

    logSpy.mockClear();
    errorSpy.mockClear();
    await run(["list"]);
    expect(output()).not.toContain(FAKE_API_KEY);
    expect(output()).toContain("apiKey: set (masked)");

    logSpy.mockClear();
    errorSpy.mockClear();
    await run(["list", "--json"]);
    expect(output()).not.toContain(FAKE_API_KEY);
  });

  it("reports a missing key as not set", async () => {
    await run(["add", "--name", "Local Llama", "--base-url", LOOPBACK_BASE_URL]);
    logSpy.mockClear();
    errorSpy.mockClear();

    await run(["list"]);
    expect(output()).toContain("apiKey: not set");
  });

  it("refuses a masked value pasted back from the dashboard", async () => {
    const code = await run(
      ["add", "--name", "Local Llama", "--base-url", LOOPBACK_BASE_URL, "--api-key-stdin"],
      `${MASKED_API_KEY}\n`,
    );

    expect(code).toBe(1);
    expect(output()).toContain("masked");
    expect(persisted()).toEqual([]);
  });
});

describe("fn provider add -- settings round trip", () => {
  it("writes a provider the engine reader returns unchanged", async () => {
    const code = await run(
      [
        "add",
        "--name", "Local Llama",
        "--base-url", LOOPBACK_BASE_URL,
        "--api-type", "openai-responses",
        "--model", "llama-3.1:Llama 3.1",
        "--model", "qwen3",
        "--model", "gpt-oss\\:20b",
        "--api-key-stdin",
      ],
      `${FAKE_API_KEY}\n`,
    );

    expect(code).toBe(0);

    const providers = persisted();
    expect(providers).toHaveLength(1);
    expect(providers[0]).toEqual({
      id: providers[0]!.id,
      name: "Local Llama",
      apiType: "openai-responses",
      baseUrl: LOOPBACK_BASE_URL,
      apiKey: FAKE_API_KEY,
      models: [
        { id: "llama-3.1", name: "Llama 3.1" },
        { id: "qwen3", name: "qwen3" },
        { id: "gpt-oss:20b", name: "gpt-oss:20b" },
      ],
    });
  });

  it("defaults apiType to openai-compatible and rejects an unknown one", async () => {
    await run(["add", "--name", "Defaulted", "--base-url", LOOPBACK_BASE_URL]);
    expect(persisted()[0]!.apiType).toBe("openai-compatible");

    const code = await run([
      "add",
      "--name", "Bad Type",
      "--base-url", LOOPBACK_BASE_URL,
      "--api-type", "openai-chat",
    ]);
    expect(code).toBe(1);
    expect(persisted()).toHaveLength(1);
  });

  it("preserves unrelated global settings written by other surfaces", async () => {
    writeFileSync(
      join(globalDir, "settings.json"),
      JSON.stringify({ theme: "dark", customProviders: [] }, null, 2),
    );

    await run(["add", "--name", "Local Llama", "--base-url", LOOPBACK_BASE_URL]);

    const raw = JSON.parse(readFileSync(join(globalDir, "settings.json"), "utf-8")) as
      Record<string, unknown>;
    expect(raw.theme).toBe("dark");
    expect(persisted()).toHaveLength(1);
  });
});

describe("fn provider list", () => {
  it("reports an empty registry without failing", async () => {
    const code = await run(["list"]);
    expect(code).toBe(0);
    expect(output()).toMatch(/no custom providers/i);
  });

  it("echoes the registry key for every provider", async () => {
    /*
    Task #8: `fn provider add` now refuses a duplicate name (see "fn provider
    add -- registry key echo"), so a same-name collision can only reach
    settings.json some other way (hand-edited JSON, a pre-fix persisted
    file). Seed it directly to keep covering customProviderRegistryKey()'s -N
    disambiguation in `fn provider list` output.
    */
    seedProviders([
      { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Local Llama", apiType: "openai-compatible", baseUrl: LOOPBACK_BASE_URL },
      { id: "aaaaaaaa-0000-4000-8000-000000000002", name: "Local Llama", apiType: "openai-compatible", baseUrl: "http://127.0.0.1:11435/v1" },
    ]);

    const code = await run(["list"]);
    expect(code).toBe(0);
    expect(output()).toContain("registry key: local-llama");
    expect(output()).toContain("registry key: local-llama-2");
  });

  it("emits machine-readable json with registry keys and no key bytes", async () => {
    await run(
      ["add", "--name", "Local Llama", "--base-url", LOOPBACK_BASE_URL, "--api-key-stdin"],
      `${FAKE_API_KEY}\n`,
    );
    logSpy.mockClear();
    errorSpy.mockClear();

    const code = await run(["list", "--json"]);
    expect(code).toBe(0);

    const parsed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join("\n")) as {
      providers: { registryKey: string; apiKeySet: boolean; apiKey?: unknown }[];
    };
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0]!.registryKey).toBe("local-llama");
    expect(parsed.providers[0]!.apiKeySet).toBe(true);
    expect(parsed.providers[0]).not.toHaveProperty("apiKey");
  });
});

describe("fn provider remove", () => {
  const alpha: CustomProvider = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Alpha",
    apiType: "openai-compatible",
    baseUrl: "http://127.0.0.1:8080/v1",
  };
  const beta: CustomProvider = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Beta",
    apiType: "openai-compatible",
    baseUrl: "http://127.0.0.1:8081/v1",
  };

  it("removes an exact registry-key match with --yes", async () => {
    seedProviders([alpha, beta]);

    const code = await run(["remove", "alpha", "--yes"]);

    expect(code).toBe(0);
    expect(persisted().map((provider) => provider.id)).toEqual([beta.id]);
    expect(output()).toContain("alpha");
  });

  it("removes an exact id match with --yes", async () => {
    seedProviders([alpha, beta]);

    const code = await run(["remove", beta.id, "--yes"]);

    expect(code).toBe(0);
    expect(persisted().map((provider) => provider.id)).toEqual([alpha.id]);
  });

  it("refuses without --yes and leaves settings untouched", async () => {
    seedProviders([alpha, beta]);

    const code = await run(["remove", "alpha"]);

    expect(code).toBe(1);
    expect(output()).toContain("--yes");
    expect(persisted()).toHaveLength(2);
  });

  it("refuses an ambiguous selector that matches both an id and a registry key", async () => {
    const collidingId: CustomProvider = { ...alpha, id: "shared-token" };
    const collidingName: CustomProvider = { ...beta, name: "Shared Token" };
    seedProviders([collidingId, collidingName]);

    expect(customProviderRegistryKey(collidingName, [collidingId, collidingName]))
      .toBe("shared-token");

    const code = await run(["remove", "shared-token", "--yes"]);

    expect(code).toBe(1);
    expect(output()).toMatch(/ambiguous/i);
    expect(persisted()).toHaveLength(2);
  });

  it("refuses an unknown selector", async () => {
    seedProviders([alpha]);

    const code = await run(["remove", "gamma", "--yes"]);

    expect(code).toBe(1);
    expect(persisted()).toHaveLength(1);
  });
});

describe("fn provider -- argument surface", () => {
  it("requires --name and --base-url", async () => {
    expect(await run(["add", "--base-url", LOOPBACK_BASE_URL])).toBe(1);
    expect(await run(["add", "--name", "Nameless"])).toBe(1);
    expect(persisted()).toEqual([]);
  });

  it("rejects an unknown subcommand", async () => {
    expect(await run(["frobnicate"])).toBe(1);
    expect(output()).toContain("provider");
  });

  it("rejects an unknown flag rather than silently dropping it", async () => {
    const code = await run([
      "add",
      "--name", "Local Llama",
      "--base-url", LOOPBACK_BASE_URL,
      "--turbo",
    ]);

    expect(code).toBe(1);
    expect(output()).toContain("--turbo");
    expect(persisted()).toEqual([]);
  });
});

describe("bin.ts operator help surface", () => {
  const binSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin.ts"),
    "utf-8",
  );

  it("documents the fn provider subcommands", () => {
    expect(binSource).toContain("fn provider list");
    expect(binSource).toContain("fn provider add");
    expect(binSource).toContain("fn provider remove");
    expect(binSource).toContain("--api-key-stdin");
    expect(binSource).toContain("--allow-remote");
  });

  it("advertises --json on the fn prd operator subcommands", () => {
    const operatorSubcommands = [
      "status",
      "preview",
      "import",
      "approve-execution",
      "approve-merge",
      "pause",
      "resume",
      "stop",
      "resolve-proof",
      "resolve-provider",
      "inspect",
      "reconcile",
    ];

    for (const subcommand of operatorSubcommands) {
      const line = binSource
        .split("\n")
        .find((candidate) => candidate.trimStart().startsWith(`fn prd ${subcommand} `));
      expect(line, `no help line for fn prd ${subcommand}`).toBeDefined();
      expect(line, `fn prd ${subcommand} help line lacks [--json]`).toContain("[--json]");
    }
  });
});

/*
Stage 4 finding (2026-08-02): the registry hardcoded every custom-provider
model at maxTokens 16384 / contextWindow 128000, so real PRD understanding
against a 65k-window local model truncated with "length: incomplete response".
These flags let the operator declare what the backend actually supports.
*/
describe("fn provider add -- per-model token limits", () => {
  it("persists --max-tokens and --context-window onto every model entry", async () => {
    const code = await run([
      "add",
      "--name", "Local",
      "--base-url", LOOPBACK_BASE_URL,
      "--model", "big-model",
      "--model", "small-model",
      "--max-tokens", "32768",
      "--context-window", "65536",
    ]);

    expect(code).toBe(0);
    const providers = persisted();
    expect(providers[0]!.models).toEqual([
      { id: "big-model", name: "big-model", maxTokens: 32768, contextWindow: 65536 },
      { id: "small-model", name: "small-model", maxTokens: 32768, contextWindow: 65536 },
    ]);
  });

  it("stores no limit fields when the flags are absent", async () => {
    await run(["add", "--name", "Local", "--base-url", LOOPBACK_BASE_URL, "--model", "m"]);

    const providers = persisted();
    expect(providers[0]!.models).toEqual([{ id: "m", name: "m" }]);
  });

  it.each(["0", "-1", "1.5", "abc"])("refuses --max-tokens %s", async (value) => {
    const code = await run([
      "add",
      "--name", "Local",
      "--base-url", LOOPBACK_BASE_URL,
      "--model", "m",
      "--max-tokens", value,
    ]);

    expect(code).toBe(1);
    expect(output()).toContain("--max-tokens");
    expect(persisted()).toEqual([]);
  });

  it.each(["0", "-1", "1.5", "abc"])("refuses --context-window %s", async (value) => {
    const code = await run([
      "add",
      "--name", "Local",
      "--base-url", LOOPBACK_BASE_URL,
      "--model", "m",
      "--context-window", value,
    ]);

    expect(code).toBe(1);
    expect(output()).toContain("--context-window");
    expect(persisted()).toEqual([]);
  });

  it("refuses limit flags when no --model is given, instead of silently dropping them", async () => {
    const code = await run([
      "add",
      "--name", "Local",
      "--base-url", LOOPBACK_BASE_URL,
      "--max-tokens", "32768",
    ]);

    expect(code).toBe(1);
    expect(output()).toContain("--model");
    expect(persisted()).toEqual([]);
  });
});
