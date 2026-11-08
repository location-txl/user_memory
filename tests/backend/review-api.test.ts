import { expect } from "vitest";
import { serve } from "@hono/node-server";
import { test } from "./fixtures.js";
import { createApp } from "../../src/server.js";
import { ConfigSchema, loadConfig } from "../../src/config.js";
import { MemoryWorker } from "../../src/memory/worker.js";

const headers = {
  Authorization: "Bearer review-token",
  "Content-Type": "application/json",
};
test("partial configuration updates preserve omitted fields and paused extraction", async ({
  store,
  home,
}) => {
  const initial = ConfigSchema.parse({
    extractionEnabled: false,
    idleSeconds: 90,
    workerTimeoutSeconds: 900,
    codexPath: "/custom/codex",
  });
  const worker = new MemoryWorker(store, { ...initial });
  const app = createApp(store, "review-token", worker);
  for (const patch of [{ model: "new-model" }, {}]) {
    const response = await app.request("/v1/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify(patch),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...initial, model: "new-model" });
    expect(await loadConfig(home)).toEqual({ ...initial, model: "new-model" });
  }
});

test("long Chinese search uses JSON body over actual HTTP and rejects oversized input", async ({
  store,
}) => {
  const app = createApp(store, "review-token");
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening)
    await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  try {
    for (const [length, expected] of [
      [1850, 200],
      [16001, 400],
    ]) {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/memories/search`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            query: "中".repeat(length),
            status: "active",
          }),
        },
      );
      expect(response.status).toBe(expected);
      if (expected === 200) expect(await response.json()).toEqual([]);
    }
  } finally {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
