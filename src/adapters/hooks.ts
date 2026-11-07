import { z } from "zod";
import { join } from "node:path";
import { open, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { atomicWrite, initHome, readOptional } from "../config.js";
import { MemoryClient } from "../client.js";
import { type Agent, type MemoryEvent } from "../contracts.js";
import { fingerprint, scrub } from "../memory/files.js";

const HookInput = z
  .object({
    session_id: z.string().optional(),
    sessionId: z.string().optional(),
    hook_event_name: z.string(),
    cwd: z.string().optional(),
    prompt: z.string().optional(),
    last_assistant_message: z.string().optional(),
    transcript_path: z.string().nullable().optional(),
    turn_id: z.string().optional(),
  })
  .passthrough();
const TranscriptLine = z
  .object({
    type: z.string().optional(),
    uuid: z.string().optional(),
    id: z.string().optional(),
    timestamp: z.string().optional(),
    message: z.unknown().optional(),
    payload: z.unknown().optional(),
  })
  .passthrough();
const Message = z
  .object({ role: z.enum(["user", "assistant", "tool"]), content: z.unknown() })
  .passthrough();
export function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const v = z
        .object({ text: z.string().optional(), type: z.string().optional() })
        .safeParse(item);
      return v.success ? (v.data.text ?? "") : "";
    })
    .filter(Boolean)
    .join("\n");
}
export function transcriptEvent(
  line: string,
  agent: Agent,
  sessionId: string,
  offset: number,
  cwd?: string,
): MemoryEvent | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return;
  }
  const parsed = TranscriptLine.safeParse(json);
  if (!parsed.success) return;
  const row = parsed.data;
  const toolOutput = z
    .object({ type: z.literal("function_call_output"), output: z.string() })
    .safeParse(row.payload);
  if (agent === "codex" && toolOutput.success) {
    if (toolOutput.data.output === "") return;
    return {
      id: `${agent}:${sessionId}:${fingerprint(`${offset}:${line}`).slice(0, 24)}`,
      agent,
      sessionId,
      cwd,
      role: "tool",
      content: scrub(toolOutput.data.output).slice(0, 32000),
      at: row.timestamp ?? new Date().toISOString(),
      injected: false,
      worker: false,
    };
  }
  const value =
    agent === "codex"
      ? row.type === "response_item"
        ? row.payload
        : undefined
      : row.message;
  const message = Message.safeParse(value);
  if (!message.success) return;
  const content = plainText(message.data.content);
  if (!content || content.includes("<user-memory-context>")) return;
  return {
    id: `${agent}:${sessionId}:${row.uuid ?? row.id ?? fingerprint(`${offset}:${line}`).slice(0, 24)}`,
    agent,
    sessionId,
    cwd,
    role: message.data.role,
    content: scrub(content).slice(0, 32000),
    at: row.timestamp ?? new Date().toISOString(),
    injected: false,
    worker: false,
  };
}
export async function spoolEvents(home: string, events: MemoryEvent[]) {
  if (!events.length || process.env.UMEM_WORKER === "1") return;
  await initHome(home);
  await atomicWrite(
    join(home, "spool", `${randomUUID()}.json`),
    JSON.stringify(events.map((e) => ({ ...e, content: scrub(e.content) }))),
  );
}
export async function runHook(home: string, agent: Agent, raw: unknown) {
  if (process.env.UMEM_WORKER === "1") return {};
  const input = HookInput.parse(raw);
  const sessionId = input.session_id ?? input.sessionId;
  if (!sessionId) throw new Error("Hook is missing session_id");
  await initHome(home);
  const client = new MemoryClient(home, 1200);
  const cursorPath = join(
    home,
    "receipts",
    `${agent}-${fingerprint(sessionId).slice(0, 24)}.json`,
  );
  const cursorSchema = z.object({
    path: z.string().optional(),
    offset: z.number().default(0),
  });
  const old = await readOptional(cursorPath);
  let cursor = cursorSchema.parse(old ? JSON.parse(old) : {});
  const events: MemoryEvent[] = [];
  const start = input.hook_event_name === "SessionStart";
  const prompt = input.hook_event_name === "UserPromptSubmit";
  const add = (role: "user" | "assistant", content: string) =>
    events.push({
      id: `${agent}:${sessionId}:${input.turn_id ?? randomUUID()}:${role}`,
      agent,
      sessionId,
      cwd: input.cwd,
      role,
      content: scrub(content).slice(0, 32000),
      at: new Date().toISOString(),
      injected: false,
      worker: false,
    });
  // 用户证据只取提交 hook 的原始 prompt，避免把恢复的历史或 AGENTS.md 当成新发言。
  if (prompt && input.prompt) add("user", input.prompt);
  if (agent === "zcode") {
    if (input.hook_event_name === "Stop" && input.last_assistant_message)
      add("assistant", input.last_assistant_message);
  } else if (input.transcript_path) {
    const size = (await stat(input.transcript_path)).size;
    if (!old || cursor.path !== input.transcript_path || size < cursor.offset) {
      // 首次接入只从当前边界开始，不能顺带导入整段历史会话。
      cursor = { path: input.transcript_path, offset: size };
      if (input.hook_event_name === "Stop" && input.last_assistant_message)
        add("assistant", input.last_assistant_message);
    } else {
      const handle = await open(input.transcript_path, "r");
      try {
        let position = cursor.offset;
        let pending = "";
        const decoder = new StringDecoder("utf8");
        while (position < size) {
          const buffer = Buffer.alloc(Math.min(256000, size - position));
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            position,
          );
          if (!bytesRead) break;
          position += bytesRead;
          pending += decoder.write(buffer.subarray(0, bytesRead));
          let index: number;
          while ((index = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, index);
            const event = transcriptEvent(
              line,
              agent,
              sessionId,
              cursor.offset,
              input.cwd,
            );
            if (event && event.role !== "user") events.push(event);
            cursor.offset += Buffer.byteLength(line + "\n");
            pending = pending.slice(index + 1);
          }
        }
      } finally {
        await handle.close();
      }
    }
  } else {
    if (input.hook_event_name === "Stop" && input.last_assistant_message)
      add("assistant", input.last_assistant_message);
  }
  await spoolEvents(home, events);
  await atomicWrite(cursorPath, JSON.stringify(cursor));
  if (!start && !prompt) return {};
  const result = await client.request<{ context: string }>("/recall", {
    method: "POST",
    body: { agent, sessionId, cwd: input.cwd, query: input.prompt ?? "" },
  });
  return result.context
    ? {
        hookSpecificOutput: {
          hookEventName: input.hook_event_name,
          additionalContext: result.context,
        },
      }
    : {};
}
