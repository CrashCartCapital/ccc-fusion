import { describe, expect, it } from "vitest";

import { codexAdapter, CodexExecReadinessDetector } from "../adapters/codex.js";

/**
 * Codex unattended turns must run through `codex exec`, not the interactive TUI.
 *
 * WHY THIS EXISTS. The adapter used to launch a bare `codex`, which starts the
 * interactive TUI. On a bare PTY with nothing answering terminal capability
 * queries (DSR `ESC[6n`, OSC 10/11 colour, kitty keyboard `ESC[?u`, device
 * attributes `ESC[c`), the TUI blocks in startup forever: no API socket, no
 * rollout file, no output. Three Round 11 campaign attempts died that way — the
 * last one burned 10h42m of wall clock having used 0.44s of CPU.
 *
 * `codex exec` is the documented non-interactive form. It reads the prompt from
 * argv, streams ordered JSONL events, fires the same `notify` turn-complete
 * program, and EXITS on its own. All assertions below are pinned to behaviour
 * verified against the installed binary (codex-cli 0.147.0).
 */

const CCC_PROFILE = "ccc-fusion";
const PROMPT = "Implement TASK-QE-EVIDENCE-LABELS and commit.";

/** Exec-mode launch settings: one unattended request whose prompt is on argv. */
function execSettings(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { oneShot: true, oneShotPrompt: PROMPT, ...extra };
}

describe("codex adapter exec mode", () => {
  it("launches the non-interactive `exec` subcommand with a JSONL event stream", () => {
    const launch = codexAdapter.buildLaunch({
      posture: null,
      settings: execSettings({ model: "gpt-5.6-sol" }),
    });

    expect(launch.command).toBe("codex");
    // The subcommand MUST be first: `codex exec [OPTIONS] [PROMPT]`.
    expect(launch.args[0]).toBe("exec");
    expect(launch.args).toContain("--json");
    // The prompt is the trailing positional, after every flag.
    expect(launch.args[launch.args.length - 1]).toBe(PROMPT);
    // Config overrides still compose (they are plain `-c key=value` tokens).
    expect(launch.args).toEqual(expect.arrayContaining(["-c", 'model="gpt-5.6-sol"']));
  });

  it("never emits `--ask-for-approval`, which `codex exec` rejects outright", () => {
    // Verified: `codex exec --ask-for-approval never` →
    //   "error: unexpected argument '--ask-for-approval' found".
    // exec is non-interactive and never prompts, so the flag is both invalid and
    // redundant. Emitting it would make every campaign turn fail to launch.
    const launch = codexAdapter.buildLaunch({
      posture: null,
      settings: execSettings({ profile: CCC_PROFILE, subscriptionReady: true }),
    });
    expect(launch.args).not.toContain("--ask-for-approval");
  });

  it("keeps the full ccc_fusion sandbox contract under exec", () => {
    const launch = codexAdapter.buildLaunch({
      posture: null,
      settings: execSettings({ profile: CCC_PROFILE, subscriptionReady: true }),
    });
    // Verified under `codex exec --strict-config`: all three keys are recognized.
    expect(launch.args).toContain(
      'permissions.ccc_fusion.filesystem={":minimal"="read",":workspace_roots"={"."="write","**/_secrets/**"="deny","**/_KELSEY/**"="deny","**/.agentsecrets/**"="deny","**/.env"="deny","**/.env.*"="deny"}}',
    );
    expect(launch.args).toContain("permissions.ccc_fusion.network.enabled=false");
    expect(launch.args).toContain('default_permissions="ccc_fusion"');
    expect(launch.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(launch.args).not.toContain("--sandbox");
  });

  it.each([
    {
      label: "dangerous autonomy posture",
      settings: execSettings({ profile: CCC_PROFILE, subscriptionReady: true }),
      posture: { autoApprove: true },
    },
    {
      label: "command replacement",
      settings: execSettings({
        profile: CCC_PROFILE,
        subscriptionReady: true,
        command: "custom-codex-wrapper",
      }),
      posture: null,
    },
    {
      label: "argument replacement",
      settings: execSettings({
        profile: CCC_PROFILE,
        subscriptionReady: true,
        extraArgs: ["--sandbox", "danger-full-access"],
      }),
      posture: null,
    },
  ])("still refuses ccc Codex $label in exec mode", ({ settings, posture }) => {
    expect(() => codexAdapter.buildLaunch({ posture, settings })).toThrow(
      /CCC Fusion Codex sandbox policy refused/u,
    );
  });

  it("refuses exec mode without a prompt rather than blocking on stdin", () => {
    // `codex exec` with no PROMPT reads instructions from stdin. Under an
    // engine-owned PTY stdin is a tty, so that is an open-ended wait with no
    // terminal signal — the exact failure shape we are removing. Fail loudly.
    expect(() =>
      codexAdapter.buildLaunch({ posture: null, settings: { oneShot: true } }),
    ).toThrow(/exec mode requires a prompt/iu);
  });

  it("resumes a captured thread through `exec resume`", () => {
    const resumed = codexAdapter.buildResume!({
      posture: null,
      nativeSessionId: "01a08bc5-3cda-7f71-b669-3694519dbabf",
      settings: execSettings({ model: "gpt-5.6-sol" }),
    });
    // `codex exec resume [SESSION_ID] [PROMPT]`.
    expect(resumed.args.slice(0, 3)).toEqual([
      "exec",
      "resume",
      "01a08bc5-3cda-7f71-b669-3694519dbabf",
    ]);
    expect(resumed.args).toContain("--json");
    expect(resumed.args[resumed.args.length - 1]).toBe(PROMPT);
    expect(resumed.args).not.toContain("--ask-for-approval");
  });

  it("declares that exec mode carries its own prompt so nothing is injected", () => {
    // The session manager injects the prompt as keystrokes after readiness. In
    // exec mode the prompt is already on argv; injecting would append stray
    // bytes to a process that is not reading the tty for input.
    expect(
      codexAdapter.consumesPromptOnLaunch!({ posture: null, settings: execSettings() }),
    ).toBe(true);
    expect(
      codexAdapter.consumesPromptOnLaunch!({ posture: null, settings: { model: "gpt-5.6-sol" } }),
    ).toBe(false);
  });

  it("leaves the interactive launch shape untouched", () => {
    const interactive = codexAdapter.buildLaunch({
      posture: null,
      settings: { profile: CCC_PROFILE, subscriptionReady: true, model: "gpt-5.6-sol" },
    });
    expect(interactive.args).not.toContain("exec");
    expect(interactive.args).not.toContain("--json");
    // Interactive Codex DOES accept (and needs) the approval flag.
    expect(interactive.args).toEqual(
      expect.arrayContaining(["--ask-for-approval", "never"]),
    );
  });
});

describe("CodexExecReadinessDetector", () => {
  it("reports ready on the first byte of the event stream", () => {
    // exec has no composer, no bracketed paste, and no prompt glyph — the TUI
    // readiness markers never appear. The first emitted event is readiness.
    const detector = new CodexExecReadinessDetector();
    expect(detector.observe("")).toBe(false);
    expect(
      detector.observe('{"type":"thread.started","thread_id":"01a08bc5"}\n'),
    ).toBe(true);
  });

  it("stays ready once ready", () => {
    const detector = new CodexExecReadinessDetector();
    detector.observe('{"type":"thread.started"}\n');
    expect(detector.observe("")).toBe(true);
  });
});
