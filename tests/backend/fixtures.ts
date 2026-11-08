import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base } from "vitest";
import type { MemoryEvent } from "../../src/contracts.js";
import { MemoryStore } from "../../src/memory/store.js";

export const test = base.extend<{ home: string; store: MemoryStore }>({
  home: async ({}, use) => {
    const home = await mkdtemp(join(tmpdir(), "umem-test-"));
    try {
      await use(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  store: async ({ home }, use) => {
    const store = await MemoryStore.open(home);
    try {
      await use(store);
    } finally {
      if (store.db.open) store.close();
    }
  },
});

export async function addTestProject(store: MemoryStore, name: string) {
  const path = join(store.home, name);
  await mkdir(path);
  return store.addProject(path);
}

export function capturedEvents(store: MemoryStore): MemoryEvent[] {
  const rows = store.db
    .prepare("SELECT data FROM events ORDER BY rowid")
    .all() as { data: string }[];
  return rows.map(({ data }) => JSON.parse(data));
}

export function reviewTurn(store: MemoryStore, events: MemoryEvent[]) {
  const first = events[0];
  const turnId = first.turnId ?? `turn-${first.id}`;
  const { agent, sessionId, projectId, cwd } = first;
  const at = new Date().toISOString();
  const fallback: MemoryEvent[] = [];
  if (!events.some((event) => event.role === "user"))
    fallback.push({
      ...first,
      id: `${first.id}:request`,
      role: "user",
      content: "请处理当前任务",
    });
  if (!events.some((event) => event.role !== "user"))
    fallback.push({
      ...first,
      id: `${first.id}:reply`,
      role: "assistant",
      content: "已回复",
    });
  return (
    store.ingest(
      [...events, ...fallback].map((event) => ({ ...event, turnId })),
      {
        agent,
        sessionId,
        projectId,
        cwd,
        turnId,
        at,
      },
    ) - fallback.length
  );
}
