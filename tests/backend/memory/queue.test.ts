import { expect } from "vitest";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addTestProject, test } from "../fixtures.js";
import { EventSchema, type MemoryEvent } from "../../../src/contracts.js";

const event = (id: string, changes: Partial<MemoryEvent> = {}) =>
  EventSchema.parse({
    id,
    agent: "codex",
    sessionId: "session-a",
    role: "user",
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
  expect(store.events(store.jobs()[0].id)).toEqual([valid]);
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
  expect(store.events(store.jobs()[0].id).map((e) => e.id)).toEqual(["valid"]);
});
