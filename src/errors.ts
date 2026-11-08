import { ZodError } from "zod";

export const errorMessages = {
  VALIDATION_ERROR: "Invalid request.",
  LOCAL_ONLY: "Only local access is allowed.",
  CROSS_ORIGIN_FORBIDDEN: "Cross-origin requests are not allowed.",
  UNAUTHORIZED:
    "Open the management page with umem web. For a custom data directory, use the same --home or UMEM_HOME as the service. API requests require the local access token.",
  PAYLOAD_TOO_LARGE: "Request body is too large.",
  PROJECT_NOT_FOUND: "Project does not exist.",
  PROJECT_ALREADY_BOUND: "Directory is already bound to another project.",
  MEMORY_NOT_FOUND: "Memory does not exist or its file is invalid.",
  EVIDENCE_NOT_FOUND:
    "Evidence was not captured, has been withdrawn, or is outside the current project. Check the memory's saved source excerpt.",
  MEMORY_CONFLICT: "Memory has changed. Read it again before editing.",
  MEMORY_CORRECTION_TARGET_MISSING:
    "This older correction has no target. Open and edit the original memory.",
  MEMORY_WITHDRAWN:
    "Memory has been withdrawn. Create a new record to remember it again.",
  WORKER_UNAVAILABLE: "The extraction worker is not running.",
  MCP_CALL_LOG_UNAVAILABLE: "MCP call records could not be read.",
  IMPORT_LIMIT_EXCEEDED:
    "Import supports at most 200 files and 4 directory levels. Select a more specific directory.",
  IMPORT_FILE_TOO_LARGE: "Import file is too large. Split it first.",
  IMPORT_PROJECT_REQUIRED: "Select a destination project for import.",
  IMPORT_SOURCE_CHANGED: "Source file has changed. Preview it again.",
  IMPORT_MEMORY_TOO_LARGE:
    "File exceeds the memory size limit. Split it before importing.",
  INTERNAL_ERROR: "Internal server error.",
} as const;
export type ErrorCode = keyof typeof errorMessages;
export type ErrorResponse = {
  error: string;
  code: ErrorCode;
  details?: Record<string, unknown>;
};
export class AppError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 503,
    message: string,
    public code: ErrorCode = "INTERNAL_ERROR",
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export function errorResponse(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ErrorResponse {
  return { error: message, code, ...(details ? { details } : {}) };
}
export function validationResponse(error: ZodError): ErrorResponse {
  return errorResponse(
    "VALIDATION_ERROR",
    error.issues
      .map(({ path, message }) => `${path.join(".")}: ${message}`)
      .join("；"),
    { issues: error.issues },
  );
}
