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
  pi.on("before_agent_start", async (event, ctx) => {
    if (process.env.UMEM_WORKER === "1") return;
    const input = z.object({ prompt: z.string() }).parse(event);
    try {
      const result = await client.request<{ context: string }>("/recall", {
        method: "POST",
        body: {
          query: input.prompt,
          agent: "pi",
          sessionId: ctx.sessionManager.getSessionId(),
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
        }),
      })
      .safeParse(event);
    if (!input.success || input.data.message.customType === "user-memory")
      return;
    const m = input.data.message;
    if (m.role !== "user" && m.role !== "assistant") return;
    const content = plainText(m.content);
    if (!content || content.includes("<user-memory-context>")) return;
    const sessionId = ctx.sessionManager.getSessionId();
    await spoolEvents(home, [
      {
        id: `pi:${sessionId}:${fingerprint(`${m.timestamp}:${content}`)}`,
        agent: "pi",
        sessionId,
        cwd: ctx.cwd,
        role: m.role,
        content: content.slice(0, 32000),
        at: new Date(m.timestamp ?? Date.now()).toISOString(),
        injected: false,
        worker: false,
      },
    ]);
  });
}
