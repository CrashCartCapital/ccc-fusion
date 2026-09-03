import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildGate2TelemetryVerifierSource } from "./ccc-gate2-telemetry-verifier-source.mjs";

const candidateInputs = [
  "src/contract.ts", "src/ingest.ts", "src/audit.ts", "src/broadcast.ts",
  "src/health-cli.ts", "README.md", "src/app.ts", "tests/telemetry.test.ts",
];

const phaseCandidateInputs = Object.freeze({
  contract: ["src/contract.ts"],
  ingest: ["src/contract.ts", "src/ingest.ts"],
  audit: ["src/contract.ts", "src/audit.ts"],
  broadcast: ["src/contract.ts", "src/broadcast.ts"],
  cli: [
    "src/contract.ts", "src/ingest.ts", "src/audit.ts", "src/broadcast.ts",
    "src/health-cli.ts", "README.md",
  ],
  candidate: candidateInputs,
  integrated: candidateInputs,
});

const scripts = Object.fromEntries(
  [...Object.keys(phaseCandidateInputs), "build", "test"].map((name) => {
    const phase = name === "build" ? "candidate" : name === "test" ? "integrated" : name;
    return [name.startsWith("verify:") ? name : ["build", "test"].includes(name) ? name : `verify:${name}`,
      `node verify/project-verifier.mjs ${phaseCandidateInputs[phase].join(" ")}`];
  }),
);

const baselineContent = new Map([
  [".gitignore", ".fusion/\n.fusion-global-settings/\n.worktrees/\ndata/\n"],
  ["package.json", `${JSON.stringify({
    name: "gate2-telemetry-service",
    version: "1.0.0",
    private: true,
    type: "module",
    engines: { node: ">=24" },
    scripts,
  }, null, 2)}\n`],
  ["Taskfile.yml", [
    "version: '3'", "", "tasks:",
    ...Object.entries(phaseCandidateInputs).flatMap(([phase]) => [
      `  verify:${phase}:`, "    cmds:", `      - node verify/project-verifier.mjs ${phaseCandidateInputs[phase].join(" ")}`,
    ]),
    "", "  build:", "    cmds:", `      - node verify/project-verifier.mjs ${phaseCandidateInputs.candidate.join(" ")}`,
    "", "  test:", "    cmds:", `      - node verify/project-verifier.mjs ${phaseCandidateInputs.integrated.join(" ")}`, "",
  ].join("\n")],
  ["fixtures/events.json", `${JSON.stringify({
    valid: { id: "evt-001", type: "temperature", observedAt: "2026-09-01T12:00:00Z", payload: { celsius: 21.5 } },
    invalid: { id: "evt-invalid", observedAt: "not-a-timestamp", payload: null, extra: true },
  }, null, 2)}\n`],
  ["verify/project-verifier.mjs", buildGate2TelemetryVerifierSource(phaseCandidateInputs)],
]);

export async function createGate2TelemetryBaseline(root) {
  try {
    if ((await readdir(root)).length > 0) throw new Error("target is not empty");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const stagingRoot = await mkdtemp(path.join(path.dirname(root), `.${path.basename(root)}-staging-`));
  try {
    for (const [relativePath, content] of baselineContent) {
      const absolutePath = path.join(stagingRoot, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, { flag: "wx" });
    }
    await rename(stagingRoot, root);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}
