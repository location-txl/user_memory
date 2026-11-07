import { expect } from "vitest";
import { test } from "./fixtures.js";
import { createApp } from "../../src/server.js";
import { ConfigSchema, loadConfig } from "../../src/config.js";
import { MemoryStore } from "../../src/memory/store.js";
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

test("近期任务保留旧记录，模型汇总包含超过近期范围的用量", async ({
  store,
}) => {
  const insert = store.db.prepare(
    "INSERT INTO jobs (agent, session_id, state, updated_at) VALUES ('codex', ?, 'done', ?)",
  );
  const at = "2026-11-07T00:00:00.000Z";
  const oldest = Number(insert.run("oldest", at).lastInsertRowid);
  for (let i = 0; i < 98; i++) insert.run(`old-${i}`, at);
  const recent = Number(insert.run("recent", at).lastInsertRowid);
  const legacy = Number(insert.run("legacy", at).lastInsertRowid);
  store.recordExtractionUsage(oldest, "test-model", {
    inputTokens: 90,
    outputTokens: 10,
  });
  store.recordExtractionUsage(recent, "test-model", {
    inputTokens: 25,
    outputTokens: 5,
    cachedInputTokens: 20,
  });
  store.recordExtractionUsage(recent, null);

  const app = createApp(store, token);
  const jobs = await (await app.request("/v1/jobs", { headers })).json();
  expect(jobs).toHaveLength(100);
  expect(jobs[0]).toMatchObject({ id: legacy, usageByModel: [] });
  const unknown = {
    model: null,
    calls: 1,
    reportedCalls: 0,
    cacheReportedCalls: 0,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    totalTokens: null,
  };
  expect(jobs[1]).toMatchObject({
    id: recent,
    usageByModel: [
      unknown,
      {
        model: "test-model",
        calls: 1,
        reportedCalls: 1,
        cacheReportedCalls: 1,
        inputTokens: 25,
        cachedInputTokens: 20,
        outputTokens: 5,
        totalTokens: 30,
      },
    ],
  });
  const status = await (await app.request("/v1/status", { headers })).json();
  expect(status.jobs).toEqual(jobs);
  expect(status.extractionUsageByModel).toEqual([
    unknown,
    {
      model: "test-model",
      calls: 2,
      reportedCalls: 2,
      cacheReportedCalls: 1,
      inputTokens: 115,
      cachedInputTokens: 20,
      outputTokens: 15,
      totalTokens: 130,
    },
  ]);
});

test("升级旧用量表保留输入输出，同模型的新调用可记录零缓存", async ({
  home,
  store,
}) => {
  store.db.exec(`
    ALTER TABLE extraction_usage DROP COLUMN cached_input_tokens;
    ALTER TABLE extraction_usage DROP COLUMN cache_reported_calls;
    INSERT INTO jobs (id, agent, session_id, state, updated_at)
      VALUES (1, 'codex', 'legacy', 'done', '2026-11-07T00:00:00Z');
    INSERT INTO extraction_usage (job_id, model, calls, reported_calls, input_tokens, output_tokens)
      VALUES (1, 'test-model', 1, 1, 100, 20);
  `);
  store.close();
  const upgraded = await MemoryStore.open(home);
  try {
    expect(upgraded.jobs()[0].usageByModel[0]).toMatchObject({
      cacheReportedCalls: 0,
      cachedInputTokens: null,
      totalTokens: 120,
    });
    upgraded.recordExtractionUsage(1, "test-model", {
      inputTokens: 5,
      outputTokens: 2,
      cachedInputTokens: 0,
    });
    expect(upgraded.jobs()[0].usageByModel[0]).toMatchObject({
      calls: 2,
      reportedCalls: 2,
      cacheReportedCalls: 1,
      cachedInputTokens: 0,
      totalTokens: 127,
    });
  } finally {
    upgraded.close();
  }
});
