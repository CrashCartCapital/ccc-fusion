import { describe, expect, it } from "vitest";
import {
  mockedCreateFnAgent,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

describe("executor test helper reset", () => {
  it("clears queued agent factory implementations between tests", async () => {
    mockedCreateFnAgent.mockResolvedValueOnce({ sentinel: true } as never);

    resetExecutorMocks();

    expect(await mockedCreateFnAgent({} as never)).toBeUndefined();
  });
});
