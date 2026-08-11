# PRD Corpus Diversity Matrix — 2026-08-03

> **Historical evidence note:** This file is retained as corpus-diversity evidence. It is not a current implementation plan. For current CCC-Fusion direction and defaults, start with [2026-08-11 product direction](./2026-08-11-ccc-fusion-product-direction.md) and the [plans index](./README.md).

One sentence: this measures the 12 real vault PRD packets Stage 4 discovery actually selected, along the format axes an anchor-resolver has to survive, so Phase 1's gate can be pinned on packets chosen for *measured* diversity rather than convenience.

## 0. Method and provenance

- **Selection source:** `/private/tmp/claude-501/.../scratchpad/s4-discover.json` — the raw output of the actual `fn prd discover` run against `00_MAIN/01_ActiveProjects` (23 project dirs), referenced by `docs/plans/2026-08-02-ccc-fusion-stage4-real-prd-understanding.md`. This is a tool-output artifact, not a re-derivation — **all 12 selections below are CONFIRMED**, not inferred.
- **Packet composition (which files count as "the packet"):** for the 3 packets with prior freeze hashes (atm, cqe, cqw) file counts are **CONFIRMED** against those hashes. For the other 9, no live `fn prd freeze` was run this session (no CLI access from this read-only session) — packet membership was **INFERRED** by reading each anchor PRD's own `[[wikilinks]]`/markdown links and including only companions the anchor genuinely links to, one directory-listing hop at a time via `smart-tree`/`Read`. Every inferred row says so explicitly.
- **Vault boundary:** read-only, scoped to `01_ActiveProjects/` only. `_archive/`, `_secrets/`, `_KELSEY/`, `.obsidian/` were never opened, including when a wikilink pointed there (noted, not followed).
- **Size/tokens:** byte sizes are exact (tool-reported file sizes, hex-decoded from `smart-tree`). Token estimates use **bytes ÷ 4**, a rough heuristic, per the task's own guidance — not a real tokenizer run.
- **Execution:** 12 parallel read-only sub-agents (one per packet), each independently reading its packet and reporting the 10 axes. The `ccc-lab-super` packet turned out to be far larger than anticipated (its anchor wikilinks nearly its entire 26-file sibling set), so that sub-agent further fanned out into 5 batch-agents; its section below is a manual synthesis of those 5 batch reports (the batch agents missed 2 of ~29 linked companions — noted in §3.4).
- **Known-evidence cross-checks:** where prior Stage 4 evidence made a specific claim (a hash, an unresolved-ref count, a duplicated sentence, "88 heading blocks," "t-phase-1"), the independent re-read was asked to confirm or correct it rather than assume it. One correction surfaced — see §5.

## 1. Matrix — structural axes

| # | Packet | Files (status) | Frontmatter (canonical+extra) | Tables | Code blocks (langs) | Dir trees | Wikilinks (count, density/KB) |
|---|---|---|---|---|---|---|---|
| 1 | agentic-trade-management (atm) | 3 — **confirmed** (hash `a471dfed…`) | 5/5 canonical + 13 extra (incl. `source_*` provenance chain) | 48 (37 live + 11 nested-in-fixture) | 20: python×5, json×6, markdown×4, text×3, bash×2 | 0 | 41 total, 0.14/KB |
| 2 | ccc-autocode-neo | 1 — **inferred** (0 wikilinks found; only backtick path citations) | 5/5 + 6 extra | 8 | 17: text×13, json×4 (each a single-line multi-KB blob) | 0 | **0** — only packet with none |
| 3 | ccc-fusion (negative control) | 1 — **confirmed** (known refusal case) | 5/5 + 8 extra | 0 | 0 | 0 | 11 total, 0.38/KB |
| 4 | ccc-lab-super (DuckLake) | ~27 (anchor+26) — **inferred**, see §3.4 for 2-file gap | 5/5 + 1–4 extra, near-uniform across files | ~105 (1 hand-padded — the only one in the whole corpus) | ~59: yaml≈38, python≈6, sql×1, mermaid×2, csv×1, text≈11 | 3 | ~541 total, ≈0.55/KB |
| 5 | ccc-quant-engine (cqe) | 1 — **confirmed** (hash `ecc8b600…`) | 5/5 + 5 extra | 7 | 9: mermaid×5, text×2, json×2 | 2 | 3 total, 0.023/KB |
| 6 | ccc-quant-wiki (cqw) | 5 — **confirmed** (hash `3d9a2a2a…`) | split: 3/5 files canonical-conformant, 2/5 (AI-tool exports) **zero frontmatter** | 25 (10 in one AI-export file) | 4: text, bash, mermaid×2 | 1 | 22 total, 0.14/KB |
| 7 | hermes-setup | 2 (anchor + 1 linked companion of 4 in dir) — **inferred** | 41 keys (anchor): 5/5 + 36 extra, heavy sha256/lineage chain | 22 | 1: mermaid | 0 | 20 total, 0.19/KB |
| 8 | plaid-read-mcp | 2 (anchor + 1 linked companion of 4 in dir) — **inferred** | 8 keys (anchor) / 6 (companion): 5/5 + small extras | 3 | 5: mermaid×1, bash×4 | 0 | 3 total, 0.077/KB |
| 9 | prd-expansion-engine | 1 — **inferred** (other links are out-of-scope brainstorming dirs / other versions) | 5/5 + 5 extra | 11 | 8: mermaid, python, sql, yaml, markdown×2, untagged×2 | 1 | 39 total (19 in-file `[[#anchor]]` self-links + 20 external), 0.56/KB |
| 10 | route-bench | 1 — **confirmed** (only file in dir) | 5/5 + 2 extra | 0 | 0 | 0 | 3 total, 0.57/KB |
| 11 | session-recall-unit (sru) | 1 — **confirmed** (only file in dir) | 5/5 + 7 extra | 21 (custom "Table:/Figure:/Listing:" captions) | 10: mermaid×2, text×2, json×5, bash×1 | 1 | 6 total, 0.065/KB |
| 12 | skill-hook-authoring | 1 — **confirmed** (only file in dir) | 5/5 + 8 extra (2 hold wikilink-syntax strings as values) | **0** — only packet with none | 14: text×7, yaml×6, md×1 | 0 | 7 total, 0.080/KB |

