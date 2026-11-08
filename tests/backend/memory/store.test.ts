import { describe, expect } from "vitest";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  rename,
  readdir,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { test, addTestProject } from "../fixtures.js";
import { MemoryStore } from "../../../src/memory/store.js";
import { CreateMemorySchema } from "../../../src/contracts.js";
import { recall } from "../../../src/memory/recall.js";

const input = (content = "默认用中文沟通") =>
  CreateMemorySchema.parse({ title: "沟通语言", content, scope: "global" });

test("目录名称安全、同名项目独立且重启后固定", async ({ home, store }) => {
  expect((await readdir(join(home, "memories"))).sort()).toEqual([
    "global",
    "projects",
  ]);
  for (const [index, name, prefix] of [
    [0, " /中文 项目!?/ ", "中文-项目"],
    [1, " /中文 项目!?/ ", "中文-项目"],
    [2, "../!?", "project"],
    [3, "𠀀".repeat(50), "𠀀".repeat(48)],
  ] as const) {
    const root = join(home, `root-${index}`);
    await mkdir(root);
    const project = await store.addProject(root, name);
    expect(project.memoryDirectory).toBe(`${prefix}-${project.id}`);
  }
  expect(await readdir(join(home, "memories", "projects"))).toEqual([]);
  const project = store.projects[0];
  const memory = await store.create({
    ...input(),
    scope: "project",
    projectId: project.id,
  });
  expect(memory.file).toBe(
    join(
      home,
      "memories",
      "projects",
      project.memoryDirectory,
      `${memory.id}.md`,
    ),
  );
  const revised = await store.revise(
    memory.id,
    memory.revision,
    { content: "更新项目约定" },
    memory.etag,
  );
  expect(revised.file).toBe(memory.file);
  expect((await store.history(memory.id))[0].content).toBe(memory.content);
  const withdrawn = await store.revise(
    revised.id,
    revised.revision,
    { status: "withdrawn" },
    revised.etag,
  );
  expect(withdrawn.file).toBe(memory.file);
  expect((await store.history(memory.id)).map((m) => m.revision)).toEqual([
    1, 2,
  ]);
  const alias = join(home, "alias");
  await mkdir(alias);
  await store.addProject(alias, "new name", project.id);
  const directory = project.memoryDirectory;
  project.name = "renamed display";
  await store.addProject(alias, undefined, project.id);
  store.close();
  const reopened = await MemoryStore.open(home);
  try {
    expect((await reopened.resolveProject(alias))?.memoryDirectory).toBe(
      directory,
    );
    expect((await reopened.get(memory.id)).file).toBe(memory.file);
    expect(reopened.errors).toEqual([]);
  } finally {
    reopened.close();
  }
});

test("错放的记忆不加载，移回后恢复，删除后移出索引", async ({
  home,
  store,
}) => {
  const project = await addTestProject(store, "one");
  const other = await addTestProject(store, "two");
  const global = await store.create(input());
  const memory = await store.create({
    ...input("项目记忆"),
    scope: "project",
    projectId: project.id,
  });
  const otherDir = join(home, "memories", "projects", other.memoryDirectory);
  await mkdir(otherDir);
  const misplaced = join(otherDir, `${memory.id}.md`);
  await rename(memory.file, misplaced);
  await store.refresh();
  expect(store.errors).toHaveLength(1);
  expect(store.errors[0]).toContain("directory must match");
  expect(await store.list({ allProjects: true })).toEqual([global]);
  await rename(misplaced, memory.file);
  const misplacedGlobal = join(otherDir, `${global.id}.md`);
  await rename(global.file, misplacedGlobal);
  await store.refresh();
  expect(store.errors).toHaveLength(1);
  expect((await store.list({ allProjects: true })).map((m) => m.id)).toEqual([
    memory.id,
  ]);
  await rename(misplacedGlobal, global.file);
  await rm(memory.file);
  await store.refresh();
  expect(store.errors).toEqual([]);
  expect(await store.list({ allProjects: true })).toEqual([global]);
});

