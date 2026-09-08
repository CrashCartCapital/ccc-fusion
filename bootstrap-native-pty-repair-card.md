# Bootstrap native PTY repair card

Status: READY FOR ONE BOUNDED OFFLINE BUILD, READ-ONLY PREP COMPLETE. This card authorizes no build, install, native execution, provider call, PostgreSQL run, test run, or source change. The parent must separately release the build step after reviewing this card.

## Frozen target and proof boundary

- Worktree: `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/ccc-bootstrap-locus-20260907`.
- Frozen `HEAD`: `cf1bf19075994f0e17302b4f6cfa802caaa9032e`; frozen tree: `22ce8540a3b1fb175a1bc330ef9d0e3c66eba3dc`.
- The tracked tree was clean when inspected. Existing untracked `.analysis-artifacts/` content belongs to other evidence and remains untouched. This card is the only new file owned here.
- Runtime: Node `v24.16.0`, modules ABI `137`, N-API `10`, `darwin`, `arm64`; `/opt/homebrew/Cellar/node@24/24.16.0/bin/node`; `uname -m` and `arch` both `arm64`.
- Existing product-route evidence is source-frozen at `.analysis-artifacts/cancel-product-route/final-product-route-evidence.md` and `harness-run-receipt.json`: 7 passed / 1 failed because the Darwin PTY binary was missing. That is an environment blocker; it is not cancellation or provider causality proof. The recorded wrapper hash is `457ca6916bce6e694034aaa9070daa045f54141dc7e95aa53703a258118e89ea`.
- Scope is local fixture hydration only. Do not touch the primary checkout, other worktrees, package manifests, lockfiles, source, shared pnpm store, provider route, or the public PostgreSQL test.

## Exact dependency seam

Installed package root:

`/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/ccc-bootstrap-locus-20260907/node_modules/.pnpm/@homebridge+node-pty-prebuilt-multiarch@0.13.1/node_modules/@homebridge/node-pty-prebuilt-multiarch`

The workspace `node-pty` link resolves to this package. It is `@homebridge/node-pty-prebuilt-multiarch@0.13.1`, with lockfile integrity `sha512-ccQ60nMcbEGrQh0U9E6x0ajW9qJNeazpcM/9CH6J8leyNtJgb+gu24WTBAfBUVeO486ZhscnaxLEITI2HXwhow==`; retain the lockfile value as the authority. There is no `build/Release/pty.node`, `build/Debug/pty.node`, or Darwin prebuild in this package. Linux prebuilds, including ABI 137, cannot be used on this host.

The package scripts were inspected but not run: `install` checks a prebuild, then calls `prebuild-install --verbose`, then `node scripts/install.js`; `scripts/install.js` spawns an unqualified `node-gyp rebuild`; `postinstall` cleans the release directory; `validate` only checks a prebuild. The direct command below deliberately avoids those lifecycle and download paths. `binding.gyp` builds `src/unix/pty.cc` as `pty` and `src/unix/spawn-helper.cc` as `spawn-helper`, uses `node-addon-api`, C++17, and expects `build/Release/pty.node` plus `build/Release/spawn-helper` on macOS.

## Frozen input inventory and hashes

These are the pre-build values. The post-build column is intentionally `UNKNOWN` because no build has run.

| Input/output | Before | After | Required disposition |
|---|---|---|---|
| package source manifest (`package.json`, `binding.gyp`, `src/`, `deps/`, `third_party/`, 215 files) | SHA-256 `af35148a25168ee6f4231eb883188ef78d0497252175e82372266b1b216c622b` | UNKNOWN | Recompute; exact match required |
| `package.json` | `55637f69bc8c50162ef4c3577ef407911e2271f9b606af50d94a865883527062` | UNKNOWN | Recompute; exact match required |
| `binding.gyp` | `0fd154d66252808b8d4defbeb31eaab89e50469a45c2ce910eae020c6d1122a0` | UNKNOWN | Recompute; exact match required |
| Node 24.16.0 header `include/node/node.h` | `b92ad0dbbb1627269b6ba81f45bfc862a45c2232eb7017b4854e9d40b1432ff5` | UNKNOWN | Header cache must not be rewritten |
| header `common.gypi` | `4cf66956f8f5e53fe8afb29f468fad859a24647eb23dd55a8d9bbdbc7bd8f730` | UNKNOWN | Header cache must not be rewritten |
| header `config.gypi` | `e9293c23647c51843442a43cbb1b7ea8def4884f5ae7a468c1563c01ab63ac91` | UNKNOWN | Header cache must not be rewritten |
| `build/Release/pty.node`, `build/Release/spawn-helper` | ABSENT | UNKNOWN | Only package-local generated outputs are allowed |

Header cache root is `/Users/ryanpappal/Library/Caches/node-gyp/24.16.0` and is present. Its `config.gypi` reports `host_arch: x64`, `target_arch: x64`, and `node_module_version: 137`, while the live Node process is arm64. The approved repair recipe therefore requires `--arch=arm64 --force-process-config`; do not silently omit either flag and do not edit the cache.

