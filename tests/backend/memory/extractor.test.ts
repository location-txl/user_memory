import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, vi } from "vitest";
import { test, reviewTurn } from "../fixtures.js";
import { ConfigSchema, initHome } from "../../../src/config.js";
import { CreateMemorySchema, EventSchema } from "../../../src/contracts.js";
import { MemoryStore } from "../../../src/memory/store.js";
import { codexExtractor, MemoryWorker } from "../../../src/memory/worker.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((_signal: string) => {
      child.emit("close", null);
      return true;
    }),
  });
  child.stdin.resume();
  return child;
}

const config = ConfigSchema.parse({
  codexPath: "fake-codex",
  workerTimeoutSeconds: 1,
});

test.for([
  { label: "缺少输出", output: undefined },
  { label: "无效 JSON", output: "{" },
])("子进程成功退出但 $label 时拒绝旧结果", async ({ output }, { home }) => {
  await initHome(home);
  const result = join(home, "worker", "result.json");
  await writeFile(result, '{"outcome":"settled","proposals":[]}');
  const child = childProcess();
  const recordUsage = vi.fn();
  vi.mocked(spawn).mockImplementation(() => {
    child.stdin.once("finish", () => {
      child.stdout.write(usageEvent(17, 4));
      if (output === undefined) child.emit("close", 0);
      else
        void writeFile(result, output).then(
          () => child.emit("close", 0),
          (error) => child.emit("error", error),
        );
    });
    return child as unknown as ReturnType<typeof spawn>;
  });

  await expect(
    codexExtractor(home, config)([], [], recordUsage),
  ).rejects.toThrow(SyntaxError);
  expect(recordUsage).toHaveBeenCalledExactlyOnceWith(null, {
    inputTokens: 17,
    cachedInputTokens: 17,
    outputTokens: 4,
  });
  expect(await readFile(result, "utf8")).toBe("");
});

test("提炼超时会终止子进程并报告可重试错误", async ({ home }) => {
  await initHome(home);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const child = childProcess();
  const recordUsage = vi.fn();
  const started = new Promise<void>((resolve) => {
    vi.mocked(spawn).mockImplementation(() => {
      resolve();
      return child as unknown as ReturnType<typeof spawn>;
    });
  });

  const extraction = codexExtractor(home, config)([], [], recordUsage);
  const failed = expect(extraction).rejects.toThrow(
    "Codex extraction timed out",
  );
  await started;
  child.stdout.write(usageEvent(11, 2));
  await vi.advanceTimersByTimeAsync(1_000);
  await failed;
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  expect(recordUsage).toHaveBeenCalledExactlyOnceWith(null, {
    inputTokens: 11,
    cachedInputTokens: 11,
    outputTokens: 2,
  });
  expect(vi.getTimerCount()).toBe(0);
});

function usageEvent(input: number, output: number, cached = input) {
  return (
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: cached,
        reasoning_output_tokens: output,
      },
    }) + "\n"
  );
}

