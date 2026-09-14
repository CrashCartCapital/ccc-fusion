# Handoff: R1 Evidence-Envelope Campaign — MiniMax M3 Never Writes

**To:** a fresh Codex session with no prior context on this work
**From:** the Claude Code session that ran campaigns KB-003 → KB-012 (2026-08-22 → 2026-08-24)
**Date:** 2026-08-24
**Status:** paused at a decision point, nothing merged, nothing pushed

---

## 0. Read this first

You are taking over a stubborn debugging campaign that has burned seven live model runs without producing a single line of code. The previous session made real progress — it found and fixed one genuine defect, and it eliminated four plausible hypotheses with evidence — but it has not solved the problem, and its most recent two hypotheses were both killed by its own probes.

**Do not simply execute the previous session's recommendation.** You are being brought in specifically to look at this fresh. Read everything below, form your own view, and then act. If you think the prior analysis went down the wrong road, say so and take a different one. If you agree, say why and proceed. Either way, you own the decision.

You are expected to work **autonomously**. Do not stop to ask permission for reversible, project-local work. Ask the operator only when an action is irreversible, authority-expanding, or destructive — the hard boundaries are in section 9.

---

## 1. The operator

Ryan is a solo, independent U.S.-based developer building modular, spec-driven AI, automation, and research systems. He is technically strong and reads code, but he is one person with finite time and finite patience for rabbit holes.

What he values, in priority order:

- **Proof over narrative.** Name the command, quote the output, state what it proves. "Should work" is worthless to him.
- **Reversible changes with clear provenance.** Archive rather than delete. Branch rather than mutate.
- **Durable fixes over one-off hacks.** He will take a slower fix that keeps working over a fast one he has to remember.
- **Pragmatism.** He does not want a rewrite to chase one uncooperative model. He has said so explicitly.
- **Plain language.** Full technical precision, no insider shorthand. Explain the mechanism, don't just name it.
- **Brevity.** He interrupted the previous session mid-report with "way too verbose homie break it down for me with options." Lead with the decision and the evidence. Use options with tradeoffs when a call is genuinely his.

He works on a Tailscale/LAN Mac stack: an M5 Max MacBook Pro (this machine, the workstation), an M4 Mac mini (always-on service node), an M2 Max MacBook Pro (headless 24/7 inference), and a UGREEN NAS. Treat that as orientation only — verify any hostname, port, or path with the narrowest safe probe before relying on it.

---

## 2. What the system is

Four moving parts. Understand all four before you touch anything.

**Fusion** (`/Users/ryanpappal/03_CODE/ccc-fusion`) is a local agent-orchestration system. Its "CCC-PRD campaign" feature takes a product requirements document, compiles it through a sealed pipeline, and dispatches coding tasks to an AI model inside an isolated git worktree, then verifies the result against a proof bundle.

The pipeline, in order: `packet.md` → `manifest.json` → proposal → sidecar → execution-plan → validate → compile → policy → preview → import → approve-execution. Each stage hashes its inputs. The task instructions the model finally sees are **sealed**: their SHA-256 is recorded as `executionCustody.promptSha256` and re-verified at `packages/engine/src/workflow-task-runtime.ts:518`. If the bytes change, the run dies with `CCC_CAMPAIGN_EXECUTION_CUSTODY_DRIFT`.

Two consequences you must internalize:

- **The sealed prompt is immutable.** You cannot edit the task instructions to fix behavior. You can only re-seal a whole new packet through the pipeline.
- **The system prompt is NOT sealed.** It is built at dispatch time in `packages/engine/src/executor.ts` and is the one lever you have over what the agent is told. The previous session's real fix went here.

**pi** is the agent runtime that actually runs the loop — `@earendil-works/pi-coding-agent`, `pi-agent-core`, and `pi-ai`, all at v0.81.1, installed as **patched pnpm dependencies**. That last detail matters: patching pi is an already-supported, already-exercised path in this repo, not a hack you'd be inventing.

