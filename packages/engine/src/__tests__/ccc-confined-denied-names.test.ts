/*
FNXC:CccConfinedShell 2026-10-14-15:05:
Errata E2-81 and E4-8 (card X1c, item 10). The confined shell's default denied
names must cover K1's `CCC_PLANNING_DENIED_NAMES`, so a name the planner refuses
to hand a writer is also unreadable and unwritable inside the writer's shell.
E2-42 added `.envrc` to K1's list and X1's final repair added it to the shell's
defaults; this test is the consistency check INT-1 promised (E2-81), and it
fails if either list drifts, for example if `.envrc` is dropped from X1's
defaults. It needs no sandbox, so it runs on every platform: the effective
names are pure, and the shared write predicate only resolves real paths in a
temporary directory.
*/
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CCC_PLANNING_DENIED_NAMES } from "@fusion/core";
import { cccConfinedEffectiveDeniedNames, cccConfinedWriteRefusal } from "../ccc-confinement/confined-shell.js";

/** K1's comparison fold for one name (E2-40), the same fold the shell applies to its effective names. */
function fold(name: string): string {
  return name.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

/** A concrete path segment for a denied name: `*` stands for any run of characters, so `.env.*` becomes `.env.local`. */
function sampleSegment(name: string): string {
  return name.split("*").join("local");
}

describe("CCC confined-shell denied names cover K1's planning denied names (E2-81)", () => {
  let root: string;
  let writeRoot: string;

  beforeAll(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), "ccc-confined-denied-names-")));
    writeRoot = join(root, "worktree", "src");
    await mkdir(writeRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("matches every K1 CCC_PLANNING_DENIED_NAMES entry, .envrc included, in cccConfinedEffectiveDeniedNames with no caller names", () => {
    // Non-vacuity: K1's list is non-empty and carries the name the consistency check exists for.
    expect(CCC_PLANNING_DENIED_NAMES.length).toBeGreaterThan(0);
    expect(CCC_PLANNING_DENIED_NAMES).toContain(".envrc");
    const effective = new Set(cccConfinedEffectiveDeniedNames([]));
    expect(CCC_PLANNING_DENIED_NAMES.filter((name) => !effective.has(fold(name)))).toEqual([]);
  });

  it("refuses a write through any K1 denied name as the basename or a directory segment with no caller names, while a near-miss name is admitted", () => {
    const refusal = (path: string) => cccConfinedWriteRefusal({ path, writeRoots: [writeRoot], deniedNames: [] });
    for (const name of CCC_PLANNING_DENIED_NAMES) {
      const segment = sampleSegment(name);
      expect([name, refusal(join(writeRoot, segment))]).toEqual([name, "denied-name"]);
      expect([name, refusal(join(writeRoot, "pkg", segment, "x.txt"))]).toEqual([name, "denied-name"]);
      // Control: the same letters without the leading dot or underscore, in an ordinary file name, are admitted.
      expect([name, refusal(join(writeRoot, `${segment.replace(/^[._]+/u, "")}-note.md`))]).toEqual([name, null]);
    }
  });
});