test("轮次用量在失败、换模型重试和重启后仍可区分零值与未上报", async ({
  home,
  store,
}) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
  reviewTurn(
    store,
    [1, 2].map((batch) =>
      EventSchema.parse({
        id: `batch-${batch}`,
        agent: "codex",
        sessionId: "usage-session",
        role: "user",
        content: String(batch).repeat(25_000),
        at: new Date().toISOString(),
      }),
    ),
  );
  const results = [
    {
      events:
        usageEvent(80, 10) + usageEvent(200, 30, 120) + usageEvent(-1, 99),
      fail: true,
    },
    { events: "invalid json\n" + usageEvent(0, 0) },
  ];
  vi.mocked(spawn).mockImplementation((_path, args) => {
    expect(args).toContain("--json");
    const result = results.shift()!;
    const child = childProcess();
    child.stdin.once("finish", () => {
      child.stdout.write(result.events.slice(0, 25));
      child.stdout.write(result.events.slice(25));
      if (result.fail) {
        child.stdout.write(
          '{"type":"turn.failed","error":{"message":"Test transport failure"}}\n',
        );
        child.emit("close", 1);
      } else
        void writeFile(
          join(home, "worker", "result.json"),
          '{"outcome":"settled","proposals":[]}',
        ).then(
          () => child.emit("close", 0),
          (error) => child.emit("error", error),
        );
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
  const worker = new MemoryWorker(store, { ...config, model: "first-model" });
  await worker.tick(true);
  const [failed] = store.jobs();
  expect(failed).toMatchObject({
    state: "failed",
    error: "Codex extraction failed (1): Test transport failure",
    usageByModel: [
      {
        model: "first-model",
        calls: 1,
        reportedCalls: 1,
        cacheReportedCalls: 1,
        inputTokens: 200,
        cachedInputTokens: 120,
        outputTokens: 30,
        totalTokens: 230,
      },
    ],
  });

  store.retry(failed.id);
  worker.config.model = "second-model";
  await worker.tick(true);
  expect(store.jobs()[0].state).toBe("done");
  expect(
    vi.mocked(spawn).mock.calls.map(([, args]) => args?.slice(1, 3)),
  ).toEqual([
    ["--model", "first-model"],
    ["--model", "second-model"],
  ]);
  store.close();
  const reopened = await MemoryStore.open(home);
  try {
    expect(reopened.jobs()[0].usageByModel).toEqual([
      ...failed.usageByModel,
      {
        model: "second-model",
        calls: 1,
        reportedCalls: 1,
        cacheReportedCalls: 1,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    ]);
  } finally {
    reopened.close();
  }
});

test("提炼输入携带旧记忆的范围和来源，明确标记不完整证据", async ({
  home,
  store,
}) => {
  const sources = Array.from({ length: 4 }, (_, i) => ({
    id: `old-${i}`,
    agent: "codex" as const,
    role: "user" as const,
    at: `2026-11-0${i + 1}T00:00:00Z`,
    excerpt: i === 3 ? "旧证据".repeat(500) : `原始条件 ${i}`,
  }));
  const memory = await store.create(
    CreateMemorySchema.parse({
      title: "构建约束",
      content: "仅在 CI 执行完整构建",
      scope: "global",
      sources,
      reason: "用户指定适用范围",
    }),
  );
  let sent = "";
  const child = childProcess();
  child.stdin.on("data", (chunk) => {
    sent += chunk.toString();
  });
  vi.mocked(spawn).mockImplementation(() => {
    child.stdin.once("finish", () => {
      void writeFile(
        join(home, "worker", "result.json"),
        '{"outcome":"settled","proposals":[]}',
      ).then(
        () => child.emit("close", 0),
        (error) => child.emit("error", error),
      );
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
  await codexExtractor(home, config)(
    [],
    [memory, { ...memory, sources: [sources[0]] }],
    undefined,
    {
      events: [
        EventSchema.parse({
          id: sources[3].id,
          agent: "codex",
          sessionId: "original-session",
          role: "user",
          at: sources[3].at,
          content: `${"背景".repeat(1000)} 只适用于旧版`,
        }),
      ],
      unavailableSourceIds: [sources[1].id],
      omittedSourceIds: [sources[2].id],
    },
  );
  const payload = JSON.parse(sent.slice(sent.indexOf('{"events":')));
  expect(payload.events).toEqual([]);
  expect(payload.sourceEvidence).toMatchObject({
    events: [
      { id: sources[3].id, content: expect.stringContaining("只适用于旧版") },
    ],
    unavailableSourceIds: [sources[1].id],
    omittedSourceIds: [sources[2].id],
  });
  expect(payload.existing[0]).toMatchObject({
    id: memory.id,
    revision: 1,
    title: memory.title,
    scope: "global",
    reason: memory.reason,
    updatedAt: memory.updatedAt,
    sourceCount: 4,
    sourcesTruncated: true,
    sources: [
      sources[1],
      sources[2],
      { ...sources[3], excerpt: sources[3].excerpt.slice(0, 1000) },
    ],
  });
  expect(payload.existing[1]).toMatchObject({
    sourceCount: 1,
    sourcesTruncated: false,
    sources: [sources[0]],
  });
});

test.for(["plain", "wrapped"])(
  "旧事件和旧 Markdown 中的 JSON 凭据在模型输入出口被隐去：%s",
  async (format, { home, store }) => {
    const secret = "synthetic-model-input-secret";
    const payload = JSON.stringify({
      access_token: secret,
      result: "保留正常证据",
    });
    const content = `${"历史上下文 ".repeat(700)} ${format === "wrapped" ? JSON.stringify({ content: [{ type: "text", text: payload }] }) : payload}`;
    const rawEvent = EventSchema.parse({
      id: "old-secret",
      agent: "codex",
      sessionId: "old",
      role: "tool",
      content,
      at: "2026-11-07T00:00:00Z",
    });
    const memory = await store.create(
      CreateMemorySchema.parse({
        title: "旧约束",
        content: "保留正常证据",
        scope: "global",
      }),
    );
    let sent = "";
    const child = childProcess();
    child.stdin.on("data", (chunk) => (sent += chunk.toString()));
    vi.mocked(spawn).mockImplementation(() => {
      child.stdin.once("finish", () => {
        void writeFile(
          join(home, "worker", "result.json"),
          '{"outcome":"settled","proposals":[]}',
        ).then(
          () => child.emit("close", 0),
          (error) => child.emit("error", error),
        );
      });
      return child as unknown as ReturnType<typeof spawn>;
    });
    await codexExtractor(home, config)(
      [rawEvent],
      [
        {
          ...memory,
          content: JSON.stringify({ refresh_token: secret }),
          sources: [
            {
              id: rawEvent.id,
              agent: "codex",
              role: "tool",
              at: rawEvent.at,
              excerpt: JSON.stringify({ password: secret }),
            },
          ],
        },
      ],
      undefined,
      { events: [rawEvent], unavailableSourceIds: [], omittedSourceIds: [] },
    );
    expect(sent).toContain("保留正常证据");
    expect(sent).toContain("sourceEvidence");
    expect(sent).not.toContain(secret);
    expect(sent).toContain("已隐去凭据");
  },
);
