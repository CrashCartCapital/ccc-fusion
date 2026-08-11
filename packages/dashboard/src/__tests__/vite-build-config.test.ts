import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("dashboard Vite production build config", () => {
  it("skips informational gzip-size reporting in CI-sized production builds", () => {
    const dashboardDir = join(__dirname, "..", "..");
    const config = readFileSync(join(dashboardDir, "vite.config.ts"), "utf8");

    expect(config).toContain("reportCompressedSize: false");
    expect(config).not.toContain("chunkSizeWarningLimit:");
  });
});
