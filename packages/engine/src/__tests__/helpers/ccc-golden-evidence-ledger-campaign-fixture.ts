import { readFileSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliAgentAdapter } from "../cli-agent/adapter.js";
import type { TelemetryHub } from "../cli-agent/telemetry-hub.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
export const cliDistRoot = join(repoRoot, "packages/cli/dist");
export const adapterId = "ccc-golden-evidence-ledger-fixture";
export const idempotencyKey = "ccc-golden-evidence-ledger-runtime-v1";
export const taskOrder = [
  "TASK-LEDGER-CONTRACT",
  "TASK-LEDGER-CORE",
  "TASK-LEDGER-CLI",
] as const;
export const ownedFilesByTask = {
  "TASK-LEDGER-CONTRACT": ["src/record.mjs", "src/validation.mjs"],
  "TASK-LEDGER-CORE": ["src/ledger.mjs", "src/report.mjs"],
  "TASK-LEDGER-CLI": ["README.md", "bin/evidence-ledger.mjs"],
} as const;
export const exactCandidateFiles = Object.values(ownedFilesByTask).flat().sort();

export type PreparedLifecycle = Readonly<{
  targetRoot: string;
  baseCommit: string;
  frozenRoot: string;
  manifestPath: string;
  sidecarPath: string;
  executionPlanPath: string;
}>;

export async function prepareLifecycle(root: string): Promise<PreparedLifecycle> {
  const module = await import("../../../../../scripts/lib/ccc-golden-packet-lifecycle.mjs") as {
    prepareEvidenceLedgerPacketLifecycle(input: Record<string, unknown>): Promise<PreparedLifecycle>;
  };
  return module.prepareEvidenceLedgerPacketLifecycle({
    root,
    route: {
      providerId: "golden-fixture-provider",
      modelId: "golden-fixture-model",
      transport: "cli",
      cliAdapterId: adapterId,
    },
    maxRequests: 9,
    maxDurationMs: 600_000,
  });
}

export async function createFixturePayload(root: string): Promise<Readonly<{
  payloadPath: string;
  providerPath: string;
  markerPath: string;
  debugPath: string;
  expected: Readonly<Record<string, string>>;
}>> {
  const candidateRoot = join(root, "candidate");
  const helper = await import("../../../../../scripts/__tests__/helpers/ccc-golden-evidence-ledger-candidate.mjs") as {
    writeCliCandidate(rootDir: string): Promise<void>;
  };
  await helper.writeCliCandidate(candidateRoot);
  const expected: Record<string, string> = {};
  for (const relativePath of exactCandidateFiles) {
    expected[relativePath] = await readFile(join(candidateRoot, relativePath), "utf8");
  }
  const payloadPath = join(root, "provider-payload.json");
  const providerPath = join(root, "provider.cjs");
  const markerPath = join(root, "provider-events.jsonl");
  const debugPath = join(root, "provider-debug.jsonl");
  await writeFile(payloadPath, `${JSON.stringify({ expected, ownedFilesByTask, taskOrder })}\n`);
  await writeFile(providerPath, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const [payloadPath, markerPath, debugPath] = process.argv.slice(2);",
    "const fixture = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));",
    "fs.appendFileSync(debugPath, JSON.stringify({ kind: 'started', cwd: process.cwd(), argv: process.argv.slice(2) }) + '\\n');",
    "let input = ''; let handled = false;",
    "process.stdout.write('READY\\n');",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => {",
    "  fs.appendFileSync(debugPath, JSON.stringify({ kind: 'input', bytes: chunk.length, cwd: process.cwd() }) + '\\n');",
    "  if (handled) return; input += chunk;",
    "  const taskId = fixture.taskOrder.find(id => fixture.ownedFilesByTask[id].some(relativePath => !fs.existsSync(relativePath)));",
    "  if (!taskId) return; handled = true;",
    "  const files = fixture.ownedFilesByTask[taskId];",
    "  for (const relativePath of files) {",
    "    fs.mkdirSync(path.dirname(relativePath), { recursive: true });",
    "    fs.writeFileSync(relativePath, fixture.expected[relativePath]);",
    "  }",
    "  fs.appendFileSync(markerPath, JSON.stringify({ taskId, cwd: process.cwd(), files }) + '\\n');",
    "});",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  return { payloadPath, providerPath, markerPath, debugPath, expected };
}

export type ProviderEvent = Readonly<{
  taskId: string;
  cwd: string;
  files: readonly string[];
}>;

export function readProviderEvents(markerPath: string): ProviderEvent[] {
  try {
    return readFileSync(markerPath, "utf8").trim().split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProviderEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function fixtureAdapter(
  fixture: Awaited<ReturnType<typeof createFixturePayload>>,
  hub: Pick<TelemetryHub, "getStateMachine" | "ingest">,
): CliAgentAdapter {
  return {
    id: adapterId,
    name: "CCC Golden Evidence Ledger deterministic fixture",
    defaultCommand: process.execPath,
    capabilities: {
      nativeDone: true,
      nativeWaiting: false,
      transcriptSource: "none",
      supportsResume: false,
    },
    buildLaunch: () => ({
      command: process.execPath,
      args: [fixture.providerPath, fixture.payloadPath, fixture.markerPath, fixture.debugPath],
    }),
    buildEnvAllowlist: () => [],
    createReadinessDetector: () => ({ observe: (chunk) => chunk.includes("READY") }),
    formatInjection: (text) => ({ payload: `${text}\n` }),
    wireTelemetry: ({ sessionId, worktreePath }) => {
      let reading = false;
      let completed = false;
      const timer = setInterval(() => {
        if (reading || completed || hub.getStateMachine(sessionId)?.getState() !== "busy") return;
        reading = true;
        try {
          if (worktreePath && readProviderEvents(fixture.markerPath).some(({ cwd }) =>
            realpathSync(cwd) === realpathSync(worktreePath))) {
            completed = true;
            hub.ingest(sessionId, { kind: "done" });
          }
        } finally {
          reading = false;
        }
      }, 5);
      return () => clearInterval(timer);
    },
  };
}
