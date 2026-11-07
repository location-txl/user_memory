import type Database from "better-sqlite3";
import { z } from "zod";
import {
  AgentSchema,
  AppError,
  Id,
  type Memory,
  type MemoryEvent,
} from "../contracts.js";
import { scrub, scrubEvent, terms } from "./files.js";
import type { MemoryStore } from "./store.js";

export const EvidenceSearchSchema = z.object({
  query: z.string().trim().min(1).max(16000),
  projectId: Id.optional(),
  agent: AgentSchema.optional(),
  sessionId: z.string().min(1).max(300).optional(),
});
export const EvidenceId = z.string().min(1).max(300);
export type EvidenceBundle = {
  events: MemoryEvent[];
  unavailableSourceIds: string[];
  omittedSourceIds: string[];
};

export function initializeEvidenceIndex(db: Database.Database) {
  db.transaction(() => {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(body)");
    const insert = db.prepare("INSERT INTO event_fts(rowid,body) VALUES (?,?)");
    const select = db.prepare(
      `SELECT e.rowid,e.data FROM events e WHERE e.rowid>?
       AND NOT EXISTS (SELECT 1 FROM event_fts WHERE rowid=e.rowid)
       ORDER BY e.rowid LIMIT 100`,
    );
    // 索引与回填一起提交，升级中断后不会留下只有部分旧事件的索引。
    let after = 0;
    while (true) {
      const rows = select.all(after) as { rowid: number; data: string }[];
      if (!rows.length) break;
      for (const row of rows) {
        const event = JSON.parse(row.data) as MemoryEvent;
        insert.run(row.rowid, terms(scrub(event.content)));
      }
      after = rows.at(-1)!.rowid;
    }
  })();
}

const visibleEvidence = `
  (e.project_id IS NULL OR e.project_id = @projectId)
  AND instr(json_extract(e.data, '$.content'), '<user-memory-context>') = 0
  AND e.id NOT IN (
    SELECT json_extract(s.value, '$.id') FROM memory_index m, json_each(m.data, '$.sources') s
    WHERE json_extract(m.data, '$.status') = 'withdrawn'
  )`;

function readEvidence(store: MemoryStore, id: string, projectId?: string) {
  const row = store.db
    .prepare(
      `SELECT e.data FROM events e WHERE e.id=@id AND ${visibleEvidence}`,
    )
    .get({ id, projectId: projectId ?? null }) as { data: string } | undefined;
  return row ? scrubEvent(JSON.parse(row.data) as MemoryEvent) : undefined;
}

export async function getEvidence(
  store: MemoryStore,
  id: string,
  projectId?: string,
) {
  store.requireProject(projectId);
  await store.refresh();
  const event = readEvidence(store, id, projectId);
  if (!event)
    throw new AppError(
      404,
      "证据未采集、已撤回或不属于当前项目；可查看记忆中保留的来源摘录。",
      "EVIDENCE_NOT_FOUND",
    );
  return event;
}

export async function searchEvidence(
  store: MemoryStore,
  input: z.infer<typeof EvidenceSearchSchema>,
) {
  store.requireProject(input.projectId);
  await store.refresh();
  const tokens = [
    ...new Set(terms(input.query).split(" ").filter(Boolean)),
  ].slice(0, 40);
  if (!tokens.length) return { total: 0, results: [] };
  const where = `event_fts MATCH @match AND ${visibleEvidence}
    AND (@agent IS NULL OR e.agent = @agent)
    AND (@sessionId IS NULL OR e.session_id = @sessionId)`;
  const params = {
    match: tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR "),
    projectId: input.projectId ?? null,
    agent: input.agent ?? null,
    sessionId: input.sessionId ?? null,
  };
  const from = "event_fts JOIN events e ON e.rowid = event_fts.rowid";
  const total = store.db
    .prepare(`SELECT count(*) FROM ${from} WHERE ${where}`)
    .pluck()
    .get(params) as number;
  const rows = store.db
    .prepare(
      `SELECT e.data FROM ${from} WHERE ${where}
     ORDER BY bm25(event_fts), e.rowid DESC LIMIT 12`,
    )
    .all(params) as { data: string }[];
  return {
    total,
    results: rows.map(({ data }) => {
      const e = scrubEvent(JSON.parse(data) as MemoryEvent);
      return {
        id: e.id,
        agent: e.agent,
        sessionId: e.sessionId,
        projectId: e.projectId,
        role: e.role,
        at: e.at,
        excerpt: e.content.slice(0, 1200),
        truncated: e.content.length > 1200,
      };
    }),
  };
}

export async function collectEvidence(
  store: MemoryStore,
  memories: Memory[],
  projectId?: string,
): Promise<EvidenceBundle> {
  store.requireProject(projectId);
  await store.refresh();
  const bundle: EvidenceBundle = {
    events: [],
    unavailableSourceIds: [],
    omittedSourceIds: [],
  };
  const seen = new Set<string>();
  let remaining = 48000 - 2;
  for (const memory of memories) {
    for (const source of memory.sources.slice(-3).reverse()) {
      if (seen.has(source.id)) continue;
      seen.add(source.id);
      const event = readEvidence(store, source.id, projectId);
      if (!event) {
        bundle.unavailableSourceIds.push(source.id);
        continue;
      }
      const size =
        JSON.stringify(event).length + (bundle.events.length ? 1 : 0);
      if (size > remaining) {
        bundle.omittedSourceIds.push(source.id);
        continue;
      }
      remaining -= size;
      bundle.events.push(event);
    }
  }
  return bundle;
}
