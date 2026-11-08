import { appendFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import { capturedEvents, test } from "./fixtures.js";
import { runHook, transcriptEvent } from "../../src/adapters/hooks.js";
import { MemoryClient } from "../../src/client.js";
import { ConfigSchema } from "../../src/config.js";
import { MemoryWorker, type Extractor } from "../../src/memory/worker.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("Codex 转录提取工具证据并脱敏，忽略注入和无效行", () => {
  const tool = JSON.stringify({
    timestamp: "2026-11-07T00:00:00.000Z",
    payload: { type: "function_call_output", output: "Bearer abcdefghijklm" },
  });
  const evidence = transcriptEvent(tool, "codex", "s", 14, "/fixture");
  expect(evidence).toMatchObject({
    agent: "codex",
    sessionId: "s",
    role: "tool",
    cwd: "/fixture",
    content: "Bearer [已隐去凭据]",
  });
  expect(transcriptEvent(tool, "codex", "s", 14)?.id).toBe(evidence?.id);
  expect(transcriptEvent(tool, "codex", "s", 15)?.id).not.toBe(evidence?.id);
  const injection = JSON.stringify({
    type: "response_item",
    payload: {
      role: "assistant",
      content: [{ text: "<user-memory-context>旧记忆</user-memory-context>" }],
    },
  });
  expect(transcriptEvent(injection, "codex", "s", 20)).toBeUndefined();
  expect(transcriptEvent("{", "codex", "s", 21)).toBeUndefined();
});

test("Claude 转录保留宿主消息 ID 并忽略无文本内容", () => {
  const line = JSON.stringify({
    uuid: "message-1",
    message: {
      role: "assistant",
      content: [{ text: "文字" }, { type: "image" }, { text: "第二段" }],
    },
  });
  expect(transcriptEvent(line, "claude", "s", 0)).toMatchObject({
    id: "claude:s:message-1",
    role: "assistant",
    content: "文字\n第二段",
  });
  expect(
    transcriptEvent(
      JSON.stringify({ message: { role: "assistant", content: [] } }),
      "claude",
      "s",
      0,
    ),
  ).toBeUndefined();
});

test("worker 自己的 hook 不召回也不写入采集目录", async ({ home }) => {
  vi.stubEnv("UMEM_WORKER", "1");
  const request = vi.spyOn(MemoryClient.prototype, "request");
  expect(
    await runHook(home, "zcode", {
      session_id: "worker",
      hook_event_name: "UserPromptSubmit",
      prompt: "不应采集",
    }),
  ).toEqual({});
  expect(request).not.toHaveBeenCalled();
  expect(await readdir(home)).toEqual([]);
});

