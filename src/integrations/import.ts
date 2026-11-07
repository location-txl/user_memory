import { readdir, readFile, lstat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { AppError, type CreateMemory } from "../contracts.js";
import { fingerprint, scrub } from "../memory/files.js";
import type { MemoryStore } from "../memory/store.js";

export async function previewImport(path: string) {
  const root = resolve(path);
  const paths: string[] = [];
  async function visit(file: string, depth: number) {
    if (depth > 4 || paths.length >= 200)
      throw new AppError(
        400,
        "单次导入最多 200 个文件、4 层目录，请选择更具体的目录",
        "IMPORT_LIMIT_EXCEEDED",
        { maxFiles: 200, maxDepth: 4 },
      );
    const info = await lstat(file);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const name of await readdir(file))
        if (!name.startsWith(".")) await visit(join(file, name), depth + 1);
    } else if (file.endsWith(".md")) paths.push(file);
  }
  await visit(root, 0);
  return Promise.all(
    paths.map(async (file) => {
      const info = await lstat(file);
      if (info.size > 128000)
        throw new AppError(
          400,
          `${basename(file)} 太大，请先拆分`,
          "IMPORT_FILE_TOO_LARGE",
          { path: file, maxBytes: 128000 },
        );
      const raw = await readFile(file, "utf8");
      const content = scrub(raw);
      return {
        path: file,
        hash: fingerprint(raw),
        title: basename(file, ".md"),
        preview: content.slice(0, 1200),
        size: raw.length,
        index: /^(MEMORY|memory_summary)\.md$/.test(basename(file)),
      };
    }),
  );
}
export async function importFiles(
  store: MemoryStore,
  files: { path: string; hash: string }[],
  scope: "global" | "project",
  projectId?: string,
) {
  store.requireProject(projectId);
  if (scope === "project" && !projectId)
    throw new AppError(400, "请选择导入目标项目", "IMPORT_PROJECT_REQUIRED");
  const memories = [];
  for (const file of files) {
    const raw = await readFile(file.path, "utf8");
    if (fingerprint(raw) !== file.hash)
      throw new AppError(
        409,
        "来源文件已改变，请重新预览",
        "IMPORT_SOURCE_CHANGED",
        { path: file.path },
      );
    if (raw.length > 16000)
      throw new AppError(
        400,
        `${basename(file.path)} 超过单条记忆限制，请拆分后导入`,
        "IMPORT_MEMORY_TOO_LARGE",
        { path: file.path, maxLength: 16000 },
      );
    const data: CreateMemory = {
      title: basename(file.path, ".md"),
      content: scrub(raw),
      scope,
      projectId: scope === "project" ? projectId : undefined,
      kind: "lesson",
      status: "candidate",
      reason: "历史记忆导入，需核对适用范围与时效后批准。",
      sources: [
        {
          id: `import:${fingerprint(`${resolve(file.path)}:${file.hash}`)}`,
          agent: "import",
          role: "import",
          path: resolve(file.path),
          excerpt: scrub(raw).slice(0, 4000),
          at: new Date().toISOString(),
        },
      ],
    };
    const id = fingerprint(
      `${scope}:${projectId ?? ""}:${resolve(file.path)}:${file.hash}`,
    ).slice(0, 32);
    memories.push(await store.create(data, id));
  }
  return memories;
}
export function nativeLocations() {
  return [
    { agent: "codex", path: join(homedir(), ".codex/memories_v2") },
    { agent: "codex", path: join(homedir(), ".codex/memories") },
    { agent: "zcode", path: join(homedir(), ".zcode/cli/memories/projects") },
    { agent: "claude", path: join(homedir(), ".claude/projects") },
    { agent: "hermes", path: join(homedir(), ".hermes/memories") },
  ];
}
