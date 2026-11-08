import { expect, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, addTestProject } from "../fixtures.js";
import {
  CreateMemorySchema,
  type MemoryEvent,
} from "../../../src/contracts.js";
import { encodeMemory } from "../../../src/memory/files.js";

const reads = vi.hoisted(() => ({
  before: undefined as undefined | ((file: string) => Promise<void>),
  after: undefined as undefined | ((file: string) => void),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      await reads.before?.(String(args[0]));
      const result = await actual.readFile(...args);
      reads.after?.(String(args[0]));
      return result;
    },
  };
});

test("历史文件读取期间补入项目事件，全部版本使用最终来源投影", async ({
  store,
}) => {
  const project = await addTestProject(store, "history-project");
  const event: MemoryEvent = {
    id: "late-history-source",
    agent: "codex",
    role: "user",
    sessionId: "private-session",
    projectId: project.id,
    content: "private-history-text",
    at: "2026-11-08",
    injected: false,
    worker: false,
  };
  const memory = await store.create(
    CreateMemorySchema.parse({
      title: "历史来源",
      content: "共享偏好",
      scope: "global",
      sources: [
        {
          id: event.id,
          agent: event.agent,
          role: event.role,
          sessionId: event.sessionId,
          at: event.at,
          excerpt: event.content,
        },
      ],
    }),
  );
  const dir = join(store.home, "history", memory.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "1.md"), encodeMemory(memory, memory.content));
  await writeFile(
    join(dir, "2.md"),
    encodeMemory({ ...memory, revision: 2 }, memory.content),
  );
  let release!: () => void;
  let started!: () => void;
  let finishFirst!: () => void;
  const firstRead = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  reads.before = async (file) => {
    if (file === join(dir, "2.md")) {
      started();
      await gate;
    }
  };
  reads.after = (file) => {
    if (file === join(dir, "1.md")) finishFirst();
  };
  try {
    const pending = store.history(memory.id);
    await blocked;
    await firstRead;
    // Flush the first read continuation while the second is explicitly blocked.
    await setImmediate();
    store.ingest([event]);
    release();
    const history = await pending;
    expect(history).toHaveLength(2);
    for (const revision of history) {
      expect(revision.sources[0].excerpt).toBe("");
      expect(revision.sources[0].sessionId).toBeUndefined();
    }
  } finally {
    release();
    reads.before = undefined;
    reads.after = undefined;
  }
});
