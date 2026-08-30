import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  git,
  readProviderEvents,
} from "./ccc-golden-evidence-ledger-campaign-fixture.js";
import type { ProductStatusOutput } from "./ccc-golden-evidence-ledger-campaign-support.js";

const execFile = promisify(execFileCallback);

export async function replayContractProof(
  status: ProductStatusOutput,
  markerPath: string,
): Promise<unknown> {
  const contractAttempt = status.status.proofs
    .find(({ definition }) => definition.id === "PROOF-LEDGER-CONTRACT")
    ?.attempts.at(-1);
  const contractWorktree = readProviderEvents(markerPath)
    .find(({ taskId }) => taskId === "TASK-LEDGER-CONTRACT")?.cwd;
  if (!contractAttempt || !contractWorktree) return { contractAttempt, contractWorktree };
  const run = async (campaignMode: boolean) => {
    try {
      const result = await execFile(process.execPath, [
        "verify/project-verifier.mjs",
        "src/record.mjs",
        "src/validation.mjs",
      ], {
        cwd: contractWorktree,
        encoding: "utf8",
        env: campaignMode ? {
          PATH: process.env.PATH,
          CCC_PROOF_ID: "PROOF-LEDGER-CONTRACT",
          CCC_PROOF_PHASE: "task",
          CCC_PROOF_SOURCE_COMMIT: contractAttempt.sourceCommit,
          CCC_PROOF_SOURCE_TREE: contractAttempt.sourceTree,
        } : { PATH: process.env.PATH },
      });
      return { exitCode: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
    } catch (error) {
      const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: failure.code,
        stdout: failure.stdout?.trim(),
        stderr: failure.stderr?.trim(),
        message: failure.message,
      };
    }
  };
  return {
    contractAttempt,
    contractWorktree,
    head: await git(contractWorktree, "rev-parse", "HEAD"),
    status: await git(contractWorktree, "status", "--porcelain"),
    rich: await run(false),
    campaign: await run(true),
  };
}
