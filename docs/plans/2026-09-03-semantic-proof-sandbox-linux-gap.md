# Semantic-proof sandbox has no Linux backend — CCC PRD Product Acceptance stall at check #21

Read-only investigation, 2026-09-03. Nothing in this document has been implemented. No branches, commits, or workflow dispatches were made.

## Bottom line

`assertCccSemanticProofSandboxReady` at `packages/engine/src/ccc-campaign-proof-sandbox.ts:460` throws on every non-Darwin platform. The CCC semantic-v2 proof verifier has exactly one sandbox backend — macOS `sandbox-exec` — and no Linux implementation has ever existed. On the `ccc-fusion-bwrap` runner the verifier subprocess is never spawned, so the `ccc-semantic-proof-execution-*` marker the acceptance poll waits for is never written, and check #21 polls to exhaustion.

The readiness probe passes because it exercises a *different* sandbox in a *different* module. That is a second, independent defect (§4).

---

## §1 Proven vs inferred

### Proven by reading source and built artifacts

**The platform gate exists and is unconditional.**

```ts
// packages/engine/src/ccc-campaign-proof-sandbox.ts:457-462
export async function assertCccSemanticProofSandboxReady(
  input: CccSemanticProofSandboxPolicyInput,
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error(`semantic-proof sandbox backend is unavailable on ${process.platform}`);
  }
```

**There is no bubblewrap code path in that module.** `grep -c 'bwrap\|bubblewrap'` over all 626 lines of `ccc-campaign-proof-sandbox.ts` returns **0**.

**The gate is present in every artifact the acceptance script actually executes.** Finishing the sentence that truncated: the same throw appears in the built engine at `packages/engine/dist/ccc-campaign-proof-sandbox.js:322`, and — this is the part that matters — in all three shipped CLI bundles that the acceptance script drives as the installed runtime:

| artifact | line |
|---|---|
| `packages/engine/dist/ccc-campaign-proof-sandbox.js` | 322 |
| `packages/cli/dist/bin.js` | 269661 |
| `packages/cli/dist/child-process-worker.js` | 269148 |
| `packages/cli/dist/extension.js` | 268986 |

