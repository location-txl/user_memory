import { z } from "zod";
import { agents } from "./contract-values.js";

export const AgentSchema = z.enum(agents);
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
    alwaysRecall: z.boolean().optional(),
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
    alwaysRecall: z.boolean().optional(),
  })
  .refine((m) => (m.scope === "global" ? !m.projectId : !!m.projectId), {
    message: "记忆范围与项目不匹配",
    params: { rule: "scope_project_mismatch" },
  });
export type CreateMemory = z.infer<typeof CreateMemorySchema>;
const EventBindingSchema = z.object({
  agent: AgentSchema,
  sessionId: z.string().min(1).max(300),
  projectId: Id.optional(),
  cwd: z.string().optional(),
});
const TurnId = z.string().min(1).max(300);
export const TurnEndSchema = EventBindingSchema.extend({
  turnId: TurnId,
  at: z.iso.datetime(),
});
export type TurnEnd = z.infer<typeof TurnEndSchema>;
export const EventSchema = EventBindingSchema.extend({
  id: z.string().min(1).max(300),
  turnId: TurnId.optional(),
  branchId: z.string().optional(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string().min(1).max(32000),
  at: z.string(),
  injected: z.boolean().default(false),
  worker: z.boolean().default(false),
});
export type MemoryEvent = z.infer<typeof EventSchema>;
export const IngestSchema = z.union([
  z.array(EventSchema),
  z.object({ events: z.array(EventSchema), turnEnd: TurnEndSchema }),
]);
export type Project = {
  id: string;
  memoryDirectory: string;
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
  basis: z.enum(["explicit_policy", "adopted_decision", "verified_lesson"]),
  reason: z.string(),
});
export const ExtractionSchema = z.object({
  outcome: z.enum(["pending", "settled"]),
  proposals: z.array(ProposalSchema).max(24),
});
export type Extraction = z.infer<typeof ExtractionSchema>;
export type Proposal = z.infer<typeof ProposalSchema>;
export { AppError } from "./errors.js";
