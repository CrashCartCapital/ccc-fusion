# Claude runtime

Pack ID: `PK-RUNTIME-CLAUDE`.

Read this generated pack only after the compact root catalog identifies a strong trigger.

### Discipline and Continuity

- The Superpowers skill discipline layer is injected via a native SessionStart hook.
- Claude's current checkpoint and warm-boot hooks use Hindsight `agent_ops`; all other memory reads and writes follow the shared purpose-bank registry in Memory Surface Reference and the live Hindsight Runtime SSOT.
- Consultation discipline, preamble, advisory treatment, stateful follow-up, Codex MCP read-only sandbox, effort/model rules, and skip conditions live in **Ensemble Consultation**. Claude-specific routes: Gemini via `agy-bridge` on `stack-core`; GPT/Codex checkpoints via `codex-mcp-server` on `stack-core` when allowed, with `review` preferred for code review.
- Claude Code MCP access is topology-configured. Current laptop route is documented in [[00_MAIN/00_RyanSSOT/REF-HUM-RyanFinalStackSSOT|Ryan Stack SSOT]]: direct `stack-core`, `trading-readonly`, and `task-control` (group SSE); Chunkhound is retired, and Claude has no live mcpproxy route. When build/install validation depends on MCP truth, verify the active config, Ryan Stack SSOT, or generated/staged `mcp-install-manifest.json`; use the MCP Server Reference retired-route rule instead of requiring old `tool-suite`/`toolgroup-*` surfaces.

### Operating Posture

- Treat memory, hooks, skills, and local configs as separate layers, not reasons to let root instructions drift from runtime truth.
- On laptop Claude, `shell-risk-screener` (PreToolUse `Bash`) and `protected-path-guard` / C1 (PreToolUse `Read|Glob|Grep|Write|Edit|MultiEdit`) count as enforced gates only after current live configuration or a narrow runtime probe confirms their registrations and deny behavior. Never assume these hooks exist across hosts or sessions; when unverified, absent, or unhealthy, treat their constraints as manual Hard Rules and do not claim the runtime enforces them.
- For current custom hook/skill build status, use the **Hook Event Verification** guidance and live runtime config rather than older brainstorming notes.
- For non-vault code repos, follow the shared **Git And Repo Management** autonomy gates; for `KnR-Vault`, follow the vault overlay's no-branch/no-routine-commit model.
- When editing vault notes, use [[Skill-ObsidianMaster|Obsidian Master]].
- For Claude Code subagent work, apply the shared **Parallel Work And Subagents** rules with Claude-specific model tiering only when the runtime explicitly exposes worker model selection: if the main session is Opus or Fable and the work divides into isolated independent slices, bias the easiest, least-complicated roughly 90% toward parallel Sonnet workers, while the main Opus/Fable session keeps orchestration plus the hardest, most comprehensive, or most important roughly 10%. Treat 90/10 as a heuristic, not a quota; never invent subagent tool arguments, split atomic work just to match the ratio, or bypass parent-owned design, isolation, integration, conflict resolution, and proof.
- Before closing meaningful coding work, keep proof explicit.

> **Extension point:** Project-specific Claude runtime layers go here.
