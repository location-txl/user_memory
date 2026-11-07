import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory/store.js";
import { CreateMemorySchema, RecallSchema } from "../src/contracts.js";
import { recall } from "../src/memory/recall.js";
import { initHome } from "../src/config.js";
import { importFiles, previewImport } from "../src/integrations/import.js";

let home: string;
let store: MemoryStore;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "umem-core-"));
  store = await MemoryStore.open(home);
});
afterEach(async () => {
  store.close();
  await rm(home, { recursive: true, force: true });
});
const input = (content = "默认用中文沟通") =>
  CreateMemorySchema.parse({ title: "沟通语言", content, scope: "global" });
describe("Markdown 是事实源", () => {
  test("手动修改立即改变查询结果，删除数据库仍可恢复记忆", async () => {
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
    store = await MemoryStore.open(home);
    expect((await store.get(memory.id)).content).toBe("默认使用粤语交流");
  });
  test("同时纠正只接受一个版本，保留上一版原文", async () => {
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
  test("手工编辑未改 revision 也不能被旧客户端覆盖", async () => {
    const m = await store.create(input());
    await writeFile(
      m.file,
      (await readFile(m.file, "utf8")).replace(m.content, "优先使用中文"),
    );
    await expect(
      store.revise(m.id, 1, { content: "旧页面的修改" }, m.etag),
    ).rejects.toMatchObject({ status: 409 });
  });
  test("无效文件保留并报告，恢复格式后自动重建", async () => {
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
  test("并发初始化不替换访问密钥或读取半写配置", async () => {
    const fresh = join(home, "fresh");
    await Promise.all(Array.from({ length: 30 }, () => initHome(fresh)));
    const token = await readFile(join(fresh, "token"), "utf8");
    await initHome(fresh);
    expect(await readFile(join(fresh, "token"), "utf8")).toBe(token);
    expect(token).toHaveLength(64);
  });
});
describe("范围、召回与撤回", () => {
  test("长记忆有摘录和完整读取提示，不会因超预算完全消失", async () => {
    const m = await store.create(input("很长的偏好说明。".repeat(1000)));
    const result = await recall(store, RecallSchema.parse({}));
    expect(result.memories[0].id).toBe(m.id);
    expect(result.context).toContain("memory_get");
    expect(result.context.length).toBeLessThan(6000);
  });
  test("全局和当前项目可以召回，其他项目及待审核不能泄漏", async () => {
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
  test("同一会话下次召回提供纠正和撤回通知", async () => {
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
  test("保留存量记忆的脱敏标记，达到标题上限时仍可撤回", async () => {
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
  test("四条在原有预算内的记忆更新会一并附上新版正文", async () => {
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
    for (const record of records) {
      expect(updated.context).toContain(`【${record.id} r2，全局】`);
      expect(updated.changes).toContain(
        `记忆 ${record.id} 已更新，以下新版本替代此前版本。`,
      );
    }
  });
  test("项目目录别名对应同一份记忆", async () => {
    await mkdir(join(home, "one"));
    await mkdir(join(home, "two"));
    const p = await store.addProject(join(home, "one"));
    await store.addProject(join(home, "two"), undefined, p.id);
    expect((await store.resolveProject(join(home, "two")))?.id).toBe(p.id);
  });
});
test("导入需匹配预览指纹；候选批准后生效，撤回后重复导入不复活", async () => {
  const path = join(home, "original.md");
  await writeFile(path, "我长期使用中文");
  const preview = await previewImport(path);
  await writeFile(path, "内容已改");
  await expect(importFiles(store, preview, "global")).rejects.toMatchObject({
    status: 409,
  });
  const latest = await previewImport(path);
  const [m] = await importFiles(store, latest, "global");
  expect(m.status).toBe("candidate");
  expect(
    (await recall(store, RecallSchema.parse({ query: "内容" }))).memories,
  ).toEqual([]);
  await store.revise(m.id, m.revision, { status: "withdrawn" }, m.etag);
  expect((await importFiles(store, latest, "global"))[0].status).toBe(
    "withdrawn",
  );
  expect(await readFile(path, "utf8")).toBe("内容已改");
});
