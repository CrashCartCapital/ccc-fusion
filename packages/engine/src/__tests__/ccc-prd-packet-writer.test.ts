/*
FNXC:CccPacketWriter 2026-10-14-09:30:
Request-to-code planning (card B4) must write its compile packet with the very
same manifest-plus-staged-rename tail that `freezeCccPrdPacket` uses, so one
writer owns the bytes custody later re-hashes. These tests pin that writer to a
fixture recorded from the freeze path BEFORE the tail was extracted (manifest
text, manifestSha256 and packetHash below were produced by the unmodified
`freezeCccPrdPacket` on the same five Markdown sources). A stub that returns
empty hashes, or an extraction that drifts by one byte, fails the recorded
equalities rather than a missing import.
*/
import { createHash } from "node:crypto";
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
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCccPrdPacketCustody } from "../ccc-prd/custody.js";
import {
  freezeCccPrdPacket,
  writeCccPrdPacketFiles,
  type CccPrdPacketSourceInput,
} from "../ccc-prd/intake.js";

const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

// Recorded from the unmodified freezeCccPrdPacket (base a08af2c73) on the
// five sources below. The hashes do not depend on any filesystem path.
const RECORDED_MANIFEST_SHA256 =
  "ad547513dc5544196c509fdb0cf8425b7f244a208639fe7a169734c100822fae";
const RECORDED_PACKET_HASH =
  "84c781ad7ef6ee2c45cb085593a91b3e19c83d4131a44876497af045eb58db27";
const RECORDED_TOTAL_BYTES = 458;
const RECORDED_MANIFEST_TEXT =
  "{\"entries\":[{\"authoritative\":true,\"relative_path\":\"sources/PRJ-AI-alpha-PRD-v1.2.3.md\",\"role\":\"root\",\"sha256\":\"00ce433e3eef65eb013da79abd355ec3b29699735fb72c22aa85e6922e9dcc23\"},{\"authoritative\":true,\"relative_path\":\"sources/modules/Production-Module.md\",\"role\":\"production_module\",\"sha256\":\"ab584eee8cb1ec5ad085de0b0f47d6e373f2be1c354a71bbbb0a75ed99805cbc\"},{\"authoritative\":false,\"relative_path\":\"sources/support/Extra Context.md\",\"role\":\"support\",\"sha256\":\"0e21c3eeaf0881731cc1410e1f19fc6583e2d32cce414592dde48b755c32de70\"},{\"authoritative\":false,\"relative_path\":\"sources/support/Guide.md\",\"role\":\"support\",\"sha256\":\"d48e5bd893778e340d1431d2d6627eb81bed07e06eec835e7a6e02e3a244c9d2\"},{\"authoritative\":true,\"relative_path\":\"sources/tests/Blocking-Test-Index.md\",\"role\":\"blocking_test_index\",\"sha256\":\"f5fd7a1e39986bbeaec51643d315ae98b6dfda953aa3e6371cd4c5f1f060764e\"}],\"schema\":\"ccc-prd.packet.v1\",\"source_version\":\"v1.2.3\"}\n";

const FIXTURE_FILES: ReadonlyArray<{
  projectRelativePath: string;
  bytes: Buffer;
  role: string;
  authoritative: boolean;
}> = [
  {
    projectRelativePath: "PRJ-AI-alpha-PRD-v1.2.3.md",
    bytes: Buffer.from([
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
    ].join("\n")),
    role: "root",
    authoritative: true,
  },
  {
    projectRelativePath: "modules/Production-Module.md",
    bytes: Buffer.from([
      "# Production Module",
      "The module depends on `../support/Extra Context.md`.",
      "It also links back to [[../PRJ-AI-alpha-PRD-v1.2.3]].",
    ].join("\n")),
    role: "production_module",
    authoritative: true,
  },
  {
    projectRelativePath: "support/Extra Context.md",
    bytes: Buffer.from("# Extra support\nbyte-for-byte\n"),
    role: "support",
    authoritative: false,
  },
  {
    projectRelativePath: "support/Guide.md",
    bytes: Buffer.from(["# Guide", "See [extra](<Extra Context.md>)."].join("\n")),
    role: "support",
    authoritative: false,
  },
  {
    projectRelativePath: "tests/Blocking-Test-Index.md",
    bytes: Buffer.from("# Blocking Test Index\n"),
    role: "blocking_test_index",
    authoritative: true,
  },
];

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ccc-prd-packet-writer-"));
  roots.push(root);
  return root;
}