test("Claude Stop 补采尚未落盘的最终回复，并与下一次增量采集去重", async ({
  home,
  store,
}) => {
  vi.spyOn(MemoryClient.prototype, "request").mockResolvedValue({
    context: "",
  });
  const transcript = join(home, "claude.jsonl");
  const hook = {
    session_id: "claude",
    prompt_id: "first",
    transcript_path: transcript,
    cwd: home,
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
  await writeFile(transcript, "");
  await runHook(home, "claude", {
    ...hook,
    hook_event_name: "UserPromptSubmit",
    prompt: "请先给出方案。",
  });
  vi.setSystemTime(new Date("2026-11-07T00:00:10Z"));
  await runHook(home, "claude", {
    ...hook,
    hook_event_name: "Stop",
    last_assistant_message: "待确认。",
  });
  await store.drainSpool();
  expect(
    capturedEvents(store).sort((a, b) => a.at.localeCompare(b.at)),
  ).toMatchObject([
    { role: "user", content: "请先给出方案。" },
    { role: "assistant", content: "待确认。" },
  ]);
  await writeFile(
    transcript,
    JSON.stringify({
      uuid: "assistant-final",
      timestamp: "2026-11-07T00:00:09.000Z",
      message: { role: "assistant", content: "待确认。" },
    }) + "\n",
  );
  vi.setSystemTime(new Date("2026-11-07T00:00:12Z"));
  await runHook(home, "claude", {
    ...hook,
    hook_event_name: "UserPromptSubmit",
    prompt_id: "next",
    prompt: "我来补充要求。",
  });
  await store.drainSpool();
  const [job] = store.jobs();
  expect(store.events(job.id)).toHaveLength(2);
  expect(store.jobs()).toHaveLength(1);
});

test("ZCode 原生 turnId 将提交与 Stop 关联为一个任务", async ({
  home,
  store,
}) => {
  vi.spyOn(MemoryClient.prototype, "request").mockResolvedValue({
    context: "",
  });
  const input = {
    session_id: "zcode-native",
    turnId: "native-turn",
    cwd: home,
  };
  await runHook(home, "zcode", {
    ...input,
    hook_event_name: "UserPromptSubmit",
    prompt: "用户原话",
  });
  await store.drainSpool();
  expect(store.jobs()).toEqual([]);
  await runHook(home, "zcode", {
    ...input,
    hook_event_name: "Stop",
    last_assistant_message: "最终回复",
  });
  await store.drainSpool();
  expect(store.jobs()).toMatchObject([{ turn_id: "native-turn" }]);
  expect(
    store
      .events(store.jobs()[0].id)
      .map((event) => event.role)
      .sort(),
  ).toEqual(["assistant", "user"]);
});

test("Claude 续跑期间不复盘，迟到 transcript 按产生时间归属原轮", async ({
  home,
  store,
}) => {
  vi.spyOn(MemoryClient.prototype, "request").mockResolvedValue({
    context: "",
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  const clock = (second: number) =>
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 7, 0, 0, second)));
  const path = join(home, "claude-delayed.jsonl");
  await writeFile(path, "");
  const emit = (event: string, id: string, data = {}) =>
    runHook(home, "claude", {
      session_id: "claude-delayed",
      transcript_path: path,
      cwd: home,
      hook_event_name: event,
      prompt_id: id,
      ...data,
    });
  clock(0);
  await emit("UserPromptSubmit", "a", { prompt: "轮 A" });
  clock(10);
  await emit("Stop", "a", {
    last_assistant_message: "暂时回复 A",
    stop_hook_active: false,
  });
  const extract = vi.fn<Extractor>(async () => ({
    outcome: "settled",
    proposals: [],
  }));
  const worker = new MemoryWorker(
    store,
    ConfigSchema.parse({ idleSeconds: 30 }),
    extract,
  );
  clock(41);
  await worker.tick();
  expect.soft(extract).not.toHaveBeenCalled();
  expect.soft(store.jobs()).toEqual([]);
  clock(45);
  await emit("Stop", "a", {
    last_assistant_message: "最终回复 A",
    stop_hook_active: true,
  });
  clock(46);
  await emit("UserPromptSubmit", "b", { prompt: "轮 B" });
  await appendFile(
    path,
    [
      {
        uuid: "late-tool-a",
        timestamp: "2026-11-07T00:00:44.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "轮 A 的工具结果" }],
        },
      },
      {
        uuid: "late-assistant-a",
        timestamp: "2026-11-07T00:00:44.100Z",
        message: { role: "assistant", content: "最终回复 A" },
      },
      {
        uuid: "tool-b",
        timestamp: "2026-11-07T00:00:48.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "轮 B 的工具结果" }],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  clock(50);
  await emit("Stop", "b", { last_assistant_message: "最终回复 B" });
  clock(51);
  await emit("SessionEnd", "b", { reason: "prompt_input_exit" });
  await store.drainSpool();
  const a = store.jobs().find((job) => job.turn_id === "a")!;
  const b = store.jobs().find((job) => job.turn_id === "b")!;
  expect(store.events(a.id).map((event) => event.content)).toEqual(
    expect.arrayContaining(["轮 A", "最终回复 A", "工具结果：轮 A 的工具结果"]),
  );
  expect(store.events(b.id).map((event) => event.content)).toEqual([
    "轮 B",
    "工具结果：轮 B 的工具结果",
    "最终回复 B",
  ]);
  expect(
    capturedEvents(store).filter((event) => event.content === "最终回复 A"),
  ).toHaveLength(1);
});

test("Claude StopFailure 取消临时收尾，SessionEnd 只保留证据", async ({
  home,
  store,
}) => {
  vi.spyOn(MemoryClient.prototype, "request").mockResolvedValue({
    context: "",
  });
  const input = {
    session_id: "claude-failure",
    prompt_id: "failed-turn",
    cwd: home,
  };
  await runHook(home, "claude", {
    ...input,
    hook_event_name: "UserPromptSubmit",
    prompt: "待执行任务",
  });
  await runHook(home, "claude", {
    ...input,
    hook_event_name: "Stop",
    last_assistant_message: "继续验证前的回复",
  });
  await runHook(home, "claude", { ...input, hook_event_name: "StopFailure" });
  await runHook(home, "claude", { ...input, hook_event_name: "SessionEnd" });
  await store.drainSpool();
  expect(capturedEvents(store)).toHaveLength(2);
  expect(store.jobs()).toEqual([]);
});

test("Codex Stop 接受宿主合法的 null 回复", async ({ home }) => {
  await expect(
    runHook(home, "codex", {
      session_id: "codex-null",
      turn_id: "t",
      hook_event_name: "Stop",
      last_assistant_message: null,
    }),
  ).resolves.toEqual({});
});
