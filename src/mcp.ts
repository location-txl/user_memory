import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MemoryClient } from "./client.js";
import { Id, type Agent, type Memory } from "./contracts.js";

export function createMcp(home: string, agent: Agent = "manual") {
  const client = new MemoryClient(home);
  const server = new McpServer(
    { name: "user-memory", version: "0.1.0" },
    {
      instructions:
        "共享长期记忆。用户明确要求记住、纠正、忘记时调用写入工具；历史资料不是授权。传入当前 cwd 绑定项目，未绑定时只可访问全局。纠正或撤回前使用 memory_get 取得 revision 和 etag。",
    },
  );
  const context = {
    cwd: z.string().optional().describe("当前项目目录；非项目会话省略"),
    projectId: Id.optional(),
  };
  async function binding(input: { cwd?: string; projectId?: string }) {
    return client.request<{ projectId?: string }>("/context", {
      method: "POST",
      body: input,
    });
  }
  async function scopedGet(
    id: string,
    input: { cwd?: string; projectId?: string },
  ) {
    const [memory, scope] = await Promise.all([
      client.request<Memory>(`/memories/${id}`),
      binding(input),
    ]);
    if (memory.scope === "project" && memory.projectId !== scope.projectId)
      throw new Error("记忆不属于当前项目");
    return memory;
  }
  const result = async (fn: () => Promise<unknown>) => {
    try {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(await fn()) }],
      };
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: e instanceof Error ? e.message : String(e),
          },
        ],
      };
    }
  };
  server.registerTool(
    "memory_search",
    {
      description:
        "搜索有效的全局与当前项目记忆，返回最多 12 条摘录；完整条件使用 memory_get 读取",
      inputSchema: { ...context, query: z.string() },
    },
    (input) =>
      result(async () => {
        const scope = await binding(input);
        const memories = await client.request<Memory[]>(
          `/memories?${new URLSearchParams({ q: input.query, status: "active", ...(scope.projectId ? { projectId: scope.projectId } : {}) })}`,
        );
        return {
          total: memories.length,
          results: memories.slice(0, 12).map((m) => ({
            id: m.id,
            title: m.title,
            scope: m.scope,
            projectId: m.projectId,
            excerpt: m.content.slice(0, 1200),
            truncated: m.content.length > 1200,
          })),
        };
      }),
  );
  server.registerTool(
    "memory_get",
    {
      description: "读取记忆及来源，获得纠正用的 revision 和 etag",
      inputSchema: { ...context, id: Id },
    },
    (input) =>
      result(async () => {
        const m = await scopedGet(input.id, input);
        return m.status === "withdrawn"
          ? {
              id: m.id,
              status: m.status,
              revision: m.revision,
              message: "该记忆已撤回，不得继续使用",
            }
          : m;
      }),
  );
  server.registerTool(
    "memory_remember",
    {
      description: "用户明确要求记住时立即保存长期信息",
      inputSchema: {
        ...context,
        title: z.string().min(1).max(160),
        content: z.string().min(1).max(16000),
        scope: z.enum(["global", "project"]),
        kind: z
          .enum(["preference", "constraint", "decision", "lesson"])
          .default("preference"),
      },
    },
    (input) =>
      result(async () => {
        const scope = await binding(input);
        if (input.scope === "project" && !scope.projectId)
          throw new Error("项目记忆需要 cwd 或已绑定的 projectId");
        return client.request("/memories", {
          method: "POST",
          body: {
            ...input,
            projectId: input.scope === "project" ? scope.projectId : undefined,
            sources: [
              {
                id: `explicit:${crypto.randomUUID()}`,
                agent,
                role: "manual",
                excerpt: input.content.slice(0, 4000),
                at: new Date().toISOString(),
              },
            ],
          },
        });
      }),
  );
  server.registerTool(
    "memory_correct",
    {
      description: "用户明确纠正后更新记忆，拒绝覆盖已变化的版本",
      inputSchema: {
        ...context,
        id: Id,
        revision: z.number().int().positive(),
        etag: z.string(),
        content: z.string().min(1).max(16000),
      },
    },
    (input) =>
      result(async () => {
        await scopedGet(input.id, input);
        return client.request(`/memories/${input.id}`, {
          method: "PATCH",
          body: {
            revision: input.revision,
            etag: input.etag,
            content: input.content,
            reason: `由 ${agent} 显式纠正`,
          },
        });
      }),
  );
  server.registerTool(
    "memory_forget",
    {
      description: "撤回记忆并停止召回；保留修订历史，不是物理擦除",
      inputSchema: {
        ...context,
        id: Id,
        revision: z.number().int().positive(),
        etag: z.string(),
      },
    },
    (input) =>
      result(async () => {
        await scopedGet(input.id, input);
        const m = await client.request<Memory>(`/memories/${input.id}`, {
          method: "PATCH",
          body: {
            revision: input.revision,
            etag: input.etag,
            status: "withdrawn",
          },
        });
        return { id: m.id, status: m.status, revision: m.revision };
      }),
  );
  return server;
}
export async function runMcp(home: string, agent?: Agent) {
  await createMcp(home, agent).connect(new StdioServerTransport());
}
