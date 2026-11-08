import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  mkdtemp,
  rm,
  readFile,
  mkdir,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initHome, atomicWrite } from "../../src/config.js";
import { startDaemon } from "../../src/daemon.js";
import { MemoryClient } from "../../src/client.js";
import { createMcp } from "../../src/mcp.js";
import { runHook, spoolEvents } from "../../src/adapters/hooks.js";
import { EventSchema, type Memory } from "../../src/contracts.js";
import { MemoryWorker, type Extractor } from "../../src/memory/worker.js";
import { capturedEvents } from "../backend/fixtures.js";
import type { McpCallsPage } from "../../src/mcp-calls.js";

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
  try {
    if (daemon?.server.listening) await daemon.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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
  const updated = await client.request<Memory>(`/memories/${m.id}`, {
    method: "PATCH",
    body: { revision: m.revision, etag: m.etag, content: "使用粤语" },
  });
  expect(updated.sources.at(-1)).toMatchObject({
    role: "manual",
    excerpt: "使用粤语",
  });
  await expect(
    client.request(`/memories/${m.id}`, {
      method: "PATCH",
      body: { revision: m.revision, etag: m.etag, content: "旧版本修改" },
    }),
  ).rejects.toMatchObject({ code: "MEMORY_CONFLICT", status: 409 });
});

