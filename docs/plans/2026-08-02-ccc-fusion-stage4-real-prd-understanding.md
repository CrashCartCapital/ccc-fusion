# Stage 4 — real-PRD understanding, review-only (2026-08-02)

One sentence: the product's discover → freeze → understand ladder ran against Ryan's real vault PRDs for the first time with a real local model, over a loopback-only route, with zero vault writes and zero hosted-provider egress.

## Route and egress posture

- Provider: `m2max-omlx` (custom, `openai-compatible`), base URL `http://127.0.0.1:18000/v1` — an SSH local-forward to oMLX on the operator's own M2 Max (`127.0.0.1:8000` there). Model: `Qwen3.6-27B-OptiQ-4bit` (262,144-token context).
- The CLI's loopback validator admitted the URL; no `--allow-remote` was used. Packet bytes leave this machine only through the operator's own SSH tunnel to the operator's own hardware. No hosted provider was touched; the Ryan-gated hosted-egress boundary was never approached.
- Registration used `fn provider add` with the API key supplied on stdin (a placeholder — oMLX ignores auth), exercising the Stage 6 operator path end to end.

## Corpus and discovery (read-only over the vault)

`fn prd corpus` and `fn prd discover` ran against `00_MAIN/01_ActiveProjects`: 23 project directories, 12 selections, no archive or protected-path reads. Selections byte-match the 2026-07-31 vertical-slice evidence (same selected PRD per project, including selecting `PRODPRD-atm-v0.8.4.md`, `260705-ccc-quant-engine-prd-v0.4.1.md`, and `PRJ-HUM-CCCQuantWiki-PRD-v0.1.md`).

## Freeze determinism (cross-session proof)

Three packets re-froze into scratch space with packet hashes identical to the 2026-07-31 receipts — same bytes, different session, different tree (merged main `5a23315fc`):

| Packet | Files | Packet hash | Unresolved refs |
| --- | --- | --- | --- |
| agentic-trade-management | 3 | `a471dfedad47a8df0783c92ed35285b76a3515fcb847f06a69f83b73f281f5f5` | 5 |
| ccc-quant-engine | 1 | `ecc8b600ee4a93d3aa95242005d6c24d0572f7adde906d43a9ebfcd7e7049403` | 0 |
| ccc-quant-wiki | 5 | `3d9a2a2ad481ab14a594e9e2c0075d85de99050b9a08c68d2323baca73f9b5ad` | 6 |

## Negative control (fresh, current code)

`fn prd freeze` on the ccc-fusion PRD v0.1 refused with `CCC_PRD_DECLARED_AUTHORITY_MISSING` (its declared authority notes resolve only under `_archive/`), created no output directory, and rendered the refusal with safe-state, consequence, and recovery text. The successor decision document is `docs/plans/2026-08-02-ccc-fusion-prd-v0.2-successor-proposal.md`.

## Understanding runs (review-only)

**Outcome:** no run completed a full review yet, and every stop was an honest, fail-closed refusal with zero partial writes — which is itself the product behaving exactly as specified. The distance to a completed review was measured precisely: after the fixes on this branch, the dense local 27B produced a structurally perfect proposal (4 requirements, 21 tasks, 4 proofs, 3 unresolved decisions) in which **47 of 48 source quotes anchor byte-exact and exactly-once**; the one survivor is a sentence that is genuinely duplicated verbatim in the source PRD, which no sentence-level quote can ever anchor uniquely — that closes only with the deterministic disambiguation layer tracked as task #9.

