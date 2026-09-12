import { describe, expect, it } from "vitest";
import {
  DARWIN_FALLBACK_TASK_BIN,
  FUSION_TASK_BIN_ENV,
  TRUSTED_LINUX_SANDBOX_PATHS,
  inspectProofHost,
  inspectSemanticProofHost,
  inspectTaskRunner,
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

describe("proof host tools: proof host availability", () => {
  const taskOnPath = { task: "/usr/local/bin/task" };

  it("accepts Darwin with sandbox-exec and a Task runner", () => {
    const inspection = inspectProofHost(probe({
      platform: "darwin",
      present: ["/usr/bin/sandbox-exec", "/usr/local/bin/task"],
      which: taskOnPath,
    }));

    expect(inspection).toMatchObject({ available: true, backend: "sandbox-exec" });
  });

  it("accepts Linux with a trusted bwrap and a Task runner", () => {
    for (const bwrap of TRUSTED_LINUX_SANDBOX_PATHS) {
      expect(inspectProofHost(probe({
        platform: "linux",
        present: [bwrap, "/usr/local/bin/task"],
        which: taskOnPath,
      }))).toMatchObject({ available: true, backend: "bubblewrap" });
    }
  });

  it("refuses Linux without a trusted bwrap and names the reason", () => {
    const inspection = inspectProofHost(probe({
      platform: "linux",
      present: ["/usr/local/bin/task", "/home/runner/.local/bin/bwrap"],
      which: taskOnPath,
    }));

    expect(inspection.available).toBe(false);
    expect(inspection.backend).toBeNull();
    expect(inspection.reason).toContain("NOT RUN: requires a trusted proof host");
    expect(inspection.reason).toContain("darwin sandbox-exec or linux bwrap");
    expect(inspection.reason).toContain("full-suite darwin-proof-lane");
    expect(inspection.reason).toContain("linux");
  });

  it("refuses a proof host that has a confinement backend but no Task runner", () => {
    const inspection = inspectProofHost(probe({
      platform: "darwin",
      present: ["/usr/bin/sandbox-exec"],
    }));

    expect(inspection.available).toBe(false);
    expect(inspection.reason).toContain("Task runner");
  });

  it("refuses an unknown platform outright", () => {
    expect(inspectProofHost(probe({
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
    expect(linux.reason).toContain("full-suite darwin-proof-lane");
  });
});
