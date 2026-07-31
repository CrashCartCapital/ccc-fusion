import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as engine from "../index.js";
import { readCccPrdPacketCustody } from "../ccc-prd/custody.js";

type DiscoveryResult = {
  schema: "ccc-prd.discovery.v1";
  activeProjectsRoot: string;
  projects: Array<{
    project: string;
    projectRoot: string;
    candidates: Array<{
      path: string;
      projectRelativePath: string;
      version: string | null;
      status: string | null;
      score: {
        semver: [number, number, number] | null;
        status: number;
        signal: number;
      };
    }>;
    selection:
      | { kind: "selected"; selectedPrdPath: string }
      | { kind: "ambiguous"; candidatePaths: string[]; reason: string }
      | { kind: "none" };
  }>;
};

type FreezeResult = {
  schema: "ccc-prd.freeze-result.v1";
  rootDir: string;
  manifestPath: string;
  receiptPath: string;
  selectedPrdPath: string;
  packet: {
    schema: "ccc-prd.packet.v1";
    sourceVersion: string;
    manifestSha256: string;
    packetHash: string;
    receiptSha256: string;
    fileCount: number;
    totalBytes: number;
    unresolvedReferenceCount: number;
    project: string;
    selectedPrdPath: string;
  };
  unresolvedReferences: Array<{
    sourcePath: string;
    sourceRelativePath: string;
    target: string;
    kind: "wiki" | "markdown";
    reason: "missing" | "ambiguous" | "outside" | "protected" | "archive" | "symlink";
  }>;
};

const ccc = engine as typeof engine & {
  discoverCccPrdCandidates(input: { activeProjectsRoot: string }): DiscoveryResult;
  freezeCccPrdPacket(input: {
    activeProjectsRoot: string;
    selectedPrdPath: string;
    outputDir: string;
  }): FreezeResult;
};

const roots: string[] = [];
const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot(prefix = "ccc-prd-intake-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function write(root: string, relativePath: string, content: string | Buffer): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function expectIntakeError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("CCC PRD discovery", () => {
  it("scores current PRDs per project and reports an exact tie as ambiguous", () => {
    const root = fixtureRoot();
    const activeProjectsRoot = write(root, "active/.keep", "").slice(0, -"/.keep".length);
    write(root, "active/project-tracker.md", [
      "# Tracker is not PRD authority",
      "Project Alpha says the old v1.0.0 file is selected.",
    ].join("\n"));
    write(root, "active/alpha/PRJ-AI-alpha-PRD-v1.0.0.md", [
      "---",
      "status: approved",
      "version: 1.0.0",
      "---",
      "# Alpha PRD",
    ].join("\n"));
    const alphaSelected = write(root, "active/alpha/specs/PRJ-AI-alpha-PRD-v1.1.0.md", [
      "---",
      "status: draft",
      "version: 1.1.0",
      "---",
      "# Alpha next PRD",
    ].join("\n"));
    write(root, "active/alpha/_archive/PRJ-AI-alpha-PRD-v99.0.0.md", "# archived");
    const betaA = write(root, "active/beta/a/PRJ-AI-beta-PRD-v2.0.0.md", [
      "---",
      "status: active",
      "---",
      "# Beta PRD",
    ].join("\n"));
    const betaB = write(root, "active/beta/b/PRJ-AI-beta-PRD-v2.0.0.md", [
      "---",
      "status: active",
      "---",
      "# Beta PRD",
    ].join("\n"));
    write(root, "active/.obsidian/PRJ-AI-hidden-PRD-v100.0.0.md", "# protected");
    write(root, "active/_sunset/PRJ-AI-retired-PRD-v100.0.0.md", "# retired");
    write(root, "active/gamma/PRJ-AI-gamma-PRD-v3.0.0.md", [
      "---",
      "status: superseded",
      "---",
      "# Superseded Gamma PRD",
    ].join("\n"));

    const first = ccc.discoverCccPrdCandidates({ activeProjectsRoot });
    const second = ccc.discoverCccPrdCandidates({ activeProjectsRoot });

    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schema: "ccc-prd.discovery.v1",
      activeProjectsRoot: resolve(activeProjectsRoot),
    });
    expect(first.projects.map((project) => project.project)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    const alpha = first.projects[0]!;
    expect(alpha.selection).toEqual({
      kind: "selected",
      selectedPrdPath: resolve(alphaSelected),
    });
    expect(alpha.candidates.map((candidate) => candidate.projectRelativePath)).toEqual([
      "PRJ-AI-alpha-PRD-v1.0.0.md",
      "specs/PRJ-AI-alpha-PRD-v1.1.0.md",
    ]);
    expect(alpha.candidates[1]).toMatchObject({
      version: "1.1.0",
      status: "draft",
      score: { semver: [1, 1, 0] },
    });
    expect(first.projects[1]!.selection).toEqual({
      kind: "ambiguous",
      candidatePaths: [resolve(betaA), resolve(betaB)],
      reason: "multiple current PRD candidates share the highest project-local semver/status score",
    });
    expect(first.projects[2]!.selection).toEqual({ kind: "none" });
  });

  it("uses an explicit PRD filename signal to break an otherwise equal project-local tie", () => {
    const root = fixtureRoot();
    const activeProjectsRoot = join(root, "active");
    const selectedPrdPath = write(
      activeProjectsRoot,
      "alpha/PRJ-AI-alpha-PRD-v1.0.0.md",
      [
        "---",
        "status: active",
        "version: 1.0.0",
        "---",
        "# Alpha PRD v1.0.0",
      ].join("\n"),
    );
    write(
      activeProjectsRoot,
      "alpha/conversion-plan-v1.0.0.md",
      [
        "---",
        "status: active",
        "version: 1.0.0",
        "---",
        "# Alpha PRD conversion progress",
      ].join("\n"),
    );

    const result = ccc.discoverCccPrdCandidates({ activeProjectsRoot });

    expect(result.projects[0]?.selection).toEqual({
      kind: "selected",
      selectedPrdPath: resolve(selectedPrdPath),
    });
  });
});

