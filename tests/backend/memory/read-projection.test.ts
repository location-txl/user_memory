import { expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { test, addTestProject } from "../fixtures.js";
import { createApp } from "../../../src/server.js";
import {
  CreateMemorySchema,
  type MemoryEvent,
} from "../../../src/contracts.js";
import { fingerprint } from "../../../src/memory/files.js";

const headers = {
  Authorization: "Bearer projection-test",
  "Content-Type": "application/json",
};

test("旧 Markdown 凭据在详情、搜索、召回和历史出口脱敏且保留原始 etag", async ({
  store,
}) => {
  const memory = await store.create(
    CreateMemorySchema.parse({
      title: "读取投影",
      content: "body-placeholder",
      scope: "global",
      reason: "reason-placeholder",
      alwaysRecall: true,
      sources: [
        {
          id: "manual-source",
          agent: "manual",
          role: "manual",
          at: "2026-11-08",
          excerpt: "source-placeholder",
        },
      ],
    }),
  );
  const secret = "synthetic-invalid-read-secret";
  const original = (await readFile(memory.file, "utf8"))
    .replace("body-placeholder", `access_token=${secret}`)
    .replace("reason-placeholder", `password=${secret}`)
    .replace("source-placeholder", `secret=${secret}`);
  await writeFile(memory.file, original);
  const projected = await store.get(memory.id);
  expect(JSON.stringify(projected)).not.toContain(secret);
  expect(projected.etag).toBe(fingerprint(original));
  expect(await readFile(memory.file, "utf8")).toBe(original);
  const app = createApp(store, "projection-test");
  for (const [path, init] of [
    [`/v1/memories/${memory.id}`, {}],
    ["/v1/memories?q=读取", {}],
    [
      "/v1/recall",
      {
        method: "POST",
        body: JSON.stringify({
          query: "读取",
          agent: "manual",
          sessionId: "test",
        }),
      },
    ],
  ] as const) {
    const result = await app.request(`http://127.0.0.1${path}`, {
      ...init,
      headers,
    });
    expect(result.status).toBe(200);
    const text = await result.text();
    expect(text).not.toContain(secret);
    expect(text).toContain("<user-memory-context>");
  }
  await store.revise(
    memory.id,
    projected.revision,
    { title: "更新标题" },
    projected.etag,
  );
  const history = await store.history(memory.id);
  expect(history).toHaveLength(1);
  expect(JSON.stringify(history)).not.toContain(secret);
  expect(history[0].etag).toBe(fingerprint(original));
});

test("旧全局来源隐藏已知项目摘录与会话，但保留全局和手动来源", async ({
  store,
}) => {
  const project = await addTestProject(store, "private-project");
  const event: MemoryEvent = {
    id: "project-source",
    agent: "codex",
    role: "user",
    sessionId: "private-session",
    projectId: project.id,
    content: "private-project-text",
    at: "2026-11-08T00:00:00Z",
    injected: false,
    worker: false,
  };
  const global = {
    ...event,
    id: "global-source",
    projectId: undefined,
    sessionId: "global-session",
    content: "global-text",
  };
  store.ingest([event, global]);
  const source = (e: MemoryEvent) => ({
    id: e.id,
    agent: e.agent,
    role: e.role,
    sessionId: e.sessionId,
    at: e.at,
    excerpt: e.content,
  });
  const memory = await store.create(
    CreateMemorySchema.parse({
      title: "来源隔离",
      content: "可共享的偏好",
      scope: "global",
      sources: [
        { ...source(event), path: "/private/path" },
        source(global),
        {
          id: "manual-source",
          agent: "manual",
          role: "manual",
          at: event.at,
          excerpt: "manual-text",
        },
      ],
    }),
  );
  const raw = await readFile(memory.file, "utf8");
  expect(raw).toContain("private-project-text");
  expect(memory.sources[0]).toEqual({
    id: event.id,
    agent: event.agent,
    role: event.role,
    at: event.at,
    excerpt: "",
  });
  expect(memory.sources[1]).toEqual(source(global));
  expect(memory.sources[2].excerpt).toBe("manual-text");
  expect(memory.etag).toBe(fingerprint(raw));
  await store.revise(
    memory.id,
    memory.revision,
    { title: "更新来源隔离" },
    memory.etag,
  );
  const history = await store.history(memory.id);
  expect(history[0].sources[0].excerpt).toBe("");
  expect(history[0].sources[0].sessionId).toBeUndefined();
  expect(history[0].sources[0].path).toBeUndefined();
  const app = createApp(store, "projection-test");
  const result = await app.request(
    `http://127.0.0.1/v1/memories/${memory.id}`,
    { headers },
  );
  expect(result.status).toBe(200);
  expect(await result.text()).not.toContain("private-project-text");
});

test("补入原始项目事件后，即使 Markdown 未改也重新投影全局来源", async ({
  store,
}) => {
  const project = await addTestProject(store, "late-source-project");
  const event: MemoryEvent = {
    id: "late-project-source",
    agent: "codex",
    role: "user",
    sessionId: "late-private-session",
    projectId: project.id,
    content: "late-private-project-text",
    at: "2026-11-08T00:00:00Z",
    injected: false,
    worker: false,
  };
  const memory = await store.create(
    CreateMemorySchema.parse({
      title: "迟到来源",
      content: "可共享的偏好",
      scope: "global",
      sources: [
        {
          id: event.id,
          agent: event.agent,
          role: event.role,
          sessionId: event.sessionId,
          at: event.at,
          excerpt: event.content,
        },
      ],
    }),
  );
  const raw = await readFile(memory.file, "utf8");
  // Until the original event exists, preserve the legacy source for compatibility.
  expect((await store.get(memory.id)).sources[0].excerpt).toBe(event.content);
  expect(store.ingest([event])).toBe(1);
  const listed = await store.list();
  expect(listed[0].sources[0].excerpt).toBe("");
  expect(listed[0].sources[0].sessionId).toBeUndefined();
  expect((await store.get(memory.id)).sources[0].excerpt).toBe("");
  expect(await readFile(memory.file, "utf8")).toBe(raw);
  expect((await store.get(memory.id)).etag).toBe(fingerprint(raw));
});
