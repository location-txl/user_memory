export const agents = [
  "codex",
  "zcode",
  "claude",
  "pi",
  "deepseek",
  "hermes",
  "manual",
  "import",
] as const;
export const mcpTools = [
  "memory_search",
  "memory_get",
  "memory_remember",
  "memory_correct",
  "memory_forget",
  "memory_evidence_search",
  "memory_evidence_get",
  "unknown",
] as const;
export const mcpOutcomes = [
  "success",
  "rejected",
  "tool_error",
  "protocol_error",
  "cancelled",
] as const;
