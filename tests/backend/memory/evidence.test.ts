import { expect } from "vitest";
import { test, addTestProject, capturedEvents } from "../fixtures.js";
import {
  CreateMemorySchema,
  EventSchema,
  type MemoryEvent,
} from "../../../src/contracts.js";
import {
  collectEvidence,
  getEvidence,
  searchEvidence,
} from "../../../src/memory/evidence.js";
import { MemoryStore } from "../../../src/memory/store.js";

const event = (overrides: Partial<MemoryEvent> = {}) =>
  EventSchema.parse({
    id: "e1",
    agent: "codex",
    sessionId: "s1",
    role: "user",
    content: "构建 TypeScript 的经验",
    at: "2026-11-07T00:00:00Z",
    ...overrides,
  });
const source = (e: MemoryEvent) => ({
  id: e.id,
  agent: e.agent,
  sessionId: e.sessionId,
  role: e.role,
  at: e.at,
  excerpt: e.content.slice(0, 1000),
});

test("证据按中英文关键词检索，项目、宿主、会话过滤先于数量限制", async ({
  store,
}) => {
  const owner = await addTestProject(store, "owner");
  const other = await addTestProject(store, "other");
  const global = event();
  const local = event({
    id: "local",
    projectId: owner.id,
    agent: "pi",
    sessionId: "s2",
  });
  store.ingest([
    global,
    local,
    ...Array.from({ length: 20 }, (_, i) =>
      event({ id: `other-${i}`, projectId: other.id }),
    ),
    event({ id: "injected", injected: true }),
    event({ id: "worker", worker: true }),
  ]);
  store.ingest([global]);
  for (const query of ["构建", "TypeScript"]) {
    expect(await searchEvidence(store, { query })).toMatchObject({
      total: 1,
      results: [{ id: global.id }],
    });
    const found = await searchEvidence(store, { query, projectId: owner.id });
    expect(found.total).toBe(2);
    expect(found.results.map((r) => r.id).sort()).toEqual(
      [global.id, local.id].sort(),
    );
  }
  expect(
    await searchEvidence(store, {
      query: "构建",
      projectId: owner.id,
      agent: "pi",
      sessionId: "s2",
    }),
  ).toMatchObject({
    total: 1,
    results: [{ id: local.id, role: "user", at: local.at }],
  });
  for (const projectId of [undefined, other.id]) {
    await expect(getEvidence(store, local.id, projectId)).rejects.toMatchObject(
      { code: "EVIDENCE_NOT_FOUND" },
    );
  }
  expect(await getEvidence(store, local.id, owner.id)).toEqual(local);
  await expect(
    searchEvidence(store, { query: "构建", projectId: "missing" }),
  ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  expect(await searchEvidence(store, { query: '"*():-' })).toEqual({
    total: 0,
    results: [],
  });
});

test("有界摘录与完整采集事件区分，数量上限和凭据隐去保留", async ({
  store,
}) => {
  const secret = "sk-abcdefghijklmnopqrstuvwx";
  const long = event({
    content: `构建 ${secret} ${"说明".repeat(3000)} 仅适用于临时测试`,
  });
  store.ingest([
    long,
    ...Array.from({ length: 12 }, (_, i) => event({ id: `more-${i}` })),
  ]);
  expect(await searchEvidence(store, { query: "构建" })).toMatchObject({
    total: 13,
    results: expect.any(Array),
  });
  expect((await searchEvidence(store, { query: "构建" })).results).toHaveLength(
    12,
  );
  const found = await searchEvidence(store, { query: "临时测试" });
  expect(found.total).toBe(1);
  expect(found.results[0]).toMatchObject({ id: long.id, truncated: true });
  expect(found.results[0].excerpt).toHaveLength(1200);
  const read = await getEvidence(store, long.id);
  expect(read.content).toContain("仅适用于临时测试");
  expect(read.content).toContain("[已隐去凭据]");
  expect(JSON.stringify([read, found])).not.toContain(secret);
});

test("撤回记忆后旧来源不可搜索或读取，采集记录仍保留用于审计", async ({
  store,
}) => {
  const e = event();
  store.ingest([e]);
  const m = await store.create(
    CreateMemorySchema.parse({
      title: "构建约束",
      content: "旧约束",
      scope: "global",
      sources: [source(e)],
    }),
  );
  expect((await searchEvidence(store, { query: "构建" })).total).toBe(1);
  await store.revise(m.id, m.revision, { status: "withdrawn" }, m.etag);
  expect(await searchEvidence(store, { query: "构建" })).toEqual({
    total: 0,
    results: [],
  });
  await expect(getEvidence(store, e.id)).rejects.toMatchObject({
    status: 404,
    code: "EVIDENCE_NOT_FOUND",
  });
  expect(capturedEvents(store)).toEqual([e]);
  expect(await collectEvidence(store, [m])).toEqual({
    events: [],
    unavailableSourceIds: [e.id],
    omittedSourceIds: [],
  });
});

test("旧数据库首次回填事件索引，重启和重复采集不产生重复命中", async ({
  store,
  home,
}) => {
  const original = event();
  store.ingest([
    original,
    ...Array.from({ length: 205 }, (_, i) =>
      event({ id: `legacy-${i}`, content: `migrationmarker${i}` }),
    ),
  ]);
  store.db.exec("DROP TABLE event_fts");
  store.close();
  for (let i = 0; i < 2; i++) {
    const reopened = await MemoryStore.open(home);
    try {
      expect(
        await searchEvidence(reopened, { query: "TypeScript" }),
      ).toMatchObject({ total: i === 0 ? 1 : 2 });
      expect(
        await searchEvidence(reopened, { query: "migrationmarker204" }),
      ).toMatchObject({ total: 1, results: [{ id: "legacy-204" }] });
      reopened.ingest([original, event({ id: "new" })]);
      expect(
        (await searchEvidence(reopened, { query: "TypeScript" })).total,
      ).toBe(2);
      expect(capturedEvents(reopened)).toHaveLength(207);
    } finally {
      reopened.close();
    }
  }
});

test("旧证据原文按预算完整装入、去重，缺失与超预算分别标注", async ({
  store,
}) => {
  const large = event({
    id: "large",
    content: `构建 ${"长".repeat(31000)} 最后限定条件`,
  });
  const omitted = event({ id: "omitted", content: "长".repeat(31000) });
  const short = event({ id: "short" });
  store.ingest([large, omitted, short]);
  const m = await store.create(
    CreateMemorySchema.parse({
      title: "构建经验",
      content: "内容",
      scope: "global",
      sources: [source(short), source(omitted), source(large)],
    }),
  );
  const missing = { ...m, sources: [source(event({ id: "not-captured" }))] };
  const bundle = await collectEvidence(store, [m, m, missing]);
  expect(bundle.events).toEqual([large, short]);
  expect(JSON.stringify(bundle.events).length).toBeLessThanOrEqual(48000);
  expect(bundle.omittedSourceIds).toEqual([omitted.id]);
  expect(bundle.unavailableSourceIds).toEqual(["not-captured"]);
  expect(m.sources[2].excerpt).not.toContain("最后限定条件");
  expect(bundle.events[0].content).toContain("最后限定条件");
});

test("全局记忆引用项目来源不会扩展原始证据的可读范围", async ({ store }) => {
  const project = await addTestProject(store, "private");
  const e = event({ projectId: project.id });
  store.ingest([e]);
  const m = await store.create(
    CreateMemorySchema.parse({
      title: "跨项目偏好",
      content: "全局适用的偏好",
      scope: "global",
      sources: [source(e)],
    }),
  );
  expect(await collectEvidence(store, [m])).toMatchObject({
    events: [],
    unavailableSourceIds: [e.id],
  });
  expect(await collectEvidence(store, [m], project.id)).toMatchObject({
    events: [e],
    unavailableSourceIds: [],
  });
});

test("已有索引会补齐旧版写入的事件，索引中间的缺口也能恢复", async ({
  home,
  store,
}) => {
  store.ingest([event()]);
  const legacy = event({ id: "legacy-gap", content: "gapneedle 旧版采集" });
  store.db
    .prepare(
      "INSERT INTO events(id,agent,session_id,project_id,data) VALUES (?,?,?,?,?)",
    )
    .run(
      legacy.id,
      legacy.agent,
      legacy.sessionId,
      null,
      JSON.stringify(legacy),
    );
  store.ingest([event({ id: "newer", content: "newneedle 新版采集" })]);
  expect(await getEvidence(store, legacy.id)).toEqual(legacy);
  store.close();
  const reopened = await MemoryStore.open(home);
  try {
    expect(
      await searchEvidence(reopened, { query: "gapneedle" }),
    ).toMatchObject({ total: 1, results: [{ id: legacy.id }] });
    expect(
      await searchEvidence(reopened, { query: "newneedle" }),
    ).toMatchObject({ total: 1 });
  } finally {
    reopened.close();
  }
});

test.for(["plain", "wrapped"])(
  "旧库凭据在详情、搜索和提炼证据出口重新脱敏：%s",
  async (format, { store }) => {
    const secret = "synthetic-legacy-oauth-value";
    const payload = JSON.stringify({
      access_token: secret,
      result: "正常结果",
    });
    const e = event({
      content: `legacysecret ${format === "wrapped" ? JSON.stringify({ output: payload }) : payload}`,
    });
    store.ingest([e]);
    // 模拟旧版已落盘的未脱敏事件，而不是依赖新版入库行为。
    store.db
      .prepare("UPDATE events SET data=? WHERE id=?")
      .run(JSON.stringify(e), e.id);
    expect(
      store.db.prepare("SELECT data FROM events WHERE id=?").pluck().get(e.id),
    ).toContain(secret);
    const m = await store.create(
      CreateMemorySchema.parse({
        title: "历史来源",
        content: "正常结果",
        scope: "global",
        sources: [source(e)],
      }),
    );
    const outputs = [
      await getEvidence(store, e.id),
      await searchEvidence(store, { query: "legacysecret" }),
      await collectEvidence(store, [m]),
    ];
    for (const output of outputs) {
      expect(JSON.stringify(output)).toContain("正常结果");
      expect(JSON.stringify(output)).not.toContain(secret);
      expect(JSON.stringify(output)).toContain("已隐去凭据");
    }
  },
);