**OmniRoute** is a local OpenAI-compatible gateway that fronts the model. It is keyless on loopback. The pinned Fusion provider deliberately sends `X-OmniRoute-No-Cache: true` — **keep that header**, it exists so campaign runs never get served a cached completion.

**MiniMax M3** is the model under test, pinned as provider `omniroute-minimax-m3-pinned`, model id `minimax/MiniMax-M3`. The pin is the point of the experiment. Never substitute `minimax-latest`, `auto/minimax`, a fallback combo, or a different provider.

---

## 3. The task the model keeps failing

Repo: `/Users/ryanpappal/03_CODE/ccc-quant-engine/.worktrees/r1-evidence-envelope`, clean at `d1314bb`.

The campaign owns exactly four files and may write nowhere else:

| Path | Bytes | Lines |
|---|---|---|
| `src/qe_report/backend.py` | 11,068 | 298 |
| `src/qe_pilot/trend/runner.py` | 50,769 | 1,344 |
| `tests/report/test_cap009_report_backend.py` | 11,487 | 301 |
| `tests/pilot/test_trend_study.py` | 8,500 | 231 |

The work: add typed `evidence_class` and `maximum_claim` fields to `TearsheetPayload`, bind both into the stable payload hash, thread the equivalent through the trend runner, and cover it in the two test files. Then commit. `commitPolicy: required` means no commit equals failure.

This is an ordinary, well-scoped coding task. A competent coding model should finish it.

---

## 4. The symptom

Seven runs (KB-005, 006, 008, 009, 010, 011, 012). **The model has never once called `edit` or `write`.** It calls `bash`, `read`, and `grep`, reads the same files repeatedly, and then emits an assistant turn with no tool call. The pi agent loop reads a no-tool-call turn as "task complete," ends the session, and `commitPolicy: required` refuses with `CCC_CAMPAIGN_REQUIRED_COMMIT_REFUSED`. Zero diff, seven times.

Two most recent runs in detail:

- **KB-011** — 57 of 99 requests used, 56 tool calls (44 bash / 11 read / 1 grep), 0 edits, worktree `light-marsh`, no commit.
- **KB-012** — 36 of 99 requests, 45 tool calls (28 bash / 17 read), 0 edits, worktree `light-orbit`, no commit. Notably it created `.scratch/backend.py` byte-identical to the real file — a *reading* workaround, not a draft.

Neither exhausted its budget. Neither ran out of wall clock.

---

## 5. What is already settled — do not re-investigate

Each of these cost real time. Re-running them is pure waste.

**Tool availability — REFUTED.** The workflow node carries `toolMode=coding`, `executor=model`, `commitPolicy=required`. `packages/engine/src/pi.ts:3251-3268` builds all seven builtins in coding mode. `toolsAllowlist` is the only filter and is set only by the cron and automation-step paths, never the workflow executor. `packages/engine/src/__tests__/ccc-campaign-fallback-executor-seam.test.ts` has asserted `sessionCall.tools === "coding"` in-repo the entire time. `edit` and `write` were always on the table.

**Request budget — REFUTED.** Raised 20 → 40 → 99. The last two runs stopped at 57/99 and 36/99, both under cap. One earlier run burned its whole budget in 4m28s of a 50-minute deadline, so wall clock is never the binding constraint — provider requests are.

**Gateway corruption — REFUTED.** With a real `tools` array present, both streaming and non-streaming responses return clean structured `tool_calls` with reasoning intact. An early probe that omitted the `tools` array produced mangled `]<]minimax[>[<tool_call>` markup — that was a probe artifact, not a gateway defect. Don't cite it.

**`compat.requiresThinkingAsText` — tested, does not help.** One probe suggested it was actively backwards for this model, but that was a single sample and a later 3-round rerun contradicted it. Treat the flag as unhelpful; do not quote the original one-shot result as evidence either way.

