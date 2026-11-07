import Database from "better-sqlite3";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CancelledNotificationSchema,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AgentSchema, type Agent } from "./contracts.js";
import { mcpOutcomes, mcpTools } from "./contract-values.js";
import type { ErrorCode } from "./errors.js";

const toolSchema = z.enum(mcpTools);
const outcomeSchema = z.enum(mcpOutcomes);
const dayMs = 86_400_000;
const retentionMs = 30 * dayMs;
const pageSize = 50;
const filename = "mcp-calls.db";

export const McpCallFilters = z.object({
  days: z.enum(["7", "30"]).default("7"),
  tool: toolSchema.optional(),
  agent: AgentSchema.optional(),
  outcome: outcomeSchema.optional(),
  before: z
    .string()
    .regex(/^\d{1,15}:[1-9]\d{0,14}$/)
    .optional(),
});

type Tool = z.infer<typeof toolSchema>;
type Outcome = z.infer<typeof outcomeSchema>;
type Call = {
  id: number;
  tool: Tool;
  agent: Agent;
  at: number;
  durationMs: number;
  outcome: Outcome;
  errorCode: ErrorCode | null;
  responseBytes: number | null;
  searchTotal: number | null;
  searchReturned: number | null;
};

type Summary = {
  tool: Tool;
  calls: number;
  failures: number;
  rejected: number;
  cancelled: number;
  p95Ms: number | null;
  emptySearches: number;
  limitedSearches: number;
  averageResponseBytes: number | null;
};

export type McpCallsPage = {
  summary: Summary[];
  calls: Call[];
  nextCursor: string | null;
};

