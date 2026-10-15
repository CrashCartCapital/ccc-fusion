/*
FNXC:CccShellCompat 2026-10-14-15:35:
Card X1b (request-to-code PRD v3 §8, D12; errata E2 "out of scope for X1",
E4-B). Package commands inside X1's confined shell. Inside the sandbox only the
per-instance toolchain clone can be executed: a `node_modules/.bin` shim
(`#!/bin/sh` from pnpm, `#!/usr/bin/env node` from npm) found by PATH lookup
fails with "bad interpreter: Operation not permitted", and npm has no `npm`
command at all. The shim layer fixes both: a `BASH_ENV` dispatcher runs shims
through the toolchain's `sh` (or `node`, as the shebang says) and exports
`npm_config_script_shell`, and wrappers with a toolchain shebang give `npm` and
`npx`.

Every positive case is paired with the same command on the raw X1 operations
(no shim layer), which must fail, so a pass cannot come from a fixture that
would have worked anyway. The tests share one X1 operations instance and one
toolchain to keep the closed check short (E4-B); the raw and the compat shell
are the same instance, with and without `withCccShellCompat`.

The single `skipIf(process.platform !== "darwin")` is the only skip form a
Darwin-tagged planning suite may carry (ADR D, skip policy).

FNXC:CccShellCompat 2026-10-14-17:15:
Repair 1 (errata E6-B items 1 and 3). The pnpm-style `#!/bin/sh` shim prints
`$BASH` and whether `SHELLOPTS` holds `posix`, so the test pins which clone
interpreter ran it: bash started as the clone's `sh` (POSIX mode on) when `sh`
was sealed from bash, or dash (no `$BASH`) when it was sealed from dash; the
mutant `sh|dash) tool=bash` fails. A `#!/usr/bin/env -S node <flag>` shim runs
through the clone's node with its flag, and an extra file planted in the shim
layer's directory or its wrappers directory refuses the next exec.
*/
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
  CCC_WRITER_SHELL_PROFILE_TEMPLATE_SHA256,
  createCccConfinedBashOperations,
  readCccConfinementOsBuild,
  type CccConfinedBashOperations,
  type CccSealedToolchain,
} from "../ccc-confinement/confined-shell.js";
import {
  CCC_SHELL_COMPAT_BASH_ENV_SOURCE,
  cccShellCompatWrappers,
  installCccShellCompat,
  withCccShellCompat,
} from "../ccc-confinement/shell-compat.js";
import { cccToolchainDefaultSearchPath, discoverCccToolchain } from "../ccc-confinement/toolchain-discovery.js";

/** The tools pnpm's sh shims call (`dirname`, `sed`, `uname`) plus `cat`, sealed under their unprefixed names. */
const REQUIRED = ["bash", "sh", "node", "git", "cat", "dirname", "sed", "uname"] as const;
/** The pnpm 10 command-shim shape: basedir through dirname and sed, a uname check, then exec node. */
const PNPM_SHIM = [
  "#!/bin/sh",
  `basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")`,
  "case `uname` in",
  "    *CYGWIN*|*MINGW*|*MSYS*) basedir=unsupported ;;",
  "esac",
  'echo "SHIM-ARG0=$0"',
  // Which clone interpreter runs this file: bash started as `sh` sets $BASH to that path and turns POSIX mode on.
  'echo "SH-BASH=${BASH-unset}"',
  'case ":${SHELLOPTS-}:" in *:posix:*) echo "SH-POSIX=on" ;; *) echo "SH-POSIX=off" ;; esac',
  'exec node "$basedir/../hello/cli.js" "$@"',
  "",
].join("\n");
/** Clone paths look like `<scratch>/toolchains/<16 hex>/bin/<name>`. */
const CLONE_BIN = /\/toolchains\/[0-9a-f]{16}\/bin$/u;

type Ran = { exitCode: number | null; output: string; error: unknown };

async function run(operations: BashOperations, command: string, cwd: string): Promise<Ran> {
  const chunks: Buffer[] = [];
  try {
    const { exitCode } = await operations.exec(command, cwd, { onData: (data) => chunks.push(data), timeout: 60 });
    return { exitCode, output: Buffer.concat(chunks).toString("utf8"), error: null };
  } catch (error) {
    return { exitCode: null, output: Buffer.concat(chunks).toString("utf8"), error };
  }
}

function line(output: string, key: string): string | undefined {
  return new RegExp(`^${key}=(.*)$`, "mu").exec(output)?.[1];
}

