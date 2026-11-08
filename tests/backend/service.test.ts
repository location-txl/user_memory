import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, vi } from "vitest";
import { test } from "./fixtures.js";
import { configureService } from "../../src/service.js";

test("登录服务预览不执行 launchctl 或写入系统目录", async ({ home }) => {
  const print = vi.fn();
  const launchctl = vi.fn();
  const system = {
    platform: "darwin" as const,
    userHome: home,
    getUid: () => 501,
    launchctl,
  };
  await configureService(
    join(home, "data"),
    "install",
    print,
    { dryRun: true },
    system,
  );
  expect(print).toHaveBeenCalledExactlyOnceWith({
    applied: false,
    path: join(home, "Library", "LaunchAgents", "local.user-memory.plist"),
    uninstall: "umem service uninstall",
  });
  expect(launchctl).not.toHaveBeenCalled();
  expect(await readdir(home)).toEqual([]);
});

test("普通安装保留原配置，强制安装替换并重载，卸载保留数据", async ({
  home,
}) => {
  const path = join(home, "Library", "LaunchAgents", "local.user-memory.plist");
  const target = "gui/501/local.user-memory";
  const data = join(home, "memory & data");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "existing plist");

  let loaded = false;
  const launchctl = vi.fn(async ([command]: string[]) => {
    if (command === "print" && !loaded) {
      throw Object.assign(new Error("Service not found"), { code: 113 });
    }
    if (command === "bootstrap") loaded = true;
    if (command === "bootout") loaded = false;
  });
  const system = {
    platform: "darwin" as const,
    userHome: home,
    getUid: () => 501,
    launchctl,
  };
  const print = vi.fn();

  await configureService(data, "install", print, {}, system);
  expect(await readFile(path, "utf8")).toBe("existing plist");
  expect(launchctl.mock.calls).toEqual([
    [["print", target]],
    [["bootstrap", "gui/501", path]],
  ]);
  expect(print).toHaveBeenLastCalledWith({
    applied: true,
    installed: true,
    path,
  });

  launchctl.mockClear();
  await configureService(data, "install", print, {}, system);
  expect(launchctl).toHaveBeenCalledExactlyOnceWith(["print", target]);
  expect(print).toHaveBeenLastCalledWith(
    expect.objectContaining({ applied: false, installed: true }),
  );
  expect(await readFile(path, "utf8")).toBe("existing plist");

  launchctl.mockClear();
  await configureService(data, "install", print, { force: true }, system);
  expect(await readFile(path, "utf8")).toContain(
    "<string>--home</string><string>" +
      join(home, "memory &amp; data") +
      "</string><string>serve</string>",
  );
  expect(launchctl.mock.calls.map(([args]) => args)).toEqual([
    ["print", target],
    ["bootout", target],
    ["print", target],
    ["bootstrap", "gui/501", path],
  ]);

  launchctl.mockClear();
  await configureService(data, "uninstall", print, {}, system);
  expect(launchctl.mock.calls.map(([args]) => args)).toEqual([
    ["print", target],
    ["bootout", target],
    ["print", target],
  ]);
  expect(print).toHaveBeenLastCalledWith({ installed: false, path });
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(data)).toContain("memories");
});
