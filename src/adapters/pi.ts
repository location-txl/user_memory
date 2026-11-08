import { randomUUID } from "node:crypto";
import { MemoryClient } from "../client.js";
import { memoryHome } from "../config.js";
import { plainText, spoolEvents } from "./hooks.js";
import { fingerprint } from "../memory/files.js";
import { z } from "zod";

type Context = {
  cwd: string;
  sessionManager: { getSessionId(): string };
  ui?: { notify(message: string, type: string): void };
};
type Pi = {
  on(
    name: string,
    handler: (event: unknown, context: Context) => Promise<unknown>,
  ): void;
};
export default function extension(pi: Pi) {
  return registerPi(pi, memoryHome());
}
export function registerPi(pi: Pi, home: string) {
  const client = new MemoryClient(home, 1200);
  const turns = new Map<string, string>();
  pi.on("before_agent_start", async (event, ctx) => {
    if (process.env.UMEM_WORKER === "1") return;
    const input = z
      .object({
        messageType: z.string().optional(),
        prompt: z.string().optional(),
      })
      .parse(event);
    if (input.messageType === "custom" || input.prompt === undefined) return;
    const sessionId = ctx.sessionManager.getSessionId();
    if (!turns.has(sessionId)) turns.set(sessionId, randomUUID());
    try {
      const result = await client.request<{ context: string }>("/recall", {
        method: "POST",
        body: {
          query: input.prompt,
          agent: "pi",
          sessionId,
          cwd: ctx.cwd,
        },
      });
      if (result.context)
        return {
          message: {
            customType: "user-memory",
            content: result.context,
            display: false,
          },
        };
    } catch (e) {
      ctx.ui?.notify(
        `公共记忆暂不可用：${e instanceof Error ? e.message : String(e)}`,
        "warning",
      );
    }
  });
  pi.on("message_end", async (event, ctx) => {
    const input = z
      .object({
        message: z.object({
          role: z.string(),
          content: z.unknown(),
          timestamp: z.number().optional(),
          customType: z.string().optional(),
          stopReason: z.string().optional(),
          toolCallId: z.string().optional(),
          isError: z.boolean().optional(),
        }),
      })
      .safeParse(event);
    if (!input.success || input.data.message.customType === "user-memory")
      return;
    const m = input.data.message;
    const role = m.role === "toolResult" ? "tool" : m.role;
    if (role !== "user" && role !== "assistant" && role !== "tool") return;
    if (m.stopReason === "error" || m.stopReason === "aborted") return;
    const content = plainText(m.content);
    if (!content || content.includes("<user-memory-context>")) return;
    const sessionId = ctx.sessionManager.getSessionId();
    await spoolEvents(home, [
      {
        id: `pi:${sessionId}:${fingerprint(`${role}:${m.toolCallId ?? m.timestamp}:${content}`)}`,
        agent: "pi",
        sessionId,
        cwd: ctx.cwd,
        turnId: turns.get(sessionId),
        role,
        content: m.isError ? `工具失败：${content}` : content,
        at: new Date(m.timestamp ?? Date.now()).toISOString(),
        injected: false,
        worker: false,
      },
    ]);
  });
  pi.on("agent_settled", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const turnId = turns.get(sessionId);
    turns.delete(sessionId);
    const settled = z.object({ aborted: z.literal(false) }).safeParse(event);
    if (!turnId || !settled.success) return;
    await spoolEvents(home, [], {
      agent: "pi",
      sessionId,
      turnId,
      cwd: ctx.cwd,
      at: new Date().toISOString(),
    });
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    turns.delete(ctx.sessionManager.getSessionId());
  });
}
