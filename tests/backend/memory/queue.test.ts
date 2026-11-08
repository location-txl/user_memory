import { expect } from "vitest";
import Database from "better-sqlite3";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addTestProject, capturedEvents, test } from "../fixtures.js";
import { EventSchema, type MemoryEvent } from "../../../src/contracts.js";
import { initHome } from "../../../src/config.js";
import { MemoryStore } from "../../../src/memory/store.js";

const event = (id: string, changes: Partial<MemoryEvent> = {}) =>
  EventSchema.parse({
    id,
    agent: "codex",
    sessionId: "session-a",
    role: "user",
    turnId: "t1",
    content: "长期偏好",
    at: "2026-11-07T00:00:00.000Z",
    ...changes,
  });

test("仅 Agent、会话和项目都一致的事件合并到同一待处理任务", async ({
  store,
}) => {
  const one = await addTestProject(store, "one");
  const two = await addTestProject(store, "two");
  expect(
    store.ingest([
      event("one", { projectId: one.id }),
      event("two", { projectId: one.id }),
      event("another-agent", { projectId: one.id, agent: "pi" }),
      event("another-session", { projectId: one.id, sessionId: "session-b" }),
      event("another-project", { projectId: two.id }),
      event("unbound"),
    ]),
  ).toBe(6);
  expect(store.jobs()).toHaveLength(0);
  for (const id of [
    "one",
    "another-agent",
    "another-session",
    "another-project",
    "unbound",
  ]) {
    const item = capturedEvents(store).find((e) => e.id === id)!;
    store.ingest([], {
      agent: item.agent,
      sessionId: item.sessionId,
      projectId: item.projectId,
      turnId: "t1",
      at: item.at,
    });
  }
  expect(store.jobs()).toHaveLength(5);
  expect(store.jobs().every((job) => job.state === "pending")).toBe(true);
  expect(
    store.jobs().map((job) => store.events(job.id).map((e) => e.id)),
  ).toEqual(
    expect.arrayContaining([
      ["one", "two"],
      ["another-agent"],
      ["another-session"],
      ["another-project"],
      ["unbound"],
    ]),
  );
});

test("批内未知项目会回滚此前写入的事件、任务和采集回执", async ({ store }) => {
  const valid = event("valid");
  expect(() =>
    store.ingest([valid, event("invalid", { projectId: "unknown" })]),
  ).toThrow(expect.objectContaining({ code: "PROJECT_NOT_FOUND" }));
  expect(store.jobs()).toEqual([]);
  expect(store.status().receipts).toEqual([]);
  expect(store.ingest([valid])).toBe(1);
  expect(capturedEvents(store)).toEqual([valid]);
});

test("损坏的 spool 保留原文并报告，有效事件消费后移除文件", async ({
  store,
  home,
}) => {
  const spool = join(home, "spool");
  await writeFile(join(spool, "broken.json"), "{");
  await writeFile(join(spool, "valid.json"), JSON.stringify([event("valid")]));
  await store.drainSpool();
  expect(await readdir(spool)).toEqual(["broken.json"]);
  expect(await readFile(join(spool, "broken.json"), "utf8")).toBe("{");
  expect(store.status().errors).toEqual([
    expect.stringContaining("broken.json"),
  ]);
  expect(capturedEvents(store).map((e) => e.id)).toEqual(["valid"]);
});

test("旧数据库的未收尾任务升级后跳过，原始证据仍可读", async ({ home }) => {
  await initHome(home);
  const legacy = new Database(join(home, "runtime.db"));
  legacy.exec(
    "CREATE TABLE jobs (id INTEGER PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL, project_id TEXT, state TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL);" +
      "CREATE TABLE events (id TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL, project_id TEXT, data TEXT NOT NULL, job_id INTEGER);",
  );
  const original = event("legacy", { turnId: undefined });
  legacy
    .prepare(
      "INSERT INTO jobs VALUES (1, 'codex', 'session-a', NULL, 'pending', NULL, ?)",
    )
    .run(original.at);
  legacy
    .prepare(
      "INSERT INTO jobs VALUES (2, 'codex', 'session-b', NULL, 'failed', 'model offline', ?)",
    )
    .run(original.at);
  legacy
    .prepare("INSERT INTO events VALUES (?, 'codex', 'session-a', NULL, ?, 1)")
    .run(original.id, JSON.stringify(original));
  legacy.close();

  const upgraded = await MemoryStore.open(home);
  try {
    expect(upgraded.jobs()).toMatchObject([
      { state: "skipped", turn_id: null },
      { state: "skipped", turn_id: null },
    ]);
    expect(upgraded.events(1)).toEqual([original]);
    expect(upgraded.retry(1)).toBe(0);
    expect(upgraded.retry(2)).toBe(0);
  } finally {
    upgraded.close();
  }
});
