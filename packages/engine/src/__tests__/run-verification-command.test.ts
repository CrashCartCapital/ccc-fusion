import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
  inspectVerifierConfinementReadiness,
  normalizeVerificationCommand,
  runVerificationCommand,
  __testOnlyBuildVerificationSandboxLaunch,
  __testOnlyDetectTrustedVerifierBwrap,
  __testOnlyReapVerificationProcessGroup,
  type RunVerificationOptions,
} from "../run-verification-tool.js";

// Some tests use platform-appropriate shell syntax. On Windows, sh-style
// quoting and pipes through `printf` are different. Real command execution is
// also limited to hosts with an enforced verifier sandbox; unsupported hosts
// exercise the pure launch/refusal contract and fail closed at runtime.
const onPosix = process.platform !== "win32";
const itPosix = onPosix ? it : it.skip;

function canExecuteVerifierSandbox(): boolean {
  if (process.platform === "darwin") return existsSync("/usr/bin/sandbox-exec");
  if (process.platform !== "linux") return false;
  const detected = __testOnlyDetectTrustedVerifierBwrap();
  if (!detected.available || !detected.path) return false;
  const probe = spawnSync(detected.path, [
    "--die-with-parent",
    "--unshare-net",
    "--ro-bind",
    "/",
    "/",
    "--",
    "/bin/true",
  ], { stdio: "ignore", timeout: 5_000 });
  return probe.status === 0;
}

