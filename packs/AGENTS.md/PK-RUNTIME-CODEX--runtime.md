# Codex runtime

Pack ID: `PK-RUNTIME-CODEX`.

Read this generated pack only after the compact root catalog identifies a strong trigger.

### Execution Discipline

- Follow the target repo's project-local git model for branches, worktrees, commits, and generated roots. For non-vault code repos, the shared **Git And Repo Management** component is the default model; for `KnR-Vault`, the vault overlay stays stricter and excludes that component.
- Prefer `~/.codex/skills/`, Taskfile, shell, and documented SSOT notes over vendor-specific runtime lore.
- Prefer deterministic guardrails in hooks, scripts, templates, and repo tooling over prose expansion in the root file.

### Codex Worker Model Tiering

- For Codex subagent work, apply the shared **Parallel Work And Subagents** rules with Codex-specific model tiering only when the runtime explicitly exposes safe worker support and worker model selection, and the current model catalog exposes the exact IDs used below. When the parent/main session is the highest-capability tier (currently `gpt-5.6-sol`) and the work divides into isolated independent slices, bias the lowest-risk, well-bounded majority toward the fast/efficient tier (`gpt-5.6-luna`), use the balanced tier (`gpt-5.6-terra`) for routine but context-heavy or medium-complexity slices, and keep orchestration in the parent/main session while reserving the highest-capability tier (`gpt-5.6-sol`) for the hardest, highest-consequence, or most comprehensive minority. Treat this as a qualitative routing bias, not a quota; choose only effort values exposed for each selected worker model and do not assume the parent session's effort is valid for every tier. If the catalog no longer exposes these exact IDs, use the same relative capability tiers only when their replacements are explicitly exposed; never invent worker arguments or friendly names. If the parent is not the highest-capability tier, use the shared worker rules and do not automatically up-tier workers.
- Use `codex-model-router` for the detailed task/effort decision, including interactive-latency, unattended-strong-oracle, Terra middle-route, non-monotonic-effort, and requested-versus-effective route checks; keep this compiled component limited to the durable family-role bias above.
- Workers are coordination, not consultation. The shared **Parallel Work And Subagents** rules remain authoritative for read/write boundaries, sandbox/tool/MCP permissions, isolation, integration, conflict resolution, and proof.

### MCP Discovery Discipline

- **Hard Rule — Codex's initial visible tool list is incomplete in this stack.** Do not treat absence from the native/callable startup list as proof an MCP capability is unavailable.
- For brokered DevStack MCP, follow **MCP Server Reference**: `tool_search` if needed, broker `retrieve_tools`, returned `server`/`name`, returned `call_with`, and no guessed names. Use the exact `server:name` form when required by the active wrapper, such as `call_tool_read` for a returned read-only route.
- Codex deltas: `mcpproxy` brokers `stack-core`, `trading-readonly`, and `task-control`, with DeepWiki through `stack-core`; direct `mcpjungle-agy`, native apps, and local/plugin MCPs remain separate surfaces. Chunkhound is retired. Route details, retired names, snapshot semantics, and broker drift handling live in **MCP Server Reference**.
- The live v0.33-era broker and the isolated v0.51-derived sidecar are separate. In a proven sidecar session, authenticated management tools such as `quarantine_security` may be model-visible; preserve operation risk, scoped-token restrictions, and the explicit unquarantine gate. Treat `/mcp/all` as confirmation-gated, non-production break glass with an isolated `CODEX_HOME`, never as the normal Codex route.
- Consultant-support tools discovered through brokered `stack-core` support review/research/code-intel workflows but do not replace the consultation split: Gemini-family via `agy-bridge`, GPT/Codex-family via `codex-mcp-server`.

### Memory Checkpoints

- Treat Codex hook availability as runtime-specific. Verify `~/.codex/hooks.json`, current session context, or the project overlay before relying on SessionStart, Stop, or PreToolUse behavior.
- For current custom hook/skill build status, use the **Hook Event Verification** guidance and live runtime config rather than older brainstorming notes.
- Checkpoint durable lessons to the owning memory surface (see Memory Surface Reference — Hindsight or Basic Memory) at natural breakpoints when the session changes direction or completes a meaningful subtask.
- Codex currently uses instruction- or skill-driven Hindsight checkpoints rather than assuming Claude's hook automation. Use the same purpose-bank registry and explicit bank/tag contract.

### Command Safety Rules

- Treat the shared **Shell Risk Screening** section in Shared Core as the canonical policy for dangerous shell actions.
- Consultation discipline, preamble, advisory treatment, stateful follow-up, Codex read-only sandbox, model/effort rules, and skip conditions live in **Ensemble Consultation**. Codex routes: Gemini/Antigravity via `agy-bridge` using `delegate` for bounded checks and `adversarial_review` for high-value review (direct `mcpjungle-agy` if exposed; otherwise discover the available broker/direct agy surface first and use only exact discovered names); GPT/Codex via `codex-mcp-server` only for allowed high-stakes review, with `review` preferred.
- Keep review, tests, and proof explicit before completion.
- When OpenAI platform behavior matters, prefer official OpenAI docs and the OpenAI Docs MCP over recalled syntax or third-party summaries.
- Keep local Codex behavior distinct from Codex cloud behavior; do not import cloud-task assumptions into local Codex instructions without stating that they are local design choices.
- Treat shell execution as a high-risk local surface that needs explicit sandboxing or allow/deny controls.

> **Extension point:** Project-specific Codex runtime layers go here.
