# Hook verification

Pack ID: `PK-HOOKS`.

Read this generated pack only after the compact root catalog identifies a strong trigger.

Current truth anchors:

- Stack-level hook and lifecycle status: [[00_MAIN/00_RyanSSOT/REF-HUM-RyanFinalStackSSOT|Ryan Stack SSOT]].
- Current Hindsight checkpoint, warm-boot, candidate, and model-route contract: [[30_DEVSTACK/instruction_system/REF-AI-HindsightRuntimeSSOT-2026-07-15|Hindsight Runtime SSOT]] plus [[00_MAIN/00_RyanSSOT/REF-AI-ClaudeCodeHooksInventory|Claude Code Hooks Inventory]].
- Current approved/build-state reference for Ryan's custom hooks and skills: [[FLX-HUM-SkillsHooksImplementationPlan-2026-07-03|Skills Hooks Implementation Plan]]. If a newer active sibling plan exists in that folder, prefer the newer plan. Treat [[SkillsHooksApproved-2026-07-03|Approved Skills Hooks]] as the adjudicated idea list; the implementation plan owns shipped/proven/deferred details when they differ.
- Live registration still wins over prose. Verify the active runtime config, such as `~/.claude/settings.json`, `~/.codex/hooks.json` when present, plugin hook manifests, project overlays, or the current session-injected context before relying on a hook.

### Hook Event Verification

| Event family | Where ownership lives | What to verify |
|---|---|---|
| `SessionStart` variants | Runtime hook config plus project overlay and current skills/hooks plan | Which startup context is actually injected for this session |
| `UserPromptSubmit` | Runtime hook config, plugin hook manifests, or session context | Whether routing hints or repo status are advisory or enforced; configured suggestions may complement native skill discovery and active runtime policy |
| `PreToolUse` / permission hooks | Runtime hook config and project-local policy | Whether a gate exists, which tool/event it covers, and what failure looks like |
| `PostToolUse` / observer hooks | Runtime or project-specific observers | Whether output is informational, blocking, or absent |
| `Stop` / closeout hooks | Runtime hook config and active background-agent trackers | Whether stop can be blocked and how to wait safely |

### Conflict Zones

These hooks can compete for the same event. Verify precedence from live config:

- Multiple hook providers can register against the same event. Do not assume a general owner from shared root prose.
- If a project names a hook router such as contextmode, treat that as project-local runtime truth and verify it before registering competing hooks.
- `SessionStart` variants can be independent. Do not collapse resume, compact, and normal startup behavior without checking the active hook config.
- Do not deregister an existing hook just because a newer hook overlaps it. If the current skills/hooks plan says a legacy hook remains intentionally registered, changing that registration needs explicit task intent and approval.

### Operating Rules

- **Hard Rule** — never bypass a live `PreToolUse` or permission hook by routing through alternate tool surfaces.
- **Hard Rule** — when live config or project policy says a hook should fire for the current runtime/event, treat a missing signal as hook failure, not approval; halt the action and verify the hook fired before retrying.
- **Default** — if a hook return shape changes, assume hook failure until verified against the live runtime config and expected output shape.

### Diagnostic Cues

- Hook output schema validation is runtime-specific. If expected hook output fails schema validation or disappears, assume hook failure until the live hook config and expected output shape are verified.
- Daemon failures probed through indirect wrappers, SSH, or stale launch history can return false negatives. Use indirect probes to diagnose why the client path failed, but trust the actual client smoke path over an indirect probe for the final healthy/broken verdict when the two disagree.
- A `Stop` hook rejection means wait for tracked work to complete via the runtime's wait surface; do not retry or suppress the stop hook.

> **Extension point:** Project-specific hook additions or overrides go here.
