import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initHome, atomicWrite } from "../src/config.js";
import { startDaemon } from "../src/daemon.js";
import { MemoryClient } from "../src/client.js";
import { createMcp } from "../src/mcp.js";
import { runHook, spoolEvents } from "../src/adapters/hooks.js";
import { EventSchema, type Memory } from "../src/contracts.js";

let home: string;
let daemon: Awaited<ReturnType<typeof startDaemon>>;
let client: MemoryClient;
let port: number;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "umem-api-"));
  const socket = createServer();
  await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
  port = (socket.address() as { port: number }).port;
  await new Promise<void>((r) => socket.close(() => r()));
  const config = await initHome(home);
  await atomicWrite(
    join(home, "config.json"),
    JSON.stringify({ ...config, port, extractionEnabled: false }),
  );
  daemon = await startDaemon(home, { quiet: true });
  client = new MemoryClient(home);
});
afterEach(async () => {
  await daemon.close();
  await rm(home, { recursive: true, force: true });
});
test("真实 HTTP 鉴权、跨站拒绝、记忆 CRUD 和版本冲突", async () => {
  expect((await fetch(`http://127.0.0.1:${port}/v1/status`)).status).toBe(401);
  const token = (await readFile(join(home, "token"), "utf8")).trim();
  expect(
    (
      await fetch(`http://127.0.0.1:${port}/v1/status`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://example.org",
        },
      })
    ).status,
  ).toBe(403);
  const m = await client.request<Memory>("/memories", {
    method: "POST",
    body: { title: "API 测试", content: "使用中文", scope: "global" },
  });
  await client.request(`/memories/${m.id}`, {
    method: "PATCH",
    body: { revision: m.revision, etag: m.etag, content: "使用粤语" },
  });
  await expect(
    client.request(`/memories/${m.id}`, {
      method: "PATCH",
      body: { revision: m.revision, etag: m.etag, content: "旧版本修改" },
    }),
  ).rejects.toMatchObject({ code: "MEMORY_CONFLICT", status: 409 });
});
test("API errors expose stable codes and structured validation details", async () => {
  const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/status`);
  expect(await unauthorized.json()).toMatchObject({
    code: "UNAUTHORIZED",
    error: expect.stringContaining("umem web"),
  });
  await expect(
    client.request("/memories", {
      method: "POST",
      body: { title: "", content: "保留用户原文", scope: "global" },
    }),
  ).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
    status: 400,
    message: expect.stringMatching(/title: .*>=1/),
    details: {
      issues: [
        expect.objectContaining({
          path: ["title"],
          code: "too_small",
          minimum: 1,
        }),
      ],
    },
  });
  await expect(
    client.request("/memories", {
      method: "POST",
      body: { title: "原文", content: "原文", scope: "project" },
    }),
  ).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
    details: {
      issues: [
        expect.objectContaining({
          code: "custom",
          params: { rule: "scope_project_mismatch" },
        }),
      ],
    },
  });
  await expect(client.request("/memories/missing")).rejects.toMatchObject({
    code: "MEMORY_NOT_FOUND",
    status: 404,
  });
  const missingPath = join(home, "missing.md");
  await expect(
    client.request("/imports/preview", {
      method: "POST",
      body: { path: missingPath },
    }),
  ).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    message: expect.stringContaining(`lstat '${missingPath}'`),
  });
  const token = (await readFile(join(home, "token"), "utf8")).trim();
  const malformed = await fetch(`http://127.0.0.1:${port}/v1/memories`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{",
  });
  expect(malformed.status).toBe(500);
  expect(await malformed.json()).toMatchObject({ code: "INTERNAL_ERROR" });
});
test("doctor displays API diagnostics as provided", async () => {
  const file = join(home, "memories", "中文文件.md");
  await writeFile(file, "Missing frontmatter fixture");
  await atomicWrite(
    join(home, "config.json"),
    JSON.stringify({ ...daemon.worker.config, codexPath: process.execPath }),
  );
  const historicalError = "Codex 提炼失败（1）：外部诊断";
  daemon.store.db
    .prepare(
      "INSERT INTO jobs (agent, session_id, state, error, updated_at) VALUES ('codex', 'historical', 'failed', ?, ?)",
    )
    .run(historicalError, new Date().toISOString());
  const status = await client.request("/status");
  expect(status).toMatchObject({
    errors: [`${file}: Missing YAML frontmatter`],
    jobs: [{ error: historicalError }],
  });
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    "--home",
    home,
    "doctor",
  ]);
  expect(JSON.parse(stdout).status).toEqual(status);
});
test.skipIf(process.platform === "win32")(
  "CLI 导入错误转义路径中的终端控制字符",
  async () => {
    const directory = join(home, "downloaded");
    const child = join(directory, "subdir\u001b[2J\u009bH");
    await mkdir(child, { recursive: true });
    await writeFile(join(child, "big.md"), "a".repeat(128001));
    await expect(
      promisify(execFile)(process.execPath, [
        "--import",
        "tsx",
        "src/cli.ts",
        "--home",
        home,
        "import",
        directory,
        "--dry-run",
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: `Import file is too large. Split it first.\n${join(directory, "subdir\\u001b[2J\\u009bH", "big.md")}\n`,
    });
  },
);
test("同一数据目录拒绝第二个写入服务", async () => {
  await expect(startDaemon(home, { quiet: true })).rejects.toThrow(/lock/i);
  expect(await client.request("/status")).toBeTruthy();
});
test("MCP 实际协议握手、写入和项目访问边界", async () => {
  const server = createMcp(home, "codex");
  const mcp = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await mcp.connect(b);
  try {
    expect((await mcp.listTools()).tools).toHaveLength(5);
    const added = await mcp.callTool({
      name: "memory_remember",
      arguments: {
        title: "MCP 测试",
        content: "我的默认语言是中文",
        scope: "global",
      },
    });
    expect(added.isError).not.toBe(true);
    const text = (added.content as { text: string }[])[0].text;
    const memory = JSON.parse(text) as Memory;
    const result = await mcp.callTool({
      name: "memory_search",
      arguments: { query: "中文" },
    });
    expect(JSON.stringify(result)).toContain(memory.id);
    await mkdir(join(home, "private"));
    const project = await daemon.store.addProject(join(home, "private"));
    const scoped = await client.request<Memory>("/memories", {
      method: "POST",
      body: {
        title: "项目限定",
        content: "只有这个项目知道",
        scope: "project",
        projectId: project.id,
      },
    });
    const forbidden = await mcp.callTool({
      name: "memory_get",
      arguments: { id: scoped.id },
    });
    expect(forbidden.isError).toBe(true);
    expect(JSON.stringify(forbidden)).not.toContain("只有这个项目知道");
    const forgotten = await mcp.callTool({
      name: "memory_forget",
      arguments: {
        id: memory.id,
        revision: memory.revision,
        etag: memory.etag,
      },
    });
    expect(forgotten.isError).not.toBe(true);
    const tombstone = await mcp.callTool({
      name: "memory_get",
      arguments: { id: memory.id },
    });
    expect(JSON.stringify(tombstone)).toContain("withdrawn");
    expect(JSON.stringify(tombstone)).not.toContain(memory.content);
  } finally {
    await mcp.close();
    await server.close();
  }
});
test("ZCode hook 将新用户原话采集到队列，并注入公共记忆", async () => {
  await client.request("/memories", {
    method: "POST",
    body: { title: "语言", content: "全局默认中文", scope: "global" },
  });
  const result = await runHook(home, "zcode", {
    session_id: "z1",
    hook_event_name: "UserPromptSubmit",
    prompt: "以后使用 TypeScript",
    turn_id: "t1",
  });
  expect(JSON.stringify(result)).toContain("全局默认中文");
  await daemon.store.drainSpool();
  const events = daemon.store.events(daemon.store.jobs()[0].id);
  expect(events[0].content).toBe("以后使用 TypeScript");
  await runHook(home, "zcode", {
    session_id: "z1",
    hook_event_name: "UserPromptSubmit",
    prompt: "以后使用 TypeScript",
    turn_id: "t1",
  });
  await daemon.store.drainSpool();
  expect(daemon.store.events(daemon.store.jobs()[0].id)).toHaveLength(1);
});
test("Codex 增量采集不导入旧历史，不丢跨缓冲区 UTF-8 或半行", async () => {
  const path = join(home, "transcript.jsonl");
  const row = (text: string, role = "assistant") =>
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role,
        content: [{ type: "output_text", text }],
      },
    });
  await writeFile(path, row("不应导入的过去") + "\n");
  await runHook(home, "codex", {
    session_id: "c1",
    hook_event_name: "SessionStart",
    transcript_path: path,
  });
  const first = await readFile(path, "utf8");
  const large = row("汉".repeat(100000));
  const final = row("最后一条新回复");
  await writeFile(path, first + large + "\n" + final.slice(0, 30));
  await runHook(home, "codex", {
    session_id: "c1",
    hook_event_name: "Stop",
    transcript_path: path,
  });
  await daemon.store.drainSpool();
  await writeFile(
    path,
    first +
      large +
      "\n" +
      final +
      "\n" +
      row("恢复的系统上下文", "user") +
      "\n",
  );
  await runHook(home, "codex", {
    session_id: "c1",
    hook_event_name: "Stop",
    transcript_path: path,
  });
  await daemon.store.drainSpool();
  const events = daemon.store.events(daemon.store.jobs()[0].id);
  expect(events).toHaveLength(2);
  expect(events[0].content).not.toContain("�");
  expect(events[1].content).toBe("最后一条新回复");
});
test("服务停机时已采集内容仍可耐久保存，重启后消费", async () => {
  await daemon.close();
  await spoolEvents(home, [
    EventSchema.parse({
      id: "offline1",
      agent: "pi",
      sessionId: "p1",
      role: "user",
      content: "离线时的新偏好",
      at: new Date().toISOString(),
    }),
  ]);
  daemon = await startDaemon(home, { quiet: true });
  await daemon.store.drainSpool();
  expect(daemon.store.events(daemon.store.jobs()[0].id)[0].content).toBe(
    "离线时的新偏好",
  );
});
