import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { expect } from "vitest";
import {
  runPrdCommand,
  type PrdCommandDependencies,
} from "../../../../cli/src/commands/prd.js";
import type { CccPrdProductStatus } from "@fusion/core";

const execFile = promisify(execFileCallback);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout.trim();
}

export type ProductStatusOutput = Readonly<{
  kind: "product-status";
  found: true;
  status: CccPrdProductStatus;
  liveExecutionAuthorizationConfirmation?: Readonly<{
    authorizationId: string;
    confirmation: string;
  }>;
  mergeApprovalConfirmations?: readonly Readonly<{
    approvalRequestId: string;
    confirmation: string;
  }>[];
}>;

export type CommandResult = Readonly<{
  exitCode: number;
  values: readonly unknown[];
}>;

export type CapturedFailure = Readonly<{
  name: string;
  message: string;
  code: string | null;
  cause: string | null;
}>;

export function captureFailure(error: unknown): CapturedFailure {
  const detail = error as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
  const cause = detail.cause as { message?: unknown } | undefined;
  return {
    name: typeof detail.name === "string" ? detail.name : "Error",
    message: typeof detail.message === "string" ? detail.message : String(error),
    code: typeof detail.code === "string" ? detail.code : null,
    cause: typeof cause?.message === "string" ? cause.message : null,
  };
}

export async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  terminal?: (value: T) => unknown | null,
  diagnose?: () => unknown | Promise<unknown>,
): Promise<T> {
  let latest: T | undefined;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    latest = await read();
    if (accept(latest)) return latest;
    const diagnostic = terminal?.(latest);
    if (diagnostic !== null && diagnostic !== undefined) {
      throw new Error(
        `${label} became impossible: ${JSON.stringify(diagnostic)}; diagnostic=${JSON.stringify(await diagnose?.())}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out: ${JSON.stringify(latest)}; diagnostic=${JSON.stringify(await diagnose?.())}`);
}

export async function waitForDurableProductBoundary(
  read: () => Promise<ProductStatusOutput>,
  accept: (value: ProductStatusOutput) => boolean,
  diagnose: (value: ProductStatusOutput) => unknown | Promise<unknown>,
): Promise<ProductStatusOutput> {
  for (;;) {
    const latest = await read();
    if (accept(latest)) return latest;
    const terminal = terminalDiagnostic(latest);
    if (terminal !== null) {
      throw new Error(
        `durable product boundary became impossible: ${JSON.stringify(terminal)}; diagnostic=${JSON.stringify(await diagnose(latest))}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function runProductCommand(
  args: string[],
  dependencies: PrdCommandDependencies,
  runPrdCommandImpl: typeof runPrdCommand = runPrdCommand,
): Promise<CommandResult> {
  const output: string[] = [];
  const exitCode = await runPrdCommandImpl(
    [...args, "--json"],
    { write: (line) => output.push(line) },
    dependencies,
    { projectName: "ccc-golden-evidence-ledger" },
  );
  return { exitCode, values: output.map((line) => JSON.parse(line) as unknown) };
}

export function productStatus(result: CommandResult): ProductStatusOutput {
  expect(result.exitCode).toBe(0);
  expect(result.values).toHaveLength(1);
  return result.values[0] as ProductStatusOutput;
}

export function terminalDiagnostic(value: ProductStatusOutput): unknown | null {
  const failedProof = value.status.proofs.flatMap(({ definition, attempts }) =>
    attempts.map((attempt) => ({ proofId: definition.id, attempt })))
    .find(({ attempt }) => attempt.state === "proved_failed");
  const failedWork = value.status.workItems.find(({ state }) =>
    ["failed", "cancelled", "exhausted"].includes(state));
  return failedProof ? { proofId: failedProof.proofId, attempt: failedProof.attempt } : failedWork ? {
    id: failedWork.id,
    state: failedWork.state,
    error: failedWork.error,
  } : (
    ["blocked", "abandoned", "resolve-manual-required"].includes(value.status.nextAction.kind)
      ? { nextAction: value.status.nextAction }
      : null
  );
}
