import { describe, expect } from "vitest";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test, addTestProject } from "../fixtures.js";
import { MemoryStore } from "../../../src/memory/store.js";
import { CreateMemorySchema } from "../../../src/contracts.js";

const input = (content = "默认用中文沟通") =>
  CreateMemorySchema.parse({ title: "沟通语言", content, scope: "global" });
describe("Markdown 是事实源", () => {
  test("手动修改立即改变查询结果，删除数据库仍可恢复记忆", async ({
    home,
    store,
  }) => {
    const memory = await store.create(input());
    const raw = await readFile(memory.file, "utf8");
    await writeFile(
      memory.file,
      raw.replace("默认用中文沟通", "默认使用粤语交流"),
    );
    expect((await store.list({ query: "粤语" })).map((m) => m.id)).toEqual([
      memory.id,
    ]);
    expect((await store.get(memory.id)).etag).not.toBe(memory.etag);
    store.close();
    await rm(join(home, "runtime.db"));
    const reopened = await MemoryStore.open(home);
    try {
      expect((await reopened.get(memory.id)).content).toBe("默认使用粤语交流");
    } finally {
      reopened.close();
    }
  });
  test("同时纠正只接受一个版本，保留上一版原文", async ({ store }) => {
    const m = await store.create(input());
    const results = await Promise.allSettled([
      store.revise(m.id, m.revision, { content: "偏好中文" }, m.etag),
      store.revise(m.id, m.revision, { content: "偏好英文" }, m.etag),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect((await store.history(m.id))[0].content).toBe(m.content);
    expect((await store.get(m.id)).revision).toBe(2);
  });
  test("手工编辑未改 revision 也不能被旧客户端覆盖", async ({ store }) => {
    const m = await store.create(input());
    await writeFile(
      m.file,
      (await readFile(m.file, "utf8")).replace(m.content, "优先使用中文"),
    );
    await expect(
      store.revise(m.id, 1, { content: "旧页面的修改" }, m.etag),
    ).rejects.toMatchObject({ status: 409 });
  });
  test("无效文件保留并报告，恢复格式后自动重建", async ({ store }) => {
    const m = await store.create(input());
    const raw = await readFile(m.file, "utf8");
    await writeFile(m.file, "无效格式");
    expect(await store.list()).toEqual([]);
    expect(store.errors.length).toBe(1);
    expect(await readFile(m.file, "utf8")).toBe("无效格式");
    await writeFile(m.file, raw);
    expect((await store.list()).length).toBe(1);
    expect(store.errors).toEqual([]);
  });
  test("保留存量记忆的脱敏标记，达到标题上限时仍可撤回", async ({ store }) => {
    const prefix = "x".repeat(143) + " password=";
    const title = prefix + "[已隐去凭据]";
    const saved = await store.create(input());
    const raw = await readFile(saved.file, "utf8");
    await writeFile(saved.file, raw.replace(saved.title, title));

    const existing = await store.get(saved.id);
    expect(existing.title).toHaveLength(160);
    const withdrawn = await store.revise(
      existing.id,
      existing.revision,
      { status: "withdrawn" },
      existing.etag,
    );
    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn.title).toBe(title);
    expect((await store.history(existing.id))[0].title).toBe(title);
    const created = await store.create({
      ...input("另一条记忆"),
      title: prefix + "example",
    });
    expect(created.title).toBe(title);
  });
});

test("项目目录别名对应同一份记忆", async ({ home, store }) => {
  await mkdir(join(home, "one"));
  await mkdir(join(home, "two"));
  const p = await store.addProject(join(home, "one"));
  await store.addProject(join(home, "two"), undefined, p.id);
  expect((await store.resolveProject(join(home, "two")))?.id).toBe(p.id);
});

test("相同范围内按正文去重，其他项目与全局有独立记录", async ({ store }) => {
  const one = await addTestProject(store, "one");
  const two = await addTestProject(store, "two");
  const global = await store.create(input());
  const project = { ...input(), scope: "project" as const, projectId: one.id };
  const first = await store.create(project);
  const duplicate = await store.create({
    ...project,
    title: "另外的标题",
    content: ` ${project.content} `,
  });
  const second = await store.create({ ...project, projectId: two.id });
  expect(duplicate.id).toBe(first.id);
  expect(new Set([global.id, first.id, second.id]).size).toBe(3);
  expect((await store.list({ projectId: one.id })).map((m) => m.id)).toEqual(
    expect.arrayContaining([global.id, first.id]),
  );
  expect(await store.list({ projectId: one.id })).toHaveLength(2);
});

test("用最新版本也不能修改或重新激活已撤回的记忆", async ({ store }) => {
  const memory = await store.create(input());
  const withdrawn = await store.revise(
    memory.id,
    memory.revision,
    { status: "withdrawn" },
    memory.etag,
  );
  await expect(
    store.revise(
      memory.id,
      withdrawn.revision,
      { status: "active", content: "试图恢复" },
      withdrawn.etag,
    ),
  ).rejects.toMatchObject({ status: 409, code: "MEMORY_WITHDRAWN" });
  expect(await store.get(memory.id)).toEqual(withdrawn);
  expect((await store.history(memory.id)).map((m) => m.revision)).toEqual([1]);
});
