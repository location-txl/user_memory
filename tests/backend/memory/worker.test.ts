import { afterEach, expect, vi } from "vitest";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { test, addTestProject, reviewTurn } from "../fixtures.js";
import { MemoryStore } from "../../../src/memory/store.js";
import { MemoryWorker, type Extractor } from "../../../src/memory/worker.js";
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
  basis: "explicit_policy",
  reason: "用户明确说明",
  ...data,
});
const config = ConfigSchema.parse({ idleSeconds: 0 });
test("事件去重，排除注入和 worker；有效用户证据自动保存", async ({ store }) => {
  expect(
    reviewTurn(store, [
      event(),
      event(),
      event({ id: "e2", injected: true }),
      event({ id: "e3", worker: true }),
    ]),
  ).toBe(1);
  const worker = new MemoryWorker(store, config, async () => ({
    outcome: "settled" as const,
    proposals: [proposal()],
  }));
  await worker.tick(true);
  expect(store.jobs()[0].state).toBe("done");
  const [m] = await store.list();
  expect(m.status).toBe("active");
  expect(m.sources[0].id).toBe("e1");
});
test("助手独自声称的偏好只进入候选；伪造证据让任务失败", async ({ store }) => {
  reviewTurn(store, [event({ role: "assistant" })]);
  await new MemoryWorker(store, config, async () => ({
    outcome: "settled" as const,
    proposals: [proposal()],
  })).tick(true);
  expect((await store.list())[0].status).toBe("candidate");
  reviewTurn(store, [event({ id: "e2" })]);
  await new MemoryWorker(store, config, async () => ({
    outcome: "settled" as const,
    proposals: [proposal({ sourceIds: ["does-not-exist"] })],
  })).tick(true);
  expect(store.jobs()[0].state).toBe("failed");
  expect(store.jobs()[0].error).toBe(
    "Extraction output references evidence that does not exist.",
  );
});
test("模型失败保留证据可重试，撤回后同源重放不复活", async ({ store }) => {
  reviewTurn(store, [event()]);
  await new MemoryWorker(store, config, async () => {
    throw new Error("测试模型断线");
  }).tick(true);
  const job = store.jobs()[0];
  expect(job.state).toBe("failed");
  expect(store.events(job.id)).toHaveLength(2);
  store.retry(job.id);
  const worker = new MemoryWorker(store, config, async () => ({
    outcome: "settled" as const,
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
  reviewTurn(store, [event()]);
  store.db.exec("UPDATE jobs SET state='running'");
  store.close();
  const reopened = await MemoryStore.open(home);
  try {
    expect(reopened.jobs()[0].state).toBe("pending");
    await new MemoryWorker(reopened, config, async () => ({
      outcome: "settled" as const,
      proposals: [proposal()],
    })).tick(true);
    expect(reopened.jobs()[0].state).toBe("done");
  } finally {
    reopened.close();
  }
});
test("纠正期间旧记录变更，旧输出不覆盖或生成冲突候选", async ({ store }) => {
  reviewTurn(store, [event()]);
  await new MemoryWorker(store, config, async () => ({
    outcome: "settled" as const,
    proposals: [proposal()],
  })).tick(true);
  reviewTurn(store, [event({ id: "e2", content: "TypeScript 偏好需要纠正" })]);
  await new MemoryWorker(store, config, async (_events, existing) => {
    const m = existing[0];
    await store.revise(
      m.id,
      m.revision,
      { content: "刚被用户改过的 TypeScript 偏好" },
      m.etag,
    );
    return {
      outcome: "settled" as const,
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
  expect(all).toHaveLength(1);
});
test("已识别的凭据从事件、正文和来源摘录中隐去", async ({ store }) => {
  const secret = "sk-abcdefghijklmnopqrstuvwx";
  reviewTurn(store, [event({ content: `测试凭据 ${secret}` })]);
  expect(store.events(store.jobs()[0].id)[0].content).not.toContain(secret);
  await new MemoryWorker(store, config, async () => ({
    outcome: "settled" as const,
    proposals: [proposal({ content: secret, title: secret, reason: secret })],
  })).tick(true);
  const [m] = await store.list();
  expect(await readFile(m.file, "utf8")).not.toContain(secret);
});

test("只提交需求超过三十秒仍不提炼，结束缓冲内的同轮证据会纳入复盘", async ({
  store,
}) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
  const extract = vi.fn<Extractor>(async () => ({
    outcome: "pending",
    proposals: [proposal({ basis: "adopted_decision", kind: "decision" })],
  }));
  const worker = new MemoryWorker(
    store,
    ConfigSchema.parse({ idleSeconds: 30 }),
    extract,
  );
  const request = event({ turnId: "t1", content: "本次优化 CI 时保留测试。" });
  store.ingest([request]);
  vi.setSystemTime(new Date("2026-11-07T00:00:45Z"));
  await worker.tick();
  expect(extract).not.toHaveBeenCalled();
  expect(store.jobs()).toEqual([]);

  const turnEnd = {
    agent: request.agent,
    sessionId: request.sessionId,
    turnId: "t1",
    at: new Date().toISOString(),
  };
  store.ingest(
    [
      event({
        id: "reply",
        turnId: "t1",
        role: "assistant",
        content: "方案等待确认。",
      }),
    ],
    turnEnd,
  );
  vi.setSystemTime(new Date("2026-11-07T00:01:00Z"));
  store.ingest([
    event({ id: "late", turnId: "t1", role: "tool" }),
    event({ id: "new-prompt", turnId: "t2" }),
  ]);
  vi.setSystemTime(new Date("2026-11-07T00:01:29Z"));
  await worker.tick();
  expect(extract).not.toHaveBeenCalled();
  vi.setSystemTime(new Date("2026-11-07T00:01:30Z"));
  store.ingest([], turnEnd);
  await worker.tick();
  expect(extract).toHaveBeenCalledOnce();
  expect(extract.mock.calls[0][0].map((e) => e.id)).toEqual([
    "e1",
    "reply",
    "late",
  ]);
  expect(store.jobs()).toMatchObject([{ state: "done" }]);
  expect(await store.list()).toEqual([]);
  expect(await worker.tick()).toBeUndefined();
  expect(extract).toHaveBeenCalledOnce();
});

test("关闭自动提炼时保留队列，显式触发仍能处理", async ({ store }) => {
  reviewTurn(store, [event()]);
  const extract = vi.fn(async () => ({
    outcome: "settled" as const,
    proposals: [proposal()],
  }));
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
  reviewTurn(store, [event()]);
  reviewTurn(store, [event({ id: "e2", sessionId: "s2" })]);
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
    return { outcome: "settled" as const, proposals: [] };
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
    reviewTurn(store, [event({ role })]);
    await new MemoryWorker(store, config, async () => ({
      outcome: "settled" as const,
      proposals: [
        proposal({
          kind,
          certainty,
          basis: kind === "lesson" ? "verified_lesson" : "explicit_policy",
        }),
      ],
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
  reviewTurn(store, [second]);
  await new MemoryWorker(store, config, async () => ({
    outcome: "settled" as const,
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
  reviewTurn(store, [event({ projectId: source.id })]);
  await new MemoryWorker(store, config, async () => ({
    outcome: "settled" as const,
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

test.for([false, true])(
  "提炼核对旧原文，但旧来源不能冒充新证据：%s",
  async (reuseOldSource, { store }) => {
    const old = event({
      id: "old",
      content: `TypeScript ${"背景".repeat(2500)} 只限测试工具`,
    });
    store.ingest([old]);
    const original = await store.create(
      CreateMemorySchema.parse({
        title: "TypeScript 约束",
        content: "所有工具使用 TypeScript",
        scope: "global",
        sources: [
          {
            id: old.id,
            agent: old.agent,
            role: old.role,
            sessionId: old.sessionId,
            at: old.at,
            excerpt: old.content.slice(0, 4000),
          },
        ],
      }),
    );
    const current = event({
      id: "new",
      content: "TypeScript 仅用于测试工具，其他工具不受此约束",
    });
    reviewTurn(store, [current]);
    const extract = vi.fn<Extractor>(
      async (events, existing, _usage, evidence) => {
        expect(events).toMatchObject([current, { role: "assistant" }]);
        expect(existing).toMatchObject([{ id: original.id }]);
        expect(evidence).toEqual({
          events: [old],
          unavailableSourceIds: [],
          omittedSourceIds: [],
        });
        expect(existing[0].sources[0].excerpt).not.toContain("只限测试工具");
        return {
          outcome: "settled" as const,
          proposals: [
            proposal({
              action: "correct",
              targetId: original.id,
              expectedRevision: original.revision,
              content: "仅测试工具使用 TypeScript",
              sourceIds: [reuseOldSource ? old.id : current.id],
            }),
          ],
        };
      },
    );
    await new MemoryWorker(store, config, extract).tick(true);
    expect(extract).toHaveBeenCalledOnce();
    if (reuseOldSource) {
      expect(store.jobs()[0]).toMatchObject({
        state: "failed",
        error: expect.stringContaining("does not exist"),
      });
      expect(await store.get(original.id)).toEqual(original);
    } else {
      expect(store.jobs()[0].state).toBe("done");
      expect(await store.get(original.id)).toMatchObject({
        revision: 2,
        content: "仅测试工具使用 TypeScript",
      });
    }
  },
);

test("写入失败后重启从已验证提案续写，不重复请求模型或写入已完成提案", async ({
  home,
  store,
}) => {
  reviewTurn(store, [event()]);
  const extract = vi.fn<Extractor>(async () => ({
    outcome: "settled",
    proposals: [
      proposal(),
      proposal({ title: "另一条约定", content: "默认用中文" }),
    ],
  }));
  const realCreate = store.create.bind(store);
  vi.spyOn(store, "create")
    .mockImplementationOnce(realCreate)
    .mockRejectedValueOnce(new Error("模拟写入失败"));
  await new MemoryWorker(store, config, extract).tick(true);
  expect(store.jobs()[0]).toMatchObject({
    state: "failed",
    review: { processed: 1, total: 2, inputEventIds: ["e1", "e1:reply"] },
  });
  store.close();
  const reopened = await MemoryStore.open(home);
  try {
    expect(reopened.retry(reopened.jobs()[0].id)).toBe(1);
    await new MemoryWorker(reopened, config, extract).tick(true);
    expect(extract).toHaveBeenCalledOnce();
    expect(reopened.jobs()[0]).toMatchObject({
      state: "done",
      review: { processed: 2, total: 2 },
    });
    expect(await reopened.list()).toMatchObject([
      { revision: 1 },
      { revision: 1 },
    ]);
  } finally {
    reopened.close();
  }
});

test("待确认的任务仍可保留用户明确给出的独立长期政策", async ({ store }) => {
  reviewTurn(store, [
    event({
      content: "以后所有项目都默认使用中文。本次 CI 优化方案先给我确认。",
    }),
  ]);
  await new MemoryWorker(store, config, async () => ({
    outcome: "pending",
    proposals: [
      proposal({ content: "默认使用中文" }),
      proposal({
        basis: "adopted_decision",
        kind: "decision",
        content: "采用 CI 方案",
      }),
    ],
  })).tick(true);
  expect(await store.list()).toMatchObject([
    { content: "默认使用中文", status: "active" },
  ]);
});

test("跨范围纠正在保存提案前失败，修正模型输出后可重试全部有效提案", async ({
  store,
}) => {
  const project = await addTestProject(store, "scope-check");
  const original = await store.create(
    CreateMemorySchema.parse({
      title: "TypeScript 全局偏好",
      content: "默认使用 TypeScript",
      scope: "global",
    }),
  );
  reviewTurn(store, [event({ projectId: project.id })]);
  const add = proposal({
    scope: "project",
    content: "项目采用独立 TypeScript 约定",
  });
  const correct = proposal({
    action: "correct",
    targetId: original.id,
    expectedRevision: original.revision,
    scope: "project",
    content: "尝试跨范围纠正",
  });
  const extract = vi
    .fn<Extractor>()
    .mockResolvedValueOnce({ outcome: "settled", proposals: [add, correct] })
    .mockResolvedValueOnce({ outcome: "settled", proposals: [add] });
  const worker = new MemoryWorker(store, config, extract);
  await worker.tick(true);
  const [job] = store.jobs();
  expect(job.state).toBe("failed");
  expect.soft(job.review).toBeUndefined();
  expect
    .soft(await store.list({ scope: "project", projectId: project.id }))
    .toEqual([]);
  expect(store.retry(job.id)).toBe(1);
  await worker.tick(true);
  expect(extract).toHaveBeenCalledTimes(2);
  expect(store.jobs()[0]).toMatchObject({
    state: "done",
    review: { processed: 1, total: 1 },
  });
  expect(
    await store.list({ scope: "project", projectId: project.id }),
  ).toMatchObject([{ content: add.content }]);
  expect(await store.get(original.id)).toEqual(original);
});

test("续写旧提案时跳过已保存的跨范围纠正并处理后续提案", async ({ store }) => {
  const project = await addTestProject(store, "old-review");
  const original = await store.create(
    CreateMemorySchema.parse({
      title: "全局 TypeScript 约定",
      content: "默认使用 TypeScript",
      scope: "global",
    }),
  );
  reviewTurn(store, [event({ projectId: project.id })]);
  const [job] = store.jobs();
  const add = proposal({ scope: "project", content: "后续有效提案" });
  store.saveExtractionReview(job.id, {
    inputEventIds: store.events(job.id).map((item) => item.id),
    contextEventIds: [],
    promptHash: "old-review",
    version: "0.1.0",
    requestedModel: null,
    targets: { [original.id]: original.etag },
    proposals: [
      proposal({
        action: "correct",
        targetId: original.id,
        expectedRevision: original.revision,
        scope: "project",
      }),
      add,
    ],
  });
  store.db.prepare("UPDATE jobs SET state='failed' WHERE id=?").run(job.id);
  expect(store.retry(job.id)).toBe(1);
  const extract = vi.fn<Extractor>();
  await new MemoryWorker(store, config, extract).tick(true);
  expect(extract).not.toHaveBeenCalled();
  expect(store.jobs()[0]).toMatchObject({
    state: "done",
    review: { processed: 2, total: 2 },
  });
  expect(await store.get(original.id)).toEqual(original);
  expect(
    await store.list({ scope: "project", projectId: project.id }),
  ).toMatchObject([{ content: add.content }]);
});

test("全局复盘保留项目来源 ID，不公开原话或用低置信来源修订生效记录", async ({
  store,
}) => {
  const project = await addTestProject(store, "source-scope");
  const original = await store.create(
    CreateMemorySchema.parse({
      title: "已有通用政策",
      content: "已有的全局正文",
      scope: "global",
    }),
  );
  const privateContent = "项目内部代号只供项目查看";
  reviewTurn(store, [
    event({
      id: "private-user",
      projectId: project.id,
      content: privateContent,
    }),
    event({
      id: "private-reply",
      projectId: project.id,
      role: "assistant",
      content: privateContent,
    }),
  ]);
  await new MemoryWorker(store, config, async () => ({
    outcome: "settled",
    proposals: [
      proposal({ sourceIds: ["private-user"], content: "新的全局正文" }),
      proposal({
        sourceIds: ["private-reply"],
        certainty: "uncertain",
        content: original.content,
      }),
    ],
  })).tick(true);
  expect.soft(await store.get(original.id)).toEqual(original);
  const created = (await store.list()).find(
    (memory) => memory.id !== original.id,
  )!;
  expect(created.sources[0].id).toBe("private-user");
  expect(await readFile(created.file, "utf8")).not.toContain(privateContent);
});

test("保留 Markdown 重建 SQLite 后，不同项目的首个提炼任务可写相同正文", async ({
  home,
  store,
}) => {
  const first = await addTestProject(store, "restore-first");
  const second = await addTestProject(store, "restore-second");
  const extract: Extractor = async (events) => ({
    outcome: "settled",
    proposals: [
      proposal({
        scope: "project",
        sourceIds: [events.find((item) => item.role === "user")!.id],
      }),
    ],
  });
  reviewTurn(store, [event({ projectId: first.id })]);
  await new MemoryWorker(store, config, extract).tick(true);
  const [before] = await store.list({ projectId: first.id });
  expect(before).toBeDefined();
  expect(store.jobs()[0].id).toBe(1);
  store.close();
  await rename(join(home, "runtime.db"), join(home, "runtime-before.db"));
  const rebuilt = await MemoryStore.open(home);
  try {
    reviewTurn(rebuilt, [
      event({
        id: "after-rebuild",
        sessionId: "second-session",
        projectId: second.id,
      }),
    ]);
    await new MemoryWorker(rebuilt, config, extract).tick(true);
    expect(rebuilt.jobs()).toMatchObject([{ id: 1, state: "done" }]);
    const [after] = await rebuilt.list({ projectId: second.id });
    expect(after).toMatchObject({
      projectId: second.id,
      content: before.content,
    });
    expect(after.id).not.toBe(before.id);
  } finally {
    rebuilt.close();
  }
});
