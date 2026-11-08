#!/usr/bin/env node
import { Command } from "commander";
import { readFile, mkdir, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initHome, memoryHome, loadConfig } from "./config.js";
import { ClientError, MemoryClient } from "./client.js";
import { errorMessages, type ErrorCode } from "./errors.js";
import { startDaemon } from "./daemon.js";
import { configureService } from "./service.js";
import { runMcp } from "./mcp.js";
import { runHook } from "./adapters/hooks.js";
import {
  HostSchema,
  planSetup,
  applySetup,
  uninstall,
} from "./integrations/setup.js";
import { AgentSchema, type Memory } from "./contracts.js";
import { version } from "./version.js";

const program = new Command()
  .name("umem")
  .description("Local cross-agent shared memory")
  .version(version)
  .option(
    "--home <path>",
    "Shared memory data directory (default: UMEM_HOME or ~/.umem)",
  );
const home = () => memoryHome(program.opts().home);
const client = () => new MemoryClient(home());
const print = (value: unknown) =>
  console.log(
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
const exec = promisify(execFile);
program
  .command("init")
  .description("Create the local data directory")
  .action(async () => {
    const directory = home();
    await initHome(directory);
    print({ home: directory });
  });
program
  .command("serve")
  .description("Start the single-writer service and extraction worker")
  .option(
    "--no-worker",
    "Pause extraction while retaining capture and explicit memory",
  )
  .action(async (options) => {
    const daemon = await startDaemon(home(), { worker: options.worker });
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await daemon.close();
    };
    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
  });
program
  .command("web")
  .description("Open the local management page")
  .action(async () => {
    await client().request("/status");
    const config = await loadConfig(home());
    const token = (await readFile(join(home(), "token"), "utf8")).trim();
    await exec(process.platform === "darwin" ? "open" : "xdg-open", [
      `http://127.0.0.1:${config.port}/#token=${token}`,
    ]);
    print("Opened the shared memory management page.");
  });
program
  .command("doctor")
  .description("Inspect service, jobs, and host integration evidence")
  .action(async () => {
    const status = await client().request("/status");
    const config = await loadConfig(home());
    const codex = await exec(config.codexPath, ["--version"]).then(
      (r) => r.stdout.trim(),
      (e) => `Unavailable: ${e.message}`,
    );
    print({
      codex,
      status,
      note: "Capture/recall timestamps confirm API activity. Verify actual memory use in a new host session.",
    });
  });
program
  .command("mcp")
  .description("MCP stdio server (started by the host)")
  .option("--agent <name>", "Host name", "manual")
  .action(async (o) => runMcp(home(), AgentSchema.parse(o.agent)));
program
  .command("hook")
  .description("Host hook JSON stdin/stdout")
  .requiredOption("--agent <name>")
  .action(async (o) => {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    try {
      print(await runHook(home(), AgentSchema.parse(o.agent), JSON.parse(raw)));
    } catch (error) {
      console.error(
        `[user-memory] ${error instanceof Error ? error.message : String(error)}`,
      );
      print({});
    }
  });
program
  .command("setup <agent>")
  .description("Back up and apply host configuration")
  .option("--dry-run", "Preview files that would change")
  .option(
    "--target-home <path>",
    "User directory containing host configuration (for isolated verification)",
  )
  .option(
    "--hermes-home <path>",
    "Actual data directory of the target Hermes profile",
  )
  .action(async (agent, o) => {
    const plan = await planSetup(
      home(),
      HostSchema.parse(agent),
      o.targetHome,
      o.hermesHome,
    );
    print(
      o.dryRun
        ? {
            applied: false,
            files: plan.changes.map((c) => ({
              path: c.path,
              action: c.before === undefined ? "create" : "merge",
            })),
            instructions: plan.instructions,
            next: "Run again without --dry-run to apply",
          }
        : await applySetup(home(), plan),
    );
  });
program
  .command("uninstall <agent>")
  .description("Restore pre-install configuration and retain memory data")
  .option("--dry-run", "List files that would be restored or removed")
  .action(async (agent, o) =>
    print(await uninstall(home(), HostSchema.parse(agent), !o.dryRun)),
  );
program
  .command("recall [query]")
  .description("Preview memory to be injected")
  .option("--cwd <path>")
  .option("--session <id>", "Session ID", "cli")
  .action(async (query, o) =>
    print(
      await client().request("/recall", {
        method: "POST",
        body: {
          query: query ?? "",
          cwd: o.cwd,
          agent: "manual",
          sessionId: o.session,
        },
      }),
    ),
  );
const evidence = program
  .command("evidence")
  .description("Inspect captured memory evidence");
evidence
  .command("search <query>")
  .description("Search captured global and current-project events")
  .option("--cwd <path>")
  .option("--project <id>")
  .option("--agent <name>")
  .option("--session <id>")
  .action(async (query, o) => {
    const scope = await client().request<{ projectId?: string }>("/context", {
      method: "POST",
      body: { cwd: o.cwd, projectId: o.project },
    });
    print(
      await client().request("/evidence/search", {
        method: "POST",
        body: {
          query,
          projectId: scope.projectId,
          agent: o.agent,
          sessionId: o.session,
        },
      }),
    );
  });
