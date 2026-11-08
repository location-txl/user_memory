import { errorResponse, validationResponse } from "./errors.js";
import { Hono } from "hono";
import { z, ZodError } from "zod";
import { timingSafeEqual } from "node:crypto";
import {
  AppError,
  CreateMemorySchema,
  IngestSchema,
  RecallSchema,
  Id,
} from "./contracts.js";
import type { MemoryStore } from "./memory/store.js";
import type { MemoryWorker } from "./memory/worker.js";
import { recall } from "./memory/recall.js";
import { memoryData } from "./memory/files.js";
import {
  EvidenceId,
  EvidenceSearchSchema,
  evidenceSource,
  getEvidence,
  searchEvidence,
} from "./memory/evidence.js";
import {
  importFiles,
  nativeLocations,
  previewImport,
} from "./integrations/import.js";
import { ConfigSchema, atomicWrite, canOmitHome } from "./config.js";
import { join } from "node:path";
import { McpCallFilters, readMcpCalls } from "./mcp-calls.js";

export function createApp(
  store: MemoryStore,
  token: string,
  worker?: MemoryWorker,
) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ZodError)
      return c.json(validationResponse(error), 400);
    if (error instanceof AppError)
      return c.json(
        errorResponse(error.code, error.message, error.details),
        error.status,
      );
    return c.json(
      errorResponse("INTERNAL_ERROR", error.message, {
        diagnostic: error.message,
      }),
      500,
    );
  });
  app.use("*", async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host))
      return c.json(errorResponse("LOCAL_ONLY", "仅允许本机访问"), 403);
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin)
      return c.json(
        errorResponse("CROSS_ORIGIN_FORBIDDEN", "不允许跨站请求"),
        403,
      );
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use("/v1/*", async (c, next) => {
    const supplied = Buffer.from(
      c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "",
    );
    const expected = Buffer.from(token);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return c.json(
        errorResponse(
          "UNAUTHORIZED",
          "请用 umem web 打开管理页。若使用自定义数据目录，请沿用启动服务时的 --home 或 UMEM_HOME。API 请求需提供本机访问密钥。",
        ),
        401,
      );
    if (Number(c.req.header("Content-Length") ?? 0) > 2_000_000)
      return c.json(errorResponse("PAYLOAD_TOO_LARGE", "请求过大"), 413);
    await next();
  });
  app.get("/v1/status", async (c) => {
    await store.refresh();
    return c.json({
      ...store.status(),
      home: store.home,
      canOmitHome: canOmitHome(store.home),
      workerEnabled: worker?.config.extractionEnabled ?? false,
    });
  });
  app.get("/v1/projects", (c) => c.json(store.projects));
  app.get("/v1/mcp-calls", (c) => {
    const filters = McpCallFilters.parse(c.req.query());
    try {
      return c.json(readMcpCalls(store.home, filters));
    } catch {
      return c.json(
        errorResponse(
          "MCP_CALL_LOG_UNAVAILABLE",
          "MCP call log is unavailable.",
        ),
        503,
      );
    }
  });
  app.post("/v1/context", async (c) => {
    const data = z
      .object({
        cwd: z.string().optional(),
        projectId: Id.optional(),
        create: z.boolean().default(false),
      })
      .parse(await c.req.json());
    store.requireProject(data.projectId);
    return c.json({
      projectId:
        data.projectId ??
        (await store.resolveProject(data.cwd, data.create))?.id,
    });
  });
  app.post("/v1/projects", async (c) => {
    const data = z
      .object({
        root: z.string().min(1),
        name: z.string().optional(),
        existingId: Id.optional(),
      })
      .parse(await c.req.json());
    const project = data.existingId
      ? await store.addProject(data.root, data.name, data.existingId)
      : await store.resolveProject(data.root, true);
    return c.json(project, 201);
  });
  app.get("/v1/memories", async (c) =>
    c.json(
      (
        await store.list({
          query: c.req.query("q"),
          projectId: c.req.query("projectId"),
          scope: c.req.query("scope"),
          status: c.req.query("status"),
          allProjects: c.req.query("all") === "true",
        })
      ).map(memoryData),
    ),
  );
  app.get("/v1/memories/:id/history", async (c) =>
    c.json((await store.history(c.req.param("id"))).map(memoryData)),
  );
  app.get("/v1/memories/:id", async (c) =>
    c.json(memoryData(await store.get(Id.parse(c.req.param("id"))))),
  );
  app.post("/v1/memories", async (c) => {
    const data = CreateMemorySchema.parse(await c.req.json());
    if (!data.sources.length)
      data.sources.push({
        id: `manual:${crypto.randomUUID()}`,
        agent: "manual",
        role: "manual",
        excerpt: data.content.slice(0, 4000),
        at: new Date().toISOString(),
      });
    return c.json(memoryData(await store.create(data)), 201);
  });
  app.patch("/v1/memories/:id", async (c) => {
    const data = z
      .object({
        revision: z.number().int().positive(),
        etag: z.string().min(1),
        content: z.string().min(1).max(16000).optional(),
        title: z.string().min(1).max(160).optional(),
        status: z.enum(["active", "candidate", "withdrawn"]).optional(),
        reason: z.string().optional(),
        alwaysRecall: z.boolean().optional(),
        sourceId: EvidenceId.optional(),
        sourceProjectId: Id.optional(),
      })
      .parse(await c.req.json());
    const { revision, etag, sourceId, sourceProjectId, ...changes } = data;
    const id = Id.parse(c.req.param("id"));
    const memory = await store.get(id);
    const evidence =
      sourceId && changes.content !== undefined
        ? await getEvidence(
            store,
            sourceId,
            memory.projectId ?? sourceProjectId,
          )
        : undefined;
    const sources =
      evidence?.role === "user"
        ? [
            ...memory.sources.filter((source) => source.id !== evidence.id),
            evidenceSource(evidence, memory.projectId),
          ]
        : undefined;
    return c.json(
      memoryData(
        await store.revise(
          id,
          revision,
          sources ? { ...changes, sources } : changes,
          etag,
        ),
      ),
    );
  });
  app.post("/v1/recall", async (c) =>
    c.json(await recall(store, RecallSchema.parse(await c.req.json()))),
  );
  app.post("/v1/evidence/search", async (c) =>
    c.json(
      memoryData(
        await searchEvidence(
          store,
          EvidenceSearchSchema.parse(await c.req.json()),
        ),
      ),
    ),
  );
  app.post("/v1/evidence/get", async (c) => {
    const data = z
      .object({ id: EvidenceId, projectId: Id.optional() })
      .parse(await c.req.json());
    return c.json(
      memoryData(await getEvidence(store, data.id, data.projectId)),
    );
  });
  app.post("/v1/ingest", async (c) => {
    const batch = IngestSchema.refine(
      (input) => (Array.isArray(input) ? input : input.events).length <= 100,
      "At most 100 events are accepted.",
    ).parse(await c.req.json());
    return c.json({ accepted: await store.ingestBatch(batch) });
  });
  app.get("/v1/jobs", (c) => c.json(store.jobs()));
  app.post("/v1/jobs/:id/retry", (c) =>
    c.json({
      retried: store.retry(
        z.coerce.number().int().positive().parse(c.req.param("id")),
      ),
    }),
  );
  app.get("/v1/imports/locations", (c) => c.json(nativeLocations()));
  app.post("/v1/imports/preview", async (c) => {
    const data = z
      .object({ path: z.string().min(1) })
      .parse(await c.req.json());
    return c.json((await previewImport(data.path)).map(memoryData));
  });
  app.post("/v1/imports/confirm", async (c) => {
    const data = z
      .object({
        files: z
          .array(z.object({ path: z.string(), hash: z.string() }))
          .max(200),
        scope: z.enum(["global", "project"]),
        projectId: Id.optional(),
      })
      .parse(await c.req.json());
    return c.json(
      (await importFiles(store, data.files, data.scope, data.projectId)).map(
        memoryData,
      ),
    );
  });
  app.get("/v1/config", (c) => c.json(worker?.config ?? {}));
  app.patch("/v1/config", async (c) => {
    if (!worker)
      throw new AppError(503, "后台提炼器未启动", "WORKER_UNAVAILABLE");
    const patch = ConfigSchema.omit({ port: true })
      .partial()
      .parse(await c.req.json());
    await atomicWrite(
      join(store.home, "config.json"),
      JSON.stringify({ ...worker.config, ...patch }, null, 2),
    );
    Object.assign(worker.config, patch);
    return c.json(worker.config);
  });
  return app;
}
