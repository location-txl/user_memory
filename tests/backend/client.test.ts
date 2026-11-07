import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import { test } from "./fixtures.js";
import { MemoryClient } from "../../src/client.js";

afterEach(() => vi.restoreAllMocks());

test("客户端使用配置的本机端口和令牌，提交 JSON 并解析响应", async ({
  home,
}) => {
  await writeFile(join(home, "config.json"), '{"port":45678}');
  await writeFile(join(home, "token"), "client-fixture-token\n");
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ accepted: 1 }));
  expect(
    await new MemoryClient(home).request("/ingest", {
      method: "POST",
      body: [{ id: "one" }],
    }),
  ).toEqual({ accepted: 1 });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "http://127.0.0.1:45678/v1/ingest",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer client-fixture-token",
        "Content-Type": "application/json",
      },
      body: '[{"id":"one"}]',
      signal: expect.any(AbortSignal),
    },
  );
});

test("客户端错误保留 HTTP 状态、业务码、消息和详情", async ({ home }) => {
  await writeFile(join(home, "token"), "client-fixture-token");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      { code: "MEMORY_CONFLICT", error: "版本已变化", details: { id: "one" } },
      { status: 409 },
    ),
  );
  await expect(
    new MemoryClient(home).request("/memories/one"),
  ).rejects.toMatchObject({
    status: 409,
    code: "MEMORY_CONFLICT",
    message: "版本已变化",
    details: { id: "one" },
  });
});
