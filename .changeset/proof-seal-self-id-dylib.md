---
"@fusion/engine": patch
---

summary: Semantic-proof sealing no longer mistakes a Mach-O dylib's own install name for a dependency.
category: fix
dev: `otool -L` prints an MH_DYLIB's LC_ID_DYLIB as the first entry of each architecture section. The sealer dropped only the header line, so maturin/Rust-built CPython extension modules (polars, pydantic_core, hypothesis) — MH_DYLIB with an `@rpath/<package>.<module>.so` id and no LC_RPATH — had their own id read as an unresolvable load command, and the seal refused with `CCC semantic-proof sealed runtime graph escaped toolchain root: @rpath/...`. `assertSealedDarwinLinkedRuntimeGraph` and `patchDarwinInstallNames` now share `parseDarwinLinkedDependencies`, which identifies the install name by value from `otool -D` (same bounded `execFile` timeout/maxBuffer discipline as the existing `otool -L` call) and drops it only when the first dependency of a section equals that id. Architecture headers in fat-binary output are no longer parsed as dependencies either. A genuine unresolvable `@rpath` load dependency is still refused; no custody, digest, or containment check is relaxed.