test("只扫描登记目录直属文件，不读取旧布局或未登记目录", async ({
  home,
  store,
}) => {
  const memory = await store.create(input());
  const raw = await readFile(memory.file, "utf8");
  await rm(memory.file);
  await mkdir(join(home, "memories", "global", "nested"));
  await mkdir(join(home, "memories", "projects", "unknown"));
  for (const directory of ["", "global/nested", "projects/unknown"])
    await writeFile(join(home, "memories", directory, `${memory.id}.md`), raw);
  expect(await store.list({ allProjects: true })).toEqual([]);
  expect(store.errors).toEqual([]);
});

test("真实 Git worktree 与主目录跨 Agent 共享项目及记忆", async ({
  home,
  store,
}) => {
  const run = promisify(execFile);
  const root = join(home, "repo");
  const worktree = join(home, "worktree");
  // 所有 Git 写入只发生在测试临时仓库，隔离个人 Git 配置与 hooks。
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  await run("git", ["init", root], { env });
  await run(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { env },
  );
  await run(
    "git",
    [
      "-C",
      root,
      "-c",
      "core.hooksPath=/dev/null",
      "worktree",
      "add",
      "--detach",
      worktree,
    ],
    { env },
  );
  const project = (await store.resolveProject(root, true))!;
  const shared = (await store.resolveProject(worktree, true))!;
  expect(shared.id).toBe(project.id);
  expect(shared.memoryDirectory).toBe(project.memoryDirectory);
  expect(store.projects).toHaveLength(1);
  const memory = await store.create({
    ...input(),
    scope: "project",
    projectId: shared.id,
  });
  for (const [agent, cwd] of [
    ["codex", root],
    ["zcode", worktree],
  ] as const) {
    const result = await recall(store, {
      agent,
      cwd,
      sessionId: agent,
      query: "默认用中文沟通",
    });
    expect(result.projectId).toBe(project.id);
    expect(result.memories.map((m) => m.id)).toContain(memory.id);
  }
  expect(
    (await recall(store, { agent: "codex", sessionId: "unbound", query: "" }))
      .memories,
  ).toEqual([]);
  const clone = join(home, "clone");
  await run("git", ["clone", root, clone], { env });
  expect((await store.resolveProject(clone, true))?.id).not.toBe(project.id);
});
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

test("同正文的用户确认会合并来源并将原候选转正", async ({ store }) => {
  const first = {
    id: "suggestion",
    agent: "codex" as const,
    role: "assistant" as const,
    at: "2026-11-07T00:00:00Z",
    excerpt: "可能偏好中文",
  };
  const confirm = {
    ...first,
    id: "confirmation",
    role: "user" as const,
    excerpt: "以后默认中文",
  };
  const original = await store.create({
    ...input(),
    status: "candidate",
    sources: [first],
  });
  const updated = await store.create({ ...input(), sources: [confirm] });
  expect(updated).toMatchObject({
    id: original.id,
    revision: 2,
    status: "active",
    sources: [first, confirm],
  });
  expect(await store.create({ ...input(), sources: [confirm] })).toEqual(
    updated,
  );
  expect(await store.history(original.id)).toMatchObject([
    { status: "candidate", sources: [first] },
  ]);
});

test("缺少目标的旧纠正候选不会被直接批准", async ({ store }) => {
  const original = await store.create(input());
  const candidate = await store.create({
    ...input("使用粤语"),
    status: "candidate",
    reason: "旧记忆已变化或证据不确定，请审核。",
  });
  await expect(
    store.revise(
      candidate.id,
      candidate.revision,
      { status: "active" },
      candidate.etag,
    ),
  ).rejects.toMatchObject({ code: "MEMORY_CORRECTION_TARGET_MISSING" });
  expect(await store.list({ status: "active" })).toEqual([original]);
});