test("证据经过真实 HTTP、CLI 与 MCP stdio，保留原文并限制项目范围", async () => {
  const root = join(home, "evidence-project");
  await mkdir(root);
  const project = await daemon.store.addProject(root);
  const global = EventSchema.parse({
    id: "evidence:global",
    agent: "codex",
    sessionId: "evidence-session",
    role: "user",
    at: "2026-11-07T00:00:00Z",
    content: "构建约定在所有项目生效",
  });
  const local = EventSchema.parse({
    ...global,
    id: "evidence:project/原文 ?#",
    projectId: project.id,
    role: "tool",
    content: `构建 ${"详情".repeat(1000)} 最后条件：仅测试环境`,
  });
  await client.request("/ingest", { method: "POST", body: [global, local] });
  expect(
    (
      await fetch(`http://127.0.0.1:${port}/v1/evidence/search`, {
        method: "POST",
      })
    ).status,
  ).toBe(401);
  await expect(
    client.request("/evidence/search", { method: "POST", body: { query: "" } }),
  ).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
  });
  await expect(
    client.request("/evidence/get", { method: "POST", body: { id: local.id } }),
  ).rejects.toMatchObject({ code: "EVIDENCE_NOT_FOUND" });

  const cli = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import",
      "tsx",
      resolve("src/cli.ts"),
      "--home",
      home,
      "evidence",
      ...args,
    ]);
    return JSON.parse(stdout);
  };
  expect(await cli("search", "构建")).toMatchObject({
    total: 1,
    results: [{ id: global.id }],
  });
  expect(
    await cli(
      "search",
      "构建",
      "--cwd",
      root,
      "--agent",
      "codex",
      "--session",
      global.sessionId,
    ),
  ).toMatchObject({ total: 2 });
  expect(await cli("get", local.id, "--project", project.id)).toEqual({
    _memoryContext: "<user-memory-context>",
    ...local,
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      resolve("src/cli.ts"),
      "--home",
      home,
      "mcp",
      "--agent",
      "pi",
    ],
    stderr: "pipe",
  });
  const mcp = new Client({ name: "evidence-test", version: "1" });
  try {
    await mcp.connect(transport, { timeout: 5_000 });
    const search = await mcp.callTool({
      name: "memory_evidence_search",
      arguments: { query: "构建", cwd: root },
    });
    expect(search.isError).not.toBe(true);
    expect(
      JSON.parse((search.content as { text: string }[])[0].text),
    ).toMatchObject({ total: 2 });
    const result = await mcp.callTool({
      name: "memory_evidence_get",
      arguments: { id: local.id, cwd: root },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({
      _memoryContext: "<user-memory-context>",
      ...local,
    });
    const forbidden = await mcp.callTool({
      name: "memory_evidence_get",
      arguments: { id: local.id },
    });
    expect(forbidden.isError).toBe(true);
    expect(JSON.stringify(forbidden)).not.toContain(local.content);
    expect((await client.request<McpCallsPage>("/mcp-calls")).calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "memory_evidence_search",
          searchTotal: 2,
          searchReturned: 2,
          outcome: "success",
        }),
        expect.objectContaining({
          tool: "memory_evidence_get",
          outcome: "tool_error",
          errorCode: "EVIDENCE_NOT_FOUND",
        }),
      ]),
    );
  } finally {
    await transport.close();
  }
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
  const file = join(home, "memories", "global", "中文文件.md");
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
    expect((await mcp.listTools()).tools).toHaveLength(7);
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
test("ZCode hook 采集原话并注入常驻记忆，提交时不排提炼任务", async () => {
  await client.request("/memories", {
    method: "POST",
    body: {
      title: "语言",
      content: "全局默认中文",
      scope: "global",
      alwaysRecall: true,
    },
  });
  const result = await runHook(home, "zcode", {
    session_id: "z1",
    hook_event_name: "UserPromptSubmit",
    prompt: "以后使用 TypeScript",
    turn_id: "t1",
  });
  expect(JSON.stringify(result)).toContain("全局默认中文");
  await daemon.store.drainSpool();
  const events = capturedEvents(daemon.store);
  expect(events[0].content).toBe("以后使用 TypeScript");
  await runHook(home, "zcode", {
    session_id: "z1",
    hook_event_name: "UserPromptSubmit",
    prompt: "以后使用 TypeScript",
    turn_id: "t1",
  });
  await daemon.store.drainSpool();
  expect(capturedEvents(daemon.store)).toHaveLength(1);
  expect(daemon.store.jobs()).toEqual([]);
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
  const events = capturedEvents(daemon.store);
  expect(events).toHaveLength(2);
  expect(events[0].content).not.toContain("�");
  expect(events[1].content).toBe("最后一条新回复");
});
test("Codex 空工具输出不阻塞同批有效事件入库", async () => {
  const path = join(home, "transcript.jsonl");
  const stop = () =>
    runHook(home, "codex", {
      session_id: "c1",
      hook_event_name: "Stop",
      transcript_path: path,
    });
  await writeFile(path, "");
  await stop();
  const rows = [
    { type: "function_call_output", output: "" },
    { type: "function_call_output", output: "有效工具输出" },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "正常回复" }],
    },
  ];
  await writeFile(
    path,
    rows
      .map((payload) =>
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-11-07T00:00:00.000Z",
          payload,
        }),
      )
      .join("\n") + "\n",
  );
  await stop();
  await daemon.store.drainSpool();
  expect(await readdir(join(home, "spool"))).toEqual([]);
  expect(daemon.store.jobs()).toEqual([]);
  expect(capturedEvents(daemon.store).map(({ content }) => content)).toEqual([
    "有效工具输出",
    "正常回复",
  ]);
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
  expect(capturedEvents(daemon.store)[0].content).toBe("离线时的新偏好");
});

test("监听失败会释放数据目录写锁", async () => {
  const blockedHome = join(home, "blocked");
  const config = await initHome(blockedHome);
  await atomicWrite(
    join(blockedHome, "config.json"),
    JSON.stringify({ ...config, port }),
  );
  await expect(
    startDaemon(blockedHome, { quiet: true, worker: false }),
  ).rejects.toMatchObject({ code: "EADDRINUSE" });
  expect(await lockfile.check(blockedHome)).toBe(false);
  expect(await client.request("/status")).toBeTruthy();
});

