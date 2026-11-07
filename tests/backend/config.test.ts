import { expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "./fixtures.js";
import { initHome, loadConfig } from "../../src/config.js";

test("并发初始化不替换访问密钥或读取半写配置", async ({ home }) => {
  const fresh = join(home, "fresh");
  await Promise.all(Array.from({ length: 30 }, () => initHome(fresh)));
  const token = await readFile(join(fresh, "token"), "utf8");
  await initHome(fresh);
  expect(await readFile(join(fresh, "token"), "utf8")).toBe(token);
  expect(token).toHaveLength(64);
});

test("已有配置在重复初始化后仍保留并读取缺省值", async ({ home }) => {
  await writeFile(
    join(home, "config.json"),
    '{"port":45678,"extractionEnabled":false}',
  );
  expect(await initHome(home)).toMatchObject({
    port: 45678,
    extractionEnabled: false,
    idleSeconds: 30,
  });
  expect(await loadConfig(home)).toMatchObject({
    port: 45678,
    extractionEnabled: false,
    idleSeconds: 30,
  });
  expect(await readFile(join(home, "config.json"), "utf8")).toBe(
    '{"port":45678,"extractionEnabled":false}',
  );
});
