import { afterEach, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { test, addTestProject } from "../fixtures.js";
import { MemoryStore } from "../../../src/memory/store.js";
import { MemoryWorker } from "../../../src/memory/worker.js";
import { ConfigSchema } from "../../../src/config.js";
import {
  CreateMemorySchema,
  EventSchema,
  type Proposal,
} from "../../../src/contracts.js";

afterEach(() => vi.useRealTimers());

const event = (data: Partial<ReturnType<typeof EventSchema.parse>> = {}) =>
  EventSchema.parse({
    id: "e1",
    agent: "codex",
    sessionId: "s1",
    role: "user",
    content: "我习惯使用 TypeScript",
    at: new Date().toISOString(),
    ...data,
  });
const proposal = (data: Partial<Proposal> = {}): Proposal => ({
  action: "add",
  targetId: null,
  expectedRevision: null,
  title: "开发语言",
  content: "偏好使用 TypeScript",
  scope: "global",
  kind: "preference",
  sourceIds: ["e1"],
  certainty: "supported",
  reason: "用户明确说明",
  ...data,
});
const config = ConfigSchema.parse({ idleSeconds: 0 });
test("事件去重，排除注入和 worker；有效用户证据自动保存", async ({ store }) => {
  expect(
    store.ingest([
      event(),
      event(),
      event({ id: "e2", injected: true }),
      event({ id: "e3", worker: true }),
    ]),
  ).toBe(1);
  const worker = new MemoryWorker(store, config, async () => ({
    proposals: [proposal()],
  }));
  await worker.tick(true);
  expect(store.jobs()[0].state).toBe("done");
  const [m] = await store.list();
  expect(m.status).toBe("active");
  expect(m.sources[0].id).toBe("e1");
});
test("助手独自声称的偏好只进入候选；伪造证据让任务失败", async ({ store }) => {
  store.ingest([event({ role: "assistant" })]);
  await new MemoryWorker(store, config, async () => ({
    proposals: [proposal()],
  })).tick(true);
  expect((await store.list())[0].status).toBe("candidate");
  store.ingest([event({ id: "e2" })]);
  await new MemoryWorker(store, config, async () => ({
    proposals: [proposal({ sourceIds: ["does-not-exist"] })],
  })).tick(true);
  expect(store.jobs()[0].state).toBe("failed");
  expect(store.jobs()[0].error).toBe(
    "Extraction output references evidence that does not exist.",
  );
});
test("模型失败保留证据可重试，撤回后同源重放不复活", async ({ store }) => {
  store.ingest([event()]);
  await new MemoryWorker(store, config, async () => {
    throw new Error("测试模型断线");
  }).tick(true);
  const job = store.jobs()[0];
  expect(job.state).toBe("failed");
  expect(store.events(job.id)).toHaveLength(1);
  store.retry(job.id);
  const worker = new MemoryWorker(store, config, async () => ({
    proposals: [proposal()],
  }));
  await worker.tick(true);
  const [m] = await store.list();
  await store.revise(m.id, 1, { status: "withdrawn" }, m.etag);
  store.db.prepare("UPDATE jobs SET state='pending' WHERE id=?").run(job.id);
  await worker.tick(true);
  expect((await store.list()).map((m) => m.status)).toEqual(["withdrawn"]);
});
test("重启恢复中断的提炼任务", async ({ home, store }) => {
  store.ingest([event()]);
  store.db.exec("UPDATE jobs SET state='running'");
  store.close();
  const reopened = await MemoryStore.open(home);
  try {
    expect(reopened.jobs()[0].state).toBe("pending");
    await new MemoryWorker(reopened, config, async () => ({
      proposals: [proposal()],
    })).tick(true);
    expect(reopened.jobs()[0].state).toBe("done");
  } finally {
    reopened.close();
  }
});
test("纠正期间旧记录变更，输出转为候选而非覆盖", async ({ store }) => {
  store.ingest([event()]);
  await new MemoryWorker(store, config, async () => ({
    proposals: [proposal()],
  })).tick(true);
  store.ingest([event({ id: "e2", content: "TypeScript 偏好需要纠正" })]);
  await new MemoryWorker(store, config, async (_events, existing) => {
    const m = existing[0];
    await store.revise(
      m.id,
      m.revision,
      { content: "刚被用户改过的 TypeScript 偏好" },
      m.etag,
    );
    return {
      proposals: [
        proposal({
          action: "correct",
          targetId: m.id,
          expectedRevision: m.revision,
          sourceIds: ["e2"],
          content: "改为 Python",
        }),
      ],
    };
  }).tick(true);
  const all = await store.list();
  expect(all.find((m) => m.status === "active")?.content).toContain(
    "刚被用户改过",
  );
  expect(all.find((m) => m.status === "candidate")?.content).toBe(
    "改为 Python",
  );
});
test("已识别的凭据从事件、正文和来源摘录中隐去", async ({ store }) => {
  const secret = "sk-abcdefghijklmnopqrstuvwx";
  store.ingest([event({ content: `测试凭据 ${secret}` })]);
  expect(store.events(store.jobs()[0].id)[0].content).not.toContain(secret);
  await new MemoryWorker(store, config, async () => ({
    proposals: [proposal({ content: secret, title: secret, reason: secret })],
  })).tick(true);
  const [m] = await store.list();
  expect(await readFile(m.file, "utf8")).not.toContain(secret);
});

test("自动提炼只认最后一次事件后的空闲期", async ({ store }) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
  const extract = vi.fn(async () => ({ proposals: [] }));
  const worker = new MemoryWorker(
    store,
    ConfigSchema.parse({ idleSeconds: 30 }),
    extract,
  );
  store.ingest([event()]);
  vi.setSystemTime(new Date("2026-11-07T00:00:29Z"));
  store.ingest([event({ id: "e2" })]);
  vi.setSystemTime(new Date("2026-11-07T00:00:58Z"));
  await worker.tick();
  expect(extract).not.toHaveBeenCalled();
  expect(store.jobs()[0].state).toBe("pending");
  vi.setSystemTime(new Date("2026-11-07T00:00:59Z"));
  await worker.tick();
  expect(extract).toHaveBeenCalledExactlyOnceWith(
    [
      expect.objectContaining({ id: "e1" }),
      expect.objectContaining({ id: "e2" }),
    ],
    [],
  );
  expect(store.jobs()[0].state).toBe("done");
});