**pi's read size cap — IRRELEVANT.** This one was a genuine error by the previous session, corrected late. The constants are `DEFAULT_MAX_LINES = 2000` and `DEFAULT_MAX_BYTES = 51200` (`pi-agent-core/dist/harness/utils/truncate.js:10-11`). Every one of the four owned files fits in a single uncapped read — the largest, `runner.py`, sits 431 bytes under the byte cap. The model-facing output is raw content with **no line-number prefixes** (`pi-coding-agent/dist/core/tools/read.js`, `outputText = truncation.content`). pi paginates cleanly with `offset`/`limit` and tells the model how to continue. pi has **no tool-result deduplication** anywhere — a grep confirmed this, so the model's own claim in one log that "the deduplication is hiding the content" was a hallucination. Nothing is being truncated. Do not build a plan on this cap.

**The replayed assistant-message shape — REFUTED, and this was the most recent lead.** pi-ai builds every replayed assistant turn as `content: compat.requiresAssistantAfterToolResult ? "" : null` (`openai-completions.js:862`). That flag defaults to `false` (`:1144`) with a per-model override available at `:1189`, and the pinned provider does not set it. `assistantMsg.content` is only overwritten when the model returned non-empty text (`:889`) — which M3 never does. **So Fusion genuinely sends `content: null`.** That looked damning. A 4-arm × 3-round probe held the conversation fixed and varied only that field — `null`+reasoning, `""`+reasoning, real text+reasoning, and `null` with no reasoning — and **all four arms behaved identically**. Setting `requiresAssistantAfterToolResult` would change nothing.

  One honest caveat on that probe: its synthetic tool result was deliberately partial, so re-reading was arguably correct behavior in every arm. The absolute verdict is confounded. The *contrast between arms* is not, because the confound is identical across them — and the contrast is what was being tested. Script: `probe12.py` in the previous session's scratchpad (see section 7).

---

## 6. The one real defect found and fixed

An `isolated` route creates a fresh, randomly-named worktree per run (`misty-crane`, `light-marsh`, `light-orbit`). Meanwhile the sealed prompt names the campaign's custody repo as "Target repository" — a **different absolute path** — via `packages/core/src/ccc-prd/projection.ts:204`. Nothing reconciled the two.

KB-011 said it out loud: *"The tool says I'm outside the worktree boundary. The current working directory is .../light-marsh but the task wants me to modify .../r1-evidence-envelope/."* The write tool was refusing its edits.

Fixed in commit **`bc6cd71fa`** by adding reconciliation language to the campaign **system** prompt in `packages/engine/src/executor.ts` (~line 18637) — the sealed prompt could not be touched. A RED test went in alongside it in `ccc-campaign-fallback-executor-seam.test.ts`.

The fix works: KB-012 showed no write-target confusion at all. It just still didn't edit anything.

Worth knowing: this defect is only *proven* to have affected KB-010 and KB-011. An analysis script (`confusion.py`) showed KB-005/006/008/009 had zero target-path mentions and zero confusion phrases. The previous session initially overclaimed that it explained all five runs and corrected itself. Don't repeat the overclaim.

---

## 7. The open question

MiniMax M3 returns `message.content` with **length 0** and puts all of its visible output in `reasoning_content`. Every prior assistant turn therefore replays without real text content. The model then complains it has lost its own context — *"I don't actually have the file contents in context from a prior read"* — and this surfaces in the logs as `</think>(prior reasoning summary unavailable)`, 24 times in KB-012 alone.

**That placeholder string exists nowhere in Fusion's source and nowhere in pi's.** It is either injected by OmniRoute during reasoning-field translation, or emitted by the model itself. Establishing which has not been done and is a live thread you could pull.

But note what section 5 established: the replay *shape* is innocent. So "amnesia caused by pi's serialization" is not a sufficient explanation. Something else is stopping this model from committing to an `edit` call. That is the question you are inheriting.