## 2. Matrix — linking, size, and the stress axes

| # | Packet | Unresolved refs (external) | Size (bytes / ~tokens, bytes÷4) | Repeated-identifier hazard | Unusual features |
|---|---|---|---|---|---|
| 1 | atm | 8 unique wikilink targets outside packet + 4 plain-string refs in manifests (prior evidence "5" ≈ the 5 core provenance refs) | 298,917 / 74,729 | Verbatim 5× compliance banner sentence; nested fixture notes (frontmatter+tables *inside* code fences) | Nested documents-in-code-fences; SHA-256-shaped placeholder constants |
| 2 | ccc-autocode-neo | 0 formal links; 4 plain backtick-path citations (non-hyperlinked) | 297,837 / 74,459 | **Highest raw count in corpus**: all 31 requirements restated verbatim 3× across 3 JSON catalogs (~93 duplicate instances) | 4 single-line multi-KB JSON blobs; no wikilink convention at all |
| 3 | ccc-fusion | 11 wikilinks, all external; authority is resolved implicitly (no single field names it) | 29,846 / 7,462 | Traceability codes repeat by design (HR-18 ×5); not a hazard | **Refuses before extraction** — `CCC_PRD_DECLARED_AUTHORITY_MISSING`, itself a distinct format axis |
| 4 | ccc-lab-super | Dozens (see §3.4); the anchor is effectively an index of ~29 internal links | ~1,007,647 / ~251,912 (27 files read; excludes the 1,063,894-byte `v723-combined.md`, never opened) | **Highest cross-file duplication in corpus**: near-identical opening paragraph + "Module Boundary" skeleton + DD-registry disclaimer shared verbatim-ish across 20+ files; several explicit cross-file duplicate test names; one file self-acknowledges a duplicate test under a different canonical name in an unread sibling | The corpus's only hand-padded/aligned table; a `WikilinkTranslationMap` file whose sole purpose is resolving this project's own link-translation problem |
| 5 | cqe | 3 wikilinks, all external, all audit-trail (doc self-declares standalone) | 135,219 / 33,805 | The **known** duplicated sentence (confirmed independently, byte-identical ×2) + dozens of `test_*` IDs recurring 2–3× | 5 mermaid diagrams; 2 inline JSON payloads |
| 6 | cqw | 6 (confirmed, matches prior evidence exactly) | 156,952 / 39,238 | Cross-file (not single-file): "BGE-M3 1024d" invariant 15+×; near-verbatim source-description rows repeated across the AI-export files and the file that recompiles them | 2 files carry literal un-rendered citation tokens (`citeturn23view0…`) — an AI-export artifact, not intentional markup |
| 7 | hermes-setup | 34 (19/20 wikilinks point outside the packet; 3 same-dir companions never linked at all) | 107,236 / 26,809 | sha256/path pairs duplicated by design across sibling docs (audit chain) | 41-key frontmatter is the densest lineage/provenance schema in the corpus |
| 8 | plaid-read-mcp | 10, all external URLs | 40,148 / 10,037 | Same proof paragraph ("225 tests at 95.40% branch coverage…") verbatim across both files — risks anchoring to the wrong source file | Mermaid block with embedded raw HTML `<br/>` |
| 9 | prd-expansion-engine | 8 distinct external targets (20 occurrences) | 70,786 / 17,697 | "Review Loop MVP" ~10×, model alias ~9×, `prdx resume` ~9-10× (domain terms, not accidental) | **Self-referential**: nests literal quoted PRD/frontmatter fragments as worked examples of its own output — a document containing document-shaped content inside code fences |
| 10 | route-bench | 2 unique targets, 3 occurrences | 5,362 / 1,341 | None found — too short to exhibit this hazard | Smallest packet in the corpus; the clean "floor" case |
| 11 | sru | 6 wikilinks + 1 frontmatter `supersedes` path | 94,356 / 23,589 | `_secrets/`/`_KELSEY/` protected-path pair ×6; near-duplicate safety clause ×5; error code ×5 | Custom "Table:/Figure:/Listing:" caption line convention, separate paragraph from its block |
| 12 | skill-hook-authoring | 20 (7 wikilinks + 13 external URLs, 6 of which are duplicated verbatim between two sections) | 89,451 / 22,363 | "Official runtime docs checked" block duplicated verbatim in two places; protected-path triple recurs 5+× | Frontmatter values that are themselves wikilink strings (`"[[sha-ufprd-v0.3]]"`) |

