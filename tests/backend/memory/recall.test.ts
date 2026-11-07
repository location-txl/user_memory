import { describe, expect } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, addTestProject } from "../fixtures.js";
import { CreateMemorySchema, RecallSchema } from "../../../src/contracts.js";
import { recall } from "../../../src/memory/recall.js";

const input = (content = "默认用中文沟通") =>
  CreateMemorySchema.parse({ title: "沟通语言", content, scope: "global" });
describe("范围、召回与撤回", () => {
  test("长记忆只提供索引和完整读取提示，避免遗漏末尾条件", async ({
    store,
  }) => {
    const m = await store.create(input("很长的偏好说明。".repeat(1000)));
    const result = await recall(store, RecallSchema.parse({}));
    expect(result.memories[0]).toMatchObject({ id: m.id, delivery: "index" });
    expect(result.context).not.toContain("很长的偏好说明");
    expect(result.context).toContain("memory_get");
    expect(result.context.length).toBeLessThan(6000);
  });
  test("全局和当前项目可以召回，其他项目及待审核不能泄漏", async ({
    home,
    store,
  }) => {
    const roots = [join(home, "p1"), join(home, "p2")];
    await Promise.all(roots.map((p) => mkdir(p)));
    const [a, b] = await Promise.all(roots.map((p) => store.addProject(p)));
    const global = await store.create(input());
    const local = await store.create(
      CreateMemorySchema.parse({
        title: "技术约束",
        content: "项目使用 TypeScript",
        scope: "project",
        projectId: a.id,
        kind: "constraint",
      }),
    );
    await store.create(
      CreateMemorySchema.parse({
        title: "秘密项目",
        content: "另一个项目采用 Kotlin",
        scope: "project",
        projectId: b.id,
      }),
    );
    await store.create(
      CreateMemorySchema.parse({
        ...input("候选内容不能注入"),
        status: "candidate",
      }),
    );
    const result = await recall(
      store,
      RecallSchema.parse({ cwd: roots[0], query: "TypeScript Kotlin" }),
    );
    expect(result.memories.map((m) => m.id).sort()).toEqual(
      [global.id, local.id].sort(),
    );
    expect(result.context).not.toContain("Kotlin");
    expect(result.context).not.toContain("候选内容");
  });
  test("同一会话下次召回提供纠正和撤回通知", async ({ store }) => {
    let m = await store.create(input());
    const request = RecallSchema.parse({ sessionId: "s" });
    await recall(store, request);
    m = await store.revise(
      m.id,
      m.revision,
      { content: "改为粤语交流" },
      m.etag,
    );
    const updated = await recall(store, request);
    expect(updated.changes.join()).toContain("已更新");
    expect(updated.context).toContain("粤语");
    await store.revise(m.id, m.revision, { status: "withdrawn" }, m.etag);
    const withdrawn = await recall(store, request);
    expect(withdrawn.changes.join()).toContain("已撤回");
    expect(withdrawn.context).not.toContain("粤语");
    expect((await recall(store, request)).changes).toEqual([]);
  });
  test("集中更新保留所有索引，并将完整上下文限制在预算内", async ({
    store,
  }) => {
    const request = RecallSchema.parse({ sessionId: "budget" });
    const records = [];
    for (let i = 0; i < 4; i++) {
      records.push(await store.create(input(`旧偏好 ${i}`)));
    }
    expect((await recall(store, request)).memories).toHaveLength(4);
    for (const [i, record] of records.entries()) {
      await store.revise(
        record.id,
        record.revision,
        { content: `${i}${"x".repeat(1434)}` },
        record.etag,
      );
    }
    const updated = await recall(store, request);
    expect(updated.memories).toHaveLength(4);
    expect(updated.context.length).toBeLessThanOrEqual(6000);
    expect(updated.memories.some((m) => m.delivery === "index")).toBe(true);
    expect((await recall(store, request)).changes).toEqual([]);
    for (const record of records) {
      expect(updated.context).toContain(`【${record.id} r2，全局】`);
      expect(updated.changes).toContain(
        `记忆 ${record.id} 已更新，此前版本已失效。以下若仅有索引，须先用 memory_get 读取新版。`,
      );
    }
  });
});

test("关键词检索兼顾中英文，无项目时只召回全局且同一条只注入一次", async ({
  store,
}) => {
  const project = await addTestProject(store, "project");
  const global = await store.create(input("使用 TypeScript 开发"));
  const local = await store.create({
    ...input("使用 TypeScript 开发"),
    scope: "project",
    projectId: project.id,
  });
  for (const query of ["TypeScript", "开发"]) {
    expect((await store.list({ query })).map((m) => m.id)).toEqual([global.id]);
    const result = await recall(store, RecallSchema.parse({ query }));
    expect(result.memories.map((m) => m.id)).toEqual([global.id]);
    expect(result.context.split(`【${global.id} `)).toHaveLength(2);
    expect(result.context).not.toContain(local.id);
  }
});

