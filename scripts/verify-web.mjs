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
import { MemoryStore } from "../dist/memory/store.js";

const home = await mkdtemp(join(tmpdir(), "umem-web-"));
const config = await initHome(home);
const socket = createServer();
await new Promise((r) => socket.listen(0, "127.0.0.1", r));
config.port = socket.address().port;
await new Promise((r) => socket.close(r));
config.extractionEnabled = false;
config.model = "test-model";
await atomicWrite(join(home, "config.json"), JSON.stringify(config));
const interrupted = await MemoryStore.open(home);
const job = interrupted.db
  .prepare(
    "INSERT INTO jobs (agent, session_id, state, updated_at) VALUES (?, ?, 'running', ?)",
  )
  .run("codex", "interrupted", new Date().toISOString());
interrupted.recordExtractionUsage(Number(job.lastInsertRowid), "test-model", {
  inputTokens: 1_234_000_000,
  cachedInputTokens: 1_200_000,
  outputTokens: 56_000,
});
interrupted.recordExtractionUsage(Number(job.lastInsertRowid), "test-model", {
  inputTokens: 10,
  outputTokens: 0,
});
interrupted.recordExtractionUsage(Number(job.lastInsertRowid), "test-model");
interrupted.recordExtractionUsage(Number(job.lastInsertRowid), null);
interrupted.close();
const invalidFile = join(home, "memories", "global", "invalid.md");
await writeFile(invalidFile, "Missing frontmatter fixture");
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
  await page
    .getByRole("heading", { name: "Global memories", exact: true })
    .waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await page
    .getByRole("combobox", { name: "Language / 语言", exact: true })
    .selectOption("zh-CN");
  await page.getByRole("heading", { name: "全局记忆", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "全局记忆", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
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
  await page.locator(".language-select select").selectOption("en");
  await page.getByRole("textbox", { name: "Content", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Content", exact: true })
      .inputValue(),
    "网页端已纠正：继续使用中文。",
  );
  await page.locator(".language-select select").selectOption("zh-CN");
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
  await page
    .locator(".source summary")
    .getByText("/ 手动记录", { exact: true })
    .waitFor();
  const manual = (await client.request("/memories?status=active")).find(
    (memory) => memory.title === "浏览器新增验证",
  );
  assert.equal(manual?.sources[0].role, "manual");
  await page.getByRole("button", { name: "撤回", exact: true }).click();
  await page.getByRole("button", { name: "确认撤回" }).click();
  await page.getByLabel("记忆状态").selectOption("withdrawn");
  await page.getByRole("heading", { name: "浏览器新增验证" }).last().waitFor();
  await page.getByRole("button", { name: "导入记忆", exact: true }).click();
  const longName = join(home, `${"a".repeat(161)}.md`);
  await writeFile(longName, "验收文件名长度提示");
  await page.getByLabel("绝对路径").fill(longName);
  await page.getByRole("button", { name: "预览文件" }).click();
  await page.getByRole("button", { name: "将 1 个文件导入待审核" }).click();
  await page.getByText("文件名（不含 .md）最多 160 个字符。").waitFor();
  await page.locator(".language-select select").selectOption("en");
  await page
    .getByText("Filename (excluding .md) must be at most 160 characters.")
    .waitFor();
  await page.locator(".language-select select").selectOption("zh-CN");
  const file = join(home, "native.md");
  await writeFile(file, "跨工具导入验收的偏好记录");
  await page.getByLabel("绝对路径").fill(file);
  await page.getByRole("button", { name: "预览文件" }).click();
  await page.getByRole("button", { name: "将 1 个文件导入待审核" }).click();
  await page.getByText("已导入 1 条记录，请到待审核中确认。").waitFor();
  await page.getByRole("button", { name: /待审核/ }).click();
  await page.getByRole("button", { name: /native/ }).click();
  await page
    .locator(".source summary")
    .getByText("/ 导入", { exact: true })
    .waitFor();
  const [imported] = await client.request("/memories?status=candidate");
  assert.equal(imported?.sources[0].role, "import");
  await page.getByRole("button", { name: "确认记住" }).click();
  await page.getByRole("heading", { name: "没有待审核记录" }).waitFor();
  await page.getByRole("button", { name: "工具接入", exact: true }).click();
  await page.getByRole("heading", { name: "Hermes", exact: true }).waitFor();
  await page.screenshot({
    path: join(output, "connections-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "设置与任务", exact: true }).click();
  for (const language of ["zh-CN", "en"]) {
    await page.locator(".language-select select").selectOption(language);
    const zh = language === "zh-CN";
    for (const name of zh
      ? ["按模型统计提炼用量", "最近提炼任务"]
      : ["Extraction usage by model", "Recent extraction jobs"]) {
      const section = page.getByRole("region", { name });
      for (const label of zh
        ? [
            "test-model",
            "Codex 默认（模型未上报）",
            "调用 3 次",
            "输入 token：1.23B",
            "其中缓存输入：1.2M (1/3 次已上报)",
            "输出 token：56K",
            "总 token：1.23B",
            "2/3 次已上报",
            "Token 未上报",
          ]
        : [
            "test-model",
            "Codex default (model not reported)",
            "Calls: 3",
            "Input tokens: 1.23B",
            "Cached input: 1.2M (1 of 3 calls reported usage)",
            "Output tokens: 56K",
            "Total tokens: 1.23B",
            "2 of 3 calls reported usage",
            "Tokens not reported",
          ]) {
        await section.getByText(label, { exact: true }).waitFor();
      }
      await section.getByTitle("1,234,000,010", { exact: true }).waitFor();
    }
    await page
      .getByText(
        "The service exited before the job finished. Waiting to retry.",
        {
          exact: true,
        },
      )
      .waitFor({ timeout: 5000 });
    await page
      .getByText(`${invalidFile}: Missing YAML frontmatter`, { exact: true })
      .waitFor({ timeout: 5000 });
  }
  await page.locator(".language-select select").selectOption("zh-CN");
  await page.getByLabel("模型（留空使用默认模型）").fill("");
  await page.getByLabel("会话空闲多久后提炼（秒）").fill("45");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByText("设置已保存").waitFor();
  const savedConfig = await client.request("/config");
  assert.equal(savedConfig.idleSeconds, 45);
  assert.equal(savedConfig.model, "");
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
  for (const language of ["en", "zh-CN"]) {
    await page.locator(".language-select select").selectOption(language);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      for (const label of language === "en"
        ? [
            "Global memories",
            "Connections",
            "Import memories",
            "Settings & jobs",
          ]
        : ["全局记忆", "工具接入", "导入记忆", "设置与任务"]) {
        await page.getByRole("button", { name: label, exact: true }).click();
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          `${language}: ${label} overflows at ${width}px`,
        );
      }
      await page.screenshot({
        path: join(output, `settings-${language}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await rm(invalidFile);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".service-state button").click();
  await page
    .getByText(`${invalidFile}: Missing YAML frontmatter`, {
      exact: true,
    })
    .waitFor({ state: "hidden" });
  const mcp = new Client({ name: "stdio-acceptance", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/cli.js"), "--home", home, "mcp", "--agent", "pi"],
    stderr: "pipe",
  });
  try {
    await mcp.connect(transport);
    assert.equal((await mcp.listTools()).tools.length, 5);
    const found = await mcp.callTool({
      name: "memory_search",
      arguments: { query: "中文" },
    });
    assert.ok(JSON.stringify(found).includes("网页端已纠正"));
    const invalid = await mcp.callTool({
      name: "memory_search",
      arguments: { query: 42 },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await mcp.close();
  }
  const summary = page.locator(".mcp-summary");
  const records = page.locator(".mcp-records");
  for (const language of ["en", "zh-CN"]) {
    const english = language === "en";
    await page.locator(".language-select select").selectOption(language);
    await page
      .getByRole("button", {
        name: english ? "MCP calls" : "MCP 调用",
        exact: true,
      })
      .click();
    await summary.getByRole("rowheader", { name: "memory_forget" }).waitFor();
    await summary.getByText("50%", { exact: true }).waitFor();
    await records
      .getByText(english ? "Input rejected" : "参数被拒", { exact: true })
      .waitFor();
    await records
      .getByText(english ? /matched · .* returned/ : /命中 .* 条 · 返回 .* 条/)
      .waitFor();
    assert.equal(await records.getByRole("listitem").count(), 2);
    assert.equal(await records.getByText("网页端已纠正").count(), 0);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({
        width,
        height: width === 1440 ? 1000 : 844,
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `${language}: MCP calls overflow at ${width}px`,
      );
      if (width === 1440 || width === 320) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: join(output, `mcp-calls-${language}-${width}.png`),
          fullPage: true,
        });
      }
      const lastRecord = records.getByRole("listitem").last();
      await lastRecord.scrollIntoViewIfNeeded();
      assert.ok(
        await lastRecord.evaluate((row) => {
          const { top, bottom } = row.getBoundingClientRect();
          return top >= 0 && bottom <= window.innerHeight;
        }),
        `${language}: last MCP record is out of view at ${width}px`,
      );
    }
    await page
      .getByLabel(english ? "Record status" : "明细状态")
      .selectOption("success");
    await records
      .getByText(english ? "Succeeded" : "成功", { exact: true })
      .waitFor();
    assert.equal(await records.getByRole("listitem").count(), 1);
    await summary.getByText("50%", { exact: true }).waitFor();
    await page.getByLabel(english ? /^Host/ : /^宿主/).selectOption("codex");
    await records
      .getByText(
        english
          ? "No calls match these filters."
          : "没有符合当前筛选条件的调用。",
        { exact: true },
      )
      .waitFor();
    await page
      .getByRole("button", {
        name: english ? "Global memories" : "全局记忆",
        exact: true,
      })
      .click();
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        result: "passed",
        verified: [
          "Create, edit, and withdraw memories",
          "Import preview and approval",
          "Persistent settings",
          "Extraction token usage by requested model",
          "Chinese content and search are preserved",
          "Persistent English and Chinese UI selection",
          "No horizontal overflow on mobile",
          "Real MCP stdio process",
          "MCP tool summary and call records with host and status filters",
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