describe("CCC PRD packet freeze", () => {
  it("resolves vault-qualified references that remain inside the selected project", () => {
    const root = fixtureRoot();
    const activeProjectsRoot = join(root, "active");
    const selectedPrdPath = write(
      activeProjectsRoot,
      "alpha/PRD-v1.0.0.md",
      [
        "# Alpha PRD",
        "## Source Set",
        "- `00_MAIN/01_ActiveProjects/alpha/support/Authority.md`",
        "## Source map and authority levels",
        "The target repository will contain `CLAUDE.md`; it is not a packet source.",
      ].join("\n"),
    );
    write(activeProjectsRoot, "alpha/support/Authority.md", "# Authority\n");
    const outputDir = join(root, "out", "qualified");

    const result = ccc.freezeCccPrdPacket({
      activeProjectsRoot,
      selectedPrdPath,
      outputDir,
    });

    expect(result.packet.fileCount).toBe(2);
    expect(result.unresolvedReferences).toEqual([]);
    expect(existsSync(join(outputDir, "sources/support/Authority.md"))).toBe(true);
  });

  it("recursively freezes exact Markdown bytes with authority, roles, and custody-compatible hashes", () => {
    const root = fixtureRoot();
    const activeProjectsRoot = join(root, "active");
    const outputDir = join(root, "frozen", "alpha-v1.2.3");
    mkdirSync(activeProjectsRoot, { recursive: true });
    mkdirSync(dirname(outputDir), { recursive: true });
    const selectedBytes = Buffer.from([
      "---",
      "status: active",
      "version: 1.2.3",
      "---",
      "# Alpha PRD v1.2.3",
      "",
      "## Source Set / Authority",
      "- [[modules/Production-Module]]",
      "- [Blocking proof index](tests/Blocking-Test-Index.md)",
      "",
      "## Non-authoritative context",
      "See [operator guide](support/Guide.md).",
    ].join("\n"));
    const selectedPrdPath = write(
      activeProjectsRoot,
      "alpha/PRJ-AI-alpha-PRD-v1.2.3.md",
      selectedBytes,
    );
    const productionPath = write(activeProjectsRoot, "alpha/modules/Production-Module.md", [
      "# Production Module",
      "The module depends on `../support/Extra Context.md`.",
      "It also links back to [[../PRJ-AI-alpha-PRD-v1.2.3]].",
    ].join("\n"));
    const blockingPath = write(
      activeProjectsRoot,
      "alpha/tests/Blocking-Test-Index.md",
      "# Blocking Test Index\n",
    );
    const guidePath = write(activeProjectsRoot, "alpha/support/Guide.md", [
      "# Guide",
      "See [extra](<Extra Context.md>).",
    ].join("\n"));
    const extraBytes = Buffer.from("# Extra support\nbyte-for-byte\n");
    const extraPath = write(
      activeProjectsRoot,
      "alpha/support/Extra Context.md",
      extraBytes,
    );

    const result = ccc.freezeCccPrdPacket({
      activeProjectsRoot,
      selectedPrdPath,
      outputDir,
    });

    expect(result).toMatchObject({
      schema: "ccc-prd.freeze-result.v1",
      rootDir: resolve(outputDir),
      manifestPath: join(resolve(outputDir), "manifest.json"),
      receiptPath: join(resolve(outputDir), "freeze-receipt.json"),
      selectedPrdPath: resolve(selectedPrdPath),
      packet: {
        schema: "ccc-prd.packet.v1",
        sourceVersion: "v1.2.3",
        fileCount: 5,
        project: "alpha",
        selectedPrdPath: resolve(selectedPrdPath),
      },
    });
    expect(readFileSync(join(outputDir, "sources/PRJ-AI-alpha-PRD-v1.2.3.md")))
      .toEqual(selectedBytes);
    expect(readFileSync(join(outputDir, "sources/support/Extra Context.md")))
      .toEqual(extraBytes);

    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as {
      schema: string;
      source_version: string;
      entries: Array<{
        relative_path: string;
        role: string;
        sha256: string;
        authoritative: boolean;
      }>;
    };
    expect(manifest).toEqual({
      schema: "ccc-prd.packet.v1",
      source_version: "v1.2.3",
      entries: [
        {
          relative_path: "sources/PRJ-AI-alpha-PRD-v1.2.3.md",
          role: "root",
          sha256: sha256(selectedBytes),
          authoritative: true,
        },
        {
          relative_path: "sources/modules/Production-Module.md",
          role: "production_module",
          sha256: sha256(readFileSync(productionPath)),
          authoritative: true,
        },
        {
          relative_path: "sources/support/Extra Context.md",
          role: "support",
          sha256: sha256(extraBytes),
          authoritative: false,
        },
        {
          relative_path: "sources/support/Guide.md",
          role: "support",
          sha256: sha256(readFileSync(guidePath)),
          authoritative: false,
        },
        {
          relative_path: "sources/tests/Blocking-Test-Index.md",
          role: "blocking_test_index",
          sha256: sha256(readFileSync(blockingPath)),
          authoritative: true,
        },
      ],
    });
    const custody = readCccPrdPacketCustody({
      rootDir: result.rootDir,
      manifestPath: result.manifestPath,
    });
    expect(result.packet.packetHash).toBe(custody.packetHash);
    expect(result.packet.manifestSha256).toBe(custody.manifestSha256);

    const receiptBytes = readFileSync(result.receiptPath);
    const receipt = JSON.parse(receiptBytes.toString("utf8")) as {
      schema: string;
      selectedPrdPath: string;
      entries: Array<{
        originPath: string;
        frozenPath: string;
        sha256: string;
        role: string;
        authoritative: boolean;
      }>;
    };
    expect(receipt.schema).toBe("ccc-prd.freeze-receipt.v1");
    expect(receipt.selectedPrdPath).toBe(resolve(selectedPrdPath));
    expect(receipt.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        originPath: resolve(selectedPrdPath),
        frozenPath: join(resolve(outputDir), "sources/PRJ-AI-alpha-PRD-v1.2.3.md"),
        role: "root",
        authoritative: true,
      }),
      expect.objectContaining({
        originPath: resolve(productionPath),
        role: "production_module",
        authoritative: true,
      }),
      expect.objectContaining({
        originPath: resolve(extraPath),
        role: "support",
        authoritative: false,
      }),
    ]));
    expect(result.packet.receiptSha256).toBe(sha256(receiptBytes));
  });

  it("refuses missing and ambiguous declared authority without output residue", () => {
    const root = fixtureRoot();
    const activeProjectsRoot = join(root, "active");
    const missingOutput = join(root, "out", "missing");
    const missingPrd = write(activeProjectsRoot, "missing/PRD-v1.0.0.md", [
      "# Missing",
      "## Authority",
      "- [[Does-Not-Exist]]",
    ].join("\n"));

    expectIntakeError(() => ccc.freezeCccPrdPacket({
      activeProjectsRoot,
      selectedPrdPath: missingPrd,
      outputDir: missingOutput,
    }), "CCC_PRD_DECLARED_AUTHORITY_MISSING");
    expect(existsSync(missingOutput)).toBe(false);

    const ambiguousOutput = join(root, "out", "ambiguous");
    const ambiguousPrd = write(activeProjectsRoot, "ambiguous/PRD-v2.0.0.md", [
      "# Ambiguous",
      "## Source Set",
      "- [[Shared-Module]]",
    ].join("\n"));
    write(activeProjectsRoot, "ambiguous/one/Shared-Module.md", "# One");
    write(activeProjectsRoot, "ambiguous/two/Shared-Module.md", "# Two");

    expectIntakeError(() => ccc.freezeCccPrdPacket({
      activeProjectsRoot,
      selectedPrdPath: ambiguousPrd,
      outputDir: ambiguousOutput,
    }), "CCC_PRD_DECLARED_AUTHORITY_AMBIGUOUS");
    expect(existsSync(ambiguousOutput)).toBe(false);

    const absoluteOutput = join(root, "out", "absolute");
    const absolutePrd = write(activeProjectsRoot, "absolute/PRD-v3.0.0.md", [
      "# Absolute",
      "## Authority",
      "- `/tmp/deceptive.md`",
    ].join("\n"));
    write(activeProjectsRoot, "absolute/tmp/deceptive.md", "# Internal lookalike");
    expectIntakeError(() => ccc.freezeCccPrdPacket({
      activeProjectsRoot,
      selectedPrdPath: absolutePrd,
      outputDir: absoluteOutput,
    }), "CCC_PRD_DECLARED_AUTHORITY_OUTSIDE_PROJECT");
    expect(existsSync(absoluteOutput)).toBe(false);

    const supportMissingOutput = join(root, "out", "support-missing");
    const supportMissingPrd = write(
      activeProjectsRoot,
      "support-missing/PRD-v4.0.0.md",
      "# Support missing\nSee [missing support](Missing-Support.md).\n",
    );
    const supportMissing = ccc.freezeCccPrdPacket({
      activeProjectsRoot,
      selectedPrdPath: supportMissingPrd,
      outputDir: supportMissingOutput,
    });
    expect(supportMissing.packet.unresolvedReferenceCount).toBe(1);
    expect(supportMissing.unresolvedReferences).toEqual([
      expect.objectContaining({
        target: "Missing-Support.md",
        kind: "markdown",
        reason: "missing",
      }),
    ]);
    expect(existsSync(supportMissingOutput)).toBe(true);

    const supportAmbiguousOutput = join(root, "out", "support-ambiguous");
    const supportAmbiguousPrd = write(
      activeProjectsRoot,
      "support-ambiguous/PRD-v5.0.0.md",
      "# Support ambiguous\nSee [[Shared-Support]].\n",
    );
    write(activeProjectsRoot, "support-ambiguous/one/Shared-Support.md", "# One");
    write(activeProjectsRoot, "support-ambiguous/two/Shared-Support.md", "# Two");
    const supportAmbiguous = ccc.freezeCccPrdPacket({
      activeProjectsRoot,
      selectedPrdPath: supportAmbiguousPrd,
      outputDir: supportAmbiguousOutput,
    });
    expect(supportAmbiguous.packet.unresolvedReferenceCount).toBe(1);
    expect(supportAmbiguous.unresolvedReferences).toEqual([
      expect.objectContaining({
        target: "Shared-Support",
        kind: "wiki",
        reason: "ambiguous",
      }),
    ]);
    expect(existsSync(supportAmbiguousOutput)).toBe(true);
  });

  it("refuses symlink, protected, in-tree, and pre-existing targets without residue", () => {
    const root = fixtureRoot();
    const activeProjectsRoot = join(root, "active");
    const realPrd = write(activeProjectsRoot, "alpha/real/PRD-v1.0.0.md", "# Real");
    const symlinkPrd = join(activeProjectsRoot, "alpha/PRD-v1.0.0.md");
    symlinkSync(realPrd, symlinkPrd);
    const symlinkOutput = join(root, "out", "symlink");

    expectIntakeError(() => ccc.freezeCccPrdPacket({
      activeProjectsRoot,
      selectedPrdPath: symlinkPrd,
      outputDir: symlinkOutput,
    }), "CCC_PRD_INTAKE_SYMLINK");
    expect(existsSync(symlinkOutput)).toBe(false);

    const linkedTarget = write(activeProjectsRoot, "linked/real-support.md", "# Real support");
    const linkedSupport = join(activeProjectsRoot, "linked/support.md");
    symlinkSync(linkedTarget, linkedSupport);
    const linkedPrd = write(activeProjectsRoot, "linked/PRD-v1.0.0.md", [
      "# Linked PRD",
      "## Source Set",
      "[support](support.md)",
    ].join("\n"));
    const linkedOutput = join(root, "out", "linked");
    expectIntakeError(() => ccc.freezeCccPrdPacket({
      activeProjectsRoot,
      selectedPrdPath: linkedPrd,
      outputDir: linkedOutput,
    }), "CCC_PRD_INTAKE_SYMLINK");
    expect(existsSync(linkedOutput)).toBe(false);

    const readmePath = write(activeProjectsRoot, "not-prd/README.md", "# Operator notes");
    const readmeOutput = join(root, "out", "not-prd");
    expectIntakeError(() => ccc.freezeCccPrdPacket({
      activeProjectsRoot,
      selectedPrdPath: readmePath,
      outputDir: readmeOutput,
    }), "CCC_PRD_INTAKE_SOURCE_INVALID");
    expect(existsSync(readmeOutput)).toBe(false);

    const protectedPrd = write(activeProjectsRoot, "protected/PRD-v1.0.0.md", [
      "# Protected reference",
      "## Supporting context",
      "- [.obsidian note](.obsidian/Secret.md)",
    ].join("\n"));
    write(activeProjectsRoot, "protected/.obsidian/Secret.md", "must never be read");
    const protectedOutput = join(root, "out", "protected");
    const protectedResult = ccc.freezeCccPrdPacket({
      activeProjectsRoot,
      selectedPrdPath: protectedPrd,
      outputDir: protectedOutput,
    });
    expect(protectedResult.unresolvedReferences).toEqual([
      expect.objectContaining({
        target: ".obsidian/Secret.md",
        reason: "protected",
      }),
    ]);
    expect(existsSync(protectedOutput)).toBe(true);
    expect(existsSync(join(protectedOutput, "sources/.obsidian/Secret.md"))).toBe(false);

    const archivePrd = write(activeProjectsRoot, "historical-link/PRD-v1.0.0.md", [
      "# Archive reference",
      "See [retired source](_archive/Retired.md).",
    ].join("\n"));
    write(activeProjectsRoot, "historical-link/_archive/Retired.md", "must never be read");
    const archiveOutput = join(root, "out", "historical-link");
    const archiveResult = ccc.freezeCccPrdPacket({
      activeProjectsRoot,
      selectedPrdPath: archivePrd,
      outputDir: archiveOutput,
    });
    expect(archiveResult.unresolvedReferences).toEqual([
      expect.objectContaining({
        target: "_archive/Retired.md",
        reason: "archive",
      }),
    ]);
    expect(existsSync(archiveOutput)).toBe(true);
    expect(existsSync(join(archiveOutput, "sources/_archive/Retired.md"))).toBe(false);

    const inTreeOutput = join(activeProjectsRoot, "protected/frozen");
    expectIntakeError(() => ccc.freezeCccPrdPacket({
      activeProjectsRoot,
      selectedPrdPath: protectedPrd,
      outputDir: inTreeOutput,
    }), "CCC_PRD_INTAKE_OUTPUT_INSIDE_SOURCE");
    expect(existsSync(inTreeOutput)).toBe(false);

    const existingOutput = join(root, "out", "existing");
    mkdirSync(existingOutput, { recursive: true });
    expectIntakeError(() => ccc.freezeCccPrdPacket({
      activeProjectsRoot,
      selectedPrdPath: realPrd,
      outputDir: existingOutput,
    }), "CCC_PRD_INTAKE_OUTPUT_EXISTS");
  });

  it("enforces the 128 file and 10 MiB packet bounds before publishing output", () => {
    const root = fixtureRoot();
    const activeProjectsRoot = join(root, "active");
    const countLinks = Array.from(
      { length: 128 },
      (_, index) => `- [support ${index}](support/file-${index}.md)`,
    );
    const countPrd = write(activeProjectsRoot, "count/PRD-v1.0.0.md", [
      "# Count bound",
      ...countLinks,
    ].join("\n"));
    for (let index = 0; index < 128; index += 1) {
      write(activeProjectsRoot, `count/support/file-${index}.md`, `# ${index}\n`);
    }
    const countOutput = join(root, "out", "count");
    expectIntakeError(() => ccc.freezeCccPrdPacket({
      activeProjectsRoot,
      selectedPrdPath: countPrd,
      outputDir: countOutput,
    }), "CCC_PRD_INTAKE_FILE_LIMIT");
    expect(existsSync(countOutput)).toBe(false);

    const sizePrd = write(activeProjectsRoot, "size/PRD-v1.0.0.md", [
      "# Size bound",
      "[large](large.md)",
    ].join("\n"));
    const largePath = write(
      activeProjectsRoot,
      "size/large.md",
      "",
    );
    truncateSync(largePath, 64 * 1024 * 1024);
    chmodSync(largePath, 0);
    const sizeOutput = join(root, "out", "size");
    expectIntakeError(() => ccc.freezeCccPrdPacket({
      activeProjectsRoot,
      selectedPrdPath: sizePrd,
      outputDir: sizeOutput,
    }), "CCC_PRD_INTAKE_BYTE_LIMIT");
    expect(existsSync(sizeOutput)).toBe(false);
  });
});
