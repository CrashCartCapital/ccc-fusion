import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DARWIN_FALLBACK_TASK_BIN,
  FUSION_TASK_BIN_ENV,
  TRUSTED_LINUX_SANDBOX_PATHS,
  inspectConfinedVerifierHost,
  inspectPython3,
  inspectSemanticProofHost,
  inspectTaskRunner,
  proofHostSkipReasons,
  resolveTaskBinary,
} from "../__test-utils__/proof-host-tools.js";

/*
Every assertion below injects platform, filesystem and PATH lookups so the unit
test states the same verdict on a Darwin workstation and on a Linux CI runner.
The helper's own default probe reads the real host; that path is exercised by
the suites that consume the gates, not here.
*/
function probe(options: {
  platform: NodeJS.Platform;
  present?: readonly string[];
  which?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}) {
  const present = new Set(options.present ?? []);
  return {
    platform: options.platform,
    env: options.env ?? {},
    exists: (path: string) => present.has(path),
    which: (name: string) => options.which?.[name] ?? null,
  };
}

describe("proof host tools: Task binary resolution", () => {
  it("prefers an existing FUSION_TASK_BIN over PATH and the Darwin fallback", () => {
    const resolved = resolveTaskBinary(probe({
      platform: "darwin",
      present: ["/opt/ci/task", "/usr/local/bin/task", DARWIN_FALLBACK_TASK_BIN],
      which: { task: "/usr/local/bin/task" },
      env: { [FUSION_TASK_BIN_ENV]: "/opt/ci/task" },
    }));

    expect(resolved).toBe("/opt/ci/task");
  });

  it("refuses a FUSION_TASK_BIN that does not exist instead of silently falling back", () => {
    const resolved = resolveTaskBinary(probe({
      platform: "darwin",
      present: [DARWIN_FALLBACK_TASK_BIN],
      which: { task: DARWIN_FALLBACK_TASK_BIN },
      env: { [FUSION_TASK_BIN_ENV]: "/opt/ci/missing-task" },
    }));

    expect(resolved).toBeNull();
    expect(inspectTaskRunner(probe({
      platform: "darwin",
      present: [DARWIN_FALLBACK_TASK_BIN],
      env: { [FUSION_TASK_BIN_ENV]: "/opt/ci/missing-task" },
    })).reason).toContain(FUSION_TASK_BIN_ENV);
  });

  it("uses the PATH lookup before the Darwin fallback", () => {
    expect(resolveTaskBinary(probe({
      platform: "darwin",
      present: ["/Users/ci/go/bin/task", DARWIN_FALLBACK_TASK_BIN],
      which: { task: "/Users/ci/go/bin/task" },
    }))).toBe("/Users/ci/go/bin/task");
  });

  it("falls back to the Homebrew path on Darwin only when it exists", () => {
    expect(resolveTaskBinary(probe({
      platform: "darwin",
      present: [DARWIN_FALLBACK_TASK_BIN],
    }))).toBe(DARWIN_FALLBACK_TASK_BIN);
    expect(resolveTaskBinary(probe({ platform: "darwin" }))).toBeNull();
    expect(resolveTaskBinary(probe({
      platform: "linux",
      present: [DARWIN_FALLBACK_TASK_BIN],
    }))).toBeNull();
  });
});

describe("proof host tools: verifier confinement availability", () => {
  const taskOnPath = { task: "/usr/local/bin/task" };

  it("accepts Darwin with sandbox-exec and reports the backend binary", () => {
    const inspection = inspectConfinedVerifierHost(probe({
      platform: "darwin",
      present: ["/usr/bin/sandbox-exec"],
    }));

    expect(inspection).toMatchObject({
      available: true,
      backend: "sandbox-exec",
      path: "/usr/bin/sandbox-exec",
    });
  });

  it("accepts Linux with a trusted bwrap and reports which one it found", () => {
    for (const bwrap of TRUSTED_LINUX_SANDBOX_PATHS) {
      expect(inspectConfinedVerifierHost(probe({
        platform: "linux",
        present: [bwrap],
      }))).toMatchObject({ available: true, backend: "bubblewrap", path: bwrap });
    }
  });

  /*
  The suites on this gate reach runVerificationCommand with a sealed proof
  command of plain `node`; requiring Task as well would skip them for a
  capability they never use. Pin the separation so it cannot be re-folded.
  */
  it("does not require a Task runner, unlike the semantic-proof gate", () => {
    const noTask = probe({ platform: "darwin", present: ["/usr/bin/sandbox-exec"] });

    expect(inspectConfinedVerifierHost(noTask).available).toBe(true);
    expect(inspectTaskRunner(noTask).available).toBe(false);
    expect(inspectSemanticProofHost(noTask).available).toBe(false);
    expect(inspectSemanticProofHost(noTask).reason).toContain("Task runner");
  });

  it("refuses Linux without a trusted bwrap and names the reason", () => {
    const inspection = inspectConfinedVerifierHost(probe({
      platform: "linux",
      present: ["/usr/local/bin/task", "/home/runner/.local/bin/bwrap"],
      which: taskOnPath,
    }));

    expect(inspection.available).toBe(false);
    expect(inspection.backend).toBeNull();
    expect(inspection.reason).toContain("NOT RUN: requires a verifier confinement backend");
    expect(inspection.reason).toContain("/usr/bin/bwrap");
    expect(inspection.reason).toContain("linux: no trusted bwrap");
  });

  it("refuses an unknown platform outright", () => {
    expect(inspectConfinedVerifierHost(probe({
      platform: "win32",
      present: ["/usr/local/bin/task"],
      which: taskOnPath,
    }))).toMatchObject({ available: false, backend: null });
  });

  it("keeps the semantic-proof sandbox Darwin-only even when Linux has bwrap", () => {
    expect(inspectSemanticProofHost(probe({
      platform: "darwin",
      present: ["/usr/bin/sandbox-exec", "/usr/local/bin/task"],
      which: taskOnPath,
    }))).toMatchObject({ available: true, backend: "sandbox-exec" });

    const linux = inspectSemanticProofHost(probe({
      platform: "linux",
      present: ["/usr/bin/bwrap", "/usr/local/bin/task"],
      which: taskOnPath,
    }));
    expect(linux.available).toBe(false);
    expect(linux.reason).toContain("NOT RUN: requires the Darwin semantic-proof sandbox");
    expect(linux.reason).toContain("only a Darwin host can run it");
  });
});

