import { z } from "zod";

export const AgentSchema = z.enum([
  "codex",
  "zcode",
  "claude",
  "pi",
  "deepseek",
  "hermes",
  "manual",
  "import",
]);
export type Agent = z.infer<typeof AgentSchema>;
export const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const SourceSchema = z.object({
  id: z.string().min(1).max(300),
  agent: AgentSchema,
  sessionId: z.string().max(300).optional(),
  role: z.enum(["user", "assistant", "tool", "import", "manual"]),
  excerpt: z.string().max(4000),
  path: z.string().optional(),
  at: z.string(),
});
export const MemoryMetaSchema = z
  .object({
    id: Id,
    title: z.string().min(1).max(160),
    scope: z.enum(["global", "project"]),
    projectId: Id.optional(),
    kind: z.enum(["preference", "constraint", "decision", "lesson"]),
    status: z.enum(["active", "candidate", "withdrawn"]),
    revision: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
    sources: z.array(SourceSchema),
    reason: z.string().optional(),
  })
  .refine(
    (m) => (m.scope === "global" ? !m.projectId : !!m.projectId),
    "Project memories require a project. Global memories cannot have a project.",
  );
export type MemoryMeta = z.infer<typeof MemoryMetaSchema>;
export type Memory = MemoryMeta & {
  content: string;
  file: string;
  etag: string;
};
export type Source = z.infer<typeof SourceSchema>;
export const CreateMemorySchema = z
  .object({
    title: z.string().min(1).max(160),
    content: z.string().min(1).max(16000),
    scope: z.enum(["global", "project"]),
    projectId: Id.optional(),
    kind: z
      .enum(["preference", "constraint", "decision", "lesson"])
      .default("preference"),
    status: z.enum(["active", "candidate"]).default("active"),
    sources: z.array(SourceSchema).default([]),
    reason: z.string().optional(),
  })
  .refine((m) => (m.scope === "global" ? !m.projectId : !!m.projectId), {
    message: "记忆范围与项目不匹配",
    params: { rule: "scope_project_mismatch" },
  });
export type CreateMemory = z.infer<typeof CreateMemorySchema>;
export const EventSchema = z.object({
  id: z.string().min(1).max(300),
  agent: AgentSchema,
  sessionId: z.string().min(1).max(300),
  projectId: Id.optional(),
  cwd: z.string().optional(),
  branchId: z.string().optional(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string().min(1).max(32000),
  at: z.string(),
  injected: z.boolean().default(false),
  worker: z.boolean().default(false),
});
export type MemoryEvent = z.infer<typeof EventSchema>;
export type Project = {
  id: string;
  name: string;
  roots: string[];
  gitCommonDir?: string;
};
export const RecallSchema = z.object({
  query: z.string().max(16000).default(""),
  projectId: Id.optional(),
  cwd: z.string().optional(),
  agent: AgentSchema.default("manual"),
  sessionId: z.string().default("manual"),
});
export type RecallInput = z.infer<typeof RecallSchema>;
export const ProposalSchema = z.object({
  action: z.enum(["add", "correct"]),
  targetId: Id.nullable(),
  expectedRevision: z.number().int().positive().nullable(),
  title: z.string().min(1).max(160),
  content: z.string().min(1).max(16000),
  scope: z.enum(["global", "project"]),
  kind: z.enum(["preference", "constraint", "decision", "lesson"]),
  sourceIds: z.array(z.string()).min(1),
  certainty: z.enum(["supported", "uncertain"]),
  reason: z.string(),
});
export const ExtractionSchema = z.object({
  proposals: z.array(ProposalSchema).max(24),
});
export type Proposal = z.infer<typeof ProposalSchema>;
export { AppError } from "./errors.js";
