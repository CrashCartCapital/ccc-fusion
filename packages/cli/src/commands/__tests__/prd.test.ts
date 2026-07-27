import { afterEach, describe, expect, it } from "vitest";
import { runPrdCommand } from "../prd.js";
import {
  cleanupPacketRoots,
  createPacketRoot,
} from "./prd-built-cli-fixture.js";

afterEach(cleanupPacketRoots);

describe("prd command exit contract", () => {
  it("returns usage exit 2 before any compiler or filesystem work", async () => {
    const output: string[] = [];
    expect(await runPrdCommand(["compile"], { write: (line) => output.push(line) })).toBe(2);
    expect(output).toEqual([
      [
        "usage: fn prd author <root-dir> <manifest-path> <sidecar-output> --target <repository> --base <40-hex-commit> --provider <provider> --model <model> --max-requests <n> --max-duration-ms <n> --max-concurrency <n> --max-prompt-bytes <n> --max-response-bytes <n> --max-review-items <n>",
        "       fn prd author <root-dir> <manifest-path> <proposal-path> <sidecar-output> (deterministic compatibility fixture)",
        "       fn prd <validate|compile> <root-dir> <manifest-path> <sidecar-path> <expected-target> <expected-base>",
      ].join("\n"),
    ]);
  });

});
