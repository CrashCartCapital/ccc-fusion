import { describe, expect, it } from "vitest";
import { runPrdCommand } from "../prd.js";

describe("prd command exit contract", () => {
  it("returns usage exit 2 before any compiler or filesystem work", async () => {
    const output: string[] = [];
    expect(await runPrdCommand(["compile"], { write: (line) => output.push(line) })).toBe(2);
    expect(output).toEqual([
      "usage: fn prd author <root-dir> <manifest-path> <proposal-path> <sidecar-output> | fn prd <validate|compile> <root-dir> <manifest-path> <sidecar-path> <expected-target> <expected-base>",
    ]);
  });
});
