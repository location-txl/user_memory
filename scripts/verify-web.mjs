import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startDaemon } from "../dist/daemon.js";
import { initHome, atomicWrite } from "../dist/config.js";
import { MemoryClient } from "../dist/client.js";

const home = await mkdtemp(join(tmpdir(), "umem-web-"));
const config = await initHome(home);
const socket = createServer();
await new Promise((r) => socket.listen(0, "127.0.0.1", r));
config.port = socket.address().port;
await new Promise((r) => socket.close(r));
config.extractionEnabled = false;
await atomicWrite(join(home, "config.json"), JSON.stringify(config));
const daemon = await startDaemon(home, { quiet: true });
const client = new MemoryClient(home);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.UMEM_BROWSER_CHANNEL
    ? { channel: process.env.UMEM_BROWSER_CHANNEL }
    : process.platform === "darwin"
      ? { channel: "chrome" }
      : {}),
});
const output = resolve(".test-output");
await mkdir(output, { recursive: true });
try {
  await mkdir(join(home, "design-system"));
  await daemon.store.addProject(join(home, "design-system"), "设计系统");
  for (const entry of [
    {
      title: "默认用中文沟通",
      content:
        "在不同项目和工具中，默认使用中文讨论。引用 API 名称、代码标识符时保留原文。",
      kind: "preference",
    },
    {
      title: "先做简单、直观的实现",
      content:
        "满足当前需求，优先选择低复杂度、易维护的实现；不为假设的未来需求增加抽象。",
      kind: "constraint",
    },
    {
      title: "改动前先查看仓库状态",
      content: "先核对当前分支和工作区，保护已有的未提交改动。",
      kind: "lesson",
    },
  ])
    await client.request("/memories", {
      method: "POST",
      body: {
        ...entry,
        scope: "global",
        sources: [
          {
            id: entry.title,
            agent: "codex",
            role: "user",
            excerpt: entry.content,
            at: new Date().toISOString(),
          },
        ],
      },
    });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const token = (await readFile(join(home, "token"), "utf8")).trim();
  await page.goto(`http://127.0.0.1:${config.port}/#token=${token}`);
  await page.getByRole("heading", { name: "全局记忆", exact: true }).waitFor();
  await page.locator(".memory-row").first().waitFor();
  assert.equal(new URL(page.url()).hash, "");
  await page.getByRole("button", { name: /默认用中文沟通/ }).click();
  await page.screenshot({
    path: join(output, "memory-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page
    .getByRole("textbox", { name: "内容", exact: true })
    .fill("网页端已纠正：继续使用中文。");
  await page.getByRole("button", { name: "保存修改" }).click();
  await page
    .getByText("网页端已纠正：继续使用中文。", { exact: true })
    .last()
    .waitFor();
  await page.getByRole("button", { name: "记一条", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "记一条", exact: true }).click();
  await page.getByLabel("标题", { exact: true }).fill("浏览器新增验证");
  await page
    .getByRole("textbox", { name: "内容", exact: true })
    .fill("页面创建的记忆可以通过 API 读取。");
  await page.getByRole("button", { name: "保存记忆", exact: true }).click();
  await page.getByRole("button", { name: /浏览器新增验证/ }).click();
  await page.getByRole("button", { name: "撤回", exact: true }).click();
  await page.getByRole("button", { name: "确认撤回" }).click();
  await page.getByLabel("记忆状态").selectOption("withdrawn");
  await page.getByRole("heading", { name: "浏览器新增验证" }).last().waitFor();
  await page.getByRole("button", { name: "导入记忆", exact: true }).click();
  const file = join(home, "native.md");
  await writeFile(file, "跨工具导入验收的偏好记录");
  await page.getByLabel("绝对路径").fill(file);
  await page.getByRole("button", { name: "预览文件" }).click();
  await page.getByRole("button", { name: "将 1 个文件导入待审核" }).click();
  await page.getByText("已导入 1 条记录，请到待审核中确认。").waitFor();
  await page.getByRole("button", { name: /待审核/ }).click();
  await page.getByRole("button", { name: "确认记住" }).click();
  await page.getByRole("heading", { name: "没有待审核记录" }).waitFor();
  await page.getByRole("button", { name: "工具接入", exact: true }).click();
  await page.getByRole("heading", { name: "Hermes", exact: true }).waitFor();
  await page.screenshot({
    path: join(output, "connections-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "设置与任务", exact: true }).click();
  await page.getByLabel("会话空闲多久后提炼（秒）").fill("45");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByText("设置已保存").waitFor();
  assert.equal((await client.request("/config")).idleSeconds, 45);
  await page.getByRole("button", { name: "全局记忆", exact: true }).click();
  await page.getByLabel("搜索记忆").fill("absentxyz938302");
  await page.getByRole("heading", { name: "没有匹配的记忆" }).waitFor();
  await page.getByLabel("搜索记忆").fill("");
  await page.locator(".memory-row").first().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(output, "memory-mobile.png"),
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  const mcp = new Client({ name: "stdio-acceptance", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/cli.js"), "--home", home, "mcp", "--agent", "pi"],
    stderr: "pipe",
  });
  await mcp.connect(transport);
  assert.equal((await mcp.listTools()).tools.length, 5);
  const found = await mcp.callTool({
    name: "memory_search",
    arguments: { query: "中文" },
  });
  assert.ok(JSON.stringify(found).includes("网页端已纠正"));
  await mcp.close();
  console.log(
    JSON.stringify(
      {
        result: "通过",
        verified: [
          "网页新增、修改、撤回",
          "预览导入与批准",
          "设置持久化",
          "中文搜索",
          "移动端无横向溢出",
          "真实 MCP stdio 进程",
        ],
        screenshots: output,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await daemon.close();
  await rm(home, { recursive: true, force: true });
}
