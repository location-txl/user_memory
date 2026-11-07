import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerPi } from "../../src/adapters/pi.js";
import { apply } from "../../src/adapters/deepseek.js";
import { MemoryClient } from "../../src/client.js";
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