## 3. Notes an extractor will find hard

**3.1 atm** — Two entire fixture notes (their own YAML frontmatter + pipe tables) live *inside* fenced code blocks. A boundary-naive extractor can double-count them as top-level documents or miss them as inert code. The verbatim 5× compliance banner means quote-anchoring must disambiguate *which* occurrence a citation targets, not match-first.

**3.2 ccc-autocode-neo** — Four single-line, multi-KB JSON blobs will break any line-based or fixed-width chunker outright, and each restates the same 31 requirements verbatim across 3 blobs — a naive dedup pass could either collapse genuinely-separate catalogs or (worse) treat the 3rd copy as corroboration. This is also the only packet with zero wikilinks, so a resolver assuming vault-linking conventions will falsely conclude "no external references" when 4 plain-path citations exist.

**3.3 ccc-fusion** — The distinct hazard class here isn't a parsing trip-up, it's that the packet refuses *before* any byte-span extraction begins, because no single frontmatter field or sentence names one canonical "declared authority" note — a compiler must dereference several wikilinks (one of which lives under `_archive/`) just to determine whether it's even allowed to proceed.

**3.4 ccc-lab-super** — This packet is an order of magnitude larger and more cross-linked than every other packet in the corpus (~1MB across ~27 files vs. atm's 300KB across 3). Nearly every module file opens with a near-identical "This module is the v7.2.3 structural port of v6.5.0 X…" paragraph, the same `## Module Boundary` (Owns/Depends On/Read After/Non-Authoritative Restatements) skeleton, and a "Table: v6.5.0 source ranges…" caption — meaning a per-file byte-exact anchor is easy, but a *cross-file* dedup/coverage pass will see the same boilerplate shape dozens of times with only nouns and ID numbers varying, and at least 3 confirmed cases where two files state the *same* fact in materially different wording (one file literally says a test is "the same requirement" as a differently-named test in a sibling module it doesn't itself contain). **Coverage gap, stated rather than hidden:** the sub-agent's 5 batches covered 26 of the anchor's ~28 non-`v723-combined.md` linked companions; `REF-AI-CCC-Lab-Super-v7.2.3-Autonomous-DecisionLedger.md` (3,692 B) and `REF-AI-CCC-DuckLake-v7.2.3-OpenSource-Reinvention-Audit-2026-06-29.md` (52,499 B) were referenced by other files' wikilinks but never independently opened this session. `v723-combined.md` (1,063,894 B) was correctly never opened.

**3.5 cqe** — The one confirmed pre-existing failure (duplicated sentence, byte-identical ×2) reproduced independently in this session's re-read — a clean, already-understood regression anchor.

**3.6 cqw** — Two of five files have **zero frontmatter** and carry literal AI-chat export artifacts (`citeturn23view0turn53view3`) mid-sentence, which will fracture any sentence-boundary-based quote span if not filtered before extraction. The packet mixes two structurally different "voices" (vault-native prose vs. AI-export numbered lists) inside one packet.

