import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const cli = (args: string[], env = process.env) =>
  exec(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), ...args], {
    env,
  });

test("CLI help is English regardless of browser language", async () => {
  for (const command of [
    [],
    ["setup"],
    ["service"],
    ["memory"],
    ["evidence"],
    ["evidence", "search"],
    ["evidence", "get"],
    ["import"],
    ["export"],
  ]) {
    const { stdout, stderr } = await cli([...command, "--help"]);
    expect(stdout).toContain("Usage:");
    expect(stdout + stderr).not.toMatch(/\p{Script=Han}/u);
  }
});

test.each(["default", "environment", "flag overrides environment"])(
  "setup preview shows a usable doctor command in English with %s home",
  async (selection) => {
    const base = await mkdtemp(join(tmpdir(), "umem-cli-language-"));
    try {
      const defaultHome = join(base, ".user-memory");
      const customHome = join(base, "custom data");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: base,
        USERPROFILE: base,
      };
      delete env.UMEM_HOME;
      if (selection !== "default") env.UMEM_HOME = customHome;
      const override = selection === "flag overrides environment";
      const options = override ? ["--home", defaultHome] : [];
      const { stdout } = await cli(
        [
          ...options,
          "setup",
          "pi",
          "--dry-run",
          "--target-home",
          join(base, "host"),
        ],
        env,
      );
      const preview = JSON.parse(stdout);
      expect(preview.applied).toBe(false);
      expect(preview.files.length).toBeGreaterThan(0);
      const expectedHome = override ? defaultHome : env.UMEM_HOME;
      const command = expectedHome
        ? `umem --home '${expectedHome}' doctor`
        : "umem doctor";
      expect(preview.instructions[0]).toContain(`run ${command} to inspect`);
      expect(stdout).not.toMatch(/\p{Script=Han}/u);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  },
);

test("unknown CLI options fail with English diagnostics", async () => {
  const result = await cli(["--not-a-real-option"]).then(
    () => undefined,
    (error: { code: number; stderr: string }) => error,
  );
  expect(result?.code).toBe(1);
  expect(result?.stderr).toContain("unknown option");
  expect(result?.stderr).not.toMatch(/\p{Script=Han}/u);
});