describe.skipIf(process.platform !== "darwin")("CCC shell compatibility layer (Darwin sandbox-exec)", () => {
  let root: string;
  let worktree: string;
  let scratchRoot: string;
  let toolchain: CccSealedToolchain;
  let raw: CccConfinedBashOperations;
  let compat: BashOperations;

  beforeAll(async () => {
    toolchain = await discoverCccToolchain({ searchPath: cccToolchainDefaultSearchPath(), required: REQUIRED });
    root = realpathSync(await mkdtemp(join(tmpdir(), "ccc-shell-compat-")));
    worktree = join(root, "worktree");
    scratchRoot = join(root, "scratch");
    const bin = join(worktree, "node_modules", ".bin");
    await Promise.all([
      mkdir(bin, { recursive: true }),
      mkdir(join(worktree, "node_modules", "hello"), { recursive: true }),
      mkdir(join(worktree, "node_modules", "hi"), { recursive: true }),
      mkdir(join(worktree, "src"), { recursive: true }),
      mkdir(scratchRoot),
    ]);
    await Promise.all([
      writeFile(join(worktree, "node_modules", "hello", "cli.js"), 'console.log("HELLO-CLI " + process.argv.slice(2).join(" ") + " exec=" + process.execPath);\n'),
      writeFile(join(worktree, "node_modules", "hi", "bin.js"), '#!/usr/bin/env node\nconsole.log("HI-NODE " + process.argv.slice(2).join(" ") + " exec=" + process.execPath);\n'),
      writeFile(join(bin, "hello"), PNPM_SHIM),
      writeFile(join(bin, "py-tool"), "#!/usr/bin/env python3\nprint('never')\n"),
      writeFile(join(bin, "envs-tool"), [
        "#!/usr/bin/env -S node --no-warnings",
        'console.log("ENVS-NODE execArgv=" + process.execArgv.join(",") + " args=" + process.argv.slice(2).join(",") + " exec=" + process.execPath);',
        "",
      ].join("\n")),
      writeFile(join(worktree, "package.json"), `${JSON.stringify({
        name: "ccc-shell-compat-fixture",
        version: "1.0.0",
        private: true,
        scripts: { greet: 'echo "SCRIPT-SHELL=$0"; hello from-script' },
      })}\n`),
    ]);
    await chmod(join(worktree, "node_modules", "hi", "bin.js"), 0o755);
    await symlink("../hi/bin.js", join(bin, "hi-node"));
    await chmod(join(bin, "hello"), 0o755);
    await chmod(join(bin, "py-tool"), 0o755);
    await chmod(join(bin, "envs-tool"), 0o755);
    raw = createCccConfinedBashOperations({
      profileId: "ccc-writer-shell.v1",
      worktreeRoot: worktree,
      gitDirs: [],
      writeRoots: [join(worktree, "src")],
      deniedNames: [],
      deniedRoots: [],
      scratchRoot,
      toolchain,
      taskEnv: {},
      limits: { wallMsCeiling: 600_000, cpuSeconds: 600, fileSizeBlocks: 2_097_152, maxOutputBytes: 1_048_576, maxReapPasses: 20 },
      qualification: {
        receiptSha256: createHash("sha256").update("x1b-shell-compat-receipt").digest("hex"),
        profileTemplateSha256: CCC_WRITER_SHELL_PROFILE_TEMPLATE_SHA256,
        osBuild: readCccConfinementOsBuild(),
      },
    });
    compat = withCccShellCompat(raw, { toolchain, scratchRoot });
  });

  afterAll(async () => {
    await raw?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("every wrapper carries a toolchain shebang and the npm wrapper runs npm inside the sandbox, while the raw shell has no npm", async () => {
    const wrappers = cccShellCompatWrappers(toolchain);
    expect(wrappers.map((wrapper) => wrapper.name)).toEqual(["npm", "npx"]);
    for (const wrapper of wrappers) {
      expect(wrapper.source.split("\n")[0]).toBe(`#!${toolchain.sh.path}`);
      // The entry it wraps carries a shebang nothing inside the sandbox can run.
      expect(readFileSync(wrapper.target, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
    }
    const install = await installCccShellCompat({ toolchain, scratchRoot });
    expect(install.dir.startsWith(`${realpathSync(scratchRoot)}/toolchains/`)).toBe(true);
    expect(readdirSync(install.wrapperDir).sort()).toEqual(["npm", "npx"]);
    for (const wrapper of wrappers) {
      expect(readFileSync(join(install.wrapperDir, wrapper.name), "utf8")).toBe(wrapper.source);
    }

    const confined = await run(compat, 'npm --version; echo "npm-rc=$?"', worktree);
    const plain = await run(raw, 'npm --version; echo "npm-rc=$?"', worktree);

    expect(confined.error).toBeNull();
    expect(confined.output).toMatch(/^\d+\.\d+\.\d+\nnpm-rc=0$/mu);
    expect(plain.error).toBeNull();
    expect(plain.output).toMatch(/npm: command not found/u);
    expect(plain.output).toMatch(/^npm-rc=127$/mu);
  });

  it("the BASH_ENV dispatcher runs node_modules/.bin shims through the toolchain sh and node and exports npm_config_script_shell, while the raw shell cannot run them", async () => {
    const command = [
      'PATH="$PWD/node_modules/.bin:$PATH" bash -c \'',
      'echo "script-shell=${npm_config_script_shell-}"; echo "bash-env=${BASH_ENV-}";',
      'hello a b; echo "hello-rc=$?"; hi-node c; echo "hi-rc=$?"\'',
    ].join(" ");

    const confined = await run(compat, command, worktree);
    const plain = await run(raw, command, worktree);

    expect(confined.error).toBeNull();
    const install = await installCccShellCompat({ toolchain, scratchRoot });
    expect(line(confined.output, "bash-env")).toBe(install.bashEnv);
    const exec = /^HELLO-CLI a b exec=(\S+)$/mu.exec(confined.output)?.[1] ?? "";
    expect(dirname(exec)).toMatch(CLONE_BIN);
    expect(line(confined.output, "script-shell")).toBe(join(dirname(exec), "bash"));
    expect(line(confined.output, "SHIM-ARG0")).toBe(join(worktree, "node_modules", ".bin", "hello"));
    // The #!/bin/sh shim ran from the clone's sh: bash started as sh (POSIX mode), or dash, which sets no $BASH.
    if (toolchain.sh.path === toolchain.bash.path) {
      expect(line(confined.output, "SH-BASH")).toBe(join(dirname(exec), "sh"));
      expect(line(confined.output, "SH-POSIX")).toBe("on");
    } else {
      expect(basename(toolchain.sh.path)).toBe("dash");
      expect(line(confined.output, "SH-BASH")).toBe("unset");
    }
    expect(line(confined.output, "hello-rc")).toBe("0");
    expect(confined.output).toContain(`HI-NODE c exec=${exec}`);
    expect(line(confined.output, "hi-rc")).toBe("0");
    // Control: without the shim layer the same shims cannot run inside the sandbox.
    expect(plain.error).toBeNull();
    expect(line(plain.output, "SH-BASH")).toBeUndefined();
    expect(line(plain.output, "script-shell")).toBe("");
    expect(plain.output).toContain("/bin/sh: bad interpreter: Operation not permitted");
    expect(line(plain.output, "hello-rc")).toBe("126");
    expect(line(plain.output, "hi-rc")).toBe("126");
  });

  it("runs a #!/usr/bin/env -S node shim through the toolchain node with the flags its shebang names, while the raw shell cannot run it", async () => {
    const command = 'PATH="$PWD/node_modules/.bin:$PATH" bash -c \'envs-tool p q; echo "envs-rc=$?"\'';

    const confined = await run(compat, command, worktree);
    const plain = await run(raw, command, worktree);

    expect(confined.error).toBeNull();
    const match = /^ENVS-NODE execArgv=(\S*) args=(\S*) exec=(\S+)$/mu.exec(confined.output);
    expect(match?.[1]).toBe("--no-warnings");
    expect(match?.[2]).toBe("p,q");
    expect(dirname(match?.[3] ?? "")).toMatch(CLONE_BIN);
    expect(line(confined.output, "envs-rc")).toBe("0");
    // Control: the raw shell finds the shim by PATH and cannot execute it inside the sandbox.
    expect(plain.error).toBeNull();
    expect(plain.output).toContain("bad interpreter: Operation not permitted");
    expect(plain.output).not.toContain("ENVS-NODE");
    expect(line(plain.output, "envs-rc")).toBe("126");
  });

  it("npm run starts its script shell from the toolchain bash, which loads the dispatcher and runs a .bin shim, while npm's default sh cannot run the shim", async () => {
    const npmCli = cccShellCompatWrappers(toolchain).find((wrapper) => wrapper.name === "npm")?.target ?? "";
    expect(npmCli).toMatch(/\/npm-cli\.js$/u);

    const confined = await run(compat, 'npm run greet; echo "run-rc=$?"', worktree);
    const plain = await run(raw, `node ${JSON.stringify(npmCli)} run greet; echo "run-rc=$?"`, worktree);

    expect(confined.error).toBeNull();
    const shell = line(confined.output, "SCRIPT-SHELL") ?? "";
    expect(dirname(shell)).toMatch(CLONE_BIN);
    expect(shell.endsWith("/bash")).toBe(true);
    expect(confined.output).toContain("HELLO-CLI from-script exec=");
    expect(line(confined.output, "run-rc")).toBe("0");
    // Control: npm itself runs on the raw shell, but its default script shell finds the shim by PATH and cannot run it.
    expect(plain.error).toBeNull();
    // npm's default script shell is `sh` by PATH lookup (the clone's sh), which never reads BASH_ENV.
    expect(line(plain.output, "SCRIPT-SHELL")).toBe("sh");
    expect(plain.output).toContain("bad interpreter: Operation not permitted");
    expect(plain.output).not.toContain("HELLO-CLI from-script");
    expect(line(plain.output, "run-rc")).not.toBe("0");
  });

  it("refuses a shim whose shebang names an interpreter outside the toolchain with a clear message and status 126, while a sh shim in the same directory runs", async () => {
    const command = 'PATH="$PWD/node_modules/.bin:$PATH" bash -c \'py-tool; echo "py-rc=$?"; hello x; echo "hello-rc=$?"\'';

    const confined = await run(compat, command, worktree);

    expect(confined.error).toBeNull();
    expect(confined.output).toContain(
      `ccc-shell-compat: ${join(worktree, "node_modules", ".bin", "py-tool")} needs python3, which the sealed toolchain does not provide`,
    );
    expect(line(confined.output, "py-rc")).toBe("126");
    expect(confined.output).not.toContain("never");
    expect(confined.output).toContain("HELLO-CLI x exec=");
    expect(line(confined.output, "hello-rc")).toBe("0");
  });

  it("keeps the dispatcher read-only inside the sandbox and refuses an exec once it changed outside, while the scratch home stays writable and the restored file runs", async () => {
    const confined = await run(compat, 'printf "x" >> "$BASH_ENV"; echo "env-write-rc=$?"; echo ok > "$HOME/probe"; echo "home-write-rc=$?"', worktree);
    const install = await installCccShellCompat({ toolchain, scratchRoot });

    expect(confined.error).toBeNull();
    expect(confined.output).toContain(`${install.bashEnv}: Operation not permitted`);
    expect(line(confined.output, "env-write-rc")).toBe("1");
    expect(line(confined.output, "home-write-rc")).toBe("0");
    expect(readFileSync(install.bashEnv, "utf8")).toBe(CCC_SHELL_COMPAT_BASH_ENV_SOURCE);

    await chmod(install.bashEnv, 0o644);
    await appendFile(install.bashEnv, "\necho tampered\n");
    let tampered: Ran;
    try {
      tampered = await run(compat, 'echo "ran-rc=$?"', worktree);
    } finally {
      await writeFile(install.bashEnv, CCC_SHELL_COMPAT_BASH_ENV_SOURCE);
      await chmod(install.bashEnv, 0o444);
    }
    const restored = await run(compat, 'echo "ran-rc=$?"', worktree);

    expect(tampered.error).toBeInstanceOf(Error);
    expect((tampered.error as Error).message).toContain(`ccc-shell-compat: ${install.bashEnv} does not hold the installed bytes`);
    expect(tampered.output).toBe("");
    expect(restored.error).toBeNull();
    expect(line(restored.output, "ran-rc")).toBe("0");
  });

  it("refuses an exec once an extra file is planted in the shim layer's directory or in its wrappers directory, while the exec runs again once the file is removed", async () => {
    const install = await installCccShellCompat({ toolchain, scratchRoot });
    const outcomes: Record<string, Ran> = {};
    for (const [key, dir] of [["top", install.dir], ["wrappers", install.wrapperDir]] as const) {
      const planted = join(dir, "extra-planted");
      await writeFile(planted, "planted\n");
      try {
        outcomes[key] = await run(compat, 'echo "ran-rc=$?"', worktree);
      } finally {
        await unlink(planted);
      }
    }
    const restored = await run(compat, 'echo "ran-rc=$?"', worktree);

    expect(outcomes.top.error).toBeInstanceOf(Error);
    expect((outcomes.top.error as Error).message).toContain(`ccc-shell-compat: ${install.dir} holds ["bash-env","extra-planted","wrappers"]`);
    expect(outcomes.top.output).toBe("");
    expect(outcomes.wrappers.error).toBeInstanceOf(Error);
    expect((outcomes.wrappers.error as Error).message).toContain(`ccc-shell-compat: ${install.wrapperDir} holds ["extra-planted","npm","npx"]`);
    expect(outcomes.wrappers.output).toBe("");
    expect(restored.error).toBeNull();
    expect(line(restored.output, "ran-rc")).toBe("0");
  });
});