test("关闭自动提炼时保留队列，显式触发仍能处理", async ({ store }) => {
  store.ingest([event()]);
  const extract = vi.fn(async () => ({ proposals: [proposal()] }));
  const worker = new MemoryWorker(
    store,
    { ...config, extractionEnabled: false },
    extract,
  );
  await worker.tick();
  expect(extract).not.toHaveBeenCalled();
  expect(store.jobs()[0].state).toBe("pending");
  await worker.tick(true);
  expect(extract).toHaveBeenCalledTimes(1);
  expect(store.jobs()[0].state).toBe("done");
});

test("正在提炼时再次 tick 不会处理同一任务或提前领取下一条", async ({
  store,
}) => {
  store.ingest([event(), event({ id: "e2", sessionId: "s2" })]);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const extract = vi.fn(async () => {
    entered();
    await gate;
    return { proposals: [] };
  });
  const worker = new MemoryWorker(store, config, extract);
  const first = worker.tick(true);
  try {
    await Promise.race([
      started,
      first.then(() => {
        throw new Error("Worker completed before calling the extractor");
      }),
    ]);
    await worker.tick(true);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(store.jobs().map((job) => job.state)).toEqual([
      "pending",
      "running",
    ]);
  } finally {
    release();
    await first;
  }
  await worker.tick(true);
  expect(extract).toHaveBeenCalledTimes(2);
  expect(store.jobs().map((job) => job.state)).toEqual(["done", "done"]);
});

test.for([
  { role: "tool", kind: "lesson", certainty: "supported", status: "active" },
  {
    role: "tool",
    kind: "preference",
    certainty: "supported",
    status: "candidate",
  },
  {
    role: "user",
    kind: "preference",
    certainty: "uncertain",
    status: "candidate",
  },
] as const)(
  "证据规则：$role / $kind / $certainty → $status",
  async ({ role, kind, certainty, status }, { store }) => {
    store.ingest([event({ role })]);
    await new MemoryWorker(store, config, async () => ({
      proposals: [proposal({ kind, certainty })],
    })).tick(true);
    expect(store.jobs()[0].state).toBe("done");
    expect(await store.list()).toMatchObject([
      { status, kind, sources: [{ id: "e1", role }] },
    ]);
  },
);

test("有明确证据的纠正保留记忆 ID、旧版和新旧来源", async ({ store }) => {
  const [first, second] = [
    event(),
    event({ id: "e2", content: "TypeScript 偏好改为 Rust" }),
  ];
  const original = await store.create(
    CreateMemorySchema.parse({
      title: "开发语言",
      content: "偏好使用 TypeScript",
      scope: "global",
      sources: [
        {
          id: first.id,
          agent: first.agent,
          role: first.role,
          excerpt: first.content,
          at: first.at,
        },
      ],
    }),
  );
  store.ingest([second]);
  await new MemoryWorker(store, config, async () => ({
    proposals: [
      proposal({
        action: "correct",
        targetId: original.id,
        expectedRevision: original.revision,
        sourceIds: [second.id],
        content: "偏好使用 Rust",
      }),
    ],
  })).tick(true);
  expect(store.jobs()[0].state).toBe("done");
  expect(await store.list()).toMatchObject([
    {
      id: original.id,
      revision: 2,
      status: "active",
      content: "偏好使用 Rust",
      sources: [{ id: first.id }, { id: second.id }],
    },
  ]);
  expect(await store.history(original.id)).toMatchObject([
    { content: original.content, revision: 1, sources: [{ id: first.id }] },
  ]);
});

test("另一个项目的事件不能纠正目标记忆", async ({ store }) => {
  const source = await addTestProject(store, "source");
  const target = await addTestProject(store, "target");
  const original = await store.create(
    CreateMemorySchema.parse({
      title: "开发语言",
      content: "偏好使用 TypeScript",
      scope: "project",
      projectId: target.id,
    }),
  );
  store.ingest([event({ projectId: source.id })]);
  await new MemoryWorker(store, config, async () => ({
    proposals: [
      proposal({
        action: "correct",
        scope: "project",
        targetId: original.id,
        expectedRevision: original.revision,
        content: "越界覆盖",
      }),
    ],
  })).tick(true);
  expect(store.jobs()[0]).toMatchObject({
    state: "failed",
    error: expect.stringContaining("outside the scope"),
  });
  expect(await store.list({ allProjects: true })).toEqual([original]);
  expect(await store.history(original.id)).toEqual([]);
});