**3.7 hermes-setup** — 34 of 41 total frontmatter+body references point outside the 2-file packet (other PRD versions, other-project SSOTs, a PHI-boundary hub); only 1 of 4 same-directory companions is actually linked, so directory-listing alone would badly overcount this packet's true membership.

**3.8 plaid-read-mcp** — Smallest genuine multi-file case in the recommended-candidate pool: exactly one real cross-file link, and that one link duplicates an entire proof paragraph verbatim across both files — a compact, cheap-to-reason-about cross-file dedup test.

**3.9 prd-expansion-engine** — 19 of its 39 wikilinks are **in-file** `[[#Heading]]` self-anchors, a distinct wikilink *style* not seen at this density elsewhere in the corpus, and the document nests literal quoted-PRD-fragment code blocks as worked examples of its own subject matter — a heading/frontmatter extractor could mistake the nested example content for real document structure.

**3.10 route-bench** — Genuinely low-hazard; useful only as the corpus's simplicity floor.

**3.11 sru** — The "Table:/Figure:/Listing:" caption convention sits as a separate paragraph immediately after its block; a naive extractor may split the caption from its content or attribute it to the next section instead.

**3.12 skill-hook-authoring** — The only packet with literally zero markdown tables (the doc explicitly restricts tables to short scalars), but two frontmatter fields hold wikilink-syntax strings as values rather than plain scalars — a YAML parser expecting plain strings will not choke, but a link-resolver that only scans document *bodies* for `[[...]]` will silently miss these two.

## 4. Discrepancy flagged, not papered over

The mission brief's stated atm stress case was the identifier **`t-phase-1`** recurring verbatim in `PRODPRD-atm-v0.8.4.md`. An independent full read of that file (this session, same byte-identical file per the unchanged freeze hash) found **no literal occurrence of `t-phase-1`** anywhere in the packet. The re-read did find a different, clearly-real repeated-identifier hazard in the same file (the verbatim 5× compliance banner, §3.1). Two explanations are possible: the original evidence used a different literal form of the identifier (case, punctuation, or embedding inside a longer token) that a straight string search would miss, or the citation was imprecise. Not resolved here — flagged for whoever owns task #9's chunked-extraction design to verify directly against the file rather than trust either claim blindly.

## 5. Recommended gate set

Five packets, chosen to maximize axis coverage from a genuinely diverse 12-packet corpus (mission asked for 3–5; going to 5 buys meaningfully more coverage without redundancy):

1. **ccc-lab-super (DuckLake)** — multi-file ✓ (by far the largest and most cross-linked packet in the corpus, ~27 files / ~1MB), highest cross-file repeated-identifier hazard ✓, and the corpus's only hand-padded/alignment-sensitive table. No other packet stresses "coverage across many files that share disguised boilerplate" at this scale.
2. **ccc-quant-engine (cqe)** — table/code-heavy ✓ (7 clean tables, 9 language-tagged code blocks incl. 5 mermaid), single-file, and already carries a *confirmed, independently-reproduced* known failure (duplicated sentence) — the cheapest, best-understood regression anchor to pin a gate check on.
3. **ccc-quant-wiki (cqw)** — multi-file ✓ (5 files) with genuinely mixed provenance: 3 vault-native + 2 zero-frontmatter AI-tool exports carrying literal citation-token garbage. Distinct from ccc-lab-super's "many uniform files" shape — this is "few files, wildly inconsistent schema."
4. **agentic-trade-management (atm)** — table/code-heavy ✓ (48 tables, 20 code blocks) and single-file at the largest scale (295KB), with a hazard no other packet has: fully-formed documents (frontmatter + tables) nested inside fenced code blocks.
5. **ccc-autocode-neo** — high repeated-identifier hazard ✓ at the highest raw count in the entire corpus (~93 duplicate requirement-statement instances across 3 JSON blobs), and the only packet with zero wikilinks at all — a real convention outlier discovery would otherwise miss entirely.

Honorable mentions not selected (redundant with the above, not wrong): **route-bench** (simplicity floor, already implicitly covered by contrast with the other five), **skill-hook-authoring** (zero-tables outlier, but its wikilink-as-frontmatter-value quirk is a narrower signal than cqw's mixed-provenance case), **ccc-fusion** (the negative-control refusal case — worth keeping as a *separate*, non-gate fixture specifically for the authority-refusal path, not for format-diversity coverage).
