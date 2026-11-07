import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, vi } from "vitest";
import { test } from "../fixtures.js";
import { ConfigSchema, initHome } from "../../../src/config.js";
import { codexExtractor } from "../../../src/memory/worker.js";

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
    stdin: new PassThrough(),
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
  await writeFile(result, '{"proposals":[]}');
  const child = childProcess();
  vi.mocked(spawn).mockImplementation(() => {
    child.stdin.once("finish", () => {
      if (output === undefined) child.emit("close", 0);
      else
        void writeFile(result, output).then(
          () => child.emit("close", 0),
          (error) => child.emit("error", error),
        );
    });
    return child as unknown as ReturnType<typeof spawn>;
  });

  await expect(codexExtractor(home, config)([], [])).rejects.toThrow(
    SyntaxError,
  );
  expect(await readFile(result, "utf8")).toBe("");
});

test("提炼超时会终止子进程并报告可重试错误", async ({ home }) => {
  await initHome(home);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const child = childProcess();
  const started = new Promise<void>((resolve) => {
    vi.mocked(spawn).mockImplementation(() => {
      resolve();
      return child as unknown as ReturnType<typeof spawn>;
    });
  });

  const extraction = codexExtractor(home, config)([], []);
  const failed = expect(extraction).rejects.toThrow(
    "Codex extraction timed out",
  );
  await started;
  await vi.advanceTimersByTimeAsync(1_000);
  await failed;
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  expect(vi.getTimerCount()).toBe(0);
});
