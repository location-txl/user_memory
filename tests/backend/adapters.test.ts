import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerPi } from "../../src/adapters/pi.js";
import { apply } from "../../src/adapters/deepseek.js";
import { MemoryClient } from "../../src/client.js";
import { MemoryStore } from "../../src/memory/store.js";
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "umem-adapter-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});
async function events() {
  const files = await readdir(join(home, "spool")).catch(() => []);
  return (
    await Promise.all(
      files.map(async (f) =>
        JSON.parse(await readFile(join(home, "spool", f), "utf8")),
      ),
    )
  ).flat();
}
test("Pi 按当前会话召回，并忽略自身注入内容", async () => {
  const request = vi
    .spyOn(MemoryClient.prototype, "request")
    .mockResolvedValue({
      context: "<user-memory-context>历史偏好</user-memory-context>",
    });
  const handlers = new Map<string, Function>();
  registerPi(
    {
      on: (name, handler) => {
        handlers.set(name, handler);
      },
    },
    home,
  );
  const ctx = {
    cwd: home,
    sessionManager: { getSessionId: () => "pi-session" },
  };
  const recall = await handlers.get("before_agent_start")!(
    { prompt: "本次提问" },
    ctx,
  );
  expect(recall.message.customType).toBe("user-memory");
  expect(request.mock.calls[0][1]?.body).toMatchObject({
    sessionId: "pi-session",
    cwd: home,
  });
  await handlers.get("message_end")!(
    {
      message: { role: "user", content: "我偏好 TypeScript", timestamp: 1234 },
    },
    ctx,
  );
  await handlers.get("message_end")!(
    {
      message: {
        role: "custom",
        content: recall.message.content,
        customType: "user-memory",
      },
    },
    ctx,
  );
  expect(await events()).toHaveLength(1);
  expect((await events())[0].role).toBe("user");
});
test("DeepSeek 保留决策与既有消息，只有真实用户提交成为证据", async () => {
  vi.spyOn(MemoryClient.prototype, "request").mockResolvedValue({
    context: "<user-memory-context>历史偏好</user-memory-context>",
  });
  const handlers = new Map<string, Function>();
  apply(
    {
      on: (name: string, handler: Function) => {
        handlers.set(name, handler);
      },
    },
    { home },
  );
  const session = { id: "dsh-session", header: { cwd: home } };
  const decision = {
    kind: "continue",
    other: "preserved",
    messages: [
      {
        id: "m1",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "真实提问" }],
      },
    ],
  };
  const result = await handlers.get("agent/pre-step")!(
    { agent: { id: session.id, session } },
    async () => decision,
  );
  expect(result.other).toBe("preserved");
  expect(result.messages).toHaveLength(2);
  expect(decision.messages).toHaveLength(1);
  const event = {
    type: "user/message",
    seq: 1,
    time: 1234,
    data: decision.messages[0],
  };
  await handlers.get("session/event")!(session, event);
  await handlers.get("session/event")!(session, {
    ...event,
    seq: 2,
    data: { ...event.data, source: { kind: "user-memory" } },
  });
  await handlers.get("session/event")!(
    { ...session, header: { cwd: home, parentSession: "parent" } },
    event,
  );
  expect(await events()).toHaveLength(1);
  expect((await events())[0].content).toBe("真实提问");
  const rejection = { kind: "reject" };
  expect(
    await handlers.get("agent/pre-step")!(
      { agent: { id: session.id, session } },
      async () => rejection,
    ),
  ).toBe(rejection);
});

test("Pi 召回失败时通知宿主并继续，后续消息仍可采集", async () => {
  vi.spyOn(MemoryClient.prototype, "request").mockRejectedValue(
    new Error("service offline"),
  );
  const handlers = new Map<string, Function>();
  registerPi(
    {
      on: (name, handler) => {
        handlers.set(name, handler);
      },
    },
    home,
  );
  const notify = vi.fn();
  const ctx = {
    cwd: home,
    sessionManager: { getSessionId: () => "pi-offline" },
    ui: { notify },
  };
  await expect(
    handlers.get("before_agent_start")!({ prompt: "当前提问" }, ctx),
  ).resolves.toBeUndefined();
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("service offline"),
    "warning",
  );
  await handlers.get("message_end")!(
    { message: { role: "user", content: "离线时的用户发言" } },
    ctx,
  );
  expect(await events()).toMatchObject([
    { sessionId: "pi-offline", role: "user", content: "离线时的用户发言" },
  ]);
});

test("DeepSeek 召回失败时原样返回宿主决定", async () => {
  vi.spyOn(MemoryClient.prototype, "request").mockRejectedValue(
    new Error("service offline"),
  );
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const handlers = new Map<string, Function>();
  apply(
    {
      on: (name: string, handler: Function) => {
        handlers.set(name, handler);
      },
    },
    { home },
  );
  const session = { id: "dsh-offline", header: { cwd: home } };
  const decision = {
    kind: "continue",
    messages: [
      { id: "user-1", role: "user", content: "提问", source: { kind: "user" } },
    ],
  };
  const result = await handlers.get("agent/pre-step")!(
    { agent: { id: session.id, session } },
    async () => decision,
  );
  expect(result).toBe(decision);
  expect(report).toHaveBeenCalledOnce();
});

