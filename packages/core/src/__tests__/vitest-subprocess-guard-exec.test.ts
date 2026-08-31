import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function configuredGuardTimeoutMs(): number {
  return Math.max(
    1_000,
    Number.parseInt(process.env.FUSION_TEST_SUBPROCESS_TIMEOUT_MS ?? "30000", 10) || 30_000,
  );
}

describe("Vitest subprocess guard exec tracking", () => {
  it("registers exec once even though Node delegates it through execFile", async () => {
    const timeoutMs = configuredGuardTimeoutMs();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const execFileResult = await execFileAsync("git", ["--version"]);
      expect(execFileResult.stdout).toContain("git version");
      const execFileTimerCount = timeoutSpy.mock.calls.filter((call) => call[1] === timeoutMs).length;

      timeoutSpy.mockClear();
      const execResult = await execAsync("git --version");
      expect(execResult.stdout).toContain("git version");
      const execTimerCount = timeoutSpy.mock.calls.filter((call) => call[1] === timeoutMs).length;

      expect(execFileTimerCount).toBeGreaterThan(0);
      expect(execTimerCount).toBe(execFileTimerCount);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
