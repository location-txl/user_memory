import { z } from "zod";
import { MemoryClient } from "../client.js";
import { memoryHome } from "../config.js";
import { plainText, spoolEvents } from "./hooks.js";

export const name = "user-memory";
export const inject = ["agents", "sessions"];
type Session = { id: string; header: { cwd: string; parentSession?: unknown } };
type Message = {
  id: string;
  role: string;
  content: unknown;
  source?: { kind: string };
};
type Decision = { kind: string; messages: Message[] };
type Context = {
  on(
    name: "agent/pre-step",
    handler: (
      event: { agent: { id: string; session: Session } },
      next: () => Promise<Decision>,
    ) => Promise<Decision>,
  ): void;
  on(
    name: "session/event",
    handler: (session: Session, event: unknown) => Promise<void>,
  ): void;
};
export function apply(ctx: Context, config: { home?: string } = {}) {
  const home = memoryHome(config.home);
  const client = new MemoryClient(home, 1200);
  ctx.on("agent/pre-step", async ({ agent }, next) => {
    const decision = await next();
    if (decision.kind === "reject" || process.env.UMEM_WORKER === "1")
      return decision;
    const messages = decision.messages.filter((m) => m.source?.kind !== name);
    const user = [...messages]
      .reverse()
      .find((m) => m.role === "user" && m.source?.kind === "user");
    try {
      const result = await client.request<{ context: string }>("/recall", {
        method: "POST",
        body: {
          query: plainText(user?.content).slice(0, 16000),
          agent: "deepseek",
          sessionId: agent.id,
          cwd: agent.session.header.cwd,
        },
      });
      if (result.context)
        messages.push({
          id: `user-memory-${agent.id}`,
          role: "user",
          content: [{ type: "text", text: result.context }],
          source: { kind: name },
        });
      return { ...decision, messages };
    } catch (error) {
      console.error("[user-memory] 召回失败", String(error));
      return decision;
    }
  });
  ctx.on("session/event", async (session, raw) => {
    if (session.header.parentSession || process.env.UMEM_WORKER === "1") return;
    const event = z
      .object({
        type: z.literal("user/message"),
        seq: z.number(),
        time: z.number(),
        data: z.object({
          content: z.unknown(),
          source: z.object({ kind: z.literal("user") }),
        }),
      })
      .safeParse(raw);
    if (!event.success) return;
    const content = plainText(event.data.data.content);
    if (!content || content.includes("<user-memory-context>")) return;
    await spoolEvents(home, [
      {
        id: `deepseek:${session.id}:${event.data.seq}`,
        agent: "deepseek",
        sessionId: session.id,
        cwd: session.header.cwd,
        role: "user",
        content: content.slice(0, 32000),
        at: new Date(event.data.time).toISOString(),
        injected: false,
        worker: false,
      },
    ]);
  });
}
