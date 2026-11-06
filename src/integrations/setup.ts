import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { stringify } from "yaml";
import { atomicWrite, initHome, readOptional } from "../config.js";
import { fingerprint } from "../memory/files.js";

export const HostSchema = z.enum([
  "codex",
  "zcode",
  "claude",
  "pi",
  "deepseek",
  "hermes",
]);
export type Host = z.infer<typeof HostSchema>;
export type Change = { path: string; before?: string; after: string };
export type SetupPlan = {
  host: Host;
  changes: Change[];
  instructions: string[];
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const ReceiptSchema = z.object({
  host: HostSchema,
  changes: z.array(
    z.object({
      path: z.string(),
      before: z.string().optional(),
      hash: z.string(),
    }),
  ),
});

export async function planSetup(
  home: string,
  host: Host,
  targetHome = homedir(),
  hermesHome?: string,
): Promise<SetupPlan> {
  const plan: SetupPlan = {
    host,
    changes: [],
    instructions: [
      "重启宿主或重新加载扩展后，运行 doctor 查看实际采集与召回时间。原生记忆保持原样；完成迁移验收后再切换。",
    ],
  };
  const cli = join(root, "dist", "cli.js");
  const args = [cli, "--home", home];
  const mcp = {
    command: process.execPath,
    args: [...args, "mcp", "--agent", host],
  };
  const command = [process.execPath, ...args, "hook", "--agent", host]
    .map(shellQuote)
    .join(" ");
  async function change(path: string, after: string) {
    const before = await readOptional(path);
    if (before !== after) plan.changes.push({ path, before, after });
  }
  async function json(
    path: string,
    mutate: (data: Record<string, any>) => void,
  ) {
    const before = await readOptional(path);
    const data = z
      .record(z.string(), z.any())
      .parse(before ? JSON.parse(before) : {});
    mutate(data);
    const after = JSON.stringify(data, null, 2) + "\n";
    if (before !== after) plan.changes.push({ path, before, after });
  }
  function server(data: Record<string, any>, key: string) {
    data[key] ??= {};
    if (
      data[key]["user-memory"] &&
      JSON.stringify(data[key]["user-memory"]) !== JSON.stringify(mcp)
    )
      throw new Error("已存在 user-memory MCP 配置，请先检查或撤销之前的安装");
    data[key]["user-memory"] = mcp;
  }
  function hooks(events: Record<string, any>, processHook = false) {
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      events[event] ??= [];
      const hook = processHook
        ? {
            type: "process",
            command: process.execPath,
            args: [...args, "hook", "--agent", host],
            timeoutMs: 3000,
          }
        : { type: "command", command, timeout: 3 };
      if (
        !events[event].some(
          (row: unknown) =>
            JSON.stringify(row) === JSON.stringify({ hooks: [hook] }),
        )
      )
        events[event].push({ hooks: [hook] });
    }
  }
  if (host === "codex") {
    await json(join(targetHome, ".codex", "hooks.json"), (data) => {
      data.hooks ??= {};
      hooks(data.hooks);
    });
    const path = join(targetHome, ".codex", "config.toml");
    const before = (await readOptional(path)) ?? "";
    const block = `# user-memory begin\n[mcp_servers.user-memory]\ncommand = ${JSON.stringify(mcp.command)}\nargs = ${JSON.stringify(mcp.args)}\n# user-memory end`;
    if (before.includes("# user-memory begin"))
      await change(
        path,
        before.replace(/# user-memory begin[\s\S]*?# user-memory end/, block),
      );
    else {
      if (
        /\[mcp_servers\.(?:user-memory|"user-memory"|'user-memory')\]/.test(
          before,
        )
      )
        throw new Error("已有同名 MCP 配置，未覆盖");
      await change(path, `${before.trimEnd()}\n\n${block}\n`);
    }
    plan.instructions.push(
      "Codex 需要支持 SessionStart/UserPromptSubmit/Stop 的 hooks 版本，并在宿主内信任这些 hooks；若被功能开关关闭，需启用 codex_hooks。桌面端以自身内置运行时的支持为准。",
    );
  } else if (host === "claude") {
    await json(join(targetHome, ".claude", "settings.json"), (data) => {
      data.hooks ??= {};
      hooks(data.hooks);
    });
    await json(join(targetHome, ".claude.json"), (data) =>
      server(data, "mcpServers"),
    );
  } else if (host === "zcode") {
    await json(join(targetHome, ".zcode", "cli", "config.json"), (data) => {
      data.hooks ??= {};
      data.hooks.enabled = true;
      data.hooks.events ??= {};
      hooks(data.hooks.events, true);
      data.mcp ??= {};
      server(data.mcp, "servers");
    });
    plan.instructions.push(
      "在 ZCode 中检查 hooks 信任状态；桌面端的 MCP 设置应出现 user-memory。",
    );
  } else if (host === "pi") {
    await change(
      join(targetHome, ".pi", "agent", "extensions", "user-memory.ts"),
      `import { registerPi } from ${JSON.stringify(join(root, "dist", "adapters", "pi.js"))};\nexport default (pi: Parameters<typeof registerPi>[0]) => registerPi(pi, ${JSON.stringify(home)});\n`,
    );
    await json(join(targetHome, ".pi", "agent", "mcp.json"), (data) =>
      server(data, "mcpServers"),
    );
    plan.instructions.push(
      "Pi 使用 /reload 加载扩展；需要支持内置 MCP 的版本。",
    );
  } else if (host === "deepseek") {
    const path = join(home, "integrations", "deepseek.cordis.yml");
    await change(
      path,
      stringify([
        {
          insert: [
            {
              id: "user-memory",
              name: join(root, "dist", "adapters", "deepseek.js"),
              config: { home },
            },
            {
              id: "user-memory-mcp",
              name: "@deepseek-ai/dsh-mcp-client",
              config: { serverName: "user-memory", transport: "stdio", ...mcp },
            },
          ],
        },
      ]),
    );
    plan.instructions.push(
      `启动：dsh web --patch ${shellQuote(path)}。自动提炼仅采集已提交的真实用户消息；不解码 Assistant 紧凑流。`,
    );
  } else {
    const directory = join(
      hermesHome ?? join(targetHome, ".hermes"),
      "plugins",
      "user-memory",
    );
    for (const file of ["__init__.py", "plugin.yaml"])
      await change(
        join(directory, file),
        await readFile(join(root, "adapters", "hermes", file), "utf8"),
      );
    await change(
      join(directory, "connection.json"),
      JSON.stringify({ home }, null, 2),
    );
    await change(
      join(home, "integrations", "hermes-mcp.yaml"),
      stringify({ mcp_servers: { "user-memory": mcp } }),
    );
    plan.instructions.push(
      `Provider 已准备到 ${directory}。在目标 Hermes profile 的 config.yaml 中合并 memory.provider: user-memory，并合并 ${join(home, "integrations", "hermes-mcp.yaml")}；这一步会切换 provider，安装命令不代改。多 profile 分别安装。`,
    );
  }
  return plan;
}

export async function applySetup(home: string, plan: SetupPlan) {
  await initHome(home);
  // 所有文件先做预检，防止“预览期间用户改过配置”时覆盖新内容。
  for (const change of plan.changes)
    if ((await readOptional(change.path)) !== change.before)
      throw new Error(`文件已改变，请重新预览：${change.path}`);
  const receiptPath = join(home, "backups", `${plan.host}.json`);
  const old = await readOptional(receiptPath);
  const receipt = old
    ? ReceiptSchema.parse(JSON.parse(old))
    : {
        host: plan.host,
        changes: [] as { path: string; before?: string; hash: string }[],
      };
  for (const c of plan.changes) {
    const saved = receipt.changes.find((s) => s.path === c.path);
    if (saved && c.before !== undefined && fingerprint(c.before) !== saved.hash)
      throw new Error(
        `安装后配置已有其他修改，请保留现有文件并手动合并：${c.path}`,
      );
  }
  for (const change of plan.changes) {
    const saved = receipt.changes.find((c) => c.path === change.path);
    if (saved) saved.hash = fingerprint(change.after);
    else
      receipt.changes.push({
        path: change.path,
        before: change.before,
        hash: fingerprint(change.after),
      });
  }
  await atomicWrite(receiptPath, JSON.stringify(receipt, null, 2));
  for (const change of plan.changes) {
    await mkdir(dirname(change.path), { recursive: true, mode: 0o700 });
    await atomicWrite(change.path, change.after);
  }
  return {
    files: plan.changes.map((c) => c.path),
    backup: receiptPath,
    instructions: plan.instructions,
  };
}
export async function uninstall(home: string, host: Host, apply = false) {
  const path = join(home, "backups", `${host}.json`);
  const receipt = ReceiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
  for (const c of receipt.changes) {
    const current = await readOptional(c.path);
    if (current === c.before) continue;
    if (current === undefined || fingerprint(current) !== c.hash)
      throw new Error(
        `安装后配置已有其他修改，未覆盖：${c.path}。原文在 ${path}`,
      );
  }
  if (apply) {
    for (const c of receipt.changes) {
      if (c.before !== undefined) await atomicWrite(c.path, c.before);
      else if ((await readOptional(c.path)) !== undefined) await unlink(c.path);
    }
    await unlink(path);
  }
  return { applied: apply, files: receipt.changes.map((c) => c.path) };
}
