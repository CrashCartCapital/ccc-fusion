import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CentralCore, readProjectIdentity } from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCwdProjectRegistered } from "../ensure-project-registered.js";

const tempPaths: string[] = [];

function makeTempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("ensureCwdProjectRegistered", () => {
  it("returns existing registered project without writing files", async () => {
    const globalDir = makeTempDir("fn-4266-global-");
    const cwd = makeTempDir("fn-4266-project-");

    const central = new CentralCore(globalDir);
    await central.init();
    const existing = await central.registerProject({
      name: "existing-project",
      path: cwd,
      isolationMode: "in-process",
    });

    const registerSpy = vi.spyOn(central, "registerProject");
    const updateSpy = vi.spyOn(central, "updateProject");

    const result = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "serve",
      autoRegister: true,
    });

    expect(result?.id).toBe(existing.id);
    expect(existsSync(join(cwd, ".fusion"))).toBe(true);
    expect(readProjectIdentity(cwd)?.id).toBe(existing.id);
    expect(registerSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();

    await central.close();
  });

  it("auto-registers unregistered project when enabled and persists identity", async () => {
    const globalDir = makeTempDir("fn-4266-global-");
    const cwd = makeTempDir("fn-4266-project-");

    const central = new CentralCore(globalDir);
    await central.init();

    const ensureSpy = vi.spyOn(central, "ensureProjectForPath");
    const updateSpy = vi.spyOn(central, "updateProject");

    const result = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "serve",
      autoRegister: true,
    });

    expect(result).not.toBeNull();
    expect(existsSync(join(cwd, ".git"))).toBe(true);
    expect(existsSync(join(cwd, ".fusion"))).toBe(true);
    expect(existsSync(join(cwd, ".fusion", "project.json"))).toBe(true);
    expect(existsSync(join(cwd, ".fusion", "fusion.db"))).toBe(false);
    expect(ensureSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: cwd,
      }),
    );
    expect(updateSpy).toHaveBeenCalledWith(expect.any(String), { status: "active" });
    expect(readProjectIdentity(cwd)?.id).toBe(result?.id);

    await central.close();
  });

  it("reattaches using stored identity when central row was wiped", async () => {
    const globalDir = makeTempDir("fn-4266-global-");
    const cwd = makeTempDir("fn-4266-project-");

    const central = new CentralCore(globalDir);
    await central.init();

    const first = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "serve",
      autoRegister: true,
    });
    expect(first).not.toBeNull();

    await central.unregisterProject(first!.id);

    const second = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "serve",
      autoRegister: true,
    });

    expect(second?.id).toBe(first?.id);

    await central.close();
  });

  it("returns null and does not write when autoRegister is false", async () => {
    const globalDir = makeTempDir("fn-4266-global-");
    const cwd = makeTempDir("fn-4266-project-");

    const central = new CentralCore(globalDir);
    await central.init();

    const ensureSpy = vi.spyOn(central, "ensureProjectForPath");

    const result = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "daemon",
      autoRegister: false,
    });

    expect(result).toBeNull();
    expect(existsSync(join(cwd, ".fusion"))).toBe(false);
    expect(ensureSpy).not.toHaveBeenCalled();

    await central.close();
  });

  it("returns null and logs error when registration throws", async () => {
    const globalDir = makeTempDir("fn-4266-global-");
    const cwd = makeTempDir("fn-4266-project-");

    const central = new CentralCore(globalDir);
    await central.init();

    vi.spyOn(central, "ensureProjectForPath").mockRejectedValueOnce(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "serve",
      autoRegister: true,
    });

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[serve] Failed to auto-register current project: boom"),
    );
    expect(readProjectIdentity(cwd)).toBeNull();

    await central.close();
  });

  /*
   * FNXC:FusionSourceCheckoutGuard 2026-09-06 (worktree-sweep incident): a
   * `serve` process launched without `cd`-ing into its target repo runs from
   * the Fusion source checkout's own cwd, which was never registered, so
   * this auto-registered it as project "ccc-fusion" — giving that repo a
   * second, DB-empty ProjectEngine whose maintenance swept unrelated real
   * git worktrees as "idle" (see worktree-sweep-guard fix in worktree-pool.ts
   * for the other half). This refusal closes the fix's second half: never
   * auto-register the engine's own source checkout as a project.
   */
  it("refuses to auto-register the Fusion source checkout itself and does not write any files", async () => {
    const globalDir = makeTempDir("fn-4266-global-");
    const cwd = makeTempDir("fn-4266-fusion-source-");
    mkdirSync(join(cwd, "packages", "engine"), { recursive: true });
    writeFileSync(
      join(cwd, "packages", "engine", "package.json"),
      JSON.stringify({ name: "@fusion/engine", version: "0.0.0" }),
      "utf-8",
    );

    const central = new CentralCore(globalDir);
    await central.init();

    const ensureSpy = vi.spyOn(central, "ensureProjectForPath");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "serve",
      autoRegister: true,
    });

    expect(result).toBeNull();
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, ".fusion"))).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[serve\].*Refus.*Fusion source checkout/i),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/cd|--project/i));

    await central.close();
  });

  it("still registers an explicitly pre-registered project even if it looks like the Fusion source checkout", async () => {
    const globalDir = makeTempDir("fn-4266-global-");
    const cwd = makeTempDir("fn-4266-fusion-source-explicit-");
    mkdirSync(join(cwd, "packages", "engine"), { recursive: true });
    writeFileSync(
      join(cwd, "packages", "engine", "package.json"),
      JSON.stringify({ name: "@fusion/engine", version: "0.0.0" }),
      "utf-8",
    );

    const central = new CentralCore(globalDir);
    await central.init();
    const existing = await central.registerProject({
      name: "ccc-fusion-dev",
      path: cwd,
      isolationMode: "in-process",
    });

    const result = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "serve",
      autoRegister: true,
    });

    expect(result?.id).toBe(existing.id);

    await central.close();
  });
});
