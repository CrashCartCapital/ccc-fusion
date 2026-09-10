import { afterEach, describe, expect, it } from "vitest";

import { CliSessionStateMachine } from "../state-machine.js";

/**
 * Regression guard for the inactivity backstop that fails long unattended
 * provider turns. A reasoning model can work for far longer than the
 * interactive 5-minute default without emitting PTY output; the backstop then
 * reads that legitimate work as a stall and fails the workflow node.
 */
const ENV_KEY = "FUSION_CLI_AGENT_STALL_THRESHOLD_MS";

type MachineStore = ConstructorParameters<typeof CliSessionStateMachine>[0]["store"];

function makeStore(): MachineStore {
  return {
    getSession: () => undefined,
    updateSession: () => undefined,
  } as unknown as MachineStore;
}

/** Build a machine, drive it to a busy turn, and report the armed watchdog delay. */
function armedDelayMs(stallThresholdMs?: number): number | null {
  let captured: number | null = null;
  const machine = new CliSessionStateMachine({
    sessionId: "session-under-test",
    store: makeStore(),
    ...(stallThresholdMs === undefined ? {} : { stallThresholdMs }),
    setTimer: (_fn, ms) => {
      captured = ms;
      return 1;
    },
    clearTimer: () => undefined,
  });
  machine.markReady();
  machine.injectPrompt();
  return captured;
}

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("CliSessionStateMachine stall threshold", () => {
  it("defaults to the interactive 5-minute backstop", () => {
    delete process.env[ENV_KEY];
    expect(armedDelayMs()).toBe(5 * 60_000);
  });

  it("honours FUSION_CLI_AGENT_STALL_THRESHOLD_MS for unattended runs", () => {
    process.env[ENV_KEY] = "86400000";
    expect(armedDelayMs()).toBe(86_400_000);
  });

  it("ignores a non-positive or unparsable override and keeps the default", () => {
    for (const bad of ["0", "-1", "not-a-number", ""]) {
      process.env[ENV_KEY] = bad;
      expect(armedDelayMs()).toBe(5 * 60_000);
    }
  });

  it("still lets an explicit option win over the environment", () => {
    process.env[ENV_KEY] = "86400000";
    expect(armedDelayMs(1234)).toBe(1234);
  });
});
