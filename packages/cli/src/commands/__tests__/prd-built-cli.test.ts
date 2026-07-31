import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPacketRoots,
  createPacketRoot,
  repoRoot,
  runFn,
  runFnAsync,
} from "./prd-built-cli-fixture.js";

afterEach(cleanupPacketRoots);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("prd built CLI user contract", () => {
  it("advertises author, validate, and compile from top-level help", () => {
    const result = runFn(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("fn prd author <root-dir> <manifest-path> <sidecar-output> --target <repository> --base <40-hex-commit> --provider <provider> --model <model>");
    expect(result.stdout).toContain("fn prd author <root-dir> <manifest-path> <proposal-path> <sidecar-output>");
    expect(result.stdout).toContain("fn prd discover <active-projects-root>");
    expect(result.stdout).toContain("fn prd freeze <active-projects-root> <selected-prd-path> <output-dir>");
    expect(result.stdout).toContain("fn prd template");
    expect(result.stdout).toContain("fn prd lint <prd-path>");
    expect(result.stdout).toContain("fn prd validate <root-dir> <manifest-path> <sidecar-path> <expected-target> <expected-base>");
    expect(result.stdout).toContain("fn prd compile <root-dir> <manifest-path> <sidecar-path> <expected-target> <expected-base>");
    expect(result.stdout).toContain("fn prd status <idempotency-key>");
    expect(result.stdout).toContain("fn prd pause <idempotency-key> --confirm <status-digest>");
    expect(result.stdout).toContain("fn prd resume <idempotency-key> --confirm <status-digest>");
    expect(result.stdout).toContain("fn prd stop <idempotency-key> --reason <reason> --confirm <status-digest>");
    expect(result.stdout).toContain("fn prd resolve-proof <idempotency-key> <attempt-key> <evidence-path>");
    expect(result.stdout).toContain("fn prd resolve-provider <idempotency-key> <attempt-key> <committed|proved-failed>");
    expect(result.stdout).toContain("fn prd approve-execution <idempotency-key>");
    expect(result.stdout).toContain("fn prd approve-merge <idempotency-key>");
  });

  it("discovers and freezes a project-local PRD through the built CLI without changing source bytes", () => {
    const packet = createPacketRoot();
    const activeProjectsRoot = join(packet.root, "active-projects");
    const projectRoot = join(activeProjectsRoot, "alpha");
    const selectedPrdPath = join(projectRoot, "PRJ-HUM-Alpha-PRD-v2.0.0.md");
    const supportPath = join(projectRoot, "REF-HUM-Alpha-Support.md");
    const outputDir = join(packet.root, "frozen-alpha");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(selectedPrdPath, `---
status: approved
version: 2.0.0
---
# Alpha Product Requirements

## Source Set

- [[REF-HUM-Alpha-Support]]
`);
    writeFileSync(supportPath, "# Alpha Support\n");
    const sourceBefore = readFileSync(selectedPrdPath);

    const discovered = runFn(["prd", "discover", activeProjectsRoot]);
    expect(discovered.status, `${discovered.stdout}\n${discovered.stderr}`).toBe(0);
    expect(JSON.parse(discovered.stdout)).toMatchObject({
      schema: "ccc-prd.discovery.v1",
      projects: [{
        project: "alpha",
        selection: {
          kind: "selected",
          selectedPrdPath,
        },
      }],
    });

    const frozen = runFn([
      "prd",
      "freeze",
      activeProjectsRoot,
      selectedPrdPath,
      outputDir,
    ]);
    expect(frozen.status, `${frozen.stdout}\n${frozen.stderr}`).toBe(0);
    expect(JSON.parse(frozen.stdout)).toMatchObject({
      schema: "ccc-prd.freeze-result.v1",
      rootDir: outputDir,
      selectedPrdPath,
      packet: {
        schema: "ccc-prd.packet.v1",
        sourceVersion: "v2.0.0",
        fileCount: 2,
        project: "alpha",
      },
    });
    expect(existsSync(join(outputDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(outputDir, "freeze-receipt.json"))).toBe(true);
    expect(readFileSync(selectedPrdPath).equals(sourceBefore)).toBe(true);
  });

  it("prints and lints the optional future-PRD contract through the built CLI", () => {
    const template = runFn(["prd", "template"]);
    expect(template.status, `${template.stdout}\n${template.stderr}`).toBe(0);
    expect(JSON.parse(template.stdout)).toMatchObject({
      kind: "prd-intake-template",
      schema: "ccc-prd.intake-contract.v1",
    });

    const packet = createPacketRoot();
    const prdPath = join(packet.root, "future-prd.md");
    writeFileSync(prdPath, "# Future PRD\n\n## Requirements\n\n- Make intake work.\n");
    const before = readFileSync(prdPath);
    const lint = runFn(["prd", "lint", prdPath]);
    expect(lint.status, `${lint.stdout}\n${lint.stderr}`).toBe(1);
    expect(JSON.parse(lint.stdout)).toMatchObject({
      schema: "ccc-prd.intake-contract.v1",
      optionalContract: true,
      readyForIntake: false,
      blockingQuestions: expect.arrayContaining([
        expect.objectContaining({ code: "CCC_PRD_TARGET_REPOSITORY_REQUIRED" }),
      ]),
    });
    expect(readFileSync(prdPath).equals(before)).toBe(true);
  });

  it("author writes the requested sidecar and validate/compile are zero-store user commands", () => {
    const packet = createPacketRoot();
    const tempPrefix = join(packet.root, ".fusion-prd-tmp");
    const author = runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, packet.sidecar]);
    expect(author.status, `${author.stdout}\n${author.stderr}`).toBe(0);
    expect(existsSync(packet.sidecar)).toBe(true);
    const sidecar = JSON.parse(readFileSync(packet.sidecar, "utf8")) as {
      proofs: Array<{ admission?: Record<string, unknown> }>;
    };
    expect(sidecar.proofs[0]?.admission).toMatchObject({
      schema: "ccc-prd.proof-admission.v1",
      pluginId: "fusion-native",
      pluginVersion: "1.0.0",
      extensionId: "ccc-proof-admission",
      proofVersion: "ccc-proof-admission.v1",
      extensionRootRelativeSource: "ccc-campaign-proof-admission.js",
      extensionSourceSha256: sha256(readFileSync(join(
        repoRoot,
        "packages/cli/dist/ccc-campaign-proof-admission.js",
      ))),
      extensionManifestSha256: sha256(readFileSync(join(
        repoRoot,
        "packages/cli/dist/plugins/fusion-native-proof-admission/manifest.json",
      ))),
    });
    const validate = runFn(["prd", "validate", packet.root, packet.manifest, packet.sidecar, packet.target, packet.base]);
    expect(validate.status).toBe(0);
    expect(JSON.parse(validate.stdout)).toMatchObject({ kind: "diagnostics" });
    expect(JSON.parse(validate.stdout)).not.toHaveProperty("requirements");
    const compile = runFn(["prd", "compile", packet.root, packet.manifest, packet.sidecar, packet.target, packet.base]);
    expect(compile.status).toBe(0);
    expect(JSON.parse(compile.stdout)).toMatchObject({ kind: "bundle" });
    expect(JSON.parse(compile.stdout)).toHaveProperty("requirements");
    expect(existsSync(tempPrefix)).toBe(false);
    expect(readFileSync(join(packet.root, "packet.md"), "utf8")).toContain("Dense PRD Packet");
  });

  it("returns stable usage and semantic-refusal exit codes", () => {
    const usage = runFn(["prd", "compile"]);
    expect(usage.status, `${usage.stdout}\n${usage.stderr}`).toBe(2);
    const packet = createPacketRoot();
    const semantic = runFn(["prd", "validate", packet.root, packet.manifest, join(packet.root, "missing.sidecar.json"), packet.target, packet.base]);
    expect(semantic.status).toBe(1);
    expect(semantic.stdout).toContain("CCC_PRD_UNDECLARED_COMPANION");
  });

  it("refuses product validation when the generated material coverage inventory is absent", () => {
    const packet = createPacketRoot();
    expect(runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, packet.sidecar]).status).toBe(0);
    const sidecar = JSON.parse(readFileSync(packet.sidecar, "utf8")) as {
      materialCoverage?: unknown;
    };
    delete sidecar.materialCoverage;
    writeFileSync(packet.sidecar, JSON.stringify(sidecar));

    const result = runFn([
      "prd",
      "validate",
      packet.root,
      packet.manifest,
      packet.sidecar,
      packet.target,
      packet.base,
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("CCC_PRD_MATERIAL_COVERAGE_REQUIRED");
  });

  it("preserves a product refusal exit code after embedded PostgreSQL cleanup", async () => {
    const packet = createPacketRoot();
    const home = join(packet.root, "home");
    const policy = join(packet.root, "execution-policy.json");
    mkdirSync(home);
    execFileSync("/usr/bin/git", ["init", "-q"], { cwd: packet.root });
    expect(runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, packet.sidecar]).status).toBe(0);
    writeFileSync(policy, JSON.stringify({
      schema: "ccc-campaign.execution-policy.v2",
      routes: [
        {
          taskId: "TASK-CLI-001",
          providerId: "deterministic-fake",
          modelId: "fixture-v2",
          transport: "pi",
          executor: "model",
          toolMode: "coding",
          worktreeMode: "isolated",
          ownedPaths: ["src/task-1"],
          allowedWriteRoots: ["src/task-1"],
          commitPolicy: "required",
        },
      ],
    }));

    const result = await runFnAsync(
      [
        "prd",
        "preview",
        packet.root,
        packet.manifest,
        packet.sidecar,
        policy,
        packet.target,
        packet.base,
      ],
      packet.root,
      {
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: join(home, ".codex"),
        DATABASE_URL: "",
        VITEST: "false",
      },
    );

    expect(result.stdout).toContain("CCC_PRD_PROJECT_OPERATION_FAILED");
    expect(result.stderr).toContain("embedded postgres: ready");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
  }, 60_000);

  it("refuses a foreign admitted target through built validate and compile", () => {
    const packet = createPacketRoot();
    expect(runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, packet.sidecar]).status).toBe(0);
    for (const command of ["validate", "compile"]) {
      const result = runFn(["prd", command, packet.root, packet.manifest, packet.sidecar, "foreign/repo", packet.base]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("CCC_PRD_FOREIGN_TARGET");
    }
  });

  it("refuses a foreign admitted base through built validate and compile", () => {
    const packet = createPacketRoot();
    expect(runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, packet.sidecar]).status).toBe(0);
    for (const command of ["validate", "compile"]) {
      const result = runFn(["prd", command, packet.root, packet.manifest, packet.sidecar, packet.target, "b".repeat(40)]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("CCC_PRD_FOREIGN_BASE");
    }
  });

  it.each(["packet.md", "manifest.json"])("refuses author output that would overwrite admitted %s bytes", (relativeOutput) => {
    const packet = createPacketRoot();
    const output = join(packet.root, relativeOutput);
    const before = readFileSync(output);
    const result = runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, output]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("CCC_PRD_SIDECAR_WRITE_FAILED");
    expect(readFileSync(output).equals(before)).toBe(true);
  });

  it("refuses author output that would overwrite an unrelated existing file", () => {
    const packet = createPacketRoot();
    const output = join(packet.root, "operator-notes.json");
    writeFileSync(output, "{\"keep\":true}\n");
    const before = readFileSync(output);
    const result = runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, output]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("CCC_PRD_SIDECAR_WRITE_FAILED");
    expect(readFileSync(output).equals(before)).toBe(true);
  });

  it("maintains an existing valid versioned sidecar", () => {
    const packet = createPacketRoot();
    const first = runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, packet.sidecar]);
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    const firstBytes = readFileSync(packet.sidecar);
    const second = runFn(["prd", "author", packet.root, packet.manifest, packet.proposal, packet.sidecar]);
    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expect(readFileSync(packet.sidecar).equals(firstBytes)).toBe(true);
  });
});
