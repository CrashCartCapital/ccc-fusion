import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStore } from "../store.js";

describe("CCC campaign local TaskStore compatibility", () => {
  let rootDir: string | undefined;
  let store: TaskStore | undefined;

  afterEach(async () => {
    await store?.close();
    store = undefined;
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
    rootDir = undefined;
  });

  it("returns null for campaign context probes when no PostgreSQL custody layer exists", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "fusion-ccc-campaign-local-"));
    store = new TaskStore(rootDir);

    await expect(store.getCccCampaignContextForTask("ordinary-task")).resolves.toBeNull();
  });
});
