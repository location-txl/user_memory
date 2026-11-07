import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import { addTestProject, test } from "./fixtures.js";
import { CreateMemorySchema } from "../../src/contracts.js";
import { createMcp } from "../../src/mcp.js";
import { createApp } from "../../src/server.js";

afterEach(() => vi.restoreAllMocks());

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
    const scoped = { id, projectId: owner.id };
    const corrected = await call("memory_correct", {
      ...scoped,
      revision,
      etag,
      content: "项目修订正文",
    });
    expect(corrected.isError).not.toBe(true);
    const current = await store.get(id);
    expect(current).toMatchObject({ content: "项目修订正文", revision: 2 });
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
