import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const cli = (...args: string[]) =>
  exec(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), ...args]);

test("CLI help is English regardless of browser language", async () => {
  for (const command of [
    [],
    ["setup"],
    ["service"],
    ["memory"],
    ["import"],
    ["export"],
  ]) {
    const { stdout, stderr } = await cli(...command, "--help");
    expect(stdout).toContain("Usage:");
    expect(stdout + stderr).not.toMatch(/\p{Script=Han}/u);
  }
});

test("setup preview uses English messages without modifying host files", async () => {
  const base = await mkdtemp(join(tmpdir(), "umem-cli-language-"));
  try {
    const { stdout } = await cli(
      "--home",
      join(base, "data"),
      "setup",
      "pi",
      "--dry-run",
      "--target-home",
      join(base, "host"),
    );
    const preview = JSON.parse(stdout);
    expect(preview.applied).toBe(false);
    expect(preview.files.length).toBeGreaterThan(0);
    expect(stdout).not.toMatch(/\p{Script=Han}/u);
  } finally {
    // base is the unique temporary directory created by this test.
    expect(base.startsWith(join(tmpdir(), "umem-cli-language-"))).toBe(true);
    await rm(base, { recursive: true, force: true });
  }
});

test("unknown CLI options fail with English diagnostics", async () => {
  const result = await cli("--not-a-real-option").then(
    () => undefined,
    (error: { code: number; stderr: string }) => error,
  );
  expect(result?.code).toBe(1);
  expect(result?.stderr).toContain("unknown option");
  expect(result?.stderr).not.toMatch(/\p{Script=Han}/u);
});
