import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assertGate2UsefulnessEvidence,
  buildGate2UsefulnessProbeSource,
  buildGate2LoopbackSandboxProfile,
  GATE2_USEFULNESS_CASE_IDS,
  runGate2TelemetryUsefulnessProbe,
} from "./helpers/ccc-gate2-usefulness-probe.js";

describe("CCC Gate 2 real-loopback usefulness probe", () => {
  it("builds a fail-closed sandbox profile for one exact non-4040 loopback port", () => {
    const profile = buildGate2LoopbackSandboxProfile({
      checkoutRoot: "/private/tmp/gate2/checkout",
      scratchRoot: "/private/tmp/gate2/scratch",
      nodeExecutable: "/opt/node/bin/node",
      port: 43_217,
    });

    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain('(allow network-bind (local tcp "localhost:43217"))');
    expect(profile).toContain('(allow network-inbound (local tcp "localhost:43217"))');
    expect(profile).toContain('(allow network-outbound (remote tcp "localhost:43217"))');
    expect(profile).toContain('(allow file-read* (subpath "/private/tmp/gate2/checkout"))');
    expect(profile).toContain('(allow file-write* (subpath "/private/tmp/gate2/scratch"))');
    expect(profile).not.toMatch(/(?:local|remote) tcp "\*:\*"/);
    expect(profile).not.toContain('(allow file-write* (subpath "/private/tmp"))');
    expect(() => buildGate2LoopbackSandboxProfile({
      checkoutRoot: "/private/tmp/gate2/checkout",
      scratchRoot: "/private/tmp/gate2/scratch",
      nodeExecutable: "/opt/node/bin/node",
      port: 4_040,
    })).toThrow(/4040.*reserved/i);
  });

  it("requires the complete commit-bound six-case evidence schema", () => {
    const evidence = {
      schema: "ccc-gate2.usefulness-evidence.v1",
      installedRuntimeReceiptDigest: "a".repeat(64),
      sourceCommit: "b".repeat(40),
      sourceTree: "c".repeat(40),
      detachedCheckout: { clean: true, headCommit: "b".repeat(40), headTree: "c".repeat(40) },
      reservedPort: 43_217,
      cases: GATE2_USEFULNESS_CASE_IDS.map((caseId) => ({ caseId, passed: true })),
      process: {
        exitCode: 0,
        signal: null,
        durationMs: 1_234,
        stdoutTail: "probe passed",
        stdoutSha256: "d".repeat(64),
        stderrTail: "",
        stderrSha256: "e".repeat(64),
      },
      sandboxProfileSha256: "f".repeat(64),
      cleanup: {
        processGroupStopped: true,
        processGroupVerification: {
          platform: "darwin",
          method: "posix-kill-zero",
          pgid: 12_345,
          absentAfterExit: true,
        },
        checkoutRemoved: true,
        scratchRemoved: true,
      },
      finalTargetStatus: "passed",
    };

    expect(assertGate2UsefulnessEvidence(evidence)).toEqual(evidence);
    expect(() => assertGate2UsefulnessEvidence({
      ...evidence,
      cases: evidence.cases.slice(1),
    })).toThrow(/six named cases/i);
    expect(() => assertGate2UsefulnessEvidence({
      ...evidence,
      sourceTree: "0".repeat(40),
    })).toThrow(/detached checkout.*tree/i);
    expect(() => assertGate2UsefulnessEvidence({
      ...evidence,
      cleanup: {
        ...evidence.cleanup,
        processGroupVerification: {
          ...evidence.cleanup.processGroupVerification,
          absentAfterExit: false,
        },
      },
    })).toThrow(/process group.*absent after exit/i);
  });

  it("builds a controller-owned probe for all six real HTTP and CLI cases", () => {
    const source = buildGate2UsefulnessProbeSource();

    for (const caseId of GATE2_USEFULNESS_CASE_IDS) expect(source).toContain(caseId);
    expect(source).toContain("src/app.ts");
    expect(source).toContain("src/health-cli.ts");
    expect(source).toContain("127.0.0.1");
    expect(source).toContain("SIGTERM");
    expect(source).toContain('within(fetch(baseUrl + "/stream"), "SSE connect")');
    expect(source).not.toMatch(/(?:127\.0\.0\.1|localhost):4040/);
  });

  it.runIf(process.platform === "darwin")("proves a known-good detached candidate through the exact-port sandbox", async () => {
    const runRoot = await mkdtemp(path.join(tmpdir(), "ccc-gate2-usefulness-test-"));
    const targetRoot = path.join(runRoot, "target");
    try {
      const repoRoot = path.resolve(import.meta.dirname, "../../../..");
      const baseline = await import(pathToFileURL(path.join(repoRoot, "scripts/lib/ccc-gate2-telemetry-baseline.mjs")).href) as {
        createGate2TelemetryBaseline(root: string): Promise<void>;
      };
      const candidate = await import(pathToFileURL(path.join(repoRoot, "scripts/__tests__/helpers/ccc-gate2-telemetry-candidate.mjs")).href) as {
        writeGate2TelemetryCandidate(root: string): Promise<void>;
      };
      await baseline.createGate2TelemetryBaseline(targetRoot);
      await candidate.writeGate2TelemetryCandidate(targetRoot);
      const appPath = path.join(targetRoot, "src/app.ts");
      const appSource = await readFile(appPath, "utf8");
      const appWithControlFrames = appSource.replace(
        "    response.flushHeaders();",
        "    response.flushHeaders();\n"
          + "    if (request.url === \"/stream\") response.write(\": connected\\r\\n\\r\\nretry: 1000\\r\\n\\r\\n\");",
      );
      expect(appWithControlFrames).not.toBe(appSource);
      await writeFile(appPath, appWithControlFrames);
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: targetRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Gate 2 Test"], { cwd: targetRoot });
      execFileSync("git", ["config", "user.email", "gate2@example.invalid"], { cwd: targetRoot });
      execFileSync("git", ["add", "."], { cwd: targetRoot });
      execFileSync("git", ["commit", "-m", "known good candidate"], { cwd: targetRoot, stdio: "ignore" });
      const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetRoot, encoding: "utf8" }).trim();
      const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: targetRoot, encoding: "utf8" }).trim();

      const evidence = await runGate2TelemetryUsefulnessProbe({
        targetRepositoryRoot: targetRoot,
        sourceCommit,
        sourceTree,
        installedRuntimeReceiptDigest: "a".repeat(64),
      });

      expect(assertGate2UsefulnessEvidence(evidence).finalTargetStatus, JSON.stringify(evidence, null, 2)).toBe("passed");
      expect(evidence.cases.map(({ caseId }) => caseId)).toEqual(GATE2_USEFULNESS_CASE_IDS);
      expect(evidence.process.stderrTail).not.toMatch(/deny|operation not permitted/i);
      expect(evidence.cleanup.processGroupVerification).toMatchObject({
        platform: "darwin",
        method: "posix-kill-zero",
        pgid: expect.any(Number),
        absentAfterExit: true,
      });
    } finally {
      await rm(runRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