function openWriter(home: string) {
  const db = new Database(join(home, filename), { timeout: 50 });
  try {
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY,
        tool TEXT NOT NULL,
        agent TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        error_code TEXT,
        response_bytes INTEGER,
        search_total INTEGER,
        search_returned INTEGER
      );
      CREATE INDEX IF NOT EXISTS calls_time ON calls(at_ms, id);
    `);
    const insert = db.prepare(`
      INSERT INTO calls (
        tool, agent, at_ms, duration_ms, outcome, error_code,
        response_bytes, search_total, search_returned
      ) VALUES (
        @tool, @agent, @at, @durationMs, @outcome, @errorCode,
        @responseBytes, @searchTotal, @searchReturned
      )
    `);
    const prune = db.prepare("DELETE FROM calls WHERE at_ms < ?");
    return {
      close: () => db.close(),
      record: db.transaction((call: Omit<Call, "id">) => {
        insert.run(call);
        prune.run(call.at - retentionMs);
      }).immediate,
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

type PendingCall = {
  tool: Tool;
  started: number;
  entered?: boolean;
  errorCode?: ErrorCode;
  responseBytes?: number;
  searchTotal?: number;
  searchReturned?: number;
};

export function observeMcpCalls(home: string, agent: Agent) {
  const pending = new Map<RequestId, PendingCall>();

  return {
    call: (id: RequestId) => pending.get(id),
    wrap(transport: Transport): Transport {
      let writer: ReturnType<typeof openWriter> | undefined;
      const finish = (id: RequestId, outcome: Outcome) => {
        const call = pending.get(id);
        if (!call) return;
        pending.delete(id);
        const at = Date.now();
        const durationMs = Math.round(performance.now() - call.started);
        const success = outcome === "success";
        try {
          (writer ??= openWriter(home)).record({
            tool: call.tool,
            agent,
            at,
            durationMs,
            outcome,
            errorCode:
              outcome === "tool_error" ? (call.errorCode ?? null) : null,
            responseBytes: success ? (call.responseBytes ?? null) : null,
            searchTotal: success ? (call.searchTotal ?? null) : null,
            searchReturned: success ? (call.searchReturned ?? null) : null,
          });
        } catch {
          console.error("[user-memory] Could not record MCP call.");
        }
      };
      const wrapped: Transport = {
        start() {
          transport.onmessage = (message, extra) => {
            if (
              "id" in message &&
              "method" in message &&
              message.method === "tools/call"
            ) {
              const tool = toolSchema.safeParse(message.params?.name);
              pending.set(message.id, {
                tool: tool.success ? tool.data : "unknown",
                started: performance.now(),
              });
            } else if (
              !("id" in message) &&
              "method" in message &&
              message.method === "notifications/cancelled"
            ) {
              const notice = CancelledNotificationSchema.safeParse(message);
              const id = notice.data?.params.requestId;
              if (id !== undefined) finish(id, "cancelled");
            }
            wrapped.onmessage?.(message, extra);
          };
          transport.onerror = (error) => wrapped.onerror?.(error);
          transport.onclose = () => {
            pending.clear();
            writer?.close();
            writer = undefined;
            wrapped.onclose?.();
          };
          return transport.start();
        },
        send(message, options) {
          if ("result" in message) {
            const outcome =
              message.result.isError !== true
                ? "success"
                : pending.get(message.id)?.entered
                  ? "tool_error"
                  : "rejected";
            finish(message.id, outcome);
          } else if ("error" in message && message.id != null) {
            finish(message.id, "protocol_error");
          }
          return transport.send(message, options);
        },
        close: () => transport.close(),
        get sessionId() {
          return transport.sessionId;
        },
        setProtocolVersion: (version) =>
          transport.setProtocolVersion?.(version),
      };
      return wrapped;
    },
  };
}

export function readMcpCalls(
  home: string,
  filters: z.infer<typeof McpCallFilters>,
): McpCallsPage {
  const tools = filters.tool
    ? [filters.tool]
    : mcpTools.filter((tool) => tool !== "unknown");
  const emptySummary = (tool: Tool): Summary => ({
    tool,
    calls: 0,
    failures: 0,
    rejected: 0,
    cancelled: 0,
    p95Ms: null,
    emptySearches: 0,
    limitedSearches: 0,
    averageResponseBytes: null,
  });
  const empty = {
    summary: tools.map(emptySummary),
    calls: [],
    nextCursor: null,
  };
  const path = join(home, filename);
  if (!statSync(path, { throwIfNoEntry: false })) return empty;

  const db = new Database(path, {
    readonly: true,
    fileMustExist: true,
    timeout: 50,
  });
  try {
    return db.transaction(() => {
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'calls'").get())
        return empty;
      const [beforeAt, beforeId] = filters.before?.split(":").map(Number) ?? [];
      const params = {
        cutoff: Date.now() - Number(filters.days) * dayMs,
        tool: filters.tool ?? null,
        agent: filters.agent ?? null,
        outcome: filters.outcome ?? null,
        beforeAt: beforeAt ?? null,
        beforeId: beforeId ?? null,
        limit: pageSize + 1,
      };
      const scope = `at_ms >= @cutoff
        AND (@tool IS NULL OR tool = @tool)
        AND (@agent IS NULL OR agent = @agent)`;
      const summaryRows = db
        .prepare(
          `
        WITH ranked AS (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY tool ORDER BY (outcome = 'cancelled'), duration_ms
            ) AS position,
            COUNT(*) FILTER (WHERE outcome != 'cancelled')
              OVER (PARTITION BY tool) AS completed
          FROM calls WHERE ${scope}
        )
        SELECT tool, COUNT(*) AS calls,
          COUNT(*) FILTER (WHERE outcome NOT IN ('success', 'cancelled')) AS failures,
          COUNT(*) FILTER (WHERE outcome = 'rejected') AS rejected,
          COUNT(*) FILTER (WHERE outcome = 'cancelled') AS cancelled,
          MAX(duration_ms) FILTER (WHERE position = (95 * completed + 99) / 100) AS p95Ms,
          COUNT(*) FILTER (WHERE search_total = 0) AS emptySearches,
          COUNT(*) FILTER (WHERE search_total > search_returned) AS limitedSearches,
          ROUND(AVG(response_bytes)) AS averageResponseBytes
        FROM ranked GROUP BY tool
      `,
        )
        .all(params) as Summary[];
      const byTool = new Map(summaryRows.map((row) => [row.tool, row]));
      const summary = tools.map(
        (tool) => byTool.get(tool) ?? emptySummary(tool),
      );
      const unknown = byTool.get("unknown");
      if (!filters.tool && unknown) summary.push(unknown);

      const rows = db
        .prepare(
          `
        SELECT id, tool, agent, at_ms AS at, duration_ms AS durationMs,
          outcome, error_code AS errorCode, response_bytes AS responseBytes,
          search_total AS searchTotal, search_returned AS searchReturned
        FROM calls WHERE ${scope}
          AND (@outcome IS NULL OR outcome = @outcome)
          AND (@beforeAt IS NULL OR (at_ms, id) < (@beforeAt, @beforeId))
        ORDER BY at_ms DESC, id DESC LIMIT @limit
      `,
        )
        .all(params) as Call[];
      const calls = rows.slice(0, pageSize);
      const last = calls.at(-1);
      const nextCursor =
        rows.length > pageSize && last ? `${last.at}:${last.id}` : null;
      return { summary, calls, nextCursor };
    })();
  } finally {
    db.close();
  }
}
