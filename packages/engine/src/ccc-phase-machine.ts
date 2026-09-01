export type CccExecutorPhase =
  | "DISCOVER"
  | "MUTATE"
  | "AWAIT_PHASE_SIGNAL"
  | "VERIFY"
  | "REPAIR"
  | "READY_FOR_CONTROLLER"
  | "TERMINAL_FAILURE";

export type CccPhaseAction =
  | "CONTINUE_DISCOVERY"
  | "PROMPT_MUTATION_CONTINUATION"
  | "PROMPT_PHASE_SIGNAL"
  | "RUN_CONTROLLER_VERIFICATION"
  | "PROMPT_REPAIR"
  | "HAND_OFF_READY"
  | "FAIL_TERMINAL";

export type CccPhaseDecision = Readonly<{
  phase: CccExecutorPhase;
  action: CccPhaseAction;
  noProgressClass?: "class-2" | "class-3";
  readCapWarning: boolean;
  capForcedStop: false;
  failureReason?: string;
}>;

export type CccPhaseObservation = Readonly<{
  phase: CccExecutorPhase;
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  turnSettled: boolean;
  explicitPhaseSignal: boolean;
  hasConfirmedMutation: boolean;
  readCount: number;
  discoverContinuations: number;
  mutateContinuations?: number;
  controllerVerification?: "ready" | "failed";
  repairAttempts?: number;
  maxDiscoverContinuations?: number;
  maxMutateContinuations?: number;
  readWarningThreshold?: number;
}>;

export function decideCccPhaseTransition(
  observation: CccPhaseObservation,
): CccPhaseDecision {
  const readWarningThreshold = observation.readWarningThreshold ?? 33;
  const maxDiscoverContinuations = observation.maxDiscoverContinuations ?? 1;
  const maxMutateContinuations = observation.maxMutateContinuations ?? 1;
  const readCapWarning = observation.readCount >= readWarningThreshold;

  if (observation.stopReason === "error" || observation.stopReason === "aborted") {
    return {
      phase: "TERMINAL_FAILURE",
      action: "FAIL_TERMINAL",
      readCapWarning,
      capForcedStop: false,
      failureReason: `provider turn ended with structural ${observation.stopReason}`,
    };
  }

  if (observation.stopReason === "toolUse") {
    return {
      phase: observation.phase,
      action: "CONTINUE_DISCOVERY",
      readCapWarning,
      capForcedStop: false,
    };
  }

  if (!observation.turnSettled) {
    return {
      phase: observation.phase,
      action: "CONTINUE_DISCOVERY",
      readCapWarning,
      capForcedStop: false,
    };
  }

  if (observation.phase === "READY_FOR_CONTROLLER") {
    return {
      phase: "READY_FOR_CONTROLLER",
      action: "HAND_OFF_READY",
      readCapWarning,
      capForcedStop: false,
    };
  }

  if (observation.phase === "VERIFY") {
    if (observation.controllerVerification === "ready") {
      return {
        phase: "READY_FOR_CONTROLLER",
        action: "HAND_OFF_READY",
        readCapWarning,
        capForcedStop: false,
      };
    }
    if (observation.controllerVerification === "failed") {
      if ((observation.repairAttempts ?? 0) < 1) {
        return {
          phase: "REPAIR",
          action: "PROMPT_REPAIR",
          readCapWarning,
          capForcedStop: false,
        };
      }
      return {
        phase: "TERMINAL_FAILURE",
        action: "FAIL_TERMINAL",
        readCapWarning,
        capForcedStop: false,
        failureReason:
          "Controller verification failed after the one allowed REPAIR turn",
      };
    }
    return {
      phase: "VERIFY",
      action: "RUN_CONTROLLER_VERIFICATION",
      readCapWarning,
      capForcedStop: false,
    };
  }

  if (observation.phase === "AWAIT_PHASE_SIGNAL") {
    if (observation.explicitPhaseSignal && observation.hasConfirmedMutation) {
      return {
        phase: "VERIFY",
        action: "RUN_CONTROLLER_VERIFICATION",
        readCapWarning,
        capForcedStop: false,
      };
    }
    return {
      phase: "TERMINAL_FAILURE",
      action: "FAIL_TERMINAL",
      noProgressClass: "class-3",
      readCapWarning,
      capForcedStop: false,
      failureReason:
        "Signal-only completion handshake ended without the required fn_complete_phase tool call",
    };
  }

  if (observation.phase === "REPAIR") {
    if (observation.explicitPhaseSignal && observation.hasConfirmedMutation) {
      return {
        phase: "VERIFY",
        action: "RUN_CONTROLLER_VERIFICATION",
        readCapWarning,
        capForcedStop: false,
      };
    }
    return {
      phase: "TERMINAL_FAILURE",
      action: "FAIL_TERMINAL",
      readCapWarning,
      capForcedStop: false,
      failureReason: !observation.explicitPhaseSignal
        ? "REPAIR ended without an explicit phase completion signal"
        : "REPAIR signalled completion without changing the failed candidate",
    };
  }

  if (
    observation.phase === "DISCOVER"
    && !observation.explicitPhaseSignal
    && !observation.hasConfirmedMutation
  ) {
    if (observation.discoverContinuations < maxDiscoverContinuations) {
      return {
        phase: "DISCOVER",
        action: "PROMPT_MUTATION_CONTINUATION",
        noProgressClass: "class-2",
        readCapWarning,
        capForcedStop: false,
      };
    }
    return {
      phase: "TERMINAL_FAILURE",
      action: "FAIL_TERMINAL",
      noProgressClass: "class-2",
      readCapWarning,
      capForcedStop: false,
      failureReason:
        `DISCOVER exhausted ${maxDiscoverContinuations} bounded DISCOVER continuation${maxDiscoverContinuations === 1 ? "" : "s"} without confirmed mutation or an explicit phase signal`,
    };
  }

  if (
    observation.phase === "MUTATE"
    && !observation.explicitPhaseSignal
    && observation.hasConfirmedMutation
  ) {
    if ((observation.mutateContinuations ?? 0) < maxMutateContinuations) {
      return {
        phase: "MUTATE",
        action: "PROMPT_MUTATION_CONTINUATION",
        noProgressClass: "class-3",
        readCapWarning,
        capForcedStop: false,
      };
    }
    return {
      phase: "AWAIT_PHASE_SIGNAL",
      action: "PROMPT_PHASE_SIGNAL",
      noProgressClass: "class-3",
      readCapWarning,
      capForcedStop: false,
    };
  }

  if (observation.explicitPhaseSignal && observation.hasConfirmedMutation) {
    return {
      phase: "VERIFY",
      action: "RUN_CONTROLLER_VERIFICATION",
      readCapWarning,
      capForcedStop: false,
    };
  }

  return {
    phase: observation.hasConfirmedMutation ? "MUTATE" : observation.phase,
    action: "CONTINUE_DISCOVERY",
    noProgressClass: observation.hasConfirmedMutation ? "class-3" : undefined,
    readCapWarning,
    capForcedStop: false,
  };
}
