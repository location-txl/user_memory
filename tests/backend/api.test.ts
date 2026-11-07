import { expect } from "vitest";
import { test } from "./fixtures.js";
import { createApp } from "../../src/server.js";
import { ConfigSchema, loadConfig } from "../../src/config.js";
import { MemoryWorker } from "../../src/memory/worker.js";

const token = "api-test-token";
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

test("API 拒绝非本机、跨源、错误令牌和超限请求", async ({ store }) => {
  const app = createApp(store, token);
  const cases = [
    ["http://remote.example/v1/status", { headers }, 403, "LOCAL_ONLY"],
    [
      "/v1/status",
      { headers: { ...headers, Origin: "https://remote.example" } },
      403,
      "CROSS_ORIGIN_FORBIDDEN",
    ],
    [
      "/v1/status",
      { headers: { Authorization: "Bearer wrong-tokenxx" } },
      401,
      "UNAUTHORIZED",
    ],
    [
      "/v1/memories",
      {
        method: "POST",
        headers: { ...headers, "Content-Length": "2000001" },
        body: "{}",
      },
      413,
      "PAYLOAD_TOO_LARGE",
    ],
  ] as const;
  for (const [path, options, status, code] of cases) {
    const response = await app.request(path, options);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  }
  expect(await store.list()).toEqual([]);
  expect((await app.request("/v1/status", { headers })).status).toBe(200);
});

test("范围和参数错误返回可判断的错误码且不写入记忆", async ({ store }) => {
  const app = createApp(store, token);
  const invalid = await app.request("/v1/memories", {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "项目记忆",
      content: "缺少项目",
      scope: "project",
    }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({
    code: "VALIDATION_ERROR",
    details: {
      issues: [
        expect.objectContaining({ params: { rule: "scope_project_mismatch" } }),
      ],
    },
  });
  const unknown = await app.request("/v1/memories?projectId=unknown", {
    headers,
  });
  expect(unknown.status).toBe(400);
  expect(await unknown.json()).toMatchObject({ code: "PROJECT_NOT_FOUND" });
  expect(await store.list()).toEqual([]);
});

test("配置更新立即生效并落盘，非法更新保留上次配置", async ({
  store,
  home,
}) => {
  const worker = new MemoryWorker(store, ConfigSchema.parse({}));
  const app = createApp(store, token, worker);
  const update = (data: unknown) =>
    app.request("/v1/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify(data),
    });
  const changes = { extractionEnabled: false, idleSeconds: 45 };
  const saved = await update(changes);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject(changes);
  const rejected = await update({ extractionEnabled: true, idleSeconds: -1 });
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  expect(await loadConfig(home)).toEqual(worker.config);
  expect(await loadConfig(home)).toMatchObject(changes);
  const status = await app.request("/v1/status", { headers });
  expect(await status.json()).toMatchObject({ workerEnabled: false });
});
