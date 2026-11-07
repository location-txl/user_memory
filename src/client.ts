import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";

import type { ErrorResponse } from "./errors.js";

export class ClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class MemoryClient {
  constructor(
    readonly home: string,
    readonly timeout = 3000,
  ) {}
  async request<T = unknown>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const config = await loadConfig(this.home);
    const token = (await readFile(join(this.home, "token"), "utf8")).trim();
    const response = await fetch(`http://127.0.0.1:${config.port}/v1${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(this.timeout),
    });
    const data = (await response.json()) as T & Partial<ErrorResponse>;
    if (!response.ok)
      throw new ClientError(
        response.status,
        data.code ?? "INTERNAL_ERROR",
        data.error ?? `HTTP ${response.status}`,
        data.details,
      );
    return data;
  }
}