test("纠正与撤回通知只发给收到旧版的 Agent、会话和项目组合", async ({
  store,
}) => {
  const a = await addTestProject(store, "a");
  const b = await addTestProject(store, "b");
  const seen = RecallSchema.parse({
    agent: "codex",
    sessionId: "s",
    projectId: a.id,
  });
  const unseen = [
    { ...seen, sessionId: "another" },
    { ...seen, agent: "pi" as const },
    { ...seen, projectId: b.id },
  ];
  const original = await store.create(input());
  await recall(store, seen);
  await store.revise(
    original.id,
    original.revision,
    { content: "改用粤语" },
    original.etag,
  );
  expect((await recall(store, seen)).changes).toEqual([
    expect.stringContaining("已更新"),
  ]);
  for (const request of unseen) {
    expect((await recall(store, request)).changes).toEqual([]);
  }

  // 使用另一条仅已知组合收到的记录，独立验证撤回通知。
  const privateMemory = await store.create({
    ...input("项目内专用词"),
    scope: "project",
    projectId: a.id,
    kind: "decision",
  });
  await recall(store, { ...seen, query: "专用词" });
  await store.revise(
    privateMemory.id,
    privateMemory.revision,
    { status: "withdrawn" },
    privateMemory.etag,
  );
  expect((await recall(store, seen)).changes).toEqual([
    expect.stringContaining(privateMemory.id),
  ]);
  for (const request of unseen) {
    expect((await recall(store, request)).changes).toEqual([]);
  }
});

test("长正文不会挤掉其他偏好，索引不包含未经完整读取的正文", async ({
  store,
}) => {
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const m = await store.create({
      ...input(`${i} ${"详细规则".repeat(600)} 仅适用于演练环境`),
      title: `规则 ${i}`,
    });
    ids.push(m.id);
  }
  const result = await recall(store, RecallSchema.parse({}));
  expect(result.context.length).toBeLessThanOrEqual(6000);
  expect(result.memories.map((m) => m.id).sort()).toEqual(ids.sort());
  expect(result.memories.every((m) => m.delivery === "index")).toBe(true);
  expect(result.context).not.toContain("详细规则");
});

test("超预算的撤回通知不会被提前确认，下次召回继续发送", async ({ store }) => {
  const previous = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [
      `removed-${i}-${"x".repeat(60)}`,
      "old-etag",
    ]),
  );
  store.db
    .prepare("INSERT INTO recalls VALUES (?, ?)")
    .run("manual:withdrawals:global", JSON.stringify(previous));
  const request = RecallSchema.parse({ sessionId: "withdrawals" });
  const delivered = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const result = await recall(store, request);
    expect(result.context.length).toBeLessThanOrEqual(6000);
    if (i === 0) expect(result.changes.length).toBeLessThan(100);
    for (const change of result.changes) {
      expect(delivered.has(change)).toBe(false);
      delivered.add(change);
    }
  }
  expect(delivered.size).toBe(100);
  expect((await recall(store, request)).changes).toEqual([]);
});

test("空白查询不会把不相关的决策注入上下文", async ({ store }) => {
  await store.create({ ...input("部署决策"), kind: "decision" });
  expect(
    (await recall(store, RecallSchema.parse({ query: "  " }))).context,
  ).toBe("");
});

test("大量更新分批通知，每条都失效旧正文且不丢失后续更新", async ({
  store,
}) => {
  const previous: Record<string, string> = {};
  for (let i = 0; i < 30; i++) {
    const m = await store.create({
      ...input(`${i} ${"新版条件".repeat(500)}`),
      title: `${i} ${"条件".repeat(70)}`,
      kind: "decision",
    });
    previous[m.id] = "previous-version";
  }
  store.db
    .prepare("INSERT INTO recalls VALUES (?, ?)")
    .run("manual:updates:global", JSON.stringify(previous));
  const request = RecallSchema.parse({ sessionId: "updates" });
  const notified = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const result = await recall(store, request);
    expect(result.context.length).toBeLessThanOrEqual(6000);
    expect(result.changes).toHaveLength(result.memories.length);
    if (i === 0) expect(result.memories.length).toBeLessThan(30);
    for (const m of result.memories) {
      expect(notified.has(m.id)).toBe(false);
      expect(m.delivery).toBe("index");
      expect(result.changes).toContainEqual(
        expect.stringContaining(`记忆 ${m.id} 已更新，此前版本已失效`),
      );
      notified.add(m.id);
    }
  }
  expect(notified.size).toBe(30);
  expect((await recall(store, request)).changes).toEqual([]);
});
