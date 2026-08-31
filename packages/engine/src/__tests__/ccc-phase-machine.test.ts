import { describe, expect, it } from "vitest";
import { decideCccPhaseTransition } from "../ccc-phase-machine.js";

const base = {
  turnSettled: true,
  explicitPhaseSignal: false,
  readCount: 0,
  discoverContinuations: 0,
  mutateContinuations: 0,
} as const;

describe("CCC provider-neutral phase decisions", () => {
  it("classifies structural toolUse as Class 1 activity, not no-progress", () => {
    const decision = decideCccPhaseTransition({
      ...base,
      phase: "DISCOVER",
      stopReason: "toolUse",
      hasConfirmedMutation: false,
    } as any);

    expect(decision).toMatchObject({
      phase: "DISCOVER",
      action: "CONTINUE_DISCOVERY",
      readCapWarning: false,
      capForcedStop: false,
    });
    expect(decision.noProgressClass).toBeUndefined();
  });

  it.each(["stop", "length"] as const)(
    "classifies quiet %s with no confirmed mutation as Class 2",
    (stopReason) => {
      const decision = decideCccPhaseTransition({
        ...base,
        phase: "DISCOVER",
        stopReason,
        hasConfirmedMutation: false,
      } as any);

      expect(decision).toMatchObject({
        phase: "DISCOVER",
        action: "PROMPT_MUTATION_CONTINUATION",
        noProgressClass: "class-2",
      });
    },
  );

  it("phase_signal_handshake_after_dirty_continuation enters one signal-only state", () => {
    const decision = decideCccPhaseTransition({
      ...base,
      phase: "MUTATE",
      stopReason: "stop",
      hasConfirmedMutation: true,
      mutateContinuations: 1,
    } as any);

    expect(decision).toMatchObject({
      phase: "AWAIT_PHASE_SIGNAL",
      action: "PROMPT_PHASE_SIGNAL",
      noProgressClass: "class-3",
    });
  });

  it("routes the signal-only state to VERIFY only after an explicit phase signal", () => {
    expect(decideCccPhaseTransition({
      ...base,
      phase: "AWAIT_PHASE_SIGNAL",
      explicitPhaseSignal: true,
      hasConfirmedMutation: true,
      mutateContinuations: 1,
    } as any)).toMatchObject({
      phase: "VERIFY",
      action: "RUN_CONTROLLER_VERIFICATION",
    });
  });

  it("fails a settled signal-only state that still omits the explicit tool signal", () => {
    expect(decideCccPhaseTransition({
      ...base,
      phase: "AWAIT_PHASE_SIGNAL",
      explicitPhaseSignal: false,
      hasConfirmedMutation: true,
      mutateContinuations: 1,
    } as any)).toMatchObject({
      phase: "TERMINAL_FAILURE",
      action: "FAIL_TERMINAL",
      failureReason: expect.stringMatching(/signal-only.*fn_complete_phase/i),
    });
  });

  it.each(["stop", "length"] as const)(
    "classifies quiet %s after confirmed mutation as Class 3",
    (stopReason) => {
      const decision = decideCccPhaseTransition({
        ...base,
        phase: "MUTATE",
        stopReason,
        hasConfirmedMutation: true,
      } as any);

      expect(decision).toMatchObject({
        phase: "MUTATE",
        action: "PROMPT_MUTATION_CONTINUATION",
        noProgressClass: "class-3",
      });
    },
  );

  it.each(["error", "aborted"] as const)(
    "routes structural %s to terminal failure, not a no-progress class",
    (stopReason) => {
      const decision = decideCccPhaseTransition({
        ...base,
        phase: "DISCOVER",
        stopReason,
        hasConfirmedMutation: false,
      } as any);

      expect(decision).toMatchObject({
        phase: "TERMINAL_FAILURE",
        action: "FAIL_TERMINAL",
        failureReason: expect.stringContaining(stopReason),
      });
      expect(decision.noProgressClass).toBeUndefined();
    },
  );

  it("warns at 33 reads without forcing a stop", () => {
    const decision = decideCccPhaseTransition({
      ...base,
      phase: "DISCOVER",
      stopReason: "stop",
      hasConfirmedMutation: false,
      readCount: 33,
    } as any);

    expect(decision.readCapWarning).toBe(true);
    expect(decision.capForcedStop).toBe(false);
    expect(decision.action).toBe("PROMPT_MUTATION_CONTINUATION");
  });

  it("routes the first failed controller VERIFY to the one allowed REPAIR", () => {
    const decision = decideCccPhaseTransition({
      ...base,
      phase: "VERIFY",
      explicitPhaseSignal: true,
      hasConfirmedMutation: true,
      controllerVerification: "failed",
      repairAttempts: 0,
    } as any);

    expect(decision).toMatchObject({
      phase: "REPAIR",
      action: "PROMPT_REPAIR",
    });
  });

  it("routes a successful controller VERIFY to READY_FOR_CONTROLLER", () => {
    const decision = decideCccPhaseTransition({
      ...base,
      phase: "VERIFY",
      explicitPhaseSignal: true,
      hasConfirmedMutation: true,
      controllerVerification: "ready",
      repairAttempts: 0,
    } as any);

    expect(decision).toMatchObject({
      phase: "READY_FOR_CONTROLLER",
      action: "HAND_OFF_READY",
    });
  });

  it("makes a second failed controller VERIFY terminal", () => {
    const decision = decideCccPhaseTransition({
      ...base,
      phase: "VERIFY",
      explicitPhaseSignal: true,
      hasConfirmedMutation: true,
      controllerVerification: "failed",
      repairAttempts: 1,
    } as any);

    expect(decision).toMatchObject({
      phase: "TERMINAL_FAILURE",
      action: "FAIL_TERMINAL",
      failureReason: expect.stringMatching(/verification.*repair/i),
    });
  });

  it("routes a changed REPAIR with a fresh signal back to controller VERIFY", () => {
    const decision = decideCccPhaseTransition({
      ...base,
      phase: "REPAIR",
      explicitPhaseSignal: true,
      hasConfirmedMutation: true,
      repairAttempts: 1,
    } as any);

    expect(decision).toMatchObject({
      phase: "VERIFY",
      action: "RUN_CONTROLLER_VERIFICATION",
    });
  });

  it.each([
    ["without a fresh signal", false, true],
    ["without changed candidate bytes", true, false],
  ] as const)("makes a settled REPAIR %s terminal", (_label, explicitPhaseSignal, hasConfirmedMutation) => {
    const decision = decideCccPhaseTransition({
      ...base,
      phase: "REPAIR",
      explicitPhaseSignal,
      hasConfirmedMutation,
      repairAttempts: 1,
    } as any);

    expect(decision).toMatchObject({
      phase: "TERMINAL_FAILURE",
      action: "FAIL_TERMINAL",
      failureReason: expect.stringMatching(/repair/i),
    });
  });
});