Model-class evidence (same packet, same contract prompt): the 35B-A3B MoE **invented** 25 of 33 quotes (paraphrase, not copy — none matched even whitespace-normalized); the dense 27B **copied** verbatim and failed only on uniqueness. Prompt-contract evidence: before the field contract was stated, 100% of runs failed shape; after, zero shape failures. Quote-discipline evidence: 6 bad refs → 1 across two guidance iterations. cqw and atm overnight lanes were launched on the final recipe (dense models, disciplined prompt; atm on the M2 Max's 262k-token window, the only place its ~98k-token prompt fits).

The atm overnight result closed the evidence set and proved the big-context route: the M2 Max's OptiQ 27B processed the full ~98k-token prompt through its 262,144-token window end-to-end and reached the provenance gate, refusing on one repeated identifier (`t-phase-1` occurs more than once in `PRODPRD-atm-v0.8.4.md`). Across all three packets the recipe lands one or two mechanical steps from a completed review: cqe 47/48 anchored (one duplicated sentence), atm one repeated identifier, cqw coverage arithmetic. Both residual classes are solved by the task #9 design, not by better prompting or bigger models.

The cqw overnight result exposed the second, independent ceiling: the dense 27B cleared shape **and** provenance on the 5-file packet but refused at the depth gate — `CCC_PRD_UNDERSTANDING_IMPLAUSIBLY_SHALLOW`, material inventory 88 heading blocks, only 20 dispositioned. Coverage completeness × byte-exact quoting × a single bounded response is arithmetically impossible for a multi-file packet: 88 dispositions with anchored quotes cannot fit one ~20k-token response. Together with the duplicated-sentence case, this makes the task #9 design (chunked extraction with per-chunk mechanical quote verification) the required path for real packets, not an optimization.

The first understanding attempts fought through a ladder of real product defects, each surfaced by an honest refusal (no partial writes anywhere):

1. `CCC_PRD_PATH_ESCAPE` — review output outside the packet root, correctly refused before any provider call.
2. `Provider is not configured` — keyless provider fails pi credential resolution (task #8; placeholder-key workaround).
3. `timed out after 1800000ms` — a 33k-token packet genuinely exceeds 30 minutes on the M2 Max's 27B dense model.
4. `length: incomplete response` — the registry hardcoded every custom-provider model at 16384 response tokens / 128000-token window, so the single-shot sidecar contract (every requirement citing an exactQuote, every heading dispositioned) cannot fit for a dense real PRD. **Fixed on this branch** (`b2a2b7e4f`): `fn provider add --max-tokens/--context-window` declare the backend's real limits per model entry.
5. `transport identity drifted … received local-omlx/keepalive` — oMLX emits SSE keepalive chunks whose model field is the placeholder "keepalive"; pi-ai captured response identity from the first differing chunk, so the anti-drift gate (E2 family) refused every oMLX response. This would also break real campaign execution against oMLX at the `pi.ts` identity seam. **Fixed on this branch** (pnpm patch on pi-ai@0.81.1): identity is captured only from substantive chunks (content, tool calls, finish signal); a genuinely aliased backend still surfaces and is refused — pinned by a fake-SSE-server regression pair.
6. `CCC_PRD_AUTHORING_PROPOSAL_INVALID` with a bare "wrong proposal schema or shape" — instrumented via a loopback tee proxy, the model's output turned out to be complete, parseable JSON with all 19 top-level keys that failed three unstated rules at once: citations under an invented `sources` key (the prompt never names `sourceRefs`), `bounds` as an array (never shaped), `confidence` as a float (never typed as "high"|"medium"|"low"). Hand-authored fixtures had masked all three. **Fixed on this branch** (`f7d35b174`): the transport prompt now carries the exact field contract, and the refusal enumerates the violated fields.
7. `CCC_PRD_SOURCE_QUOTE_MISSING` — with the contract in the prompt, the 35B-A3B model produced the right shape (4 requirements, 21 tasks, 5 proofs) but invented 25 of its 33 `exactQuote` citations: paraphrases and syntheses, not copies, none matching even after whitespace normalization. The provenance gate refused exactly as designed — worker narration is not proof, and an invented citation is refused, not repaired. This is a model-capability ceiling for byte-exact quoting over ~33k-token prompts, not a product defect; dense-27B lanes (local 5-bit, M2 Max OptiQ 4-bit) were raced to measure whether a stronger local model class clears it, and task #9 tracks the design alternatives (chunked extraction with per-chunk quote verification, deterministic quote re-anchoring, span-id citations) if none does.

Timing ground truth from the instrumented lane: oMLX on this M5 Max processes the ~33k-token prompt at ~23,000 tokens/s when cached and generates at ~74 tokens/s for the A3B MoE (13.5k generated tokens ≈ 3 minutes); the M2 Max's dense 27B could not finish inside 30 minutes on its first attempt, which is what the raised per-run duration caps are for.

## Product findings surfaced by this stage

1. **Keyless custom provider fails at prompt time.** `fn provider add` stores a provider without an API key, but pi-ai's credential resolution then fails the authoring transport with `Provider is not configured: <key>`. Local endpoints usually need no key, so the product's loopback-first story has a papercut. Tracked as task #8; placeholder-key workaround proven.
2. **Same-name re-add silently forks the registry key.** Adding `--name m2max-omlx` twice produced `m2max-omlx` and `m2max-omlx-2` with no warning.
3. **Review output must live inside the admitted packet root.** An outside-root review path refuses with `CCC_PRD_PATH_ESCAPE` before any provider call — correct fail-closed behavior, observed live.
4. **Read-only CLI paths exit cleanly; settings writes still hang** (pre-existing task #7): corpus/discover/freeze/understand exited 0 on their own, while `provider add/remove` needed the watchdog.
