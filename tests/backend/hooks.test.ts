import { readdir } from "node:fs/promises";
import { afterEach, expect, vi } from "vitest";
import { test } from "./fixtures.js";
import { runHook, transcriptEvent } from "../../src/adapters/hooks.js";
import { MemoryClient } from "../../src/client.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