### Evidence you can pick up

The previous session's scratchpad is at:

```
/private/tmp/claude-501/-Users-ryanpappal-03-CODE-ccc-fusion/cd1a8a93-d26e-406d-8adb-4eec65aed38b/scratchpad/
```

Most useful files there: `probe9.py` (faithful replay with a real tools array), `probe10.py` (streaming path, which is what Fusion actually uses), `probe11.py` (the `requiresThinkingAsText` comparison), `probe12.py` (the 4-arm replay-shape test), `confusion.py` (per-run write-target confusion tally), and the `packet-run6/` sealed packet. These are session-scoped temp files — **copy anything you want to keep somewhere durable before relying on it.**

Per-run agent logs live at `<task-worktree>/.fusion/tasks/<TASK>/agent-log.jsonl`. Important schema note that cost the last session time: those rows store only tool **names** and assistant prose — never tool arguments. Rows are flat `{agent, taskId, text, timestamp, type}`. Don't write an analyzer assuming nested structure.

There is also a memory file with the condensed findings at
`/Users/ryanpappal/.claude/projects/-Users-ryanpappal-03-CODE-ccc-fusion/memory/ccc-fusion-minimax-m3-never-writes.md`.

---

## 8. Exact current state

**Fusion worktree:** `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/r1-qe-runner`, branch `agent/r1-qe-runner`. Clean except untracked `.opencode/`.

Unpushed commits, newest first. The top three are this mission's; the rest came from peer sessions and are disclosed here so you don't mistake them for yours:

```
bc6cd71fa  fix(ccc-campaign): reconcile the isolated worktree with the sealed target path
1eda5a7bc  fix(campaign): stop the local-Git recheck firing on ordinary inspection
494ff4094  fix(providers): let a custom-provider model declare reasoning capability
ecca81fab  fix(ccc-campaign): surface the terminal reason for failed work items
072b734cc  fix(engine): re-pin drifted shellout allowlist line
7e8a6ac68  fix(ccc-campaign): make the OmniRoute initial HTTP route receipt optional
7d26188ec  test(ccc): cover reapOrphanWorktrees against self-reclaim
91d54bb0f  fix(ccc-campaign): scope OmniRoute receipt check to reconciled terminals
015ddd257  fix(ccc): stop pool sweeps reclaiming their own root
25b04db5e  fix(ccc): resolve linked roots without stale cache
```

**Target repo:** `/Users/ryanpappal/03_CODE/ccc-quant-engine/.worktrees/r1-evidence-envelope`, clean at `d1314bb`.

**Control plane:** Pueue task **740**, Running, group `default`, label `ccc-fusion:r1-control-plane-bc6cd71`, listening on port 4040. Embedded PostgreSQL is Pueue task **705**, Running.

**Critical operational trap — this cost the previous session an entire wasted run.** `fn serve` runs the engine **in-process** (`serve.ts:292`, ProjectEngine/InProcessRuntime). No child-process worker is spawned. So **rebuilding the code does nothing until you restart the control plane.** The Pueue label encodes the commit that is actually live — `ccc-fusion:r1-control-plane-bc6cd71` means commit `bc6cd71` is running. If you change engine code, you must restart task 740 and re-label it, or you are testing stale bytes.

Second trap in the same family: there are **two** build outputs. `packages/engine/dist` and, separately bundled, `packages/cli/dist/bin.js` / `child-process-worker.js` / `extension.js`. A fix can land in one and not the other. Verify the function body, not just a grep hit — a naive grep for the changed line produced a false positive last time because the same expression appears elsewhere in the bundle.

**Sealed packet:** `packet-run6/` in the scratchpad. maxRequests 99, maxDurationMs 5400000, description 1238 chars, packet.md 9479 bytes. One byte-level constraint if you re-seal: `implementationFactProvenance.bounds.maxRequests.spans[0]` is a **2-byte span** (`byteStart:1674, byteEnd:1676`), so 99 is the maximum cap you can set without shifting every downstream offset.

