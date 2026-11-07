import { expect, vi } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { test } from "./fixtures.js";
import { createApp } from "../../src/server.js";
import { ConfigSchema, loadConfig } from "../../src/config.js";
import { MemoryStore } from "../../src/memory/store.js";
import { MemoryWorker } from "../../src/memory/worker.js";
import { createMcp } from "../../src/mcp.js";
import type { McpCallsPage } from "../../src/mcp-calls.js";

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

test("MCP 汇总覆盖全部匹配调用，分页和状态仅筛明细，写入清理 30 天前记录", async ({
  home,
  store,
}) => {
  const app = createApp(store, token);
  const path = "/v1/mcp-calls";
  expect((await app.request(path)).status).toBe(401);
  expect(
    (await app.request(`${path}?days=1&before=wrong`, { headers })).status,
  ).toBe(400);
  const read = async (query = "") => {
    const response = await app.request(path + query, { headers });
    expect(response.status).toBe(200);
    return (await response.json()) as McpCallsPage;
  };
  const empty = await read();
  expect(empty.summary).toHaveLength(7);
  expect(
    empty.summary.every((row) => row.calls === 0 && row.p95Ms === null),
  ).toBe(true);
  expect(empty.calls).toEqual([]);

  const now = Date.parse("2026-11-07T04:00:00Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const server = createMcp(home, "codex");
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const rejectSearch = () =>
      client.callTool({ name: "memory_search", arguments: { query: 1 } });
    expect((await rejectSearch()).isError).toBe(true);
    const db = new Database(join(home, "mcp-calls.db"));
    try {
      db.exec("UPDATE calls SET duration_ms = 0");
      const insert = db.prepare(
        "INSERT INTO calls (tool, agent, at_ms, duration_ms, outcome) VALUES (?, ?, ?, ?, ?)",
      );
      for (let i = 1; i <= 50; i++)
        insert.run(
          "memory_search",
          "codex",
          now,
          i,
          i === 1 ? "tool_error" : "success",
        );
      insert.run("memory_search", "codex", now, 999, "cancelled");
      insert.run("memory_get", "pi", now - 8 * 86_400_000, 2, "success");
      insert.run("memory_get", "pi", now - 31 * 86_400_000, 2, "success");

      const first = await read();
      expect(first.calls).toHaveLength(50);
      expect(first.summary[0]).toMatchObject({
        calls: 52,
        rejected: 1,
        failures: 2,
        cancelled: 1,
        p95Ms: 48,
      });
      expect(first.summary[1]).toMatchObject({ tool: "memory_get", calls: 0 });
      expect(first.nextCursor).not.toBeNull();
      const second = await read(
        `?before=${encodeURIComponent(first.nextCursor!)}`,
      );
      expect(second.summary).toEqual(first.summary);
      expect(second.calls.map((call) => call.id)).toEqual([2, 1]);
      expect(second.nextCursor).toBeNull();
      const rejected = await read(
        "?tool=memory_search&agent=codex&outcome=rejected",
      );
      expect(rejected.summary).toEqual([first.summary[0]]);
      expect(rejected.calls.map((call) => call.outcome)).toEqual(["rejected"]);
      const older = await read("?days=30&agent=pi&tool=memory_get");
      expect(older.summary).toHaveLength(1);
      expect(older.calls).toHaveLength(1);

      await rejectSearch();
      expect(
        db
          .prepare("SELECT COUNT(*) FROM calls WHERE at_ms < ?")
          .pluck()
          .get(now - 30 * 86_400_000),
      ).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    clock.mockRestore();
    await server.close();
  }
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