test("真实 MCP stdio 调用可搜索记忆，后台离线的失败也在重启后可查", async () => {
  const memory = await client.request<Memory>("/memories", {
    method: "POST",
    body: {
      title: "stdio 验收",
      content: "使用 Rust 编写工具",
      scope: "global",
    },
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      resolve("src/cli.ts"),
      "--home",
      home,
      "mcp",
      "--agent",
      "pi",
    ],
    stderr: "pipe",
  });
  const mcp = new Client({ name: "stdio-test", version: "1" });
  try {
    await mcp.connect(transport, { timeout: 5_000 });
    expect((await mcp.listTools({}, { timeout: 5_000 })).tools).toHaveLength(7);
    const found = await mcp.callTool(
      { name: "memory_search", arguments: { query: "Rust" } },
      undefined,
      { timeout: 5_000 },
    );
    expect(found.isError).not.toBe(true);
    const [{ text }] = found.content as { text: string }[];
    expect(JSON.parse(text)).toMatchObject({
      total: 1,
      results: [{ id: memory.id, excerpt: memory.content }],
    });
    expect(
      (await client.request<McpCallsPage>("/mcp-calls")).calls,
    ).toMatchObject([
      {
        tool: "memory_search",
        agent: "pi",
        outcome: "success",
        searchReturned: 1,
      },
    ]);
    await daemon.close();
    const offline = await mcp.callTool(
      { name: "memory_search", arguments: { query: "Rust" } },
      undefined,
      { timeout: 5_000 },
    );
    expect(offline.isError).toBe(true);
    daemon = await startDaemon(home, { quiet: true });
    expect(
      (await client.request<McpCallsPage>("/mcp-calls")).calls,
    ).toMatchObject([
      {
        tool: "memory_search",
        agent: "pi",
        outcome: "tool_error",
        responseBytes: null,
      },
      {
        tool: "memory_search",
        agent: "pi",
        outcome: "success",
        searchReturned: 1,
      },
    ]);
  } finally {
    await transport.close();
  }
});

test("CLI 导入预览、批准、纠正、撤回和导出走真实后端", async () => {
  const path = join(home, "source.md");
  const target = join(home, "exported");
  await writeFile(path, "偏好使用 Kotlin");
  const cli = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import",
      "tsx",
      resolve("src/cli.ts"),
      "--home",
      home,
      ...args,
    ]);
    return JSON.parse(stdout);
  };

  expect(await cli("import", path, "--dry-run")).toMatchObject([
    { path, preview: "偏好使用 Kotlin" },
  ]);
  expect(await daemon.store.list()).toEqual([]);
  const [memory] = (await cli("import", path)) as Memory[];
  expect(memory).toMatchObject({ status: "candidate", revision: 1 });
  expect(await cli("memory", "approve", memory.id)).toMatchObject({
    status: "active",
    revision: 2,
  });
  expect(
    await cli("memory", "correct", memory.id, "偏好使用 Swift"),
  ).toMatchObject({
    content: "偏好使用 Swift",
    status: "active",
    revision: 3,
  });
  expect(await cli("memory", "forget", memory.id)).toMatchObject({
    status: "withdrawn",
    revision: 4,
  });
  expect(await daemon.store.get(memory.id)).toMatchObject({
    status: "withdrawn",
    content: "偏好使用 Swift",
  });

  const root = join(home, "project-root");
  await mkdir(root);
  const project = await daemon.store.addProject(root);
  const projectMemory = await client.request<Memory>("/memories", {
    method: "POST",
    body: {
      title: "项目约定",
      content: "使用项目目录",
      scope: "project",
      projectId: project.id,
    },
  });
  expect(await cli("export", target)).toMatchObject({ directory: target });
  expect((await readdir(target)).sort()).toEqual([
    "history",
    "memories",
    "projects.json",
  ]);
  expect(
    await readFile(
      join(target, "memories", "global", `${memory.id}.md`),
      "utf8",
    ),
  ).toBe(await readFile(memory.file, "utf8"));
  expect(await readdir(join(target, "history", memory.id))).toHaveLength(3);
  expect(
    await readFile(
      join(
        target,
        "memories",
        "projects",
        project.memoryDirectory,
        `${projectMemory.id}.md`,
      ),
      "utf8",
    ),
  ).toBe(await readFile(projectMemory.file, "utf8"));
  expect(await readFile(join(target, "projects.json"), "utf8")).toBe(
    await readFile(join(home, "projects.json"), "utf8"),
  );
});

