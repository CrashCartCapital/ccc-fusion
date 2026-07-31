import { describe, it, expect, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOUNDED_VERIFICATION_GUIDANCE,
  MARATHON_SOFT_CAP_SEC,
  MAX_TIMEOUT_SEC,
  createRunVerificationTool,
  detectMarathonVerification,
  normalizeVerificationCommand,
  runVerificationCommand,
  __testOnlyReapVerificationProcessGroup,
  type RunVerificationOptions,
} from "../run-verification-tool.js";

// Some tests use platform-appropriate shell syntax. On Windows, sh-style
// quoting and pipes through `printf` are different — these tests are skipped
// when running on win32. The implementation itself is portable via
// `shell: true` (Node picks cmd.exe on Windows, /bin/sh on POSIX).
const onPosix = process.platform !== "win32";
const itPosix = onPosix ? it : it.skip;
const onDarwin = process.platform === "darwin";
const itDarwin = onDarwin ? it : it.skip;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tests for runVerificationCommand - the core verification execution logic.
 * These tests validate basic command execution, output capture, and error handling.
 *
 * NOTE: Timeout testing is intentionally excluded because the tool enforces its
 * own timeouts which conflict with test timeouts. The timeout behavior is validated
 * during integration testing in the main test suite.
 */
// Pick a sandbox-safe cwd. On macOS/Linux we use "/tmp" rather than
// os.tmpdir() because some sandboxed runners cannot reach the per-user
// $TMPDIR (e.g. /var/folders/.../T on macOS). On Windows /tmp does not exist
// so we fall back to os.tmpdir() which is always C:\Users\…\Temp there.
describe("runVerificationCommand", { timeout: 30000 }, () => {
  const tempDir = onPosix ? mkdtempSync(join("/tmp", "fusion-verifier-test-")) : tmpdir();
  const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));

  describe("command normalization", () => {
    it("rewrites package test -- --run filters to direct vitest with package-relative files", () => {
      const result = normalizeVerificationCommand(
        [
          "pnpm --filter @fusion/dashboard test -- --run",
          "packages/dashboard/src/__tests__/routes-tasks.test.ts",
          "packages/dashboard/src/__tests__/routes-settings.test.ts",
        ].join(" "),
        workspaceRoot,
      );

      expect(result.command).toBe(
        [
          "pnpm --filter @fusion/dashboard exec vitest run",
          "src/__tests__/routes-tasks.test.ts",
          "src/__tests__/routes-settings.test.ts",
          "--silent=passed-only --reporter=dot",
        ].join(" "),
      );
      expect(result.warnings).toEqual([
        expect.stringContaining("rewrote package test file filter"),
      ]);
    });

    it("leaves ordinary package tests unchanged when no file filter is forwarded", () => {
      const command = "pnpm --filter @fusion/dashboard test";
      expect(normalizeVerificationCommand(command, workspaceRoot)).toEqual({ command, warnings: [] });
    });

    it("leaves commands with unterminated shell quotes unchanged", () => {
      const command = "pnpm --filter @fusion/dashboard test -- --run 'src/__tests__/routes-tasks.test.ts";
      expect(normalizeVerificationCommand(command, workspaceRoot)).toEqual({ command, warnings: [] });
    });

    it("preserves pnpm global flags that precede --filter", () => {
      const result = normalizeVerificationCommand(
        "pnpm -w --filter @fusion/dashboard test -- --run packages/dashboard/src/__tests__/routes-tasks.test.ts",
        workspaceRoot,
      );

      expect(result.command).toBe(
        "pnpm -w --filter @fusion/dashboard exec vitest run src/__tests__/routes-tasks.test.ts --silent=passed-only --reporter=dot",
      );
    });

    it("verifies the CLI package directory through package.json before rewriting", () => {
      const result = normalizeVerificationCommand(
        "pnpm --filter @runfusion/fusion test -- --run packages/cli/src/__tests__/cli.test.ts",
        workspaceRoot,
      );

      expect(result.command).toBe(
        "pnpm --filter @runfusion/fusion exec vitest run src/__tests__/cli.test.ts --silent=passed-only --reporter=dot",
      );
    });
  });

  describe("marathon verification detection", () => {
    it.each([
      ["pnpm test", "root workspace test suite"],
      ["pnpm -w test", "root workspace test suite"],
      ["pnpm test:full", "full workspace verification script"],
      ["pnpm verify:workspace", "full workspace verification script"],
      ["pnpm --filter @fusion/core test", "whole-package test script"],
      ["for i in $(seq 1 20); do pnpm --filter @fusion/core exec vitest run src/foo.test.ts; done", "shell loop repeats"],
      ["while true; do pnpm test; done", "shell loop repeats"],
      ["seq 1 20 | xargs -I{} pnpm --filter @fusion/core exec vitest run src/foo.test.ts", "seq/xargs pipeline"],
      ["pnpm --filter @fusion/core exec vitest run src/a.test.ts && pnpm --filter @fusion/core exec vitest run src/a.test.ts", "&& chain repeats"],
    ])("flags marathon command %s", (command, reason) => {
      const detection = detectMarathonVerification(command, "workspace");

      expect(detection.isMarathon).toBe(true);
      expect(detection.reason).toContain(reason);
      expect(detection.guidance).toContain("allowFullSuite");
    });

    it.each([
      "pnpm --filter @fusion/core exec vitest run src/__tests__/settings-consistency.test.ts --silent=passed-only --reporter=dot",
      "pnpm --filter @fusion/dashboard test -- --run src/__tests__/routes-tasks.test.ts",
      "pnpm lint",
      "pnpm build",
    ])("passes targeted or non-test command %s", (command) => {
      expect(detectMarathonVerification(command, "package").isMarathon).toBe(false);
    });
  });

  describe("tool verification budgets and marathon caps", () => {
    it("uses the project verification timeout default when provided", async () => {
      const onVerificationStart = vi.fn();
      const tool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6608",
        recordActivity: vi.fn(),
        verificationCommandTimeoutMs: 1_500,
        onVerificationStart,
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      await tool.execute("call-budget", { command: "exit 0", scope: "workspace" });

      expect(onVerificationStart).toHaveBeenCalledWith(2_000);
    });

    it("falls back to legacy package/workspace defaults when the setting is absent or disabled", async () => {
      const packageStart = vi.fn();
      const disabledWorkspaceStart = vi.fn();
      const packageTool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6608",
        recordActivity: vi.fn(),
        onVerificationStart: packageStart,
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      const disabledTool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6608",
        recordActivity: vi.fn(),
        verificationCommandTimeoutMs: 0,
        onVerificationStart: disabledWorkspaceStart,
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      await packageTool.execute("call-package-default", { command: "exit 0", scope: "package" });
      await disabledTool.execute("call-workspace-default", { command: "exit 0", scope: "workspace" });

      expect(packageStart).toHaveBeenCalledWith(300_000);
      expect(disabledWorkspaceStart).toHaveBeenCalledWith(900_000);
    });

    it("applies the hard timeout cap to configured defaults and explicit overrides", async () => {
      const configuredStart = vi.fn();
      const explicitStart = vi.fn();
      const configuredTool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6608",
        recordActivity: vi.fn(),
        verificationCommandTimeoutMs: (MAX_TIMEOUT_SEC + 60) * 1000,
        onVerificationStart: configuredStart,
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      const explicitTool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6608",
        recordActivity: vi.fn(),
        onVerificationStart: explicitStart,
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      await configuredTool.execute("call-configured-cap", { command: "exit 0", scope: "package" });
      await explicitTool.execute("call-explicit-cap", { command: "exit 0", scope: "package", timeoutSec: MAX_TIMEOUT_SEC + 1 });

      expect(configuredStart).toHaveBeenCalledWith(MAX_TIMEOUT_SEC * 1000);
      expect(explicitStart).toHaveBeenCalledWith(MAX_TIMEOUT_SEC * 1000);
    });

    itPosix("reports an actionable timeout without relying on stuck detection", async () => {
      const tool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6608",
        recordActivity: vi.fn(),
        onVerificationStart: vi.fn(),
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      const result = await tool.execute("call-timeout", { command: "sh -c 'sleep 10 & wait'", scope: "package", timeoutSec: 1 });

      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(result.details).toEqual(expect.objectContaining({ success: false, timedOut: true }));
      expect(text).toContain("Command timed out after 1s");
      expect(text).toContain(BOUNDED_VERIFICATION_GUIDANCE);
    });

    itPosix("soft-caps marathon commands unless allowFullSuite is provided", async () => {
      const cappedStart = vi.fn();
      const allowedStart = vi.fn();
      const recordActivity = vi.fn();
      const command = "pnpm() { echo pulse; }; pnpm test";
      const cappedTool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6608",
        recordActivity: vi.fn(),
        onVerificationStart: cappedStart,
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      const allowedTool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6608",
        recordActivity,
        onVerificationStart: allowedStart,
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      const capped = await cappedTool.execute("call-capped", { command, scope: "workspace", timeoutSec: 600 });
      const allowed = await allowedTool.execute("call-allowed", { command, scope: "workspace", timeoutSec: 600, allowFullSuite: true });

      const cappedText = capped.content[0]?.type === "text" ? capped.content[0].text : "";
      const allowedText = allowed.content[0]?.type === "text" ? allowed.content[0].text : "";
      expect(cappedStart).toHaveBeenCalledWith(MARATHON_SOFT_CAP_SEC * 1000);
      expect(cappedText).toContain("marathon verification detected");
      expect(allowedStart).toHaveBeenCalledWith(600_000);
      expect(allowedText).toContain("allowFullSuite=true acknowledged");
      expect(allowed.details).toEqual(expect.objectContaining({ success: true, timedOut: false }));
      expect(recordActivity).toHaveBeenCalled();
    });
  });

  describe("tool verification lifecycle callbacks", () => {
    it("brackets a successful verification run with start and end callbacks", async () => {
      const onVerificationStart = vi.fn();
      const onVerificationEnd = vi.fn();
      const tool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6598",
        recordActivity: vi.fn(),
        onVerificationStart,
        onVerificationEnd,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      await tool.execute("call-1", { command: "exit 0", scope: "package" });

      expect(onVerificationStart).toHaveBeenCalledTimes(1);
      expect(onVerificationStart).toHaveBeenCalledWith(300_000);
      expect(onVerificationEnd).toHaveBeenCalledTimes(1);
      expect(onVerificationStart.mock.invocationCallOrder[0]).toBeLessThan(onVerificationEnd.mock.invocationCallOrder[0]);
    });

    it("fires the end callback when the verification command fails", async () => {
      const onVerificationStart = vi.fn();
      const onVerificationEnd = vi.fn();
      const tool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-6598",
        recordActivity: vi.fn(),
        onVerificationStart,
        onVerificationEnd,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      const result = await tool.execute("call-2", { command: "exit 7", scope: "package" });

      expect(result.details).toEqual(expect.objectContaining({ success: false, exitCode: 7 }));
      expect(onVerificationStart).toHaveBeenCalledTimes(1);
      expect(onVerificationEnd).toHaveBeenCalledTimes(1);
    });
  });

  describe("tool cwd custody", () => {
    function tool() {
      return createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-CWD-CUSTODY",
        recordActivity: vi.fn(),
        onVerificationStart: vi.fn(),
        onVerificationEnd: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
    }

    it.each([
      ["relative parent escape", ".."],
      ["absolute outside path", tmpdir()],
    ])("refuses %s before granting a writable sandbox root", async (_label, cwd) => {
      await expect(tool().execute("call-cwd-refusal", {
        command: "exit 0",
        scope: "package",
        cwd,
      })).rejects.toThrow(/canonical worktree/i);
    });

    itDarwin("allows a canonical existing package directory inside the worktree", async () => {
      const packageDir = join(tempDir, "package-cwd");
      mkdirSync(packageDir, { recursive: true });

      const result = await tool().execute("call-cwd-admitted", {
        command: "pwd",
        scope: "package",
        cwd: "package-cwd",
      });

      expect(result.details).toEqual(expect.objectContaining({
        success: true,
        cwd: realpathSync(packageDir),
      }));
    });
  });

  describe("basic command execution", () => {
    it("executes a simple echo command and captures output", async () => {
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "echo test-output",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("test-output");
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it("returns correct exit code for failed command", async () => {
      // `exit N` is recognised by both POSIX sh and Windows cmd.exe.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "exit 42",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(42);
    });

    it("returns success when expectFailure=true and command exits non-zero", async () => {
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "exit 3",
        cwd: tempDir,
        timeoutMs: 30000,
        expectFailure: true,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(3);
    });
  });

  describe("environment hygiene", () => {
    itPosix("passes only the deterministic local verification environment", async () => {
      const plantedEnv = {
        LANG: "C",
        LC_ALL: "C",
        DATABASE_URL: "postgresql://fusion:planted-password@127.0.0.1/fusion",
        OPENAI_API_KEY: "planted-openai-key-7db561e55b65",
        MCPJUNGLE_TOKEN: "planted-broker-token-7db561e55b65",
        AWS_SECRET_ACCESS_KEY: "planted-provider-secret-7db561e55b65",
        NODE_OPTIONS: "--no-warnings",
        BASH_ENV: "/tmp/fusion-verifier-unsafe-bash-env",
        ENV: "/tmp/fusion-verifier-unsafe-shell-env",
        GIT_CONFIG_COUNT: "0",
        NPM_CONFIG_USERCONFIG: "/tmp/fusion-verifier-unsafe-npmrc",
      } as const;
      const originalEnv = Object.fromEntries(
        Object.keys(plantedEnv).map((key) => [key, process.env[key]]),
      );
      Object.assign(process.env, plantedEnv);

      try {
        const observedKeys = [
          "PATH",
          "LANG",
          "LC_ALL",
          "CI",
          "COREPACK_ENABLE_DOWNLOAD_PROMPT",
          "GIT_TERMINAL_PROMPT",
          "GCM_INTERACTIVE",
          "DATABASE_URL",
          "OPENAI_API_KEY",
          "MCPJUNGLE_TOKEN",
          "AWS_SECRET_ACCESS_KEY",
          "NODE_OPTIONS",
          "BASH_ENV",
          "ENV",
          "GIT_CONFIG_COUNT",
          "NPM_CONFIG_USERCONFIG",
        ];
        const script = [
          `const keys = ${JSON.stringify(observedKeys)};`,
          "process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key]]))));",
        ].join(" ");
        const result = await runVerificationCommand({
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
          cwd: tempDir,
          timeoutMs: 30_000,
          onHeartbeat: vi.fn(),
        });
        const childEnv = JSON.parse(result.stdout) as Record<string, string>;

        expect(result.success).toBe(true);
        expect(childEnv.PATH).toBe(process.env.PATH);
        expect(childEnv.LANG).toBe("C");
        expect(childEnv.LC_ALL).toBe("C");
        expect(childEnv.CI).toBe("1");
        expect(childEnv.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe("0");
        expect(childEnv.GIT_TERMINAL_PROMPT).toBe("0");
        expect(childEnv.GCM_INTERACTIVE).toBe("never");
        expect(childEnv).not.toHaveProperty("DATABASE_URL");
        expect(childEnv).not.toHaveProperty("OPENAI_API_KEY");
        expect(childEnv).not.toHaveProperty("MCPJUNGLE_TOKEN");
        expect(childEnv).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
        expect(childEnv).not.toHaveProperty("NODE_OPTIONS");
        expect(childEnv).not.toHaveProperty("BASH_ENV");
        expect(childEnv).not.toHaveProperty("ENV");
        expect(childEnv).not.toHaveProperty("GIT_CONFIG_COUNT");
        expect(childEnv).not.toHaveProperty("NPM_CONFIG_USERCONFIG");
      } finally {
        for (const [key, value] of Object.entries(originalEnv)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    });

    itPosix("redacts known excluded values from captured output and line callbacks", async () => {
      const envKey = "FUSION_PROVIDER_TOKEN";
      const sensitiveValue = "planted-verifier-token-94eb2f87f7f8";
      const proofDigest = "a".repeat(64);
      const originalValue = process.env[envKey];
      process.env[envKey] = sensitiveValue;

      try {
        const encodedValue = Buffer.from(sensitiveValue, "utf8").toString("base64");
        const script = [
          `const value = Buffer.from(${JSON.stringify(encodedValue)}, "base64").toString("utf8");`,
          `const digest = ${JSON.stringify(proofDigest)};`,
          'process.stdout.write("stdout:" + value + "\\ndigest:" + digest + "\\n");',
          'process.stderr.write("stderr:" + value + "\\n");',
        ].join(" ");
        const onLine = vi.fn();
        const result = await runVerificationCommand({
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
          cwd: tempDir,
          timeoutMs: 30_000,
          onHeartbeat: vi.fn(),
          onLine,
        });
        const callbackText = onLine.mock.calls.flat().join("");

        expect(result.success).toBe(true);
        expect(result.stdout).toContain("stdout:[REDACTED]");
        expect(result.stderr).toContain("stderr:[REDACTED]");
        expect(callbackText).toContain("[REDACTED]");
        expect(result.stdout).toContain(`digest:${proofDigest}`);
        expect(result.stdout).not.toContain(sensitiveValue);
        expect(result.stderr).not.toContain(sensitiveValue);
        expect(callbackText).not.toContain(sensitiveValue);
      } finally {
        if (originalValue === undefined) {
          delete process.env[envKey];
        } else {
          process.env[envKey] = originalValue;
        }
      }
    });
  });

  describe("verifier confinement", () => {
    itDarwin("denies writes outside the verifier cwd while allowing normal cwd writes", async () => {
      const cwd = mkdtempSync(join(tempDir, "fusion-verifier-cwd-"));
      const outside = mkdtempSync(join(tempDir, "fusion-verifier-outside-"));
      const allowedPath = join(cwd, "allowed.txt");
      const outsidePath = join(outside, "outside.txt");
      const script = [
        `const fs = require("node:fs");`,
        `fs.writeFileSync(${JSON.stringify(allowedPath)}, "allowed");`,
        `try { fs.writeFileSync(${JSON.stringify(outsidePath)}, "outside"); }`,
        `catch (error) { console.error(String(error && error.code || error)); process.exit(13); }`,
        `process.stdout.write("outside-write-succeeded");`,
      ].join(" ");

      try {
        const result = await runVerificationCommand({
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
          cwd,
          timeoutMs: 30_000,
          onHeartbeat: vi.fn(),
          bypassVerificationSlot: true,
        });

        expect(readFileSync(allowedPath, "utf8")).toBe("allowed");
        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(13);
        expect(result.stdout).not.toContain("outside-write-succeeded");
        expect(existsSync(outsidePath)).toBe(false);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });

    itDarwin("isolates HOME and denies protected host-home reads", async () => {
      const cwd = mkdtempSync(join(tempDir, "fusion-verifier-home-cwd-"));
      const protectedHome = mkdtempSync(join(tempDir, "fusion-verifier-home-"));
      const protectedFile = join(protectedHome, "protected-token.txt");
      const secret = "planted-verifier-home-secret-42dd5f5d";
      const originalHome = process.env.HOME;
      writeFileSync(protectedFile, secret);
      process.env.HOME = protectedHome;
      const script = [
        `const fs = require("node:fs");`,
        `process.stdout.write("HOME=" + process.env.HOME + "\\n");`,
        `try { process.stdout.write(fs.readFileSync(${JSON.stringify(protectedFile)}, "utf8")); }`,
        `catch (error) { console.error(String(error && error.code || error)); process.exit(14); }`,
      ].join(" ");

      try {
        const result = await runVerificationCommand({
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
          cwd,
          timeoutMs: 30_000,
          onHeartbeat: vi.fn(),
          bypassVerificationSlot: true,
        });

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(14);
        expect(result.stdout).not.toContain(protectedHome);
        expect(result.stdout).not.toContain(secret);
      } finally {
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        rmSync(cwd, { recursive: true, force: true });
        rmSync(protectedHome, { recursive: true, force: true });
      }
    });

    itDarwin("denies nested protected-directory reads when the verifier cwd is inside HOME", async () => {
      const protectedHome = mkdtempSync(join(tempDir, "fusion-verifier-nested-home-"));
      const cwd = join(protectedHome, "workspace", "package");
      const nestedProtectedDir = join(protectedHome, "workspace", "other", "_secrets");
      const protectedFile = join(nestedProtectedDir, "token.txt");
      const secret = "planted-verifier-nested-secret-46c4f75e";
      const originalHome = process.env.HOME;
      mkdirSync(cwd, { recursive: true });
      mkdirSync(nestedProtectedDir, { recursive: true });
      writeFileSync(protectedFile, secret);
      process.env.HOME = protectedHome;
      const script = [
        `const fs = require("node:fs");`,
        `try { process.stdout.write(fs.readFileSync(${JSON.stringify(protectedFile)}, "utf8")); }`,
        `catch (error) { console.error(String(error && error.code || error)); process.exit(16); }`,
      ].join(" ");

      try {
        const result = await runVerificationCommand({
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
          cwd,
          timeoutMs: 30_000,
          onHeartbeat: vi.fn(),
          bypassVerificationSlot: true,
        });

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(16);
        expect(result.stdout).not.toContain(secret);
      } finally {
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        rmSync(protectedHome, { recursive: true, force: true });
      }
    });

    itDarwin("denies verifier network connections", async () => {
      const cwd = mkdtempSync(join(tempDir, "fusion-verifier-network-cwd-"));
      const server = createServer((socket) => {
        socket.on("error", () => {
          // The denied client path may reset while the server is closing.
        });
        socket.end("connected");
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP listener address");
      }
      const script = [
        `const net = require("node:net");`,
        `const socket = net.connect({ host: "127.0.0.1", port: ${address.port} });`,
        `socket.setTimeout(1500);`,
        `socket.on("connect", () => { process.stdout.write("network-connected"); socket.end(); process.exit(0); });`,
        `socket.on("timeout", () => { console.error("network-timeout"); socket.destroy(); process.exit(15); });`,
        `socket.on("error", (error) => { console.error(String(error && error.code || error)); process.exit(15); });`,
      ].join(" ");

      try {
        const result = await runVerificationCommand({
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
          cwd,
          timeoutMs: 30_000,
          onHeartbeat: vi.fn(),
          bypassVerificationSlot: true,
        });

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(15);
        expect(result.stdout).not.toContain("network-connected");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe("timeouts", () => {
    itPosix("times out and kills a quiet long-running process group", async () => {
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "sh -c 'sleep 10 & wait'",
        cwd: tempDir,
        timeoutMs: 100,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.durationMs).toBeLessThan(5_000);
    });

    itPosix("reaps background children after a command exits cleanly", async () => {
      /*
       * FNXC:Verification 2026-06-21-10:00:
       * A clean shell exit is not enough evidence that verification is fully done; background children must be gone too or later task completion can stall behind leaked test workers.
       */
      const childScript = "setInterval(() => {}, 1000)";
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "console.log(child.pid);",
        "child.unref();",
      ].join(" ");
      const result = await runVerificationCommand({
        command: `${process.execPath} -e ${JSON.stringify(parentScript)}`,
        cwd: tempDir,
        timeoutMs: 30_000,
        onHeartbeat: vi.fn(),
      });

      expect(result.success).toBe(true);
      const leakedPid = Number.parseInt(result.stdout.trim(), 10);
      expect(Number.isFinite(leakedPid)).toBe(true);
      expect(result.timedOut).toBe(false);

      for (let i = 0; i < 15 && isProcessAlive(leakedPid); i++) {
        await sleep(100);
      }
      expect(isProcessAlive(leakedPid)).toBe(false);
    });

    it("escalates non-timeout process-group reaping with fake timers", () => {
      /*
       * FNXC:Verification 2026-06-21-10:26:
       * Keep timer assertions on a narrow seam with fake timers so the integration test above never polls wall-clock time while still pinning SIGTERM -> SIGKILL escalation.
       */
      vi.useFakeTimers();
      const kill = vi.fn();
      const supervised = { kill } as unknown as Parameters<typeof __testOnlyReapVerificationProcessGroup>[0];

      try {
        __testOnlyReapVerificationProcessGroup(supervised);
        expect(kill).toHaveBeenCalledTimes(1);
        expect(kill).toHaveBeenCalledWith("SIGTERM");

        vi.advanceTimersByTime(499);
        expect(kill).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(1);
        expect(kill).toHaveBeenCalledTimes(2);
        expect(kill).toHaveBeenLastCalledWith("SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("output capture", () => {
    itPosix("captures multi-line stdout (POSIX shell)", async () => {
      // POSIX uses `;` as a command separator; cmd.exe uses `&`. Skip on Windows.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "echo line1; echo line2; echo line3",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.stdout).toContain("line1");
      expect(result.stdout).toContain("line2");
      expect(result.stdout).toContain("line3");
    });

    itPosix("captures stderr separately (POSIX shell)", async () => {
      // `>&2` redirect syntax is POSIX-specific. Skip on Windows.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "echo to-stdout; echo to-stderr >&2",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.stdout).toContain("to-stdout");
      expect(result.stderr).toContain("to-stderr");
    });
  });

  describe("heartbeat callbacks", () => {
    itPosix("fires onHeartbeat for each output line (POSIX shell)", async () => {
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "echo a; echo b; echo c",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      // Should call heartbeat at least once per line
      expect(onHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    itPosix("fires onLine callback with each line when provided (POSIX shell)", async () => {
      const onHeartbeat = vi.fn();
      const onLine = vi.fn();
      const opts: RunVerificationOptions = {
        command: "echo hello; echo world",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
        onLine,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      expect(onLine.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("error handling", () => {
    itPosix("handles missing commands gracefully (POSIX sh reports exit 127)", async () => {
      // The implementation runs commands via the platform shell. POSIX sh
      // returns exit 127 for "command not found"; cmd.exe returns 1 (or
      // 9009 in some cases). This test pins the POSIX behaviour.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "/nonexistent/command/path",
        cwd: tempDir,
        timeoutMs: 5000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(127);
      expect(result.timedOut).toBe(false);
    });

    it("includes all result fields", async () => {
      // `exit 0` is portable across POSIX sh and cmd.exe; `true` is POSIX-only.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "exit 0",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("exitCode");
      expect(result).toHaveProperty("durationMs");
      expect(result).toHaveProperty("stdout");
      expect(result).toHaveProperty("stderr");
      expect(result).toHaveProperty("timedOut");
      expect(result).toHaveProperty("killed");
      expect(result).toHaveProperty("command");
      expect(result).toHaveProperty("cwd");
      expect(result).toHaveProperty("warnings");
    });

    it("preserves command and cwd in result", async () => {
      const onHeartbeat = vi.fn();
      const command = "echo preserved";
      const opts: RunVerificationOptions = {
        command,
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.command).toBe(command);
      expect(result.cwd).toBe(tempDir);
    });
  });

  describe("complex shell commands", () => {
    itPosix("handles piped commands (POSIX shell)", async () => {
      // The implementation runs commands through the platform shell. POSIX
      // pipes + printf differ from Windows cmd.exe syntax, so this test is
      // POSIX-only.
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "printf 'test1\\ntest2\\ntest3\\n' | grep test",
        cwd: tempDir,
        timeoutMs: 5000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      expect(result.stdout).toContain("test1");
    });

    itPosix("executes commands with shell-local environment variables (POSIX shell)", async () => {
      const onHeartbeat = vi.fn();
      const opts: RunVerificationOptions = {
        command: "FUSION_TEST_ENV=fusion-test; export FUSION_TEST_ENV; printf '%s\\n' \"$FUSION_TEST_ENV\"",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat,
      };

      const result = await runVerificationCommand(opts);

      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe("fusion-test");
    });

    itPosix("executes commands with allowlisted locale variables (POSIX shell)", async () => {
      const result = await runVerificationCommand({
        command: "echo $LANG",
        cwd: tempDir,
        timeoutMs: 30000,
        onHeartbeat: vi.fn(),
      });

      expect(result.success).toBe(true);
      // Should have output (LANG is part of the deterministic allowlist).
      expect(result.stdout.trim().length).toBeGreaterThan(0);
    });
  });
});
