import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join } from "node:path";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { z } from "zod";
import {
  AppError,
  Id,
  type CreateMemory,
  type Memory,
  type MemoryEvent,
  type MemoryMeta,
  type Project,
} from "../contracts.js";
import { atomicWrite, initHome, readOptional } from "../config.js";
import { errorMessages } from "../errors.js";
import { decodeMemory, encodeMemory, scrub, terms } from "./files.js";

const exec = promisify(execFile);
const ProjectSchema = z.object({
  id: Id,
  memoryDirectory: z.string().regex(/^[\p{L}\p{N}_-]+$/u),
  name: z.string(),
  roots: z.array(z.string()),
  gitCommonDir: z.string().optional(),
});
export type Job = {
  id: number;
  agent: string;
  session_id: string;
  project_id: string | null;
  state: string;
  error: string | null;
  updated_at: string;
};
export type ExtractionTokens = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
};
export type ExtractionUsage = {
  model: string | null;
  calls: number;
  reportedCalls: number;
  cacheReportedCalls: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export class MemoryStore {
  readonly db: Database.Database;
  readonly memories = new Map<string, Memory>();
  errors: string[] = [];
  projects: Project[] = [];
  private signatures = new Map<string, string>();
  private tail: Promise<unknown> = Promise.resolve();
  private refreshTail: Promise<unknown> = Promise.resolve();

  private constructor(readonly home: string) {
    this.db = new Database(join(home, "runtime.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_index (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, title, body);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL, project_id TEXT, data TEXT NOT NULL, job_id INTEGER);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL, project_id TEXT, state TEXT NOT NULL DEFAULT 'pending', error TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS extraction_usage (
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        model TEXT NOT NULL,
        calls INTEGER NOT NULL,
        reported_calls INTEGER NOT NULL,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        cache_reported_calls INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER,
        PRIMARY KEY (job_id, model)
      );
      CREATE TABLE IF NOT EXISTS receipts (agent TEXT PRIMARY KEY, captured_at TEXT, recalled_at TEXT);
      CREATE TABLE IF NOT EXISTS recalls (binding TEXT PRIMARY KEY, versions TEXT NOT NULL);
    `);
    this.db
      .transaction(() => {
        const columns = this.db.pragma("table_info(extraction_usage)") as {
          name: string;
        }[];
        if (!columns.some(({ name }) => name === "cached_input_tokens")) {
          this.db.exec(`
          ALTER TABLE extraction_usage ADD COLUMN cached_input_tokens INTEGER;
          ALTER TABLE extraction_usage ADD COLUMN cache_reported_calls INTEGER NOT NULL DEFAULT 0;
        `);
        }
      })
      .immediate();
  }
  static async open(home: string) {
    await initHome(home);
    const store = new MemoryStore(home);
    const raw = await readOptional(join(home, "projects.json"));
    store.projects = z.array(ProjectSchema).parse(raw ? JSON.parse(raw) : []);
    store.db.exec(
      "UPDATE jobs SET state='pending', error='The service exited before the job finished. Waiting to retry.' WHERE state='running'",
    );
    await store.refresh(true);
    return store;
  }
  close() {
    this.db.close();
  }
  async serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }
  async refresh(force = false) {
    const next = this.refreshTail.then(() => this.refreshFiles(force));
    this.refreshTail = next.catch(() => {});
    return next;
  }
  private memoryPath(memory: Pick<MemoryMeta, "id" | "scope" | "projectId">) {
    if (memory.scope === "global")
      return join(this.home, "memories", "global", `${memory.id}.md`);
    const project = this.projects.find((p) => p.id === memory.projectId);
    if (!project) throw new Error(errorMessages.PROJECT_NOT_FOUND);
    return join(
      this.home,
      "memories",
      "projects",
      project.memoryDirectory,
      `${memory.id}.md`,
    );
  }
  private async refreshFiles(force: boolean) {
    const dir = join(this.home, "memories");
    const directories = [
      "global",
      ...this.projects.map((p) => join("projects", p.memoryDirectory)),
    ];
    const files: string[] = [];
    for (const directory of directories) {
      const entries = await readdir(join(dir, directory), {
        withFileTypes: true,
      }).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT" && directory !== "global") return [];
        throw e;
      });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md"))
          files.push(join(directory, entry.name));
      }
    }
    files.sort();
    const signatures = new Map<string, string>();
    for (const file of files) {
      const info = await stat(join(dir, file));
      signatures.set(file, `${info.mtimeMs}:${info.ctimeMs}:${info.size}`);
    }
    if (
      !force &&
      signatures.size === this.signatures.size &&
      [...signatures].every(([f, s]) => this.signatures.get(f) === s)
    )
      return;
    const next = new Map<string, Memory>();
    const errors: string[] = [];
    for (const file of files) {
      try {
        const memory = decodeMemory(
          await readFile(join(dir, file), "utf8"),
          join(dir, file),
        );
        if (basename(file) !== `${memory.id}.md`)
          throw new Error(`${file}: Filename must match the memory ID`);
        if (
          memory.projectId &&
          !this.projects.some((p) => p.id === memory.projectId)
        )
          throw new Error(`${file}: ${errorMessages.PROJECT_NOT_FOUND}`);
        if (join(dir, file) !== this.memoryPath(memory))
          throw new Error(
            `${file}: Memory directory must match its scope and project`,
          );
        next.set(memory.id, memory);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    this.db.transaction(() => {
      this.db.exec("DELETE FROM memory_index; DELETE FROM memory_fts;");
      const insert = this.db.prepare("INSERT INTO memory_index VALUES (?, ?)");
      const index = this.db.prepare(
        "INSERT INTO memory_fts(id,title,body) VALUES (?, ?, ?)",
      );
      for (const m of next.values()) {
        insert.run(m.id, JSON.stringify(m));
        if (m.status === "active")
          index.run(m.id, terms(m.title), terms(m.content));
      }
    })();
    this.memories.clear();
    for (const [id, m] of next) this.memories.set(id, m);
    this.signatures = signatures;
    this.errors = errors;
  }
  requireProject(projectId?: string) {
    if (projectId && !this.projects.some((p) => p.id === projectId))
      throw new AppError(400, "项目不存在", "PROJECT_NOT_FOUND");
  }
  async resolveProject(
    cwd?: string,
    create = false,
  ): Promise<Project | undefined> {
    if (!cwd) return undefined;
    const absolute = await realpath(cwd);
    const exact = this.projects.find((p) => p.roots.includes(absolute));
    if (exact) return exact;
    let root = absolute;
    let gitCommonDir: string | undefined;
    try {
      const result = await exec(
        "git",
        [
          "-C",
          absolute,
          "rev-parse",
          "--show-toplevel",
          "--path-format=absolute",
          "--git-common-dir",
        ],
        { timeout: 2000 },
      );
      const lines = result.stdout.trim().split("\n");
      root = await realpath(lines[0]);
      gitCommonDir = await realpath(lines[1]);
    } catch {
      /* 非 Git 目录使用已登记的根目录。 */
    }
    const known =
      this.projects.find(
        (p) => gitCommonDir && p.gitCommonDir === gitCommonDir,
      ) ??
      this.projects
        .filter((p) =>
          p.roots.some((r) => absolute === r || absolute.startsWith(`${r}/`)),
        )
        .sort(
          (a, b) =>
            Math.max(...b.roots.map((r) => r.length)) -
            Math.max(...a.roots.map((r) => r.length)),
        )[0];
    if (known || !create) return known;
    return this.addProject(root, undefined, undefined, gitCommonDir);
  }
  async addProject(
    root: string,
    name?: string,
    existingId?: string,
    gitCommonDir?: string,
  ) {
    return this.serial(async () => {
      const path = await realpath(root);
      const duplicate = this.projects.find((p) => p.roots.includes(path));
      if (duplicate && duplicate.id !== existingId) {
        if (existingId)
          throw new AppError(
            409,
            "目录已绑定其他项目",
            "PROJECT_ALREADY_BOUND",
          );
        return duplicate;
      }
      const project = existingId
        ? this.projects.find((p) => p.id === existingId)
        : undefined;
      if (existingId && !project)
        throw new AppError(404, "项目不存在", "PROJECT_NOT_FOUND");
      const id = project?.id ?? randomUUID();
      const projectName = name || path.split("/").at(-1) || path;
      const prefix =
        [
          ...projectName
            .replace(/[^\p{L}\p{N}_-]+/gu, "-")
            .replace(/^-+|-+$/g, ""),
        ]
          .slice(0, 48)
          .join("") || "project";
      const result = project ?? {
        id,
        name: projectName,
        memoryDirectory: `${prefix}-${id}`,
        roots: [],
        gitCommonDir,
      };
      if (!result.roots.includes(path)) result.roots.push(path);
      if (!project) this.projects.push(result);
      await atomicWrite(
        join(this.home, "projects.json"),
        JSON.stringify(this.projects, null, 2),
      );
      return result;
    });
  }
  async list(
    options: {
      query?: string;
      projectId?: string;
      scope?: string;
      status?: string;
      allProjects?: boolean;
    } = {},
  ) {
    await this.refresh();
    this.requireProject(options.projectId);
    let list = [...this.memories.values()].filter(
      (m) =>
        (options.allProjects ||
          m.scope === "global" ||
          (options.projectId && m.projectId === options.projectId)) &&
        (!options.scope || m.scope === options.scope) &&
        (!options.status || m.status === options.status),
    );
    if (options.query?.trim()) {
      const tokens = terms(options.query)
        .split(" ")
        .filter(Boolean)
        .slice(0, 40);
      if (!tokens.length) return [];
      const match = tokens
        .map((t) => `"${t.replaceAll('"', '""')}"`)
        .join(" OR ");
      const ranked = this.db
        .prepare(
          "SELECT id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts,0,3,1)",
        )
        .all(match) as { id: string }[];
      const ranks = new Map(ranked.map((r, i) => [r.id, i]));
      list = list.filter(
        (m) =>
          ranks.has(m.id) ||
          (m.status !== "active" &&
            `${m.title} ${m.content}`
              .toLowerCase()
              .includes(options.query!.toLowerCase())),
      );
      list.sort((a, b) => (ranks.get(a.id) ?? 1e9) - (ranks.get(b.id) ?? 1e9));
      return list;
    }
    return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async get(id: string) {
    await this.refresh();
    const memory = this.memories.get(id);
    if (!memory)
      throw new AppError(404, "记忆不存在或文件格式无效", "MEMORY_NOT_FOUND");
    return memory;
  }
  async create(input: CreateMemory, fixedId?: string): Promise<Memory> {
    return this.serial(async () => {
      await this.refresh();
      this.requireProject(input.projectId);
      const duplicate = [...this.memories.values()].find(
        (m) =>
          m.status !== "withdrawn" &&
          m.scope === input.scope &&
          m.projectId === input.projectId &&
          m.content.trim() === input.content.trim(),
      );
      if (duplicate) return duplicate;
      const id = Id.parse(fixedId ?? randomUUID());
      const previous = this.memories.get(id);
      if (previous) return previous;
      const now = new Date().toISOString();
      const { content, ...data } = input;
      const meta: MemoryMeta = {
        ...data,
        id,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const file = this.memoryPath(meta);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await atomicWrite(file, encodeMemory(meta, scrub(content)));
      await this.refresh(true);
      return this.memories.get(id)!;
    });
  }
  async revise(
    id: string,
    revision: number,
    changes: Partial<
      Pick<Memory, "title" | "content" | "status" | "reason" | "sources">
    >,
    etag: string,
  ) {
    return this.serial(async () => {
      const memory = await this.get(id);
      if (memory.revision !== revision || memory.etag !== etag)
        throw new AppError(
          409,
          errorMessages.MEMORY_CONFLICT,
          "MEMORY_CONFLICT",
        );
      if (memory.status === "withdrawn")
        throw new AppError(
          409,
          errorMessages.MEMORY_WITHDRAWN,
          "MEMORY_WITHDRAWN",
        );
      const historyDir = join(this.home, "history", id);
      await mkdir(historyDir, { recursive: true });
      await atomicWrite(
        join(historyDir, `${revision}-${memory.etag.slice(0, 12)}.md`),
        await readFile(memory.file, "utf8"),
      );
      const { content, file, etag: oldEtag, ...meta } = memory;
      const { content: nextContent, ...metadata } = changes;
      await atomicWrite(
        file,
        encodeMemory(
          {
            ...meta,
            ...metadata,
            revision: revision + 1,
            updatedAt: new Date().toISOString(),
          },
          scrub(nextContent ?? content),
        ),
      );
      await this.refresh(true);
      return this.memories.get(id)!;
    });
  }
  async history(id: string) {
    Id.parse(id);
    const dir = join(this.home, "history", id);
    const files = await readdir(dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
    return Promise.all(
      files
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map(async (f) =>
          decodeMemory(await readFile(join(dir, f), "utf8"), join(dir, f)),
        ),
    );
  }
  ingest(events: MemoryEvent[]) {
    let added = 0;
    this.db.transaction(() => {
      for (const event of events) {
        if (event.injected || event.worker) continue;
        this.requireProject(event.projectId);
        const saved = { ...event, content: scrub(event.content) };
        const result = this.db
          .prepare(
            "INSERT OR IGNORE INTO events(id,agent,session_id,project_id,data) VALUES (?,?,?,?,?)",
          )
          .run(
            event.id,
            event.agent,
            event.sessionId,
            event.projectId ?? null,
            JSON.stringify(saved),
          );
        if (!result.changes) continue;
        added++;
        this.db
          .prepare(
            "INSERT INTO receipts(agent,captured_at) VALUES (?,?) ON CONFLICT(agent) DO UPDATE SET captured_at=excluded.captured_at",
          )
          .run(event.agent, new Date().toISOString());
        const pending = this.db
          .prepare(
            "SELECT id FROM jobs WHERE agent=? AND session_id=? AND project_id IS ? AND state='pending'",
          )
          .get(event.agent, event.sessionId, event.projectId ?? null) as
          { id: number } | undefined;
        const jobId =
          pending?.id ??
          Number(
            this.db
              .prepare(
                "INSERT INTO jobs(agent,session_id,project_id,updated_at) VALUES (?,?,?,?)",
              )
              .run(
                event.agent,
                event.sessionId,
                event.projectId ?? null,
                new Date().toISOString(),
              ).lastInsertRowid,
          );
        this.db
          .prepare("UPDATE events SET job_id=? WHERE id=?")
          .run(jobId, event.id);
        this.db
          .prepare("UPDATE jobs SET updated_at=? WHERE id=?")
          .run(new Date().toISOString(), jobId);
      }
    })();
    return added;
  }
  recordExtractionUsage(
    jobId: number,
    model: string | null,
    usage?: ExtractionTokens,
  ) {
    this.db
      .prepare(
        `
        INSERT INTO extraction_usage (
          job_id, model, calls, reported_calls, input_tokens, output_tokens,
          cache_reported_calls, cached_input_tokens
        )
        VALUES (?, ?, 1, ?, ?, ?, ?, ?)
        ON CONFLICT (job_id, model) DO UPDATE SET
          calls = calls + 1,
          reported_calls = reported_calls + excluded.reported_calls,
          cache_reported_calls = cache_reported_calls + excluded.cache_reported_calls,
          input_tokens = COALESCE(input_tokens + excluded.input_tokens, input_tokens, excluded.input_tokens),
          cached_input_tokens = COALESCE(cached_input_tokens + excluded.cached_input_tokens, cached_input_tokens, excluded.cached_input_tokens),
          output_tokens = COALESCE(output_tokens + excluded.output_tokens, output_tokens, excluded.output_tokens)
      `,
      )
      .run(
        jobId,
        model ?? "",
        usage ? 1 : 0,
        usage?.inputTokens ?? null,
        usage?.outputTokens ?? null,
        usage?.cachedInputTokens === undefined ? 0 : 1,
        usage?.cachedInputTokens ?? null,
      );
  }
  jobs() {
    const jobs = this.db
      .prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT 100")
      .all() as Job[];
    const usage = this.db
      .prepare(
        `
      SELECT job_id, NULLIF(model, '') AS model, calls, reported_calls AS reportedCalls,
             cache_reported_calls AS cacheReportedCalls, cached_input_tokens AS cachedInputTokens,
             input_tokens AS inputTokens, output_tokens AS outputTokens,
             input_tokens + output_tokens AS totalTokens
      FROM extraction_usage
      WHERE job_id IN (SELECT id FROM jobs ORDER BY id DESC LIMIT 100)
      ORDER BY model
    `,
      )
      .all() as (ExtractionUsage & { job_id: number })[];
    const byJob = new Map<number, ExtractionUsage[]>();
    for (const { job_id, ...row } of usage) {
      const rows = byJob.get(job_id) ?? [];
      rows.push(row);
      byJob.set(job_id, rows);
    }
    return jobs.map((job) => ({
      ...job,
      usageByModel: byJob.get(job.id) ?? [],
    }));
  }
  events(jobId: number) {
    return (
      this.db
        .prepare("SELECT data FROM events WHERE job_id=? ORDER BY rowid")
        .all(jobId) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as MemoryEvent);
  }
  retry(jobId: number) {
    return this.db
      .prepare(
        "UPDATE jobs SET state='pending',error=NULL,updated_at=? WHERE id=? AND state='failed'",
      )
      .run(new Date().toISOString(), jobId).changes;
  }
  status() {
    return {
      memories: this.memories.size,
      active: [...this.memories.values()].filter((m) => m.status === "active")
        .length,
      candidates: [...this.memories.values()].filter(
        (m) => m.status === "candidate",
      ).length,
      errors: this.errors,
      receipts: this.db.prepare("SELECT * FROM receipts").all(),
      jobs: this.jobs(),
      extractionUsageByModel: this.db
        .prepare(
          `
        SELECT NULLIF(model, '') AS model, SUM(calls) AS calls,
               SUM(cache_reported_calls) AS cacheReportedCalls, SUM(cached_input_tokens) AS cachedInputTokens,
               SUM(reported_calls) AS reportedCalls, SUM(input_tokens) AS inputTokens,
               SUM(output_tokens) AS outputTokens, SUM(input_tokens + output_tokens) AS totalTokens
        FROM extraction_usage GROUP BY extraction_usage.model ORDER BY model
      `,
        )
        .all() as ExtractionUsage[],
    };
  }
  async drainSpool() {
    const directory = join(this.home, "spool");
    const { EventSchema } = await import("../contracts.js");
    for (const file of (await readdir(directory)).filter((f) =>
      f.endsWith(".json"),
    )) {
      const path = join(directory, file);
      try {
        const events = z
          .array(EventSchema)
          .parse(JSON.parse(await readFile(path, "utf8")));
        for (const event of events)
          if (!event.projectId && event.cwd)
            event.projectId = (await this.resolveProject(event.cwd, true))?.id;
        this.ingest(events);
        await unlink(path);
      } catch (e) {
        const message = `Queued event file ${file}: ${e instanceof Error ? e.message : String(e)}`;
        if (!this.errors.includes(message)) this.errors.push(message);
      }
    }
  }
}
