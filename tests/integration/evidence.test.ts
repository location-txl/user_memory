import { afterEach, expect, vi } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { test as base } from "../backend/fixtures.js";
import { initHome, atomicWrite } from "../../src/config.js";
import { startDaemon } from "../../src/daemon.js";
import { MemoryClient } from "../../src/client.js";
import { createMcp } from "../../src/mcp.js";
import { runHook } from "../../src/adapters/hooks.js";
import { EventSchema, CreateMemorySchema } from "../../src/contracts.js";
import { MemoryStore } from "../../src/memory/store.js";
import { MemoryWorker } from "../../src/memory/worker.js";
import { searchEvidence } from "../../src/memory/evidence.js";
import { encodeMemory } from "../../src/memory/files.js";

afterEach(() => vi.restoreAllMocks());
const exec = promisify(execFile);
const cli = (home: string, ...args: string[]) =>
  exec(process.execPath, [
    "--import",
    "tsx",
    resolve("src/cli.ts"),
    "--home",
    home,
    ...args,
  ]);
const at = "2026-11-07T00:00:00Z";
const event = (id: string, content: string) =>
  EventSchema.parse({
    id,
    content,
    agent: "codex",
    sessionId: "evidence-fix",
    role: "tool",
    at,
  });
async function configure(home: string) {
  const socket = createServer();
  await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((r) => socket.close(() => r()));
  const config = await initHome(home);
  await atomicWrite(
    join(home, "config.json"),
    JSON.stringify({ ...config, port, extractionEnabled: false }),
  );
}
const test = base.extend<{ daemon: Awaited<ReturnType<typeof startDaemon>> }>({
  daemon: async ({ home }, use) => {
    await configure(home);
    const daemon = await startDaemon(home, { quiet: true, worker: false });
    try {
      await use(daemon);
    } finally {
      await daemon.close();
    }
  },
});

test("证据 CLI 输出经真实 hook 回流后不能绕过撤回，普通工具证据仍采集", async ({
  home,
  daemon,
}) => {
  const { store } = daemon;
  const original = event("original", "replayneedle 旧构建经验");
  store.ingest([original]);
  store.db.exec("UPDATE jobs SET state='done'");
  const memory = await store.create(
    CreateMemorySchema.parse({
      title: "旧经验",
      content: original.content,
      scope: "global",
      kind: "lesson",
      sources: [
        {
          id: original.id,
          agent: original.agent,
          role: original.role,
          excerpt: original.content,
          at,
        },
      ],
    }),
  );
  const transcript = join(home, "transcript.jsonl");
  await writeFile(transcript, "");
  const stop = () =>
    runHook(home, "codex", {
      session_id: "reader",
      hook_event_name: "Stop",
      transcript_path: transcript,
    });
  await stop();
  const { stdout } = await cli(home, "evidence", "get", original.id);
  expect(stdout).toContain(original.content);
  const outputs = [stdout, "independentneedle 当前真实构建结果"];
  await writeFile(
    transcript,
    outputs
      .map((output) =>
        JSON.stringify({
          type: "response_item",
          payload: { type: "function_call_output", output },
          timestamp: at,
        }),
      )
      .join("\n") + "\n",
  );
  await stop();
  await store.drainSpool();
  await store.revise(
    memory.id,
    memory.revision,
    { status: "withdrawn" },
    memory.etag,
  );
  expect(await searchEvidence(store, { query: "replayneedle" })).toMatchObject({
    total: 0,
  });
  expect(
    await searchEvidence(store, { query: "independentneedle" }),
  ).toMatchObject({ total: 1 });
  // 即使宿主未在 hook 层过滤，公共入库入口也不能把它当作新证据。
  expect(store.ingest([event("direct-replay", stdout)])).toBe(0);
  const extract = vi.fn(async (events) => {
    expect(events).toHaveLength(1);
    expect(events[0].content).toContain("independentneedle");
    return { proposals: [] };
  });
  await new MemoryWorker(store, daemon.worker.config, extract).tick(true);
  expect(extract).toHaveBeenCalledOnce();
  expect(store.jobs()[0].state).toBe("done");
});

test("CLI 和 MCP 零结果查询不登记父目录，随后兄弟目录仍分属不同项目", async ({
  home,
  daemon,
}) => {
  const parent = join(home, "projects");
  const a = join(parent, "a");
  const b = join(parent, "b");
  await mkdir(a, { recursive: true });
  await mkdir(b);
  expect(
    JSON.parse(
      (await cli(home, "evidence", "search", "missing", "--cwd", parent))
        .stdout,
    ),
  ).toMatchObject({ total: 0 });
  expect(daemon.store.projects).toHaveLength(0);
  const server = createMcp(home);
  const mcp = new Client({ name: "scope-test", version: "1" });
  const [s, c] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(s);
    await mcp.connect(c);
    for (const tool of ["memory_evidence_search", "memory_search"]) {
      const result = await mcp.callTool({
        name: tool,
        arguments: { query: "missing", cwd: parent },
      });
      expect(result.isError).not.toBe(true);
    }
    expect(daemon.store.projects).toHaveLength(0);
    await new MemoryClient(home).request("/ingest", {
      method: "POST",
      body: [{ ...event("child", "siblingneedle"), cwd: a }],
    });
    expect(daemon.store.projects).toHaveLength(1);
    expect(
      JSON.parse(
        (await cli(home, "evidence", "search", "siblingneedle", "--cwd", b))
          .stdout,
      ),
    ).toMatchObject({ total: 0 });
    expect(daemon.store.projects).toHaveLength(1);
    expect(
      JSON.parse(
        (await cli(home, "evidence", "search", "siblingneedle", "--cwd", a))
          .stdout,
      ),
    ).toMatchObject({ total: 1 });
    const remembered = await mcp.callTool({
      name: "memory_remember",
      arguments: {
        title: "项目偏好",
        content: "明确创建项目记忆",
        scope: "project",
        cwd: b,
      },
    });
    expect(remembered.isError).not.toBe(true);
    expect(daemon.store.projects).toHaveLength(2);
  } finally {
    await mcp.close();
    await server.close();
  }
});