/*
A skip reason is the only thing an operator reads about a suite that did not
run, so a coverage claim inside one has to be true. The first version of this
module ended every confinement and Task reason with "covered by full-suite
darwin-proof-lane" -- a lane that exists nowhere in .github/workflows, on a repo
whose every test runner is explicitly linux. That reintroduced, inside the
skip-reporting tool itself, exactly the silent-skip problem the tool exists to
remove.

The rule these two cases enforce: a skip reason may name a CI lane only if that
lane is a real `runs-on` label.

Two things keep the check from going vacuous. The extractor is proven against
the exact string that went wrong. And the reasons it scans are forced refusals
produced through injected probes, not `proofHostSkipReasons` alone -- on a
Darwin workstation the live confinement and semantic verdicts are *available*,
so their reason text is "ready", and a check that only read the live values
would silently stop inspecting the very strings that were wrong.
*/
const CI_LANE_CLAIM = /\b[a-z0-9]+(?:-[a-z0-9]+)*-lane\b|\bccc-fusion[a-z0-9-]*\b/gu;

function claimedCiLanes(reason: string): string[] {
  return [...new Set(reason.match(CI_LANE_CLAIM) ?? [])];
}

function workflowRunnerLabels(): string[] {
  const workflows = resolve(import.meta.dirname!, "../../../../.github/workflows");
  const labels = new Set<string>();
  for (const entry of readdirSync(workflows)) {
    if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
    for (const line of readFileSync(join(workflows, entry), "utf8").split("\n")) {
      const runsOn = /^\s*runs-on:\s*(.+?)\s*$/u.exec(line);
      if (!runsOn) continue;
      for (const label of runsOn[1]!.replace(/[[\]]/gu, "").split(",")) {
        const trimmed = label.trim();
        if (trimmed) labels.add(trimmed);
      }
    }
  }
  return [...labels];
}

describe("proof host tools: skip reasons never claim a CI lane that does not exist", () => {
  it("extracts a lane claim from the exact string that was wrong, and finds none in the real workflows", () => {
    const regression = "NOT RUN: requires a trusted proof host; covered by full-suite darwin-proof-lane";
    expect(claimedCiLanes(regression)).toContain("darwin-proof-lane");

    const labels = workflowRunnerLabels();
    // Proves the parser reached real workflow files before the loop below.
    expect(labels).toContain("ccc-fusion");
    expect(labels).toContain("ccc-fusion-bwrap");
    expect(labels).not.toContain("darwin-proof-lane");
  });

  it("names only real runner labels in every gate's refusal reason", () => {
    // A host with no confinement backend, no Task runner and no python3, so
    // every gate states its "NOT RUN: ..." text regardless of the real host.
    const barren = probe({ platform: "linux" });
    const forced: Record<string, string> = {
      confinedVerifierHost: inspectConfinedVerifierHost(barren).reason,
      semanticProofHost: inspectSemanticProofHost(barren).reason,
      task: inspectTaskRunner(barren).reason,
      python3: inspectPython3(barren).reason,
    };
    for (const [gate, reason] of Object.entries(forced)) {
      expect(reason, `${gate} did not refuse on a barren host`).toContain("NOT RUN:");
    }

    const scanned: Record<string, string> = { ...forced };
    for (const [gate, reason] of Object.entries(proofHostSkipReasons)) {
      scanned[`live:${gate}`] = reason;
    }

    const labels = workflowRunnerLabels();
    for (const [gate, reason] of Object.entries(scanned)) {
      for (const lane of claimedCiLanes(reason)) {
        expect(labels, `${gate} skip reason names CI lane "${lane}"`).toContain(lane);
      }
    }
  });
});
