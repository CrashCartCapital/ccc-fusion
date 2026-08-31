import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import {
  createEvidenceLedgerBaseline,
  runEvidenceLedgerCommand,
} from "../lib/ccc-golden-evidence-ledger.mjs";

const commandPath = fileURLToPath(new URL("../ccc-golden-evidence-ledger.mjs", import.meta.url));

function capture() {
  let value = "";
  return {
    stream: { write: (chunk) => { value += chunk; } },
    value: () => value,
  };
}

test("PRD:GOLDEN-1 command handler initializes the trusted baseline with a bounded receipt", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-command-green-"));
  const target = path.join(parent, "target");
  try {
    const stdout = capture();
    const stderr = capture();
    const status = await runEvidenceLedgerCommand(["init", target], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      cwd: parent,
    });

    assert.equal(status, 0);
    assert.equal(stderr.value(), "");
    assert.deepEqual(JSON.parse(stdout.value()), {
      schema: "ccc-golden.fixture-result.v1",
      command: "init",
      target,
      fileCount: 14,
    });
    assert.deepEqual((await readdir(target)).sort(), [".gitignore", "Taskfile.yml", "fixtures", "package.json", "verify"].sort());
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 command handler refuses malformed arguments without writing", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-command-red-"));
  try {
    const stdout = capture();
    const stderr = capture();
    const status = await runEvidenceLedgerCommand([], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      cwd: parent,
    });

    assert.equal(status, 2);
    assert.equal(stdout.value(), "");
    assert.equal(stderr.value(), "usage: ccc-golden-evidence-ledger init <target>\n");
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 command handler refuses targets outside its allowed root", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-command-boundary-red-"));
  const workingRoot = path.join(parent, "working");
  const escapedTarget = path.join(parent, "outside");
  try {
    await mkdir(workingRoot);
    const stdout = capture();
    const stderr = capture();
    const status = await runEvidenceLedgerCommand(["init", "../outside"], {
      cwd: workingRoot,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(status, 1);
    assert.equal(stdout.value(), "");
    assert.equal(stderr.value(), "CCC_GOLDEN_INIT_FAILED\n");
    assert.deepEqual(await readdir(workingRoot), []);
    assert.deepEqual((await readdir(parent)).sort(), ["working"]);
    await assert.rejects(readFile(escapedTarget), { code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 command handler fails closed when the target already contains baseline files", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-command-collision-red-"));
  const target = path.join(parent, "target");
  try {
    assert.equal(await runEvidenceLedgerCommand(["init", target], { cwd: parent, stdout: capture().stream, stderr: capture().stream }), 0);
    const before = (await readdir(target)).sort();
    const stdout = capture();
    const stderr = capture();
    const status = await runEvidenceLedgerCommand(["init", target], {
      cwd: parent,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(status, 1);
    assert.equal(stdout.value(), "");
    assert.equal(stderr.value(), "CCC_GOLDEN_INIT_FAILED\n");
    assert.deepEqual((await readdir(target)).sort(), before);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 command handler leaves a non-empty target byte-identical on refusal", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-command-partial-red-"));
  const target = path.join(parent, "target");
  try {
    await mkdir(target);
    await writeFile(path.join(target, "package.json"), "sentinel\n");
    const stdout = capture();
    const stderr = capture();
    const status = await runEvidenceLedgerCommand(["init", target], {
      cwd: parent,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(status, 1);
    assert.equal(stdout.value(), "");
    assert.equal(stderr.value(), "CCC_GOLDEN_INIT_FAILED\n");
    assert.deepEqual(await readdir(target), ["package.json"]);
    assert.equal(await readFile(path.join(target, "package.json"), "utf8"), "sentinel\n");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 baseline creation leaves no target or staging residue after a mid-write failure", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-command-transaction-red-"));
  const target = path.join(parent, "target");
  let writes = 0;
  try {
    await assert.rejects(
      createEvidenceLedgerBaseline(target, {
        writeFile: async (...args) => {
          writes += 1;
          if (writes === 2) throw new Error("injected mid-write failure");
          return writeFile(...args);
        },
      }),
      /injected mid-write failure/,
    );
    assert.equal(writes, 2);
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("PRD:GOLDEN-1 thin CLI invokes the proven command handler", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "ccc-golden-ledger-cli-green-"));
  const target = path.join(parent, "target");
  try {
    const result = spawnSync(process.execPath, [commandPath, "init", target], {
      cwd: parent,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).fileCount, 14);
    assert.deepEqual((await readdir(target)).sort(), [".gitignore", "Taskfile.yml", "fixtures", "package.json", "verify"].sort());
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
