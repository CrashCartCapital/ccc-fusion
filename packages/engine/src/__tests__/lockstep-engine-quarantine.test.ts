import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type QuarantineEntry = {
  file: string;
  reason: string;
  quarantinedAt: string;
};

const repoRoot = resolve(import.meta.dirname!, "../../../..");
const configPath = resolve(repoRoot, "packages/engine/vitest.config.ts");
const ledgerPath = resolve(repoRoot, "scripts/lib/test-quarantine.json");
const enginePathPrefix = "packages/engine/";
const iso8601Timestamp = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/*
FNXC:EngineTests 2026-09-11-17:45:
Generalised from packages/cli/src/__tests__/lockstep-cli-quarantine.test.ts (FN-8223) after the
2026-09-11 full-suite quarantine audit found the engine-slow project's exclude list claiming
(since c15c78fee, 2026-07-13) to be "mirrored in scripts/lib/test-quarantine.json" while the
ledger's `entries` array had been `[]` the entire time. Unlike packages/cli/vitest.config.ts and
packages/dashboard/vitest.config.ts, packages/engine/vitest.config.ts has no single
`quarantinedEngineTests: string[]` array — its per-project `exclude:` arrays mix genuine flaky-
test quarantine entries with structural project-routing excludes (real-pg files routed to
engine-product-route, reliability-interactions routed to engine-reliability, `*.slow.test.ts`
routed to engine-slow itself). Only the engine-slow project's own `exclude:` array is, by that
block's own long-standing doc comment, ENTIRELY a quarantine list (nothing structural lives
there — engine-slow's own files are already scoped out by its `include` glob), so this guard
parses that block specifically rather than guessing which lines in engine-default/engine-
reliability's mixed exclude arrays are quarantine-style vs. structural (that mixed-array pattern
is a known, separate piece of drift and was not touched here). It also matches any future
`const quarantined*Tests: string[] = [...]` array added to this file, mirroring the CLI/dashboard
shape, so this test does not need another rewrite if engine ever adopts that pattern. Runs as a
normal test file directly under src/__tests__/ (engine-default project — no `--project=engine-core` build step),
so it executes under `pnpm --filter @fusion/engine test`, `pnpm test:full`, and the CI
`test-shards` job without any new wiring.
*/

function extractBalancedArrayBody(source: string, openBracketIndex: number): string {
  let depth = 0;
  let index = openBracketIndex;
  for (; index < source.length; index += 1) {
    if (source[index] === "[") depth += 1;
    else if (source[index] === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  expect(depth, "engine vitest config exclude array must be a balanced, statically parseable literal").toBe(0);
  return source.slice(openBracketIndex + 1, index);
}

function extractQuotedPaths(arrayBody: string): string[] {
  return [...arrayBody.matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
}

/** The engine-slow project's own `exclude: [...]` array — by its own doc comment, entirely a quarantine list. */
function parseEngineSlowExcludes(configSource: string): string[] {
  const slowProjectIndex = configSource.indexOf('name: "engine-slow"');
  expect(slowProjectIndex, 'packages/engine/vitest.config.ts must declare an "engine-slow" project').toBeGreaterThan(-1);
  const excludeKeyIndex = configSource.indexOf("exclude:", slowProjectIndex);
  expect(excludeKeyIndex, "engine-slow project must declare an exclude: array").toBeGreaterThan(-1);
  const openBracketIndex = configSource.indexOf("[", excludeKeyIndex);
  return extractQuotedPaths(extractBalancedArrayBody(configSource, openBracketIndex));
}

/** Forward-compatible with the CLI/dashboard `const quarantined*Tests: string[] = [...]` shape, should engine ever adopt it. */
function parseQuarantinedTestsArrays(configSource: string): string[] {
  const paths: string[] = [];
  const declarationPattern = /const quarantined\w*Tests: string\[\] = \[/g;
  let match: RegExpExecArray | null;
  while ((match = declarationPattern.exec(configSource))) {
    const openBracketIndex = match.index + match[0].length - 1;
    paths.push(...extractQuotedPaths(extractBalancedArrayBody(configSource, openBracketIndex)));
  }
  return paths;
}

function normalizeEnginePath(path: string): string {
  return `${enginePathPrefix}${path}`;
}

function countByPath(paths: string[]): Map<string, number> {
  return paths.reduce((counts, path) => counts.set(path, (counts.get(path) ?? 0) + 1), new Map<string, number>());
}

describe("engine quarantine ledger lockstep", () => {
  it("keeps the engine-slow quarantine exclude and matching ledger rows in bidirectional lockstep", () => {
    const configSource = readFileSync(configPath, "utf8");
    const configPaths = [...parseEngineSlowExcludes(configSource), ...parseQuarantinedTestsArrays(configSource)].map(
      normalizeEnginePath,
    );
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { entries: QuarantineEntry[] };
    const ledgerEntries = ledger.entries.filter((entry) => entry.file.startsWith(enginePathPrefix));
    const ledgerPaths = ledgerEntries.map((entry) => entry.file);
    const configCounts = countByPath(configPaths);
    const ledgerCounts = countByPath(ledgerPaths);

    for (const count of configCounts.values()) {
      expect(count).toBe(1);
    }
    for (const count of ledgerCounts.values()) {
      expect(count).toBe(1);
    }
    expect(configCounts).toEqual(ledgerCounts);

    for (const entry of ledgerEntries) {
      expect(entry.reason.trim()).not.toBe("");
      expect(entry.quarantinedAt).toMatch(iso8601Timestamp);
      expect(Number.isNaN(Date.parse(entry.quarantinedAt))).toBe(false);
    }
  });
});
