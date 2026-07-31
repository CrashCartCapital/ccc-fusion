import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runnerDir = path.join(repoRoot, ".github", "runner");
const dockerfilePath = path.join(runnerDir, "Dockerfile");
const entrypointPath = path.join(runnerDir, "entrypoint.sh");

function writeExecutable(filePath, source) {
  writeFileSync(filePath, source);
  chmodSync(filePath, 0o755);
}

test("local runner reuses its existing registration after a Docker restart", (t) => {
  const dockerfile = readFileSync(dockerfilePath, "utf8");
  assert.match(dockerfile, /^COPY entrypoint\.sh \/home\/runner\/entrypoint\.sh$/m);
  assert.equal(existsSync(entrypointPath), true);

  const runnerHome = mkdtempSync(path.join(tmpdir(), "fusion-runner-entrypoint-"));
  t.after(() => rmSync(runnerHome, { recursive: true, force: true }));

  writeExecutable(
    path.join(runnerHome, "config.sh"),
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$RUNNER_HOME/config.calls"
touch "$RUNNER_HOME/.runner"
`,
  );
  writeExecutable(
    path.join(runnerHome, "run.sh"),
    `#!/usr/bin/env bash
printf 'run\n' >> "$RUNNER_HOME/run.calls"
printf '%s\n' "\${RUNNER_MANUALLY_TRAP_SIG:-}" >> "$RUNNER_HOME/manual-trap.values"
`,
  );

  const initialEnvironment = {
    ...process.env,
    RUNNER_HOME: runnerHome,
    RUNNER_URL: "https://github.com/CrashCartCapital/ccc-fusion",
    RUNNER_TOKEN: "short-lived-registration-token",
    RUNNER_NAME: "fusion-arm64-test",
    RUNNER_LABELS: "self-hosted,linux,ARM64,ccc-fusion",
  };

  execFileSync("bash", [entrypointPath], {
    cwd: runnerHome,
    env: initialEnvironment,
    stdio: "pipe",
  });

  const restartEnvironment = { ...initialEnvironment };
  delete restartEnvironment.RUNNER_TOKEN;
  execFileSync("bash", [entrypointPath], {
    cwd: runnerHome,
    env: restartEnvironment,
    stdio: "pipe",
  });

  assert.equal(readFileSync(path.join(runnerHome, "config.calls"), "utf8").trim().split("\n").length, 1);
  assert.equal(readFileSync(path.join(runnerHome, "run.calls"), "utf8").trim().split("\n").length, 2);
  assert.deepEqual(
    readFileSync(path.join(runnerHome, "manual-trap.values"), "utf8").trim().split("\n"),
    ["1", "1"],
  );
});
