import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base } from "vitest";
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