test("导入预览与确认输出不能重新成为工具证据", async ({ home, daemon }) => {
  const path = join(home, "import.md");
  await writeFile(path, "importreplayneedle 待核实的历史经验");
  const preview = (await cli(home, "import", path, "--dry-run")).stdout;
  const imported = (await cli(home, "import", path)).stdout;
  const [memory] = JSON.parse(imported);
  expect(memory.status).toBe("candidate");
  expect(preview).toContain("importreplayneedle");
  const transcript = join(home, "import-reader.jsonl");
  await writeFile(transcript, "");
  const stop = () =>
    runHook(home, "codex", {
      session_id: "import-reader",
      hook_event_name: "Stop",
      transcript_path: transcript,
    });
  await stop();
  await writeFile(
    transcript,
    [preview, imported]
      .map((output) =>
        JSON.stringify({
          type: "response_item",
          payload: { type: "function_call_output", output },
        }),
      )
      .join("\n") + "\n",
  );
  await stop();
  await daemon.store.drainSpool();
  await daemon.store.revise(
    memory.id,
    memory.revision,
    { status: "withdrawn" },
    memory.etag,
  );
  expect(
    await searchEvidence(daemon.store, { query: "importreplayneedle" }),
  ).toMatchObject({ total: 0 });
  expect(daemon.store.jobs()).toEqual([]);
});

test("合法长中文查询和任意来源 ID 经 CLI 与 MCP 可以完整往返", async ({
  home,
  daemon,
}) => {
  const ids = [".", "..", "source/中文 ?#%"];
  daemon.store.ingest(ids.map((id) => event(id, "长查询".repeat(700))));
  const query = "长".repeat(1850);
  expect(
    JSON.parse((await cli(home, "evidence", "search", query)).stdout),
  ).toHaveProperty("total");
  for (const id of ids) {
    expect(
      JSON.parse((await cli(home, "evidence", "get", id)).stdout),
    ).toMatchObject({ id, content: "长查询".repeat(700) });
  }
  const server = createMcp(home);
  const mcp = new Client({ name: "input-test", version: "1" });
  const [s, c] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(s);
    await mcp.connect(c);
    for (const args of [
      { name: "memory_evidence_search", arguments: { query } },
      ...ids.map((id) => ({ name: "memory_evidence_get", arguments: { id } })),
    ]) {
      const result = await mcp.callTool(args);
      expect(result.isError).not.toBe(true);
      expect(
        JSON.parse((result.content as { text: string }[])[0].text),
      ).toHaveProperty(
        args.name === "memory_evidence_search" ? "total" : "content",
      );
    }
  } finally {
    await mcp.close();
    await server.close();
  }
});

base(
  "一万条命中和两百条记忆下搜索及状态请求不超过默认客户端超时",
  async ({ home }) => {
    await configure(home);
    for (let i = 0; i < 200; i++) {
      await atomicWrite(
        join(home, "memories", "global", `m${i}.md`),
        encodeMemory(
          {
            id: `m${i}`,
            title: `构建约束 ${i}`,
            scope: "global",
            kind: "lesson",
            status: i % 2 ? "active" : "withdrawn",
            revision: 1,
            createdAt: at,
            updatedAt: at,
            sources: [
              {
                id: `event-${i}`,
                role: "tool",
                agent: "codex",
                at,
                excerpt: "Synthetic build evidence. ".repeat(80),
              },
            ],
          },
          "合成构建约束。".repeat(100),
        ),
      );
    }
    const store = await MemoryStore.open(home);
    try {
      store.ingest(
        Array.from({ length: 10000 }, (_, i) =>
          event(`event-${i}`, `loadneedle synthetic result ${i}`),
        ),
      );
    } finally {
      store.close();
    }
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("src/cli.ts"),
        "--home",
        home,
        "serve",
        "--no-worker",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await new Promise<void>((ready, reject) => {
        child.stdout.on("data", (data) => {
          if (data.toString().includes("Shared memory started:")) ready();
        });
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(new Error(`service exited: ${code}`)),
        );
      });
      const client = new MemoryClient(home);
      await client.request("/status");
      const started = performance.now();
      const search = cli(home, "evidence", "search", "loadneedle");
      // 客户端与服务分属不同进程，服务阻塞不会冻结客户端的超时计时器。
      const status = new Promise((r) => setTimeout(r, 250)).then(() =>
        client.request("/status"),
      );
      const results = await Promise.allSettled([search, status]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      const output = (
        results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof cli>>>
      ).value;
      expect(JSON.parse(output.stdout)).toMatchObject({ total: 9900 });
      console.info(
        `Evidence load regression: ${Math.round(performance.now() - started)}ms including CLI startup`,
      );
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
        await once(child, "exit");
        clearTimeout(kill);
      }
    }
  },
  30000,
);