**Two live `settings.json` edits** are in place with backups at `~/.fusion/settings.json.bak-20260824-reasoning` and `.bak-20260824-maxtokens16384`. Current pinned model config: reasoning enabled, `maxTokens` 16384 (Ryan chose 16384 explicitly over the smaller default).

**Known open bugs, not yet fixed, disclosed for completeness:** an advisory `baseCommitSha e32ef2c` capture bug; a `createFnAgent` header-drop bug at `pi.ts:3197`; a leftover `stash@{0}`; an unresolvable `dispatched_unknown` work item from KB-004. Also `.tmp_backend_tail.txt` is preserved in the `sharp-ridge` worktree as evidence.

---

## 9. Hard boundaries — non-negotiable

- **No merge, no push, no PR, no release, no publication.** Local commits on `agent/r1-qe-runner` are fine. Nothing leaves this machine.
- **Never print or expose connection material** for the embedded PostgreSQL, or any credential, token, or session value — not in commands, logs, prompts, or artifacts.
- **Never edit the database or workflow state by hand.** Go through the CLI.
- **Do not disturb unrelated Pueue groups**, and **do not disturb the `oc-fanout` service** beyond your own batches. Probe exact ownership before reusing or restarting anything. Never kill by broad pattern. Task 740 and any task you start yourself are yours; nothing else is.
- **Never access `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/wave-3`** — access is revoked. `wave-3-retry` is read-only dependency hydration only.
- **Preserve all evidence.** Task directories KB-003 through KB-012 and the `light-orbit/.scratch` copy stay. If residual `.fusion` evidence blocks a recreation, **archive it to a clearly named sibling — never delete it.** Ryan's standing rule across all projects is move to `.archive/`, never `rm`.
- **Do not rewrite, squash, merge, or push the existing commits.** Do not clean, reset, or stash the parent checkout, and do not use it as a campaign target.
- **Do not run a broad `git worktree prune`** or remove another session's worktree metadata.
- **Never substitute the model pin.** Not `minimax-latest`, not `auto/minimax`, not a fallback combo, not another provider — *except* inside a deliberate, clearly-labeled control experiment (see section 10, option E), which is explicitly permitted and is the whole point of that option.
- **Keep the `X-OmniRoute-No-Cache: true` header** on the pinned Fusion provider.
- **Preserve all unrelated dirty and untracked work** in every repo you touch.
- The earlier failed campaign attempts are **evidence, not retry candidates.** Do not re-run them.

Shell posture: apply a risk screen before any command that deletes, overwrites, changes permissions, executes remote code, or reaches outside the project. Prefer preview-then-act. Never type a SafeExec confirmation phrase or bypass SafeExec.

---

## 10. Where the previous session landed

Two independent consultations were run — Gemini via `agy-bridge adversarial_review`, and GPT via `codex-mcp-server` at `gpt-5.6-terra`. They converged on three points:

1. **Do not switch the runner to OpenCode.** Gemini's reasoning: OpenCode uses the same OpenAI-compatible client shape and will meet the identical gateway/model behavior, so you'd rebuild an integration and land in the same place. Codex: "refuse D now."
2. **Pre-loading the file contents into the prompt is dead**, once the read-cap premise collapsed. Both ranked it near-bottom.
3. **A control run with a known-good model is the cheap decisive test.** Gemini ranked it first; Codex second.

They split on sequencing. Codex wanted the loop-termination fix first, bounded: treat "zero diff plus no-tool-call" as an explicit `INCOMPLETE_NO_DIFF` state, inject exactly one corrective continuation, then fail loudly — framing it as fixing false-success reporting, not root cause. Gemini called that a band-aid and wanted the control run first.

The previous session's recommendation to Ryan was **B + E together**:

- **B — fix loop termination.** Under `commitPolicy: required`, a no-tool-call turn should not be silently accepted as completion. This is a real Fusion correctness bug on its own merits: the harness currently reports success when it produced nothing, and that will bite every future campaign regardless of model.
- **E — run one control campaign with a different, known-good coding model** against the same sealed task, same worktree, same tools. If it commits cleanly, the machinery is verified and M3 is the isolated failure. If it also fails, there's a harness bug that B's instrumentation will help surface.

Ryan has **not yet approved B+E.** He asked for this handoff instead. So you are not bound by it.

Codex also offered a sharper follow-up experiment that has **not been run** and is probably the single best next probe if you want ground truth on the replay question: capture the **real** turn-1 assistant object off the wire, then send two requests that differ in exactly one way — one with the `messages` array pi actually builds, one with that prior assistant object replaced by the raw provider object, preserving `content`, `reasoning_content`, `tool_calls`, and call IDs byte-for-byte. Don't force `tool_choice`. If the raw-object version edits and pi's version doesn't, the replay mapping is broken. If both edit, the problem is downstream in how Fusion handles the returned call or termination. If neither edits, it's M3/gateway task behavior and you stop blaming pi. Also record whether `(prior reasoning summary unavailable)` is already present in the outbound request before it reaches the gateway — that alone settles who injects it.

---

## 11. Your mandate

**Take a fresh look, decide the best path, and execute it.**

Concretely:

1. **Orient.** Verify the current state yourself — don't take section 8 on faith, it was written by a session that had already been wrong twice. Confirm the control plane commit matches the code you intend to test.
2. **Form your own hypothesis.** You have the full refuted list. What does it point at that nobody has looked at? Candidates nobody has properly pursued: who actually injects the placeholder string; whether the outbound request pi builds differs materially from what MiniMax's own API contract requires for multi-turn reasoning replay; whether something in Fusion's tool-result handling or termination path mishandles a returned call; whether the task framing itself pushes the model into an unbounded exploration phase.
3. **Discriminate before you build.** Run the cheapest experiment that could falsify your hypothesis. The previous session's biggest wins and biggest wastes both came down to whether it tested the real shape or a synthetic one. Test the real shape.
4. **Then fix it, under TDD.** RED first — name the failing test and capture the failure signature. GREEN — the smallest verification that proves the requirement holds. REFACTOR — rerun the narrowest check that risk demands.
5. **Prove it end to end.** A fix is not done until a live campaign produces a real diff on the owned paths, creates the required commit, and passes the sealed proof.

If you conclude partway through that the honest answer is "MiniMax M3 cannot do agentic editing through this harness," **that is a legitimate and valuable result.** Say it plainly, with the evidence, and stop spending on it. Do not manufacture a success.

---

## 12. How to use your compute

Ryan explicitly wants this run as an orchestration, not a solo grind.

**`oc-fanout` is your primary compute.** It is at `/Users/ryanpappal/.local/bin/oc-fanout` (a uv tool install of `opencode-fanout`, source at `/Users/ryanpappal/03_CODE/opencode-fanout`). It runs parent-reviewed rolling interactive OpenCode lanes from a sealed manifest, and it has a real gate model — you are the parent and you review candidates before anything lands.

Start with `oc-fanout doctor` to confirm the local stack, then `oc-fanout capacity` to see host workers. Author a manifest (schema version 1.0: `batch_id`, `repository`, `baseline` commit, `max_active_sessions`, `model_limits`, `integration_proof` argv, and a `tasks` array of prompts with critical constraints). Validate it with `oc-fanout plan` before `oc-fanout start`. Then drive the loop with `wait`, `status`, `next`, `review-queue`, `logs`, and gate each result with `accept` / `retry` / `repair` / `reject`, followed by `deliver` and `close`. There are working manifests to model yours on at `/Users/ryanpappal/03_CODE/oc-fanout-quick-smoke-manifest.json` and the several `qe-cap-006-oc-fanout-manifest-*.json` files in `03_CODE/`.

