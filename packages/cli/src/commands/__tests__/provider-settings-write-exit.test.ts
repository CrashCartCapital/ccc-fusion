/*
Task #7: every CLI global-settings write path (e.g. `fn provider add`) lazily
starts an embedded-PostgreSQL revision layer (GlobalSettingsStore ->
getRevisionLayer() -> CentralCore) whose shutdown handle nothing ever reached,
so the process hung at exit until an external `gtimeout` killed it. Read-only
paths (corpus/discover/freeze/understand, `fn provider list`) never open that
layer and always exited cleanly -- this regression is specific to the write
path, and only reproduces against the REAL BUILT CLI as a child process:
vitest's in-process unit tests short-circuit getRevisionLayer() to undefined
(global-settings.ts checks `process.env.VITEST === "true"`), so they never
exercised the embedded-PG lifecycle at all.
*/
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const cliEntry = join(repoRoot, "packages/cli/bin.mjs");

/** Never poll with a foreground sleep loop: kill and resolve at the bound instead of hanging the test runner too. */
function runFnBounded(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ exited: boolean; status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      // The real bug only reproduces in a genuine (non-test) CLI invocation:
      // global-settings.ts short-circuits its embedded-PG revision layer to
      // undefined whenever VITEST === "true", which this test's own vitest
      // process would otherwise leak into the spawned child's environment.
      env: { ...process.env, CI: "1", FUSION_SKIP_ONBOARDING: "1", VITEST: "", ...env },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ exited: false, status: null, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exited: true, status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

describe("fn provider add exits on its own", () => {
  it("does not hang the process after writing global settings (embedded-PG revision layer must close)", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-provider-exit-"));
    const result = await runFnBounded(
      ["provider", "add", "--name", "settings-write-exit-test", "--base-url", "http://127.0.0.1:8000/v1", "--model", "test-model"],
      { HOME: home },
      20_000,
    );
    expect(
      result.exited,
      `fn provider add did not exit within 20s -- the embedded-PG revision layer is not being closed.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(true);
    expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
  }, 25_000);
});
