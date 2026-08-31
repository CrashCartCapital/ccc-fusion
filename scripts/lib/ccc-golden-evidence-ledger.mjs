import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { buildProjectVerifierSource } from "./ccc-golden-project-verifier-source.mjs";

const validRecords = [
  {
    id: "ev-003",
    subject: "pump-a",
    claim: "Pressure variance observed",
    observedAt: "2026-08-29T10:03:00Z",
    source: "sensor-beta",
    confidence: "medium",
    tags: ["variance", "pressure"],
  },
  {
    id: "ev-001",
    subject: "pump-a",
    claim: "Pressure nominal",
    observedAt: "2026-08-29T10:01:00Z",
    source: "sensor-alpha",
    confidence: "high",
    tags: ["pressure"],
  },
  {
    id: "ev-002",
    subject: "pump-b",
    claim: "Temperature nominal",
    observedAt: "2026-08-29T10:02:00Z",
    source: "sensor-alpha",
    confidence: "high",
  },
  {
    id: "ev-004",
    subject: "pump-a",
    claim: "Maintenance ticket opened",
    observedAt: "2026-08-29T10:02:00Z",
    source: "ops-console",
    confidence: "low",
    tags: ["ticket", "maintenance"],
  },
];

const record = (overrides = {}) => ({
  id: "ev-invalid",
  subject: "pump-a",
  claim: "Invalid fixture claim",
  observedAt: "2026-08-29T10:05:00Z",
  source: "fixture",
  confidence: "low",
  ...overrides,
});

const ndjson = (records) => `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

const phaseCandidateInputs = {
  contract: ["src/record.mjs", "src/validation.mjs"],
  core: ["src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs"],
  cli: ["src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs", "README.md", "bin/evidence-ledger.mjs"],
  project: ["README.md", "bin/evidence-ledger.mjs", "src/record.mjs", "src/validation.mjs", "src/ledger.mjs", "src/report.mjs"],
};

const packageJson = {
  name: "ccc-golden-evidence-ledger",
  version: "1.0.0",
  private: true,
  type: "module",
  scripts: {
    "verify:contract": `node verify/project-verifier.mjs ${phaseCandidateInputs.contract.join(" ")}`,
    "verify:core": `node verify/project-verifier.mjs ${phaseCandidateInputs.core.join(" ")}`,
    "verify:cli": `node verify/project-verifier.mjs ${phaseCandidateInputs.cli.join(" ")}`,
    "verify:project": `node verify/project-verifier.mjs ${phaseCandidateInputs.project.join(" ")}`,
    test: `node verify/project-verifier.mjs ${phaseCandidateInputs.project.join(" ")}`,
  },
};

const baselineContent = new Map([
  [".gitignore", ".fusion/\n.fusion-global-settings/\n.worktrees/\n"],
  ["Taskfile.yml", [
    "version: '3'",
    "",
    "tasks:",
    ...["contract", "core", "cli", "project"].flatMap((phase) => [
      `  verify:${phase}:`,
      "    cmds:",
      `      - node verify/project-verifier.mjs ${phaseCandidateInputs[phase].join(" ")}`,
    ]),
    "",
  ].join("\n")],
  ["fixtures/duplicate-id.ndjson", ndjson([record({ id: "ev-duplicate" }), record({ id: "ev-duplicate", claim: "Second claim" })])],
  ["fixtures/hardcode-control.ndjson", ndjson([
    record({ id: "control-001", subject: "router-x", claim: "Primary route healthy", source: "route-probe", confidence: "high", tags: ["routing"] }),
    record({ id: "control-002", subject: "router-y", claim: "Fallback route idle", observedAt: "2026-08-29T10:06:00Z", source: "route-probe", confidence: "medium" }),
  ])],
  ["fixtures/invalid-calendar-date.ndjson", ndjson([record({ observedAt: "2026-02-30T10:05:00Z" })])],
  ["fixtures/invalid-confidence.ndjson", ndjson([record({ confidence: "certain" })])],
  ["fixtures/invalid-json.ndjson", "{\"id\":\n"],
  ["fixtures/invalid-timestamp.ndjson", ndjson([record({ observedAt: "2026-08-29T03:05:00-07:00" })])],
  ["fixtures/missing-required-field.ndjson", `${JSON.stringify((({ source: _source, ...rest }) => rest)(record()))}\n`],
  ["fixtures/unknown-field.ndjson", ndjson([record({ extra: "forbidden" })])],
  ["fixtures/valid-shuffled.ndjson", ndjson([validRecords[1], validRecords[3], validRecords[0], validRecords[2]])],
  ["fixtures/valid.ndjson", ndjson(validRecords)],
  ["package.json", `${JSON.stringify(packageJson, null, 2)}\n`],
]);

const baselineHashes = Object.fromEntries(
  [...baselineContent].map(([relativePath, content]) => [
    relativePath,
    createHash("sha256").update(content).digest("hex"),
  ]),
);
baselineContent.set("verify/project-verifier.mjs", buildProjectVerifierSource(baselineHashes));

export async function createEvidenceLedgerBaseline(root, options = {}) {
  try {
    if ((await readdir(root)).length > 0) {
      throw new Error("target is not empty");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const stagingRoot = await mkdtemp(path.join(path.dirname(root), `.${path.basename(root)}-staging-`));
  const write = options.writeFile ?? writeFile;
  try {
    for (const [relativePath, content] of baselineContent) {
      const absolutePath = path.join(stagingRoot, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await write(absolutePath, content, { flag: "wx" });
    }
    await rename(stagingRoot, root);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function canonicalizePlannedPath(candidate) {
  let existing = candidate;
  const missingSegments = [];
  while (true) {
    try {
      return path.join(await realpath(existing), ...missingSegments.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missingSegments.push(path.basename(existing));
      existing = parent;
    }
  }
}

export async function runEvidenceLedgerCommand(args, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();
  if (args.length !== 2 || args[0] !== "init" || typeof args[1] !== "string" || args[1].trim().length === 0) {
    stderr.write("usage: ccc-golden-evidence-ledger init <target>\n");
    return 2;
  }
  const target = path.resolve(cwd, args[1]);
  const allowedRoot = path.resolve(options.allowedRoot ?? cwd);
  try {
    const canonicalAllowedRoot = await realpath(allowedRoot);
    const canonicalTarget = await canonicalizePlannedPath(target);
    const relativeTarget = path.relative(canonicalAllowedRoot, canonicalTarget);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
      throw new Error("target is outside allowed root");
    }
    await createEvidenceLedgerBaseline(target);
  } catch {
    stderr.write("CCC_GOLDEN_INIT_FAILED\n");
    return 1;
  }
  stdout.write(`${JSON.stringify({
    schema: "ccc-golden.fixture-result.v1",
    command: "init",
    target,
    fileCount: baselineContent.size,
  })}\n`);
  return 0;
}