const verifierSandboxAvailable = canExecuteVerifierSandbox();
const describeVerifierHost = verifierSandboxAvailable ? describe : describe.skip;
const itVerifierHost = verifierSandboxAvailable ? it : it.skip;
const itUnsupportedLinux = process.platform === "linux" && !verifierSandboxAvailable ? it : it.skip;

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

  describeVerifierHost("tool verification budgets and marathon caps", () => {
    it("keeps the raw verifier command out of tool lifecycle logs", async () => {
      const privatePath = join(tempDir, "private-tool-log-token");
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const tool = createRunVerificationTool({
        worktreePath: tempDir,
        rootDir: workspaceRoot,
        taskId: "FN-VERIFIER-LOG-PRIVACY",
        recordActivity: vi.fn(),
        onVerificationStart: vi.fn(),
        onVerificationEnd: vi.fn(),
        log,
      });

      const result = await tool.execute("call-private-command", {
        command: `exit 0 # ${privatePath}`,
        scope: "package",
      });

      expect(result.details).toEqual(expect.objectContaining({ success: true }));
      const lifecycleLogs = [
        ...log.info.mock.calls.flat(),
        ...log.warn.mock.calls.flat(),
        ...log.error.mock.calls.flat(),
      ].map(String).join("\n");
      expect(lifecycleLogs).toContain("cmd=verifier command (");
      expect(lifecycleLogs).not.toContain(privatePath);
    });

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

  describeVerifierHost("tool verification lifecycle callbacks", () => {
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

    itVerifierHost("allows a canonical existing package directory inside the worktree", async () => {
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

  describeVerifierHost("basic command execution", () => {
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

  describeVerifierHost("environment hygiene", () => {
    itPosix("passes only the deterministic local verification environment", async () => {
      const plantedEnv = {
        LANG: "C",
        LC_ALL: "C",
        DATABASE_URL: "postgresql://fusion:planted-password@127.0.0.1/fusion",
        PGPASSWORD: "postgres",
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
          "PGPASSWORD",
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
        expect(childEnv.PATH).toBe(
          process.env.PATH?.split(plantedEnv.PGPASSWORD).join("[REDACTED]"),
        );
        expect(childEnv.LANG).toBe("C");
        expect(childEnv.LC_ALL).toBe("C");
        expect(childEnv.CI).toBe("1");
        expect(childEnv.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe("0");
        expect(childEnv.GIT_TERMINAL_PROMPT).toBe("0");
        expect(childEnv.GCM_INTERACTIVE).toBe("never");
        expect(childEnv).not.toHaveProperty("DATABASE_URL");
        expect(childEnv).not.toHaveProperty("PGPASSWORD");
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
    itVerifierHost("functionally proves the real verifier confinement backend can execute an isolated no-op", async () => {
      const readiness = await inspectVerifierConfinementReadiness();

      expect(readiness).toEqual(expect.objectContaining({
        ready: true,
        backend: process.platform === "darwin" ? "sandbox-exec" : "bubblewrap",
        code: "VERIFIER_CONFINEMENT_READY",
        message: expect.stringMatching(/ready|executed/i),
      }));
      expect(readiness.trustedPaths).toContain(
        process.platform === "darwin" ? "/usr/bin/sandbox-exec" : "/usr/bin/bwrap",
      );
      expect(readiness.detail).toMatch(
        process.platform === "darwin" ? /sandbox-exec/i : /bubblewrap/i,
      );
    });

    itVerifierHost("keeps the expanded verifier sandbox policy out of supervisor diagnostics", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const result = await runVerificationCommand({
        command: "exit 0",
        cwd: tempDir,
        timeoutMs: 30_000,
        onHeartbeat: vi.fn(),
        onLine: vi.fn(),
      });

      expect(result.success).toBe(true);
      const logs = errorSpy.mock.calls.flat().map(String).join("\n");
      expect(logs).toContain(
        `command=${process.platform === "darwin" ? "/usr/bin/sandbox-exec" : "/usr/bin/bwrap"}`,
      );
      expect(logs).not.toContain("(version 1)");
      expect(logs).not.toContain("(subpath");
    });

    itVerifierHost("keeps raw verifier commands out of failure and timeout diagnostics", async () => {
      const privatePath = join(tempDir, "private-operator-path-token");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        const failed = await runVerificationCommand({
          command: `exit 17 # ${privatePath}`,
          cwd: tempDir,
          timeoutMs: 30_000,
          onHeartbeat: vi.fn(),
        });
        const timedOut = await runVerificationCommand({
          command: `sleep 2 # ${privatePath}`,
          cwd: tempDir,
          timeoutMs: 50,
          onHeartbeat: vi.fn(),
        });

        expect(failed.success).toBe(false);
        expect(timedOut.timedOut).toBe(true);
        const logs = warnSpy.mock.calls.flat().map(String).join("\n");
        expect(logs).toContain("[fn_run_verification]");
        expect(logs).not.toContain(privatePath);
      } finally {
        warnSpy.mockRestore();
      }
    });

    itUnsupportedLinux("reports a functional readiness failure when Linux confinement cannot execute", async () => {
      const readiness = await inspectVerifierConfinementReadiness();

      expect(readiness).toEqual(expect.objectContaining({
        ready: false,
        backend: "bubblewrap",
        code: "VERIFIER_CONFINEMENT_UNAVAILABLE",
        message: expect.stringMatching(/unavailable|failed/i),
        trustedPaths: ["/usr/bin/bwrap", "/bin/bwrap"],
        detail: expect.stringMatching(/bubblewrap|bwrap|namespace|sandbox/i),
      }));
    });

    it("never trusts a PATH-prepended verifier sandbox executable", () => {
      const fakeBin = mkdtempSync(join(tempDir, "fusion-verifier-fake-bwrap-"));
      const fakeBwrap = join(fakeBin, "bwrap");
      const originalPath = process.env.PATH;
      writeFileSync(fakeBwrap, "#!/bin/sh\necho 'bubblewrap 99.0.0'\n", "utf8");
      chmodSync(fakeBwrap, 0o755);
      process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;

      try {
        const detected = __testOnlyDetectTrustedVerifierBwrap();
        expect(detected.path).not.toBe(fakeBwrap);
        if (detected.available) {
          expect(["/usr/bin/bwrap", "/bin/bwrap"]).toContain(detected.path);
        }
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(fakeBin, { recursive: true, force: true });
      }
    });

    it("builds a fail-closed Linux bubblewrap launch without a host shell wrapper", async () => {
      const repoRoot = mkdtempSync(join(tempDir, "fusion-verifier-linux-launch-"));
      const cwd = join(repoRoot, "packages", "target");
      const protectedDir = join(repoRoot, "nested", "_secrets");
      const skippedTreeProtectedDir = join(repoRoot, "dist", "_secrets");
      const dependencyProtectedDir = join(repoRoot, "node_modules", "example", "_secrets");
      mkdirSync(join(repoRoot, ".git"), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      mkdirSync(protectedDir, { recursive: true });
      mkdirSync(skippedTreeProtectedDir, { recursive: true });
      mkdirSync(dependencyProtectedDir, { recursive: true });

      const launch = await __testOnlyBuildVerificationSandboxLaunch(
        {
          command: "printf 'sandboxed\\n'",
          cwd,
          childEnv: {
            PATH: process.env.PATH,
            HOME: "/planted/host-home",
            CI: "1",
          },
        },
        {
          platform: "linux",
          bubblewrap: { available: true, path: "/usr/bin/bwrap", version: "0.9.0" },
        },
      );

      try {
        expect("error" in launch).toBe(false);
        if ("error" in launch) return;
        expect(launch.command).toBe("/usr/bin/bwrap");
        expect(launch.args).toEqual(expect.arrayContaining([
          "--clearenv",
          "--unshare-net",
          "--chdir",
          realpathSync(cwd),
        ]));
        expect(launch.args.slice(-4)).toEqual([
          "--",
          "/bin/sh",
          "-c",
          "printf 'sandboxed\\n'",
        ]);
        expect(launch.env.HOME).not.toBe("/planted/host-home");
        expect(launch.shell).toBe(false);
        expect(launch.args).toContain(realpathSync(protectedDir));
        expect(launch.args).toContain(realpathSync(skippedTreeProtectedDir));
        expect(launch.args).toContain(realpathSync(dependencyProtectedDir));
        const readRootMount = launch.args.findIndex((arg, index) =>
          arg === "--ro-bind" && launch.args[index + 1] === realpathSync(repoRoot));
        const writableCwdMounts = launch.args
          .map((arg, index) => arg === "--bind" && launch.args[index + 1] === realpathSync(cwd) ? index : -1)
          .filter((index) => index >= 0);
        expect(readRootMount).toBeGreaterThanOrEqual(0);
        expect(Math.max(...writableCwdMounts)).toBeGreaterThan(readRootMount);
      } finally {
        if (!("error" in launch)) launch.cleanup();
        rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    itPosix("read-only mounts the canonical npm global task package root on Linux", async () => {
      const repoRoot = mkdtempSync(join(tempDir, "fusion-verifier-linux-task-repo-"));
      const globalRoot = mkdtempSync(join(tempDir, "fusion-verifier-linux-task-global-"));
      const cwd = join(repoRoot, "packages", "target");
      const fakeBin = join(globalRoot, "bin");
      const taskPackageRoot = join(globalRoot, "lib", "node_modules", "@go-task", "cli");
      const taskExecutable = join(taskPackageRoot, "run-task.js");
      mkdirSync(join(repoRoot, ".git"), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(taskPackageRoot, { recursive: true });
      writeFileSync(taskExecutable, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(taskExecutable, 0o755);
      symlinkSync("../lib/node_modules/@go-task/cli/run-task.js", join(fakeBin, "task"));

      const launch = await __testOnlyBuildVerificationSandboxLaunch(
        {
          command: "task verify:vertical",
          cwd,
          childEnv: {
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          },
        },
        {
          platform: "linux",
          bubblewrap: { available: true, path: "/usr/bin/bwrap", version: "0.9.0" },
        },
      );

      try {
        expect("error" in launch).toBe(false);
        if ("error" in launch) return;
        expect(launch.args).toEqual(expect.arrayContaining([
          "--ro-bind",
          realpathSync(taskPackageRoot),
          realpathSync(taskPackageRoot),
        ]));
      } finally {
        if (!("error" in launch)) launch.cleanup();
        rmSync(repoRoot, { recursive: true, force: true });
        rmSync(globalRoot, { recursive: true, force: true });
      }
    });

    it("refuses Linux verification when bubblewrap is unavailable", async () => {
      const launch = await __testOnlyBuildVerificationSandboxLaunch(
        {
          command: "exit 0",
          cwd: tempDir,
          childEnv: { PATH: process.env.PATH },
        },
        {
          platform: "linux",
          bubblewrap: { available: false, reason: "not-installed" },
        },
      );

      expect(launch).toEqual({
        error: expect.stringMatching(/bubblewrap.*not-installed.*refusing to run verification natively/i),
      });
    });

    itUnsupportedLinux("fails closed without executing the verifier when Linux confinement is unavailable", async () => {
      const cwd = mkdtempSync(join(tempDir, "fusion-verifier-unsupported-linux-"));
      const marker = join(cwd, "must-not-exist.txt");

      try {
        const result = await runVerificationCommand({
          command: `printf unsafe > ${JSON.stringify(marker)}`,
          cwd,
          timeoutMs: 30_000,
          onHeartbeat: vi.fn(),
          bypassVerificationSlot: true,
        });

        expect(result.success).toBe(false);
        expect(result.exitCode).not.toBe(0);
        expect(existsSync(marker)).toBe(false);
        expect([result.stderr, ...result.warnings].join("\n")).toMatch(
          /bubblewrap|bwrap|sandbox|namespace/i,
        );
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    itVerifierHost("denies writes outside the verifier cwd while allowing normal cwd writes", async () => {
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

    itVerifierHost("isolates HOME and denies protected host-home reads", async () => {
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

    itVerifierHost("denies nested protected-directory reads when the verifier cwd is inside HOME", async () => {
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

    itVerifierHost("denies verifier network connections", async () => {
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

  describeVerifierHost("timeouts", () => {
    itPosix("aborts a spawned verifier process group before its hard timeout", async () => {
      const controller = new AbortController();
      const onLine = vi.fn((line: string) => {
        if (line.includes("verifier-started")) controller.abort();
      });
      const result = await runVerificationCommand({
        command: "echo verifier-started; sleep 2",
        cwd: tempDir,
        timeoutMs: 10_000,
        onHeartbeat: vi.fn(),
        onLine,
        signal: controller.signal,
      });

      expect(onLine).toHaveBeenCalledWith(expect.stringContaining("verifier-started"));
      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.killed).toBe(true);
      expect(result.durationMs).toBeLessThan(1_500);
      expect(result.warnings).toContain("Verification aborted by caller signal");
    });

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
      const cwd = mkdtempSync(join(tempDir, "fusion-verifier-reap-"));
      const leakedEffect = join(cwd, "leaked-effect.txt");
      const childScript = [
        "const fs = require('node:fs');",
        `setTimeout(() => fs.writeFileSync(${JSON.stringify(leakedEffect)}, 'leaked'), 750);`,
        "setInterval(() => {}, 1000);",
      ].join(" ");
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "console.log('spawned-background-child');",
        "child.unref();",
      ].join(" ");

      try {
        const result = await runVerificationCommand({
          command: `${process.execPath} -e ${JSON.stringify(parentScript)}`,
          cwd,
          timeoutMs: 30_000,
          onHeartbeat: vi.fn(),
        });

        expect(result.success).toBe(true);
        expect(result.stdout).toContain("spawned-background-child");
        expect(result.timedOut).toBe(false);
        await sleep(1_250);
        expect(existsSync(leakedEffect)).toBe(false);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
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

  describeVerifierHost("output capture", () => {
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

  describeVerifierHost("heartbeat callbacks", () => {
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

  describeVerifierHost("error handling", () => {
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

  describeVerifierHost("complex shell commands", () => {
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
      // A minimal host (for example a slim container runner) may set no locale
      // variable at all, so stub LANG and assert the exact value round-trips —
      // this proves allowlist passthrough deterministically instead of
      // assuming the ambient environment.
      vi.stubEnv("LANG", "C.UTF-8");
      try {
        const result = await runVerificationCommand({
          command: "echo $LANG",
          cwd: tempDir,
          timeoutMs: 30000,
          onHeartbeat: vi.fn(),
        });

        expect(result.success).toBe(true);
        expect(result.stdout.trim()).toBe("C.UTF-8");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});