The acceptance script builds and then drives the CLI (`buildCurrentCli`, check #1 `built-cli-current-run`), so the code under test is the bundle, not the source tree. The bundle carries the gate. This rules out "the source has it but the built path differs."

**The default wiring routes through it, twice.** `packages/engine/src/ccc-campaign-proof-execution.ts:1727-1731`:

```ts
preflightSandbox: input.preflightSemanticProofSandbox ?? assertCccSemanticProofSandboxReady,
runSandbox: input.runSemanticProofSandbox ?? runCccSemanticProofSandboxedProcess,
```

and `runCccSemanticProofSandboxedProcess` itself calls `assertCccSemanticProofSandboxReady` again at `ccc-campaign-proof-sandbox.ts:486`. Removing only the preflight call would not open the path.

**The failure sequence, from source:**

1. `ccc-campaign-proof-execution.ts:1530` — `mkdtemp(join(tmpdir(), "ccc-semantic-proof-execution-"))`. This *does* run on Linux.
2. `:1584-1590` — materialize, digest comparison, `verifyToolchain`. All platform-agnostic (see §2).
3. `:1591` — `await dependencies.preflightSandbox(...)` throws.
4. `:1594-1601` — caught, converted by `proofRefusal` to a `PermanentError` with code `CCC_CAMPAIGN_PROOF_CUSTODY_REFUSED` and message `CCC campaign semantic proof <id> pre-dispatch custody refused: semantic-proof sandbox backend is unavailable on linux`.
5. `:1701-1703` — the `finally` runs `makeTempTreeWriteable` then `rm(tempRoot, { recursive: true, force: true })`.

The temp directory therefore exists for the few seconds of materialization and is then deleted. `readOwnedProofCutpointMarkers` (`scripts/ccc-prd-product-acceptance.mjs:3309`) returns `[]` on every attempt with no error, because the readdir always succeeds — it just finds nothing that survives, and no marker file ever, because no verifier process ever runs to write one.

**Two pieces of the original evidence read differently than assumed.**

`tail(value, lines = 120)` at `scripts/ccc-prd-product-acceptance.mjs:293` keeps the **last** 120 lines. The refusal happens within seconds of the approval; the diagnostic is captured 600 s later after ~30 stuck-detector cycles have scrolled past. The serve log showing only idle housekeeping is truncation, not absence of dispatch.

Walking `ledger.pass(` call sites in file order, `proof-dispatch-restart-manual-required` (line 5500) is check #21 and is the **first check in the entire suite that executes a semantic-v2 proof**. Checks #1-#20 are authoring, corpus freeze, validation, refusal cases, lifecycle controls, and the provider cutpoint — none touch the proof sandbox. The next proof-executing check is `task-phase-proofs-committed` (#29, line 6106). CI has therefore never once executed a semantic-v2 proof. The 72-second pass of #1-#20 is exactly what a run that has not yet reached the sandbox looks like, and the 5× budget raise changed nothing because there was nothing to wait for.

### Inferred, not executed

**That `preflightSandbox` is the *first* thing to throw on Linux ARM64.** Materialization and `verifyCccSemanticProofToolchainBeforeSpawn` are platform-agnostic in source (§2), so they should reach step 3 — but I did not run them on Linux. If one of them throws earlier, the observable outcome is byte-identical: same `catch` at `:1594`, same `CCC_CAMPAIGN_PROOF_CUSTODY_REFUSED`, same absent markers, same stall. Only the message embedded in the refusal string differs. The diagnosis of "no Linux sandbox backend" holds either way, because even a clean materialization terminates at `:1591`.

**That the campaign's PostgreSQL custody and work-item fence are satisfied in CI.** `runSemanticProofV2` refuses at `:1489` without an async layer and at `:1495` without an origin task id. Both are inferred-satisfied from the fact that checks #1-#20 exercised the same store and the provider-cutpoint approval flow completed. Not directly observed.

**Cheapest discriminator, and it is already being collected.** The poll's failure diagnostic at `scripts/ccc-prd-product-acceptance.mjs:5239-5246` returns `{ serve, status, markers }`. The `status` field should already carry the refusal — pull the full failure JSON from the CI run and read `status`, not just `serve` and `markers`. It will name which step threw, verbatim. No new instrumentation is needed; the existing report was read selectively.

---

## §2 Scope of the gap — one missing backend, plus three silently disabled custody assertions

Short answer: **one module is genuinely macOS-shaped and must be written from scratch. Everything else in the v2 path is portable in shape but weaker on Linux in ways that pass silently.** This is day-scale for the Node+Task proof shape and week-scale for full parity — not a month, and not a rewrite.

### 2.1 `ccc-campaign-proof-sandbox.ts` — entirely macOS-shaped (626 lines)

This is the whole gap. Every layer is Darwin-specific:

| concern | line(s) | Darwin mechanism |
|---|---|---|
| policy language | 82-99 | SBPL string/literal/subpath emitters |
| linked-runtime discovery | 175-190 | `/usr/bin/otool -L` |
| dyld support | 412 | `(import "/System/Library/Sandbox/Profiles/dyld-support.sb")` |
| system read roots | 373 | `/System/Library`, `/private/var/db/dyld` |
| exec allowlist | 414-426 | `(allow process-exec <exact literal list>)` |
| network | 430-438 | `(deny network*)` plus exact-loopback `(allow network-bind …)` |
| write grants | 452-453 | `(allow file-write* <scratch>)`, `(allow file-write* "/dev/null")` |
| spawn | 566 | `superviseSpawn(DARWIN_SANDBOX_EXECUTABLE, ["-p", profile, …])` |

A Linux sibling has to be written. Only the spawn supervision (`superviseSpawn`, output hashing, timeout/force-kill ladder at `:557-626`) is platform-agnostic and reusable as-is — swap the command from `sandbox-exec` to `bwrap` and the surrounding ~80 lines are unchanged.

### 2.2 `ccc-campaign-proof-materialization.ts` — portable in shape, weaker in guarantee

Every Darwin-specific function here **early-returns cleanly on non-Darwin rather than throwing**. That means materialization will succeed on Linux — but three custody assertions quietly stop asserting:

| function | line | Linux behavior | consequence |
|---|---|---|---|
| `darwinHomebrewLinkedRuntimeManifest` | 1003-1006 | returns `[]` | sealed toolchain records an empty shared-library closure |
| `patchDarwinInstallNames` | 1136-1141 | returns immediately | no rpath rewriting (Linux needs `patchelf --set-rpath`) |
| `assertSealedDarwinLinkedRuntimeGraph` | 1223-1227 | returns immediately | the check that a sealed binary has no dependency outside the toolchain root **does not run at all** |

For the acceptance fixture this is harmless: its proofs declare only Node and Go Task, no Python, so there is no dylib closure to seal. But a Python-bearing proof on Linux would produce a materially weaker seal that reports success. That is a latent correctness gap, not merely a missing feature, and it should be fixed before any Linux lane claims proof-strength parity.

`resolveCccSemanticProofGitBinary` (`:172-175`) already handles non-Darwin correctly via `wellKnownGitBinaryPaths()`. `verifyCccSemanticProofToolchainBeforeSpawn` (`:464`) is fully platform-agnostic — SHA-256 byte comparison and version probes only.

### 2.3 One inherent cross-platform binding, not a bug

The admitted `executionToolchain` records `executableSha256` for the Node and Task binaries, and `verifyCccSemanticProofToolchainBeforeSpawn` re-verifies those bytes before spawn. A PRD authored on macOS cannot have its proofs executed on Linux — the toolchain identity will not match, by design. This does not affect the acceptance script, which authors and freezes its packet inside the same CI run on the same host. Worth recording so nobody later mistakes it for a regression.

### 2.4 Verdict

One backend to write, three assertions to port. The macOS-shaped surface is confined to a single 626-line module; it has not leaked into the execution, materialization, or attempt-ledger layers.

---

## §3 Options, with honest cost

### (a) Implement a Linux bubblewrap backend for the semantic-proof sandbox

**A working, production-quality bwrap launcher already exists in this repo** — `buildStrictLinuxVerifierLaunch` at `packages/engine/src/run-verification-tool.ts:462-560`. It is the crux of this option, and it is genuinely reusable.

Reusable as-is:

- `policyToBwrapArgs` (`packages/engine/src/sandbox/bubblewrap-policy.ts:53`) — `--die-with-parent`, `--unshare-pid/uts/ipc`, `--new-session`, `--proc`, `--dev`, `--clearenv`, `--tmpfs`, bind/ro-bind emission, `--setenv`, `--chdir`.
- `detectTrustedVerifierBwrap` (`run-verification-tool.ts:441-460`) — resolves only `/usr/bin/bwrap` or `/bin/bwrap`, canonicalizes, never consults ambient `PATH`. Exactly the trust posture the proof sandbox needs.
- The writable-rebind ordering fix (`:526-529`) — `policyToBwrapArgs` emits writable mounts before read-only ones, so a writable child under a read-only ancestor gets clobbered; the existing code rebinds after. This is a non-obvious bug that has already been found and fixed once; reusing it avoids rediscovering it.
- Protected-path masking overlays (`:531-538`) — `.env`, `.git`, `.fusion` masked with empty dirs / `/dev/null` ro-binds.
- Isolated `HOME`/`TMPDIR`/pnpm-store scratch construction (`:481-499`) and the `cleanup` closure.

Must be written new:

1. **`buildCccSemanticProofBwrapArgs`** — the SBPL-to-bwrap policy translation. Most of it gets *simpler*, not harder: bwrap is default-deny by construction, so `deniedReadRoots` (which currently deny-list `snapshot.targetRoot` and `engineRoot` in SBPL) becomes "do not bind them," which is strictly stronger than a deny rule. `/System/Library`, `/private/var/db/dyld` and the dyld-support import all vanish; ro-binding `/usr`, `/lib`, `/lib64` replaces them.

2. **An answer for the exec allowlist.** SBPL's `(allow process-exec <exact literal list>)` at `:414-426` has **no bwrap equivalent**. bwrap cannot whitelist which executables a process may exec. The closest approximation is to bind only the sealed toolchain binaries plus `/bin/sh`, so nothing else is reachable to exec — close in effect, weaker in kind. This is a genuine proof-strength difference and should be stated in whatever admits the Linux backend, not papered over.

3. **A loopback decision.** `buildStrictLinuxVerifierLaunch` *refuses outright* when a loopback port is requested (`run-verification-tool.ts:466-472`: "Linux verifier confinement cannot admit one exact loopback port without broad network sharing"). The semantic-proof path does pass `loopbackPort` — `ccc-campaign-proof-execution.ts:1651-1656`, gated on `proofRequiresNodeLoopback(proof)` (`:69-72`, true when the proof declares the node-loopback verifier profile). Worth re-examining rather than inheriting: bwrap's `--unshare-net` creates a fresh network namespace whose loopback device bwrap brings up, which is *more* naturally loopback-only than the SBPL approach that has to name an exact port against a shared stack. That existing refusal may be over-cautious, and re-deriving it could turn a blocker into a win. Either way, proofs needing loopback stay macOS-only until this is settled.

4. **Linux linked-runtime discovery** — `ldd`/`readelf -d` in place of `otool -L`, feeding the §2.2 assertions. Only needed for Python-bearing proofs.

**Honest cost.** For the Node + Go Task proof shape — which is what the acceptance fixture and check #21 exercise — this is **1-2 days** including a test lane, because the hard parts (bwrap detection, arg emission, mount ordering, masking, cleanup) are already written and proven on this exact runner. Full parity including Python sealing, the §2.2 assertions ported to ELF, and a settled loopback story is **1-3 weeks**, and the exec-allowlist gap may never close exactly.

### (b) Run the acceptance gate on a macOS runner

**No self-hosted macOS runner exists in this fleet.** Every self-hosted label in `.github/workflows/` is `[self-hosted, linux, ARM64, ccc-fusion]` or `…, ccc-fusion-bwrap]`. macOS appears only as GitHub-hosted `macos-latest`, in `mobile.yml`, `release.yml`, and `test-release.yml`.

What makes this *more* viable than expected: the workflow comment at `ccc-prd-product-gate.yml:54-60` establishes that this job needs **no postgres service container** — the script strips `DATABASE_URL` from the child env and drives the CLI's own bundled embedded PostgreSQL. Service containers are the usual thing that makes GitHub-hosted macOS impossible, and they are not needed here. Go Task installs via npm on macOS identically to the current Linux step. `sandbox-exec` is present on `macos-latest`, and Xcode CLT (for `codesign` / `install_name_tool` during sealing) is preinstalled.

What is actually wrong with it: it proves the product only on the platform where it already worked. The gate's stated purpose is whole-product acceptance; running it exclusively on macOS means the Linux path this project ships to CI is never exercised end-to-end, and the §2.2 silent-weakening on Linux would stay invisible indefinitely. It also costs GitHub-hosted macOS minutes at the 10× multiplier for a ~5-minute local run that will be slower on a hosted VM.

Reasonable as a **stopgap** to get the gate green and keep it honest while (a) is built. Not reasonable as the destination.

### (c) Declare the gate macOS-only and say so in the workflow

Cheapest and, right now, the most truthful. The workflow header (`ccc-prd-product-gate.yml:9-24`) already documents three failing runs and calls the cause "pending verifier-dispatch diagnosis." That diagnosis is this document. The change is to replace that text with the actual finding, and stop the job from *appearing* to test something it structurally cannot.

Concretely: keep it `workflow_dispatch`-only, add a guard step that fails immediately with the real reason on a non-Darwin runner rather than after 12 minutes of polling, and record the semantic-proof Linux backend as tracked work. Cost: under an hour.

**Recommendation.** Do (c) immediately — a gate that stalls for 12 minutes and reports a poll timeout is actively misleading, and the fix is an hour. Then do (a) for the Node+Task shape, which is 1-2 days and reuses a proven bwrap implementation. Skip (b) unless the gate needs to be green before (a) can land.

Independently of all three, do §4 — it is small, and it is the reason nobody caught this in the first place.

---

## §4 The skipped guard — a separate defect, recorded separately

This is a guard-design defect that exists whether or not a Linux backend is ever written. It must not be fixed by accident.

### What the code does

`createCccCampaignProofSuiteHandler` returns one handler serving two proof contracts. Its first statement is an early return:

```ts
// packages/engine/src/ccc-campaign-proof-execution.ts:1737-1739
if (node.config?.cccProofGate === true || node.config?.cccProofPhase !== undefined) {
  return runSemanticProofV2(input, semanticProofDependencies, node, context);
}
```

The confinement gate sits 77 lines further down, on the path that early return skips:

```ts
// packages/engine/src/ccc-campaign-proof-execution.ts:1816-1822
const confinementReadiness = await inspectConfinementReadiness();
if (!isVerifierConfinementReady(confinementReadiness)) {
  proofRefusal(
    `CCC campaign verifier confinement is unavailable (${confinementReadiness.code}): ${confinementReadiness.message}`,
    "CCC_CAMPAIGN_VERIFIER_CONFINEMENT_UNAVAILABLE",
  );
}
```

So the **v1 proof-suite path is gated on backend availability; the v2 semantic path is not gated at all.** The v2 path — the one with the platform-specific backend, the one that can be unavailable — is precisely the one that never asks.

### Should v2 consult a confinement gate?

Yes — but not this one, and this is the important part. `inspectVerifierConfinementReadiness` (`packages/engine/src/run-verification-tool.ts:1172`) probes `runVerificationCommand` → `buildVerificationSandboxLaunch`, which is the **agent verification-tool** sandbox. The v2 semantic path never calls it. Wiring the existing probe into `runSemanticProofV2` would produce a gate that passes on Linux and then dispatches into a backend that does not exist — the same defect, relocated.

What is needed is a readiness inspector for the semantic-proof backend specifically:

- Add `inspectSemanticProofSandboxReadiness()` in `ccc-campaign-proof-sandbox.ts`, returning the same `VerifierConfinementReadiness` envelope shape, backed by `assertCccSemanticProofSandboxReady`.
- Call it at the top of `runSemanticProofV2`, **before** the `mkdtemp` at `:1530`, refusing with a distinct code such as `CCC_CAMPAIGN_SEMANTIC_PROOF_SANDBOX_UNAVAILABLE`.
- Extend `scripts/check-verifier-confinement.mjs` to report **both** backends. The workflow's "Verifier confinement readiness" step would then fail at roughly second 30 with a named cause, instead of the campaign stalling at minute 12 with a poll timeout.

### The trap to avoid

If someone implements the Linux backend (§3a) and stops there, this defect vanishes from view without being fixed. The v2 path would still have no confinement gate, and the *next* backend-availability regression — bwrap uninstalled, unprivileged user namespaces disabled by a kernel setting, the runner image changing — would again surface as a silent 10-minute stall rather than a named refusal. Fix the guard even if the backend lands first.

### Related: a bare catch that discards the error

```ts
// packages/engine/src/ccc-campaign-proof-execution.ts:1674-1682
} catch {
  terminalEnvelope = executionRefusedEnvelope(
    proof, execution.phase, execution.snapshot,
    sandboxRefusedResult(), Math.max(0, Date.now() - startedAt), "sandbox_refused",
  );
}
```

Any failure from `runSandbox` is swallowed with no binding, no logging, no diagnostic. If the preflight at `:1591` were removed without adding a backend, the second `assertCccSemanticProofSandboxReady` inside `runCccSemanticProofSandboxedProcess` (`ccc-campaign-proof-sandbox.ts:486`) would throw here and be converted to an anonymous `sandbox_refused` envelope — a different silent failure with the same root cause. Worth attaching the error message to the envelope regardless of the rest.

---

## §5 How long has this been true — original limitation, never a regression

```
$ git log --diff-filter=A --format='%h %ad %s' --date=short -- packages/engine/src/ccc-campaign-proof-sandbox.ts
d12614d53 2026-08-13 feat(campaign): harden sealed semantic-v2 execution (#41)
```

The file has three commits in its entire history:

| commit | date | subject |
|---|---|---|
| `d12614d53` | 2026-08-13 | feat(campaign): harden sealed semantic-v2 execution (#41) |
| `1d2784829` | — | feat(ccc): seal Python proof and OmniRoute receipts |
| `446bb8302` | 2026-09-02 | feat(ccc): Gate 2 whole-product campaign passes from an installed runtime (#56) |

Inspecting the file as introduced:

```
$ git show d12614d53:packages/engine/src/ccc-campaign-proof-sandbox.ts | grep -n 'darwin\|platform'
150: async function darwinLinkedRuntimeFiles(…)
279:   const linkedRuntimeFiles = await darwinLinkedRuntimeFiles([
351:   if (process.platform !== "darwin") {
352:     throw new Error(`semantic-proof sandbox backend is unavailable on ${process.platform}`);
```

**The Darwin-only gate was present in the very first commit that created the file.** No Linux path was ever removed, weakened, or regressed. This is an original limitation of the semantic-v2 sandbox, written on a macOS workstation, that went unsurfaced for three weeks because no CI run ever reached a semantic-v2 proof (§1) — and because the one guard that could have named it checks a different backend (§4).

No test asserts the non-Darwin throw, and no test exercises the semantic-proof sandbox on Linux. The gap was invisible to the test suite by construction.

---

## Constraints observed

Read-only throughout. `packages/engine/src/executor.ts` was not read or modified; the trail never entered it. The acceptance script was not run (the tree has untracked files). No branches, commits, or workflow dispatches.