evidence
  .command("get <source-id>")
  .description("Read a complete captured event by source ID")
  .option("--cwd <path>")
  .option("--project <id>")
  .action(async (id, o) => {
    const scope = await client().request<{ projectId?: string }>("/context", {
      method: "POST",
      body: { cwd: o.cwd, projectId: o.project },
    });
    print(
      await client().request("/evidence/get", {
        method: "POST",
        body: { id, projectId: scope.projectId },
      }),
    );
  });
const memory = program
  .command("memory")
  .description("Manage memories directly");
memory
  .command("list")
  .option("--query <query>")
  .option("--project <id>")
  .option("--status <status>", "active/candidate/withdrawn", "active")
  .option("--all", "List all projects")
  .action(async (o) =>
    print(
      await client().request(
        `/memories?${new URLSearchParams({ status: o.status, ...(o.query ? { q: o.query } : {}), ...(o.project ? { projectId: o.project } : {}), ...(o.all ? { all: "true" } : {}) })}`,
      ),
    ),
  );
memory
  .command("get <id>")
  .action(async (id) =>
    print(await client().request(`/memories/${encodeURIComponent(id)}`)),
  );
memory
  .command("add <title> <content>")
  .option("--project <id>")
  .option(
    "--kind <kind>",
    "preference/constraint/decision/lesson",
    "preference",
  )
  .action(async (title, content, o) =>
    print(
      await client().request("/memories", {
        method: "POST",
        body: {
          title,
          content,
          scope: o.project ? "project" : "global",
          projectId: o.project,
          kind: o.kind,
        },
      }),
    ),
  );
memory.command("correct <id> <content>").action(async (id, content) => {
  const m = await client().request<Memory>(
    `/memories/${encodeURIComponent(id)}`,
  );
  print(
    await client().request(`/memories/${m.id}`, {
      method: "PATCH",
      body: { revision: m.revision, etag: m.etag, content },
    }),
  );
});
for (const [action, status] of [
  ["approve", "active"],
  ["forget", "withdrawn"],
])
  memory.command(`${action} <id>`).action(async (id) => {
    const m = await client().request<Memory>(
      `/memories/${encodeURIComponent(id)}`,
    );
    print(
      await client().request(`/memories/${m.id}`, {
        method: "PATCH",
        body: { revision: m.revision, etag: m.etag, status },
      }),
    );
  });
const project = program
  .command("project")
  .description("Register projects and directory aliases");
project
  .command("list")
  .action(async () => print(await client().request("/projects")));
project
  .command("bind <path>")
  .option("--to <id>", "Bind to an existing project")
  .action(async (path, o) =>
    print(
      await client().request("/projects", {
        method: "POST",
        body: { root: resolve(path), existingId: o.to },
      }),
    ),
  );
program
  .command("import <path>")
  .description("Save specified Markdown files as candidate memories")
  .option("--dry-run", "Preview files to import")
  .option("--project <id>")
  .action(async (path, o) => {
    const files = await client().request<{ path: string; hash: string }[]>(
      "/imports/preview",
      { method: "POST", body: { path: resolve(path) } },
    );
    print(
      o.dryRun
        ? files
        : await client().request("/imports/confirm", {
            method: "POST",
            body: {
              files: files.map(({ path, hash }) => ({ path, hash })),
              scope: o.project ? "project" : "global",
              projectId: o.project,
            },
          }),
    );
  });
program
  .command("jobs")
  .option("--retry <id>", "Retry a failed job")
  .action(async (o) =>
    print(
      o.retry
        ? await client().request(`/jobs/${Number(o.retry)}/retry`, {
            method: "POST",
          })
        : await client().request("/jobs"),
    ),
  );
program
  .command("export <directory>")
  .description(
    "Export Markdown, revision history, and project mappings; exclude access tokens and runtime queues",
  )
  .action(async (directory) => {
    const target = resolve(directory);
    await mkdir(target, { recursive: false, mode: 0o700 });
    for (const item of ["memories", "history", "projects.json"])
      await cp(join(home(), item), join(target, item), {
        recursive: true,
      }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      });
    print({
      directory: target,
      note: "Stop the service before exporting for a consistent cross-file snapshot. Runtime queues are excluded; for a full backup, stop the service and copy the entire data directory.",
    });
  });
const service = program
  .command("service")
  .description("Manage the macOS login service");
service.action(() => service.outputHelp());
service
  .command("install")
  .description("Install and load the login service")
  .option("--force", "Replace and reload the existing login service")
  .option("--dry-run", "Show the service path and uninstall command only")
  .action((options) => configureService(home(), "install", print, options));
service
  .command("uninstall")
  .description("Stop and remove the login service")
  .action(() => configureService(home(), "uninstall", print));

await program.parseAsync().catch((error) => {
  if (
    error instanceof ClientError &&
    error.code !== "INTERNAL_ERROR" &&
    error.code !== "VALIDATION_ERROR" &&
    Object.hasOwn(errorMessages, error.code)
  ) {
    const message = errorMessages[error.code as ErrorCode];
    const path = error.details?.path;
    const displayPath =
      typeof path === "string"
        ? path.replace(
            /\p{Cc}/gu,
            (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
          )
        : undefined;
    console.error(displayPath ? `${message}\n${displayPath}` : message);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
