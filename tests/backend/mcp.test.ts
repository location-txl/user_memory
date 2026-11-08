import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import { addTestProject, test } from "./fixtures.js";
import { CreateMemorySchema } from "../../src/contracts.js";
import { createMcp } from "../../src/mcp.js";
import { createApp } from "../../src/server.js";
import type { McpCallsPage } from "../../src/mcp-calls.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

afterEach(() => vi.restoreAllMocks());

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("MCP 限制项目读写，拒绝旧版纠正，撤回后只返回状态", async ({
  home,
  store,
}) => {
  const owner = await addTestProject(store, "owner");
  const other = await addTestProject(store, "other");
  const memory = await store.create(
    CreateMemorySchema.parse({
      title: "项目记忆",
      content: "项目私有正文",
      scope: "project",
      projectId: owner.id,
    }),
  );
  const token = (await readFile(join(home, "token"), "utf8")).trim();
  const app = createApp(store, token);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
    app.request(new Request(input, init)),
  );
  const server = createMcp(home, "codex");
  const client = new Client({ name: "test", version: "1" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { id, revision, etag } = memory;
    for (const scope of [{}, { projectId: other.id }]) {
      for (const [tool, args] of [
        ["memory_get", { id }],
        ["memory_correct", { id, revision, etag, content: "越界纠正" }],
        ["memory_forget", { id, revision, etag }],
      ] as const) {
        const result = await call(tool, { ...args, ...scope });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain(memory.content);
      }
    }
    expect(await store.get(id)).toEqual(memory);
    const source = {
      id: "user-correction",
      agent: "codex" as const,
      sessionId: "test-correction",
      projectId: owner.id,
      role: "user" as const,
      content: "请记住项目修订正文。",
      at: new Date().toISOString(),
      injected: false,
      worker: false,
    };
    store.ingest([
      source,
      { ...source, id: "foreign-correction", projectId: other.id },
    ]);
    const scoped = { id, projectId: owner.id };
    const foreign = await call("memory_correct", {
      ...scoped,
      revision,
      etag,
      content: "越界来源",
      sourceId: "foreign-correction",
    });
    expect(foreign.isError).toBe(true);
    const corrected = await call("memory_correct", {
      ...scoped,
      revision,
      etag,
      content: "项目修订正文",
      sourceId: source.id,
    });
    expect(corrected.isError).not.toBe(true);
    const current = await store.get(id);
    expect(current).toMatchObject({ content: "项目修订正文", revision: 2 });
    expect(current.sources.at(-1)).toMatchObject({
      id: source.id,
      role: "user",
      excerpt: source.content,
    });
    const global = await store.create(
      CreateMemorySchema.parse({
        title: "全局偏好",
        content: "默认采用旧约定",
        scope: "global",
      }),
    );
    expect(
      (
        await call("memory_correct", {
          projectId: owner.id,
          id: global.id,
          revision: global.revision,
          etag: global.etag,
          content: "默认采用新约定",
          sourceId: source.id,
        })
      ).isError,
    ).not.toBe(true);
    const globalRead = await call("memory_get", {
      id: global.id,
      projectId: other.id,
    });
    const globalRecord = JSON.parse(
      (globalRead.content as { text: string }[])[0].text,
    );
    expect(globalRecord.content).toBe("默认采用新约定");
    expect(globalRecord.sources.at(-1).id).toBe(source.id);
    expect(JSON.stringify(globalRecord)).not.toContain(source.content);
    expect(
      (
        await call("memory_evidence_get", {
          id: source.id,
          projectId: other.id,
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await call("memory_correct", {
          ...scoped,
          revision,
          etag,
          content: "旧版覆盖",
        })
      ).isError,
    ).toBe(true);
    expect(await store.get(id)).toEqual(current);

    const forgotten = await call("memory_forget", {
      ...scoped,
      revision: current.revision,
      etag: current.etag,
    });
    expect(forgotten.isError).not.toBe(true);
    const read = await call("memory_get", scoped);
    expect(read.isError).not.toBe(true);
    const [{ text }] = read.content as { text: string }[];
    expect(JSON.parse(text)).toEqual({
      _memoryContext: "<user-memory-context>",
      id,
      status: "withdrawn",
      revision: 3,
      message: expect.any(String),
    });
  } finally {
    try {
      await client.close();
    } finally {
      await server.close();
    }
  }
});

test("MCP 调用记录区分各状态，搜索只记录数量和字节", async ({
  home,
  store,
}) => {
  const keyword = "privatetelemetryneedle";
  const privateText = "调用日志不应留下这段正文";
  for (let i = 0; i < 13; i++) {
    await store.create(
      CreateMemorySchema.parse({
        title: `${keyword} ${i}`,
        content: `${privateText} ${i}`,
        scope: "global",
      }),
    );
  }
  const token = (await readFile(join(home, "token"), "utf8")).trim();
  const app = createApp(store, token);
  const searchStarted = deferred();
  const releaseSearch = deferred();
  const searchFinished = deferred();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).searchParams.get("q") !== "cancel-this")
      return app.request(request);
    searchStarted.resolve();
    await releaseSearch.promise;
    const response = await app.request(request);
    searchFinished.resolve();
    return response;
  });
  const getCalls = async () => {
    const response = await app.request("/v1/mcp-calls", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as McpCallsPage;
  };
  const server = createMcp(home, "codex");
  const client = new Client({ name: "test", version: "1" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools).toHaveLength(7);
    expect((await getCalls()).calls).toEqual([]);

    const results = await client.callTool({
      name: "memory_search",
      arguments: { query: keyword, cwd: home },
    });
    const text = (results.content as { text: string }[])[0].text;
    expect(text).toContain(privateText);
    const bytes = Buffer.byteLength(text);
    const empty = await client.callTool({
      name: "memory_search",
      arguments: { query: "nomatchfixture" },
    });
    const emptyBytes = Buffer.byteLength(
      (empty.content as { text: string }[])[0].text,
    );
    expect(
      (
        await client.callTool({
          name: "memory_search",
          arguments: { query: 42 },
        })
      ).isError,
    ).toBe(true);
    expect(
      (await client.callTool({ name: "private-unknown-tool", arguments: {} }))
        .isError,
    ).toBe(true);
    const protocolResponse = deferred<JSONRPCMessage>();
    const onmessage = clientTransport.onmessage;
    clientTransport.onmessage = (message, extra) => {
      if ("id" in message && message.id === "malformed")
        protocolResponse.resolve(message);
      else onmessage?.(message, extra);
    };
    await clientTransport.send({
      jsonrpc: "2.0",
      id: "malformed",
      method: "tools/call",
      params: { name: "memory_search", arguments: "private-malformed" },
    });
    expect(await protocolResponse.promise).toHaveProperty("error");

    const abort = new AbortController();
    const cancelled = client.callTool(
      { name: "memory_search", arguments: { query: "cancel-this" } },
      undefined,
      { signal: abort.signal },
    );
    await searchStarted.promise;
    expect(
      (
        await client.callTool({
          name: "memory_get",
          arguments: { id: "private-missing-id" },
        })
      ).isError,
    ).toBe(true);
    abort.abort(new Error("private-cancellation"));
    await expect(cancelled).rejects.toThrow("private-cancellation");
    releaseSearch.resolve();
    await searchFinished.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const page = await getCalls();
    expect(page.calls).toHaveLength(7);
    expect(page.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "memory_search",
          agent: "codex",
          outcome: "success",
          searchTotal: 13,
          searchReturned: 12,
          responseBytes: bytes,
        }),
        expect.objectContaining({
          tool: "memory_search",
          outcome: "success",
          searchTotal: 0,
          searchReturned: 0,
          responseBytes: emptyBytes,
        }),
        expect.objectContaining({
          tool: "memory_search",
          outcome: "rejected",
          responseBytes: null,
        }),
        expect.objectContaining({
          tool: "memory_search",
          outcome: "protocol_error",
        }),
        expect.objectContaining({
          tool: "memory_search",
          outcome: "cancelled",
          searchTotal: null,
        }),
        expect.objectContaining({ tool: "unknown", outcome: "rejected" }),
        expect.objectContaining({
          tool: "memory_get",
          outcome: "tool_error",
          errorCode: "MEMORY_NOT_FOUND",
        }),
      ]),
    );
    expect(page.summary[0]).toMatchObject({
      calls: 5,
      failures: 2,
      rejected: 1,
      cancelled: 1,
      emptySearches: 1,
      limitedSearches: 1,
      averageResponseBytes: Math.round((bytes + emptyBytes) / 2),
    });
    const secrets = [
      keyword,
      privateText,
      home,
      token,
      "private-unknown-tool",
      "private-missing-id",
      "private-malformed",
      "private-cancellation",
    ];
    await client.close();
    const persisted = await readFile(join(home, "mcp-calls.db"));
    for (const secret of secrets) {
      expect(JSON.stringify(page)).not.toContain(secret);
      expect(persisted.includes(secret)).toBe(false);
    }
  } finally {
    releaseSearch.resolve();
    await server.close();
  }
});

test("MCP 日志无法写入时仍返回原工具结果", async ({ home, store }) => {
  await mkdir(join(home, "mcp-calls.db"));
  const token = (await readFile(join(home, "token"), "utf8")).trim();
  const app = createApp(store, token);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
    app.request(new Request(input, init)),
  );
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const server = createMcp(home);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    expect(
      await client.callTool({
        name: "memory_search",
        arguments: { query: "no match" },
      }),
    ).toEqual({
      content: [
        {
          type: "text",
          text: '{"_memoryContext":"<user-memory-context>","projectId":null,"total":0,"results":[]}',
        },
      ],
    });
    expect(stderr.mock.calls).toEqual([
      ["[user-memory] Could not record MCP call."],
    ]);
    const unavailable = await app.request("/v1/mcp-calls", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      code: "MCP_CALL_LOG_UNAVAILABLE",
      error: "MCP call log is unavailable.",
    });
  } finally {
    await server.close();
  }
});
