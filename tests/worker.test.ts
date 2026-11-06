import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory/store.js";
import { MemoryWorker } from "../src/memory/worker.js";
import { ConfigSchema } from "../src/config.js";
import { EventSchema, type Proposal } from "../src/contracts.js";

let store: MemoryStore;
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "umem-worker-"));
  store = await MemoryStore.open(home);
});
afterEach(async () => {
  store.close();
  await rm(home, { recursive: true, force: true });
});
const event = (data: object = {}) =>
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
test("事件去重，排除注入和 worker；有效用户证据自动保存", async () => {
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
test("助手独自声称的偏好只进入候选；伪造证据让任务失败", async () => {
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
  expect(store.jobs()[0].error).toContain("不存在的证据");
});
test("模型失败保留证据可重试，撤回后同源重放不复活", async () => {
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
test("重启恢复中断的提炼任务", async () => {
  store.ingest([event()]);
  store.db.exec("UPDATE jobs SET state='running'");
  store.close();
  store = await MemoryStore.open(home);
  expect(store.jobs()[0].state).toBe("pending");
  await new MemoryWorker(store, config, async () => ({
    proposals: [proposal()],
  })).tick(true);
  expect(store.jobs()[0].state).toBe("done");
});
test("纠正期间旧记录变更，输出转为候选而非覆盖", async () => {
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
test("已识别的凭据从事件、正文和来源摘录中隐去", async () => {
  const secret = "sk-abcdefghijklmnopqrstuvwx";
  store.ingest([event({ content: `测试凭据 ${secret}` })]);
  expect(store.events(store.jobs()[0].id)[0].content).not.toContain(secret);
  await new MemoryWorker(store, config, async () => ({
    proposals: [proposal({ content: secret, title: secret, reason: secret })],
  })).tick(true);
  const [m] = await store.list();
  expect(await readFile(m.file, "utf8")).not.toContain(secret);
});
