import { expect, vi } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "../fixtures.js";
import { ConfigSchema } from "../../../src/config.js";
import { EventSchema } from "../../../src/contracts.js";
import { MemoryWorker } from "../../../src/memory/worker.js";
import { MemoryStore } from "../../../src/memory/store.js";

const event = (id: string, role: "user" | "assistant" | "tool") =>
  EventSchema.parse({
    id,
    agent: "codex",
    sessionId: "session",
    turnId: "turn",
    role,
    content: `${id} captured evidence`,
    at: new Date().toISOString(),
  });
const end = {
  agent: "codex" as const,
  sessionId: "session",
  turnId: "turn",
  at: new Date().toISOString(),
};
const config = ConfigSchema.parse({ idleSeconds: 0 });

test("nested independent repositories do not inherit their workspace project", async ({
  store,
  home,
}) => {
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const parent = await store.resolveProject(workspace, true);
  const projects = [];
  for (const name of ["a", "b"]) {
    const root = join(workspace, name);
    await mkdir(root);
    execFileSync("git", ["init", "-q", root]);
    expect(await store.resolveProject(root, false)).toBeUndefined();
    projects.push(await store.resolveProject(root, true));
  }
  expect(new Set([parent!.id, ...projects.map((p) => p!.id)]).size).toBe(3);
  expect(store.projects).toHaveLength(3);
});

test("only matching aliases influence longest-prefix project selection", async ({
  store,
  home,
}) => {
  const parentRoot = join(home, "plain");
  const childRoot = join(parentRoot, "nested");
  const leaf = join(childRoot, "leaf");
  const alias = join(home, "unrelated-alias-with-a-very-very-long-name");
  await mkdir(leaf, { recursive: true });
  await mkdir(alias);
  const parent = await store.addProject(parentRoot);
  await store.addProject(alias, undefined, parent.id);
  const child = await store.addProject(childRoot);
  expect((await store.resolveProject(leaf))?.id).toBe(child.id);
});

test("late events reopen done and skipped turns without replaying duplicate captures", async ({
  store,
}) => {
  const extract = vi.fn(async () => ({
    outcome: "settled" as const,
    proposals: [],
  }));
  const worker = new MemoryWorker(store, config, extract);
  store.ingest([event("user", "user")], end);
  await worker.tick(true);
  expect(store.jobs()[0].state).toBe("skipped");
  store.ingest([event("reply", "assistant")]);
  await worker.tick(true);
  expect(store.jobs()[0].state).toBe("done");
  store.ingest([event("late", "tool")]);
  expect(store.jobs()[0].state).toBe("pending");
  await worker.tick(true);
  expect(store.jobs()[0].state).toBe("done");
  expect(
    store.extractionReview(store.jobs()[0].id)?.review.inputEventIds,
  ).toContain("late");
  store.ingest([event("late", "tool")]);
  await worker.tick(true);
  expect(extract).toHaveBeenCalledTimes(2);
});

test("events arriving during extraction receive a fresh review after checkpoint completion", async ({
  store,
}) => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const extract = vi.fn(async () => {
    if (extract.mock.calls.length === 1) {
      entered();
      await gate;
    }
    return { outcome: "settled" as const, proposals: [] };
  });
  const worker = new MemoryWorker(store, config, extract);
  store.ingest([event("user", "user"), event("reply", "assistant")], end);
  const first = worker.tick(true);
  await started;
  store.ingest([event("late", "tool")]);
  finish();
  await first;
  expect(store.jobs()[0].state).toBe("pending");
  expect(store.extractionReview(store.jobs()[0].id)).toBeUndefined();
  await worker.tick(true);
  expect(extract).toHaveBeenCalledTimes(2);
  expect(store.jobs()[0].state).toBe("done");
  expect(
    store.extractionReview(store.jobs()[0].id)?.review.inputEventIds,
  ).toContain("late");
});

test("restart resumes old checkpoint then schedules evidence outside its snapshot", async ({
  home,
  store,
}) => {
  store.ingest([event("user", "user"), event("reply", "assistant")], end);
  const worker = new MemoryWorker(store, config, async () => ({
    outcome: "settled",
    proposals: [],
  }));
  await worker.tick(true);
  const jobId = store.jobs()[0].id;
  store.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(jobId);
  store.ingest([event("late", "tool")]);
  store.close();
  const recovered = await MemoryStore.open(home);
  try {
    const extract = vi.fn(async () => ({
      outcome: "settled" as const,
      proposals: [],
    }));
    const resumed = new MemoryWorker(recovered, config, extract);
    await resumed.tick(true);
    expect(extract).not.toHaveBeenCalled();
    expect(recovered.jobs()[0].state).toBe("pending");
    await resumed.tick(true);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(recovered.extractionReview(jobId)?.review.inputEventIds).toContain(
      "late",
    );
  } finally {
    recovered.close();
  }
});

test("failed checkpoints survive late evidence and complete before the next review", async ({
  store,
}) => {
  store.ingest([event("user", "user"), event("reply", "assistant")], end);
  const extract = vi.fn(async () => ({
    outcome: "settled" as const,
    proposals: [],
  }));
  const worker = new MemoryWorker(store, config, extract);
  await worker.tick(true);
  const jobId = store.jobs()[0].id;
  const checkpoint = store.extractionReview(jobId);
  store.db.prepare("UPDATE jobs SET state='failed' WHERE id=?").run(jobId);
  store.ingest([event("late", "tool")]);
  expect(store.extractionReview(jobId)).toEqual(checkpoint);
  expect(store.retry(jobId)).toBe(1);
  await worker.tick(true);
  expect(extract).toHaveBeenCalledTimes(1);
  expect(store.jobs()[0].state).toBe("pending");
  await worker.tick(true);
  expect(extract).toHaveBeenCalledTimes(2);
  expect(store.extractionReview(jobId)?.review.inputEventIds).toContain("late");
});

test("prompt budget omissions do not endlessly requeue a completed snapshot", async ({
  store,
}) => {
  const events = [
    event("user", "user"),
    event("reply", "assistant"),
    ...Array.from({ length: 12 }, (_, i) => ({
      ...event(`tool-${i}`, "tool"),
      content: "x".repeat(10000),
    })),
  ];
  store.ingest(events, end);
  const extract = vi.fn(async () => ({
    outcome: "settled" as const,
    proposals: [],
  }));
  const worker = new MemoryWorker(store, config, extract);
  await worker.tick(true);
  const job = store.jobs()[0];
  const review = store.extractionReview(job.id)!.review;
  expect(review.inputEventIds.length).toBeLessThan(events.length);
  expect(review.capturedEventIds).toHaveLength(events.length);
  expect(job.state).toBe("done");
  await worker.tick(true);
  expect(extract).toHaveBeenCalledTimes(1);
});