function writeFixtureProject(activeProjectsRoot: string): string {
  for (const file of FIXTURE_FILES) {
    const path = join(activeProjectsRoot, "alpha", file.projectRelativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.bytes);
  }
  return join(activeProjectsRoot, "alpha", FIXTURE_FILES[0]!.projectRelativePath);
}

/** Every regular file under `root`, keyed by POSIX-relative path, valued by content hash. */
function snapshotTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(root, path).split("\\").join("/")] = sha256(readFileSync(path));
    }
  };
  walk(root);
  return files;
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

describe("CCC PRD packet writer", () => {
  it("reproduces the recorded freeze manifest hash and packet hash from the same sources and receipt", () => {
    const root = fixtureRoot();
    const outputDir = join(root, "out", "nested", "packet");
    const receiptBytes = Buffer.from("{\"fixture\":\"freeze-receipt\"}\n");

    const written = writeCccPrdPacketFiles({
      outputDir,
      sourceVersion: "v1.2.3",
      sources: FIXTURE_FILES,
      extraFiles: [{ name: "freeze-receipt.json", bytes: receiptBytes }],
    });

    expect(written.manifestSha256).toBe(RECORDED_MANIFEST_SHA256);
    expect(written.packetHash).toBe(RECORDED_PACKET_HASH);
    expect(written.rootDir).toBe(outputDir);
    expect(written.manifestPath).toBe(join(outputDir, "manifest.json"));
    expect(readFileSync(written.manifestPath, "utf8")).toBe(RECORDED_MANIFEST_TEXT);
    expect(sha256(readFileSync(written.manifestPath))).toBe(written.manifestSha256);
    expect(readFileSync(join(outputDir, "freeze-receipt.json")).equals(receiptBytes)).toBe(true);
    for (const file of FIXTURE_FILES) {
      expect(
        readFileSync(join(outputDir, "sources", ...file.projectRelativePath.split("/")))
          .equals(file.bytes),
      ).toBe(true);
    }
    expect(Object.keys(snapshotTree(outputDir)).sort()).toEqual([
      "freeze-receipt.json",
      "manifest.json",
      ...FIXTURE_FILES.map((file) => `sources/${file.projectRelativePath}`),
    ].sort());
  });

  it("keeps freeze output equal to the recorded pre-extraction output and to a writer replay of its sources and receipt", () => {
    const root = fixtureRoot();
    const activeProjectsRoot = join(root, "active");
    const selectedPrdPath = writeFixtureProject(activeProjectsRoot);
    const frozenDir = join(root, "frozen", "alpha-v1.2.3");
    mkdirSync(dirname(frozenDir), { recursive: true });

    const frozen = freezeCccPrdPacket({
      activeProjectsRoot,
      selectedPrdPath,
      outputDir: frozenDir,
    });

    expect(frozen.packet).toMatchObject({
      sourceVersion: "v1.2.3",
      manifestSha256: RECORDED_MANIFEST_SHA256,
      packetHash: RECORDED_PACKET_HASH,
      fileCount: FIXTURE_FILES.length,
      totalBytes: RECORDED_TOTAL_BYTES,
    });
    expect(readFileSync(frozen.manifestPath, "utf8")).toBe(RECORDED_MANIFEST_TEXT);

    const receiptBytes = readFileSync(frozen.receiptPath);
    const receipt = JSON.parse(receiptBytes.toString("utf8")) as {
      manifestSha256: string;
      packetHash: string;
      entries: Array<{
        relativePath: string;
        projectRelativePath: string;
        role: string;
        authoritative: boolean;
      }>;
    };
    expect(receipt.manifestSha256).toBe(RECORDED_MANIFEST_SHA256);
    expect(receipt.packetHash).toBe(RECORDED_PACKET_HASH);
    expect(frozen.packet.receiptSha256).toBe(sha256(receiptBytes));

    const replayed: CccPrdPacketSourceInput[] = receipt.entries.map((entry) => ({
      projectRelativePath: entry.projectRelativePath,
      bytes: readFileSync(join(frozenDir, ...entry.relativePath.split("/"))),
      role: entry.role,
      authoritative: entry.authoritative,
    }));
    const replayDir = join(root, "replay", "alpha-v1.2.3");
    const written = writeCccPrdPacketFiles({
      outputDir: replayDir,
      sourceVersion: frozen.packet.sourceVersion,
      sources: replayed,
      extraFiles: [{ name: "freeze-receipt.json", bytes: receiptBytes }],
    });

    expect(written.manifestSha256).toBe(frozen.packet.manifestSha256);
    expect(written.packetHash).toBe(frozen.packet.packetHash);
    expect(snapshotTree(replayDir)).toEqual(snapshotTree(frozenDir));
    expect(readCccPrdPacketCustody({
      rootDir: replayDir,
      manifestPath: written.manifestPath,
    })).toMatchObject({
      manifestSha256: RECORDED_MANIFEST_SHA256,
      packetHash: RECORDED_PACKET_HASH,
    });
  });

  it("writes a planning-shaped packet that custody reads back with identical hashes regardless of source order", () => {
    const root = fixtureRoot();
    const planning: CccPrdPacketSourceInput[] = [
      ["__fusion__/planning/original-request.md", "original_request", "Add a retry button.\n"],
      ["__fusion__/planning/admission-facts.md", "support", "Target repository: /tmp/target\n"],
      ["__fusion__/planning/final-prd.md", "prd", "# Final PRD\n"],
      ["__fusion__/planning/technical-annex.md", "technical_annex", "# Annex\nDEC-001\n"],
    ].map(([projectRelativePath, role, text]) => ({
      projectRelativePath: projectRelativePath!,
      role: role!,
      bytes: Buffer.from(text!),
      authoritative: true,
    }));

    const forward = writeCccPrdPacketFiles({
      outputDir: join(root, "forward"),
      sourceVersion: "v1",
      sources: planning,
    });
    const reversed = writeCccPrdPacketFiles({
      outputDir: join(root, "reversed"),
      sourceVersion: "v1",
      sources: [...planning].reverse(),
    });

    expect(forward.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(forward.packetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(reversed.manifestSha256).toBe(forward.manifestSha256);
    expect(reversed.packetHash).toBe(forward.packetHash);
    expect(snapshotTree(join(root, "reversed"))).toEqual(snapshotTree(join(root, "forward")));
    const custody = readCccPrdPacketCustody({
      rootDir: join(root, "forward"),
      manifestPath: forward.manifestPath,
    });
    expect(custody.manifestSha256).toBe(forward.manifestSha256);
    expect(custody.packetHash).toBe(forward.packetHash);
    expect(custody.sources.map((source) => [source.path, source.role])).toEqual([
      ["sources/__fusion__/planning/admission-facts.md", "support"],
      ["sources/__fusion__/planning/final-prd.md", "prd"],
      ["sources/__fusion__/planning/original-request.md", "original_request"],
      ["sources/__fusion__/planning/technical-annex.md", "technical_annex"],
    ]);
  });

  it("changes both hashes when any single source byte or role changes", () => {
    const root = fixtureRoot();
    const base = writeCccPrdPacketFiles({
      outputDir: join(root, "base"),
      sourceVersion: "v1.2.3",
      sources: FIXTURE_FILES,
    });
    const flipped = FIXTURE_FILES.map((file, index) => index === 2
      ? { ...file, bytes: Buffer.concat([file.bytes, Buffer.from("x")]) }
      : file);
    const edited = writeCccPrdPacketFiles({
      outputDir: join(root, "edited"),
      sourceVersion: "v1.2.3",
      sources: flipped,
    });
    const reroled = writeCccPrdPacketFiles({
      outputDir: join(root, "reroled"),
      sourceVersion: "v1.2.3",
      sources: FIXTURE_FILES.map((file, index) => index === 3
        ? { ...file, role: "production_module" }
        : file),
    });
    const reversioned = writeCccPrdPacketFiles({
      outputDir: join(root, "reversioned"),
      sourceVersion: "v1.2.4",
      sources: FIXTURE_FILES,
    });

    for (const other of [edited, reroled, reversioned]) {
      expect(other.manifestSha256).not.toBe(base.manifestSha256);
      expect(other.packetHash).not.toBe(base.packetHash);
    }
    expect(base.manifestSha256).toBe(RECORDED_MANIFEST_SHA256);
  });

  it("refuses an existing output directory without touching it", () => {
    const root = fixtureRoot();
    const outputDir = join(root, "occupied");
    mkdirSync(outputDir);
    writeFileSync(join(outputDir, "keep.txt"), "keep");

    expectIntakeError(() => writeCccPrdPacketFiles({
      outputDir,
      sourceVersion: "v1.2.3",
      sources: FIXTURE_FILES,
    }), "CCC_PRD_INTAKE_OUTPUT_EXISTS");

    expect(readdirSync(outputDir)).toEqual(["keep.txt"]);
    expect(readFileSync(join(outputDir, "keep.txt"), "utf8")).toBe("keep");
    expect(readdirSync(root)).toEqual(["occupied"]);
  });

  it("refuses unsafe source paths and extra-file names before any filesystem effect", () => {
    const root = fixtureRoot();
    const outputDir = join(root, "fresh", "deep", "packet");
    const file = FIXTURE_FILES[0]!;
    const withPath = (projectRelativePath: string): CccPrdPacketSourceInput[] => [
      { ...file, projectRelativePath },
    ];

    for (const unsafe of ["../escape.md", "a/../../escape.md", "/abs.md", "a//b.md", "a/./b.md", "", "nul\0.md"]) {
      expectIntakeError(() => writeCccPrdPacketFiles({
        outputDir,
        sourceVersion: "v1.2.3",
        sources: withPath(unsafe),
      }), "CCC_PRD_INTAKE_PATH_ESCAPE");
    }
    expectIntakeError(() => writeCccPrdPacketFiles({
      outputDir,
      sourceVersion: "v1.2.3",
      sources: [file, { ...FIXTURE_FILES[1]!, projectRelativePath: file.projectRelativePath }],
    }), "CCC_PRD_INTAKE_SOURCE_INVALID");
    expectIntakeError(() => writeCccPrdPacketFiles({
      outputDir,
      sourceVersion: "v1.2.3",
      sources: [{ ...file, role: "" }],
    }), "CCC_PRD_INTAKE_SOURCE_INVALID");
    expectIntakeError(() => writeCccPrdPacketFiles({
      outputDir,
      sourceVersion: "",
      sources: FIXTURE_FILES,
    }), "CCC_PRD_INTAKE_SOURCE_INVALID");
    expectIntakeError(() => writeCccPrdPacketFiles({
      outputDir,
      sourceVersion: "v1.2.3",
      sources: FIXTURE_FILES.map((source) => ({ ...source, authoritative: false })),
    }), "CCC_PRD_INTAKE_SOURCE_INVALID");
    for (const name of ["manifest.json", "sources", "nested/receipt.json", "..", ""]) {
      expectIntakeError(() => writeCccPrdPacketFiles({
        outputDir,
        sourceVersion: "v1.2.3",
        sources: FIXTURE_FILES,
        extraFiles: [{ name, bytes: Buffer.from("x") }],
      }), "CCC_PRD_INTAKE_SOURCE_INVALID");
    }
    expectIntakeError(() => writeCccPrdPacketFiles({
      outputDir,
      sourceVersion: "v1.2.3",
      sources: FIXTURE_FILES,
      extraFiles: [
        { name: "receipt.json", bytes: Buffer.from("1") },
        { name: "receipt.json", bytes: Buffer.from("2") },
      ],
    }), "CCC_PRD_INTAKE_SOURCE_INVALID");

    expect(readdirSync(root)).toEqual([]);
  });

  it("removes its stage directory and created parents when a write fails midway", () => {
    const root = fixtureRoot();
    const existingParent = join(root, "existing");
    mkdirSync(existingParent);
    // "collide" is written as a file first, so "collide/child.md" cannot get a directory.
    const colliding: CccPrdPacketSourceInput[] = [
      { projectRelativePath: "collide", bytes: Buffer.from("file"), role: "support", authoritative: true },
      { projectRelativePath: "collide/child.md", bytes: Buffer.from("child"), role: "support", authoritative: true },
    ];

    expectIntakeError(() => writeCccPrdPacketFiles({
      outputDir: join(existingParent, "packet"),
      sourceVersion: "v1",
      sources: colliding,
    }), "CCC_PRD_INTAKE_WRITE_FAILED");
    expect(readdirSync(existingParent)).toEqual([]);

    expectIntakeError(() => writeCccPrdPacketFiles({
      outputDir: join(root, "fresh", "deep", "packet"),
      sourceVersion: "v1",
      sources: colliding,
    }), "CCC_PRD_INTAKE_WRITE_FAILED");
    expect(existsSync(join(root, "fresh"))).toBe(false);
    expect(readdirSync(root)).toEqual(["existing"]);
  });
});
