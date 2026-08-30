import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareEvidenceLedgerPacketLifecycle } from "../lib/ccc-golden-packet-lifecycle.mjs";

const packetInput = () => ({
  targetRoot: "/tmp/ccc-golden-ledger-target",
  targetBase: "a".repeat(40),
  route: {
    providerId: "openai-compatible-omniroute",
    modelId: "openai-compatible-omniroute/runtime-probed-model",
    transport: "pi",
    receiptAdapterId: "terminal-route-sse-comments.v1",
  },
  maxRequests: 9,
  maxDurationMs: 600_000,
});

function restoreEnvironment(snapshot) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  Object.assign(process.env, snapshot);
}

test("PRD:GOLDEN-3A lifecycle child commands receive an isolated allowlisted environment", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "ccc-golden-lifecycle-env-red-"));
  const lifecycleRoot = path.join(sandbox, "lifecycle");
  const fakeBin = path.join(sandbox, "bin");
  const observationsPath = path.join(sandbox, "git-child-environments.jsonl");
  const realGit = process.env.CCC_TEST_REAL_GIT ?? "/opt/homebrew/bin/git";
  const originalEnvironment = { ...process.env };
  await mkdir(lifecycleRoot);
  await mkdir(fakeBin);
  await writeFile(path.join(fakeBin, "git"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
appendFileSync(${JSON.stringify(observationsPath)}, JSON.stringify({
  HOME: process.env.HOME,
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_MIGRATION_URL: process.env.DATABASE_MIGRATION_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY,
  CCC_PROVIDER_TOKEN: process.env.CCC_PROVIDER_TOKEN,
}) + "\\n");
const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
  await chmod(path.join(fakeBin, "git"), 0o755);

  try {
    Object.assign(process.env, {
      PATH: `${fakeBin}:${originalEnvironment.PATH}`,
      HOME: path.join(sandbox, "poison-real-home"),
      DATABASE_URL: "postgresql://ambient-db.invalid/fusion",
      DATABASE_MIGRATION_URL: "postgresql://ambient-migration.invalid/fusion",
      OPENAI_API_KEY: "ambient-openai-key",
      ANTHROPIC_API_KEY: "ambient-anthropic-key",
      OMNIROUTE_API_KEY: "ambient-omniroute-key",
      CCC_PROVIDER_TOKEN: "ambient-provider-token",
    });
    const lifecycle = await prepareEvidenceLedgerPacketLifecycle({ root: lifecycleRoot, ...packetInput() });
    assert.deepEqual(lifecycle.warnings, []);

    const observations = (await readFile(observationsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(observations.length >= 6);
    for (const observed of observations) {
      assert.deepEqual(observed, { HOME: path.join(lifecycleRoot, ".home") });
    }
  } finally {
    restoreEnvironment(originalEnvironment);
    await rm(sandbox, { recursive: true, force: true });
  }
});
