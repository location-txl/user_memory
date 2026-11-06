#!/usr/bin/env node
import { Command } from "commander";
import { readFile, mkdir, cp } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initHome, memoryHome, loadConfig, atomicWrite } from "./config.js";
import { MemoryClient } from "./client.js";
import { startDaemon } from "./daemon.js";
import { runMcp } from "./mcp.js";
import { runHook } from "./adapters/hooks.js";
import {
  HostSchema,
  planSetup,
  applySetup,
  uninstall,
} from "./integrations/setup.js";
import { AgentSchema, type Memory } from "./contracts.js";

const program = new Command()
  .name("umem")
  .description("本机跨 Agent 公共记忆")
  .version("0.1.0")
  .option("--home <path>", "公共记忆数据目录");
const home = () => memoryHome(program.opts().home);
const client = () => new MemoryClient(home());
const print = (value: unknown) =>
  console.log(
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
const exec = promisify(execFile);
program
  .command("init")
  .description("创建本地数据目录")
  .action(async () => {
    const directory = home();
    await initHome(directory);
    print({ home: directory });
  });
program
  .command("serve")
  .description("启动唯一写入服务和自动提炼器")
  .option("--no-worker", "暂停自动提炼，保留采集与主动记忆")
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
  .description("打开本机管理页")
  .action(async () => {
    await client().request("/status");
    const config = await loadConfig(home());
    const token = (await readFile(join(home(), "token"), "utf8")).trim();
    await exec(process.platform === "darwin" ? "open" : "xdg-open", [
      `http://127.0.0.1:${config.port}/#token=${token}`,
    ]);
    print("已打开公共记忆管理页。");
  });
program
  .command("doctor")
  .description("查看服务、任务和各宿主的实际接入证据")
  .action(async () => {
    const status = await client().request("/status");
    const config = await loadConfig(home());
    const codex = await exec(config.codexPath, ["--version"]).then(
      (r) => r.stdout.trim(),
      (e) => `不可用：${e.message}`,
    );
    print({
      codex,
      status,
      note: "采集/召回时间表示接口已运行；最终模型是否使用记忆，需要宿主内新会话验收。",
    });
  });
program
  .command("mcp")
  .description("MCP stdio 服务（供宿主启动）")
  .option("--agent <name>", "宿主名称", "manual")
  .action(async (o) => runMcp(home(), AgentSchema.parse(o.agent)));
program
  .command("hook")
  .description("宿主 hook JSON stdin/stdout")
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
  .description("预览或应用宿主配置，先备份再写入")
  .option("--apply", "应用列出的配置变更")
  .option("--target-home <path>", "宿主配置所在用户目录（用于隔离验收）")
  .option("--hermes-home <path>", "Hermes 目标 profile 的实际数据目录")
  .action(async (agent, o) => {
    const plan = await planSetup(
      home(),
      HostSchema.parse(agent),
      o.targetHome,
      o.hermesHome,
    );
    print(
      o.apply
        ? await applySetup(home(), plan)
        : {
            applied: false,
            files: plan.changes.map((c) => ({
              path: c.path,
              action: c.before === undefined ? "新增" : "合并",
            })),
            instructions: plan.instructions,
            next: "加 --apply 应用；不会关闭原生记忆",
          },
    );
  });
program
  .command("uninstall <agent>")
  .description("预览或恢复安装前配置，保留记忆数据")
  .option("--apply")
  .action(async (agent, o) =>
    print(await uninstall(home(), HostSchema.parse(agent), o.apply)),
  );
program
  .command("recall [query]")
  .description("查看即将注入的记忆")
  .option("--cwd <path>")
  .option("--session <id>", "会话 ID", "cli")
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
const memory = program.command("memory").description("直接管理记忆");
memory
  .command("list")
  .option("--query <query>")
  .option("--project <id>")
  .option("--status <status>", "active/candidate/withdrawn", "active")
  .option("--all", "列出所有项目")
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
const project = program.command("project").description("登记项目与目录别名");
project
  .command("list")
  .action(async () => print(await client().request("/projects")));
project
  .command("bind <path>")
  .option("--to <id>", "绑定到已有项目")
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
  .description("预览原生 MD；--apply 将预览文件保存为待审核记忆")
  .option("--apply")
  .option("--project <id>")
  .action(async (path, o) => {
    const files = await client().request<{ path: string; hash: string }[]>(
      "/imports/preview",
      { method: "POST", body: { path: resolve(path) } },
    );
    print(
      o.apply
        ? await client().request("/imports/confirm", {
            method: "POST",
            body: {
              files: files.map(({ path, hash }) => ({ path, hash })),
              scope: o.project ? "project" : "global",
              projectId: o.project,
            },
          })
        : files,
    );
  });
program
  .command("jobs")
  .option("--retry <id>", "重试一个失败任务")
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
  .description("导出 MD、修订历史与项目映射；不含访问密钥和运行队列")
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
      note: "需要跨文件一致快照时，请先停服务再导出。运行队列未导出；完整备份需停服务后复制整个数据目录。",
    });
  });
program
  .command("service")
  .description("生成或安装 macOS 登录启动项")
  .option("--apply")
  .action(async (o) => {
    if (process.platform !== "darwin")
      throw new Error(
        "登录启动项目前仅支持 macOS。其他系统可运行 umem serve。",
      );
    await initHome(home());
    const path = join(
      homedir(),
      "Library",
      "LaunchAgents",
      "local.user-memory.plist",
    );
    const esc = (s: string) =>
      s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    const cli = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "dist",
      "cli.js",
    );
    const content = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>local.user-memory</string><key>ProgramArguments</key><array>${[process.execPath, cli, "--home", home(), "serve"].map((s) => `<string>${esc(s)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH ?? "/usr/bin:/bin")}</string></dict><key>StandardOutPath</key><string>${esc(join(home(), "service.log"))}</string><key>StandardErrorPath</key><string>${esc(join(home(), "service.log"))}</string></dict></plist>`;
    if (o.apply) {
      await mkdir(dirname(path), { recursive: true });
      await atomicWrite(path, content);
      await exec("launchctl", ["bootstrap", `gui/${process.getuid!()}`, path]);
    }
    print({
      applied: !!o.apply,
      path,
      stop: `launchctl bootout gui/${process.getuid!()}/local.user-memory`,
      note: "应用前先停止手动运行的 umem serve。移除启动项可删除上述 plist。",
    });
  });
await program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
