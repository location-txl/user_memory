import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  planSetup,
  applySetup,
  uninstall,
  type Host,
} from "../src/integrations/setup.js";
import { readOptional } from "../src/config.js";
let base: string;
let home: string;
let target: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "umem-setup-"));
  home = join(base, "data");
  target = join(base, "host");
  await mkdir(target);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});
test.each<Host>(["codex", "zcode", "claude", "pi", "deepseek", "hermes"])(
  "%s 安装可预览、重复执行和完整撤销",
  async (host) => {
    const plan = await planSetup(home, host, target);
    expect(plan.changes.length).toBeGreaterThan(0);
    for (const c of plan.changes)
      expect(await readOptional(c.path)).toBeUndefined();
    await applySetup(home, plan);
    expect((await planSetup(home, host, target)).changes).toEqual([]);
    const preview = await uninstall(home, host);
    expect(preview.applied).toBe(false);
    await uninstall(home, host, true);
    for (const c of plan.changes)
      expect(await readOptional(c.path)).toBeUndefined();
  },
);
test("安装保留已有 hooks、MCP 和用户配置，卸载恢复原文", async () => {
  const path = join(target, ".zcode", "cli", "config.json");
  await mkdir(join(target, ".zcode", "cli"), { recursive: true });
  const original = JSON.stringify({
    custom: "保留",
    mcp: { servers: { existing: { command: "old" } } },
    hooks: {
      events: {
        Stop: [{ hooks: [{ type: "command", command: "echo keep" }] }],
      },
    },
  });
  await writeFile(path, original);
  await applySetup(home, await planSetup(home, "zcode", target));
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved.custom).toBe("保留");
  expect(saved.mcp.servers.existing.command).toBe("old");
  expect(saved.hooks.events.Stop).toHaveLength(2);
  await uninstall(home, "zcode", true);
  expect(await readFile(path, "utf8")).toBe(original);
});
test("预览之后的更改拒绝覆盖，安装之后的更改拒绝回滚", async () => {
  const plan = await planSetup(home, "pi", target);
  const first = plan.changes[0];
  await mkdir(join(target, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(first.path, "另一个编辑器的内容");
  await expect(applySetup(home, plan)).rejects.toThrow("File has changed");
  await rm(first.path);
  await applySetup(home, await planSetup(home, "pi", target));
  await writeFile(first.path, "用户的新修改");
  await expect(uninstall(home, "pi", true)).rejects.toThrow(
    "Configuration has changed",
  );
  expect(await readFile(first.path, "utf8")).toBe("用户的新修改");
});
