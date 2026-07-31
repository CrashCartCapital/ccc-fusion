// @vitest-environment node

import express from "express";
import { expect, it, vi } from "vitest";
import { request as performRequest } from "../../test-request.js";
import { createCliAgentHooksRouterForTest } from "../cli-agent-hooks.js";

const JSON_HEADERS = {
  "content-type": "application/json",
  host: "127.0.0.1",
  "x-fusion-cli-session-id": "session-1",
  "x-fusion-cli-session-token": "token-1",
};

function mount(ingest: ReturnType<typeof vi.fn>) {
  const router = createCliAgentHooksRouterForTest(() => ({
    validateToken: (sessionId, token) =>
      sessionId === "session-1" && token === "token-1",
    ingest,
  }));
  const app = express();
  app.use("/api", router);
  return app;
}

it("maps an authenticated Codex agent-turn-complete notify to positive completion", async () => {
  const ingest = vi.fn();
  const app = mount(ingest);

  const response = await performRequest(
    app,
    "POST",
    "/api/cli-agent/hooks?event=notify",
    JSON.stringify({
      type: "agent-turn-complete",
      "thread-id": "codex-thread-1",
      "turn-id": "codex-turn-1",
      cwd: "/tmp/disposable-worktree",
      "last-assistant-message": "done",
    }),
    JSON_HEADERS,
  );

  expect(response.status).toBe(200);
  expect(ingest).toHaveBeenCalledWith("session-1", {
    kind: "done",
    payload: {
      nativeSessionId: "codex-thread-1",
      turnId: "codex-turn-1",
      cwd: "/tmp/disposable-worktree",
      lastAssistantMessage: "done",
    },
  });
});

it("keeps a non-completion notify blocked on human input", async () => {
  const ingest = vi.fn();
  const app = mount(ingest);

  const response = await performRequest(
    app,
    "POST",
    "/api/cli-agent/hooks?event=notify",
    JSON.stringify({ type: "permission-request", detail: "confirm" }),
    JSON_HEADERS,
  );

  expect(response.status).toBe(200);
  expect(ingest).toHaveBeenCalledWith("session-1", {
    kind: "waitingOnInput",
    payload: {
      notification: { type: "permission-request", detail: "confirm" },
    },
  });
});