test("Pi 只对真实用户运行的非中止收尾标记轮次", async () => {
  const request = vi
    .spyOn(MemoryClient.prototype, "request")
    .mockResolvedValue({ context: "" });
  const handlers = new Map<string, Function>();
  registerPi(
    {
      on: (name, handler) => {
        handlers.set(name, handler);
      },
    },
    home,
  );
  const ctx = {
    cwd: home,
    sessionManager: { getSessionId: () => "pi-settle" },
  };
  const emit = (name: string, event: unknown) =>
    handlers.get(name)!(event, ctx);
  await emit("before_agent_start", { messageType: "custom", message: {} });
  expect(request).not.toHaveBeenCalled();
  await emit("agent_settled", { aborted: false });
  await emit("before_agent_start", { messageType: "user", prompt: "已中止" });
  await emit("message_end", {
    message: { role: "user", timestamp: 1, content: "已中止" },
  });
  await emit("agent_settled", { aborted: true });
  await emit("before_agent_start", { messageType: "user", prompt: "继续执行" });
  await emit("message_end", {
    message: { role: "user", timestamp: 2, content: "继续执行" },
  });
  await emit("message_end", {
    message: { role: "toolResult", timestamp: 3, content: "检查完成" },
  });
  await emit("agent_settled", { aborted: false });
  const store = await MemoryStore.open(home);
  try {
    await store.drainSpool();
    expect(store.jobs()).toHaveLength(1);
    expect(store.events(store.jobs()[0].id).map((e) => e.role)).toEqual([
      "user",
      "tool",
    ]);
  } finally {
    store.close();
  }
});

test("DeepSeek 按原生轮次关联用户与结果，只标记 completed", async () => {
  const handlers = new Map<string, Function>();
  apply(
    {
      on: (name: string, handler: Function) => {
        handlers.set(name, handler);
      },
    },
    { home },
  );
  const session = { id: "dsh-turn", header: { cwd: home } };
  let seq = 0;
  const emit = (type: string, data: object) =>
    handlers.get("session/event")!(session, {
      type,
      seq: ++seq,
      time: seq * 1000,
      data,
    });
  await emit("turn/start", { turn: 1 });
  await emit("user/message", { content: "需求", source: { kind: "user" } });
  await emit("turn/end", { turn: 1, reason: { kind: "aborted" } });
  await emit("turn/start", { turn: 2 });
  await emit("user/message", { content: "请执行", source: { kind: "user" } });
  await emit("tool/result", {
    turn: 2,
    message: { content: [{ type: "text", text: "已验证" }] },
  });
  await emit("assistant/message", {
    turn: 2,
    message: {
      content: [
        { type: "text", text: "完成" },
        { type: "reasoning", text: "隐藏推理" },
      ],
    },
  });
  await emit("turn/end", { turn: 2, reason: { kind: "completed" } });
  const store = await MemoryStore.open(home);
  try {
    await store.drainSpool();
    expect(store.jobs()).toMatchObject([{ turn_id: "2" }]);
    expect(store.events(store.jobs()[0].id).map((e) => e.content)).toEqual([
      "请执行",
      "已验证",
      "完成",
    ]);
  } finally {
    store.close();
  }
});

test.each(["pi", "deepseek"])(
  "%s 截断长工具结果前脱敏转义 JSON",
  async (host) => {
    const handlers = new Map<string, Function>();
    const extension = {
      on: (name: string, handler: Function) => handlers.set(name, handler),
    };
    const canary = "synthetic-password-value";
    const content = JSON.stringify({
      output: `${"x".repeat(31900)} ${JSON.stringify({ password: canary })} ${"x".repeat(500)}`,
    });
    expect(content.indexOf(canary) + canary.length).toBeLessThan(32000);
    if (host === "pi") {
      registerPi(extension, home);
      await handlers.get("message_end")!(
        { message: { role: "toolResult", toolCallId: "call", content } },
        { cwd: home, sessionManager: { getSessionId: () => "pi-long" } },
      );
    } else {
      apply(extension, { home });
      await handlers.get("session/event")!(
        { id: "deepseek-long", header: { cwd: home } },
        {
          type: "tool/result",
          seq: 1,
          time: 1000,
          data: { turn: 1, message: { content } },
        },
      );
    }
    const [captured] = await events();
    expect(captured.content).not.toContain(canary);
    expect(captured.content).toContain("[已隐去凭据]");
    expect(captured.content.length).toBeLessThanOrEqual(32000);
    const store = await MemoryStore.open(home);
    try {
      await store.drainSpool();
      const row = store.db
        .prepare("SELECT data FROM events WHERE id=?")
        .get(captured.id) as { data: string };
      expect(JSON.parse(row.data).content).toBe(captured.content);
    } finally {
      store.close();
    }
  },
);
