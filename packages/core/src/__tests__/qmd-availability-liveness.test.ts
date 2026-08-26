import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tsxPackageJsonPath = createRequire(import.meta.url).resolve("tsx/package.json");
const tsxCliPath = join(tsxPackageJsonPath, "..", "dist", "cli.mjs");

describe("awaited qmd availability probe", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("settles before a short-lived caller exits", async () => {
    const stubDir = mkdtempSync(join(tmpdir(), "fn-qmd-availability-stub-"));
    tempDirs.push(stubDir);
    const stubPath = join(stubDir, "qmd");
    writeFileSync(stubPath, "#!/usr/bin/env bash\nsleep 0.25\nexit 0\n", "utf8");
    chmodSync(stubPath, 0o755);

    const fixturePath = join(import.meta.dirname, "fixtures", "qmd-availability-fixture.mjs");
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const child = spawn(process.execPath, [tsxCliPath, fixturePath], {
        env: {
          ...process.env,
          PATH: `${stubDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });

    expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(result.stdout).toContain("qmd-availability-fixture:started");
    expect(result.stdout).toContain("qmd-availability-fixture:available=true");
  });

  it("settles unavailable when qmd ignores the probe timeout signal", async () => {
    const stubDir = mkdtempSync(join(tmpdir(), "fn-qmd-availability-stubborn-"));
    tempDirs.push(stubDir);
    const stubPath = join(stubDir, "qmd");
    writeFileSync(
      stubPath,
      "#!/usr/bin/env bash\ntrap '' TERM\nsleep 8\nexit 0\n",
      "utf8",
    );
    chmodSync(stubPath, 0o755);

    const fixturePath = join(import.meta.dirname, "fixtures", "qmd-availability-fixture.mjs");
    const startedAt = Date.now();
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const child = spawn(process.execPath, [tsxCliPath, fixturePath], {
        env: {
          ...process.env,
          PATH: `${stubDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });

    expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.stdout).toContain("qmd-availability-fixture:available=false");
  }, 15_000);

  it("settles an explicitly unref'd probe when its caller remains alive", async () => {
    const stubDir = mkdtempSync(join(tmpdir(), "fn-qmd-availability-unref-timeout-"));
    tempDirs.push(stubDir);
    const stubPath = join(stubDir, "qmd");
    writeFileSync(
      stubPath,
      "#!/usr/bin/env bash\ntrap '' TERM\nsleep 8\nexit 0\n",
      "utf8",
    );
    chmodSync(stubPath, 0o755);

    const fixturePath = join(import.meta.dirname, "fixtures", "qmd-availability-fixture.mjs");
    const startedAt = Date.now();
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const child = spawn(process.execPath, [tsxCliPath, fixturePath, "unref-timeout"], {
        env: {
          ...process.env,
          PATH: `${stubDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });

    expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.stdout).toContain("qmd-availability-fixture:available=false");
  }, 15_000);
});