Use fanout lanes for the parallelizable work: independent investigation threads, competing hypotheses tested simultaneously, mechanical analysis over the ten task directories, building and running probe variants. Do not use it for the decisions — those are yours.

**Codex subagents, in limited number.** Ryan refers to these as the "luna" subagents. The agent roster lives at `/Users/ryanpappal/.codex/agents/*.toml` and includes `debugger`, `analyst`, `verifier`, `critic`, `architect`, `explore`, `test-engineer`, `code-reviewer`, and others. **Resolve the exact model identifier from live config rather than from any advertised list** — read `~/.mcpjungle/configs/codex-mcp-server.json` for the current default (it is `gpt-5.6-terra` with reasoning effort `ultra` as of this writing) and `~/.codex/config.toml` for the CLI default (`gpt-5.6-sol`). Always pass `model` explicitly. Keep the subagent count small and purposeful — a handful of well-scoped agents, not a swarm.

**`agy-bridge`, frequently.** Use `mcp__agy-bridge__delegate` for atomic checks and `mcp__agy-bridge__adversarial_review` for every plan critique, design review, and pre-implementation sanity check. Ryan wants this consulted often, not once at the end. It caught real problems in the previous session's reasoning — and it also made three factually wrong claims that were caught by reading the code (it asserted pi adds line-number prefixes, that pi-ai strips `reasoning_content`, and it cited a file path that doesn't exist). **Treat every consult output as a proposal to verify, never as authority.** Verify against the code before you act on it.

**Other MCP routing** (this client connects direct to MCPJungle groups, no broker hop):

- Local search first — exact `rg` and targeted reads beat everything. Then Smart Tree for structure, GitNexus for graph and impact analysis, repowise for health and risk.
- Context7 and DeepWiki and Octocode for library and upstream-source questions — genuinely useful here for pi's and MiniMax's actual API contracts.
- OmniRoute MCP tools for route diagnostics. One gotcha worth knowing: the quota endpoint returns a constant 100% while the real numbers live in `quota_snapshots`, and combo metrics count cache hits as provider successes. Trust the `x-omniroute-*` headers. Also, on uncached calls the gateway commits headers before choosing an upstream, so the route arrives only as trailing SSE comments.
- Hindsight and Basic Memory for cross-session recall.
- Search ladder if you need the open web: Brave → Serper → Tavily → fetch-guard → Paper Search.

Retired and never to be called: `tool-suite`, `toolgroup-green*`, `toolgroup-yellow`, PAL `clink`, `claude-mem`, Chunkhound.

---

## 13. Definition of done

You are done when **one** of these is true, with proof:

**Success.** A live sealed campaign, freshly imported and authorized, runs with requested and effective receipts both showing `omniroute-minimax-m3-pinned` / `minimax/MiniMax-M3`. The model modifies only the four owned files, creates the required commit, and passes the sealed proof. You have independently reviewed the diff. Nothing was merged, pushed, or published.

**Honest negative.** You have established, with a falsifiable experiment and quoted evidence, that this model cannot complete agentic editing through this harness — and you have named exactly which layer fails and why the remaining options aren't worth their cost.

Either way, report in this shape:

- **What you did** — commands run, what each proved.
- **What you found** — mechanism, not vibes. Cite file and line.
- **What changed** — commits, config edits, and where the backups are.
- **What's still open** — including anything you deliberately chose not to chase, and why.
- **Doing / Just did / Next** — a short catch-up note so Ryan can step away and return days later and be current in seconds.

Be concise. Lead with the decision and the evidence. He'd rather have four sharp paragraphs than four pages.

Good luck. The previous session's honest assessment: this is a real, interesting bug, the harness is closer to correct than it was three days ago, and the answer is probably one layer away from where everyone has been looking.
