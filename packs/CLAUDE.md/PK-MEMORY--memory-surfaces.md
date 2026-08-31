# Memory surfaces

Pack ID: `PK-MEMORY`.

Read this generated pack only after the compact root catalog identifies a strong trigger.

- Keep root instruction files coherent and intentional. Add rules only when they materially improve recurring behavior.
- Reference files and notes instead of pasting large bodies into chat.
- Checkpoint durable lessons to the owning memory surface (see Memory Surface Reference) at natural phase breaks and before major direction changes.
- Compact after finishing a logical phase or when the session starts to carry stale branches.
- Reset the approach after two failed correction cycles with no real delta.

> **Extension point:** Project-specific checkpoint targets and compaction triggers go here.

Current truth anchors:

- Use [[00_MAIN/00_RyanSSOT/REF-HUM-RyanFinalStackSSOT|Ryan Stack SSOT]] for current memory/knowledge-surface health, rejected/retired status, and live-empty/stale distinctions.
- Hindsight banks, models, tags, hooks, and operating rules are governed by [[30_DEVSTACK/config/REF-AI-HindsightRuntimeSSOT-2026-07-15|Hindsight Runtime SSOT]].
- Treat qmd, mdidx, and llm-wiki-compiler as potentially live-empty. Any compiled-wiki query surface is corpus-bound and source-dated unless fresh proof says otherwise. Kwipu was removed 2026-08-24 — deleted from disk and deregistered from MCPJungle.

### Surface Map

| Surface | Scope | Best For | Write Cost |
|---|---|---|---|
| Hindsight (when configured) | Per-bank Postgres | Purpose-banked experiential memory, durable lessons, and long-horizon observations; agents must choose the correct bank explicitly | Medium; bank choice and provenance matter |
| Basic Memory | Per-project markdown notes | Project-local memory that should travel with the repo, not the vault | Cheap; file-system level |
| Session/runtime context store (when configured) | Ephemeral session state | Within-session context routing, hook gating, transient state | Cheap; resets per session |
| GitNexus or equivalent code graph | Code graph | Cross-repo symbol search, code archaeology, structural facts | Read-only from the agent's view |
| Compiled-wiki query surface (none installed) | LLM-wiki query | Reads compiled wiki content; not a source of truth or memory writer | Read-only |
| `llm-wiki-compiler` or equivalent wiki write surface | LLM-wiki write | Promotes durable structured knowledge into the wiki | Heavy; deliberate |

### Read And Trust State

- Query Hindsight or Basic Memory only after live route or SSOT says reachable. Treat Hindsight reads and writes as bank-scoped private context; verify active bank and project tags before relying on them.
- `agent-session-search` is read-only transcript archaeology. Use exact literal queries and treat snippets as private, stale-prone leads until checked against transcript, live files, git, or runtime state.
- Compiled-wiki answers are corpus-bound and source-dated; do not use them for current stack, MCP, or runtime truth without matching freshness proof.
- qmd, mdidx, and llm-wiki surfaces may be installed but empty. If retrieval is empty or stale, say so and fall back to scoped direct `rg` or reads with protected/archive exclusions; empty retrieval is not absence of evidence.
- Wiki promotion is deliberate: use it only for durable, deduplicated, source-grounded knowledge after the routing rules choose the wiki write surface.
- Hindsight vector provenance may be unknown even when dimensions match. Separately, the CCC vault corpus is BGE-M3 1024d; any embedding-model change requires full wipe and rebuild, never partial rebuild.

### Routing Rules

- **Default** — choose one owning memory surface for each durable fact; duplicate writes only when one surface is explicitly a pointer or summary of the other.
- **Default** — operator-wide durable lessons → the purpose-matched Hindsight bank when Hindsight is active; verify the bank before write.
- **Default** — repo-specific lessons that should travel with the project → Basic Memory in the touched project.
- **Default** — long-horizon observation streams → the purpose-matched Hindsight bank when Hindsight is active; verify the bank before write.
- **Default** — within-session ephemeral state → the runtime/session context store when available. A governed checkpoint hook may retain only evidence-linked, redacted durable lessons through the candidate policy in the runtime SSOT.
- **Conditional** — wiki write only when the knowledge is durable, deduplicated, and earns wiki-level structure; otherwise use the owning memory surface above.

### Hindsight Bank Discipline

- **Hard Rule** — pass an explicit purpose-matched bank on every Hindsight call. Current routing is instruction-governed; the service-specific coarse admission guard rejects missing or non-admitted banks but does not prove that an admitted chosen bank is semantically correct.
- **Default** — route operational tool/runtime lessons to `agent_ops`; whole-life preferences and durable personal context to `life`; cross-project lessons and re-entry context to `projects`; trading research process and methodology to `trading_research`; synthetic probes only to `canary`. Keep `professional_admin` reserved and `default` unused.
- **Default** — use tags such as `project:<slug>` and `cwd_hash:<hash>` inside shared banks; do not create a bank per project.
- **Hard Rule** — Hindsight is not the owner of current facts, full transcripts, active task state, prices, positions, balances, credentials, or protected health information. Store source-linked lessons and preferences, and verify recalled claims against their canonical owner before action.

### Write-Before-Recall

- Before a checkpoint, name what should be remembered and to which surface; do not let it default.
- If a checkpoint-critical memory write fails, surface the error, mark the memory as unwritten, and use an approved fallback only if the routing rule permits it.

> **Extension point:** Project-specific memory routing, bank assignments, or per-project wiki paths go here.