test("服务离线时 CLI hook 返回空上下文，保留本轮用户证据", async () => {
  await daemon.close();
  const run = promisify(execFile)(process.execPath, [
    "--import",
    "tsx",
    resolve("src/cli.ts"),
    "--home",
    home,
    "hook",
    "--agent",
    "zcode",
  ]);
  run.child.stdin?.end(
    JSON.stringify({
      session_id: "offline-hook",
      hook_event_name: "UserPromptSubmit",
      turn_id: "t1",
      prompt: "离线期间的新偏好",
    }),
  );
  const { stdout, stderr } = await run;
  expect(JSON.parse(stdout)).toEqual({});
  expect(stderr).toContain("[user-memory]");
  const directory = join(home, "spool");
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  expect(
    JSON.parse(await readFile(join(directory, files[0]), "utf8")),
  ).toMatchObject([
    { sessionId: "offline-hook", role: "user", content: "离线期间的新偏好" },
  ]);
});

test("隔离库端到端：仅提交需求不提炼，待确认方案不入库，按钮任务不注入 CI", async () => {
  const cwd = join(home, "ui-project");
  await mkdir(cwd);
  const project = await daemon.store.addProject(cwd);
  const ci = await client.request<Memory>("/memories", {
    method: "POST",
    body: {
      title: "纯文档变更跳过 CI",
      content: "GitHub Actions 需要保留必要校验。",
      scope: "project",
      projectId: project.id,
      kind: "constraint",
    },
  });
  const first = { session_id: "review", turn_id: "first", cwd };
  const result = await runHook(home, "codex", {
    ...first,
    hook_event_name: "UserPromptSubmit",
    prompt: "本次优化 CI，保留必要测试。",
  });
  expect(JSON.stringify(result)).toContain(ci.title);
  const extract = vi.fn<Extractor>(async (events) => ({
    outcome: "pending",
    proposals: [
      {
        action: "add",
        targetId: null,
        expectedRevision: null,
        title: "CI 提速方案",
        content: "CI 应当采用本轮提议的策略。",
        scope: "project",
        kind: "decision",
        sourceIds: [events[0].id],
        basis: "adopted_decision",
        certainty: "supported",
        reason: "模拟将待确认方案误作为已采纳决策",
      },
    ],
  }));
  const worker = new MemoryWorker(daemon.store, daemon.worker.config, extract);
  await worker.tick(true);
  expect(extract).not.toHaveBeenCalled();
  expect(daemon.store.jobs()).toEqual([]);
  expect(capturedEvents(daemon.store)).toMatchObject([
    { turnId: "first", role: "user" },
  ]);

  await runHook(home, "codex", {
    ...first,
    hook_event_name: "Stop",
    last_assistant_message: "建议调整工作流，请先确认，尚未执行。",
  });
  await worker.tick(true);
  expect(extract).toHaveBeenCalledOnce();
  expect(daemon.store.jobs()).toMatchObject([
    { state: "done", review: { total: 0 } },
  ]);
  expect(
    (await daemon.store.list({ projectId: project.id })).map((m) => m.id),
  ).toEqual([ci.id]);

  const unrelated = await runHook(home, "codex", {
    ...first,
    turn_id: "second",
    hook_event_name: "UserPromptSubmit",
    prompt: "帮我优化一下按钮的圆角配色",
  });
  expect(unrelated).toEqual({});
});