The exact available compiler/toolchain is `/usr/bin/clang`, `/usr/bin/clang++` (Apple clang `21.0.0`, `clang-2100.1.1.101`, target `arm64-apple-darwin25.5.0`), `/usr/bin/make` (GNU Make `3.81`), and `/Users/ryanpappal/.pyenv/shims/python3` / `python` (Python `3.12.10`). Global `node-gyp` is absent. The only workspace copy is `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/ccc-bootstrap-locus-20260907/node_modules/.pnpm/node-gyp@11.5.0/node_modules/node-gyp/bin/node-gyp.js`; direct `help` completed successfully and reported `node-gyp@11.5.0` with `node@24.16.0`. The package declares dev `node-gyp = 10.1.0`, but no 10.1.0 copy is installed; use the exact available workspace binary only after the parent releases the step, and record this version difference in the receipt.

## One atomic offline build (future command; do not run from this card)

Preview immediately before the build:

1. Verify the frozen worktree `HEAD` and tree, package root, Node `v24.16.0`, `modules=137`, `arch=arm64`, header-cache path, tool path/hash, compiler paths, and all before hashes above.
2. Verify package `build/` is absent. If it exists, do not clean it: archive the exact project-local directory to a new `.analysis-artifacts/native-pty-repair/build-<timestamp>/` path after recording its file hashes and obtain parent review before proceeding.
3. Verify no lifecycle process, package install, download, shared-store write, lockfile change, source edit, or primary-checkout write is part of the operation.

Exact command, once released by the parent:

```sh
cd /Users/ryanpappal/03_CODE/ccc-fusion-worktrees/ccc-bootstrap-locus-20260907/node_modules/.pnpm/@homebridge+node-pty-prebuilt-multiarch@0.13.1/node_modules/@homebridge/node-pty-prebuilt-multiarch
node /Users/ryanpappal/03_CODE/ccc-fusion-worktrees/ccc-bootstrap-locus-20260907/node_modules/.pnpm/node-gyp@11.5.0/node_modules/node-gyp/bin/node-gyp.js rebuild \
  --nodedir=/Users/ryanpappal/Library/Caches/node-gyp/24.16.0 \
  --arch=arm64 \
  --force-process-config
```

This is one local `node-gyp` rebuild against the already-present cache. It must not become `pnpm install`, `npm install`, a package lifecycle, a prebuild download, a global `node-gyp` invocation, a copied binary, a shared `node_modules` repair, or a source/lockfile edit. Capture stdout/stderr and exit status without redacting the diagnostic reason; redact only secrets if any unexpectedly appear.

Expected owned generated targets are only the package-local `build/` tree, chiefly `build/Release/pty.node` and `build/Release/spawn-helper`. If the command fails, stop after this single attempt. For rollback, preserve the failing receipt, move the exact generated package-local `build/` to a timestamped archive under `.analysis-artifacts/native-pty-repair/`, and restore the recorded prior absence or prior hash. Never use `rm -rf`, `node-gyp clean`, or cleanup against the shared store or header cache.

## Later acceptance proof (not run here)

After the parent reviews the build receipt, the future worker must capture these checks in the same worktree:

1. `file` and `lipo -info` on both generated targets must identify Mach-O arm64; `otool -L` must show only expected local/system dependencies. `node -p 'process.versions.modules'` must remain `137`.
2. A one-off, non-committed smoke command must load the package through its normal `lib` loader, assert `typeof spawn === "function"`, spawn the current Node with a tiny `PTY_OK` command, observe the sentinel, and require `(exitCode === 0)` with no signal. This is a bounded verification command, not a new harness or framework.
3. Run the existing native supervisor test, unchanged, from the engine package: `pnpm --filter @fusion/engine exec vitest run src/__tests__/ccc-native-cli-supervisor.real-process.test.ts --project=engine-default --silent=passed-only --reporter=dot`. The receipt must show the manager's process-group closure, sibling process untouched, durable closure receipt, and no live session after disposal. Do not reinterpret its injected loader as proof of the native binary; the one-off smoke and the later real product route together provide that link.
4. The existing `SessionManager.preflightPtyRuntime()` seam must load the real package and expose `spawn`; the later original public cancellation/restart PostgreSQL test remains unchanged and is owned by its phase observer. It must be run separately, at its existing timeout, only after this local proof and parent review. No new provider or PG invocation belongs in this card.
5. Recompute the source, cache, and header hashes. Source and header values must exactly match the before table; generated output hashes, architecture, ABI, import, PTY exit-0, process-group drain, and cleanup receipts must be recorded. Any changed source/cache/header hash is a hard stop.

## Stop rules and handoff

Stop without retry if the frozen `HEAD`/tree, package path, source manifest, lock integrity, Node version/arch, header hashes, compiler/tool paths, or node-gyp path/version differs; if any lifecycle/download/shared-store/source/lock/primary write occurs; if output is not arm64/ABI 137; if import or PTY exit-0 fails; if a descendant or PTY slot remains live; or if rollback cannot preserve the exact prior state. Do not increase product timeouts, bypass locks, substitute a Linux prebuild, or claim provider/cancellation correctness from this local artifact.

Handoff verdict: **READY** for one parent-released, offline, package-local `node-gyp rebuild`; the required local compiler, make, Python, Node, and cached headers are available. Current generated native targets are **MISSING**, and all post-build/import/managed-PTY/process-group evidence is **UNKNOWN** until that separately authorized attempt is made. This card contains no production-tested, installed, or live-working claim.
