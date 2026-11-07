import { expect } from "vitest";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, addTestProject } from "../fixtures.js";
import { RecallSchema } from "../../../src/contracts.js";
import { recall } from "../../../src/memory/recall.js";
import {
  importFiles,
  previewImport,
} from "../../../src/integrations/import.js";

test("导入需匹配预览指纹；批准后仅目标项目可召回，撤回后重导不复活", async ({
  home,
  store,
}) => {
  const path = join(home, "original.md");
  const project = await addTestProject(store, "target");
  const other = await addTestProject(store, "other");
  await writeFile(path, "我长期使用中文");
  const preview = await previewImport(path);
  await writeFile(path, "使用 TypeScript 开发");
  await expect(
    importFiles(store, preview, "project", project.id),
  ).rejects.toMatchObject({
    status: 409,
    code: "IMPORT_SOURCE_CHANGED",
  });
  const latest = await previewImport(path);
  await expect(importFiles(store, latest, "project")).rejects.toMatchObject({
    status: 400,
    code: "IMPORT_PROJECT_REQUIRED",
  });
  const [memory] = await importFiles(store, latest, "project", project.id);
  expect(memory).toMatchObject({ status: "candidate", projectId: project.id });
  const request = RecallSchema.parse({
    projectId: project.id,
    query: "TypeScript",
  });
  expect((await recall(store, request)).memories).toEqual([]);
  const active = await store.revise(
    memory.id,
    memory.revision,
    { status: "active" },
    memory.etag,
  );
  expect(
    (await store.list({ ...request, status: "active" })).map((m) => m.id),
  ).toEqual([memory.id]);
  expect((await recall(store, request)).memories).toMatchObject([
    { id: memory.id, revision: active.revision },
  ]);
  expect(
    (await recall(store, { ...request, projectId: other.id })).memories,
  ).toEqual([]);
  await store.revise(
    active.id,
    active.revision,
    { status: "withdrawn" },
    active.etag,
  );
  const result = await recall(store, request);
  expect(result.memories).toEqual([]);
  expect(result.changes).toEqual([expect.stringContaining("已撤回")]);
  expect(
    (await importFiles(store, latest, "project", project.id))[0],
  ).toMatchObject({
    id: memory.id,
    status: "withdrawn",
  });
  expect(await readFile(path, "utf8")).toBe("使用 TypeScript 开发");
});

test.skipIf(process.platform === "win32")(
  "预览只纳入可见 Markdown 文件并跳过软链接",
  async ({ home }) => {
    const directory = join(home, "import");
    const external = join(home, "external.md");
    await mkdir(join(directory, ".hidden"), { recursive: true });
    await writeFile(external, "外部文件");
    await writeFile(join(directory, "MEMORY.md"), "可预览");
    await writeFile(join(directory, ".secret.md"), "隐藏文件");
    await writeFile(join(directory, ".hidden", "entry.md"), "隐藏目录");
    await writeFile(join(directory, "notes.txt"), "普通文本");
    await symlink(external, join(directory, "link.md"));
    expect(await previewImport(directory)).toMatchObject([
      { path: join(directory, "MEMORY.md"), preview: "可预览", index: true },
    ]);
  },
);
