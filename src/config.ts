import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
  link,
  unlink,
} from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";

const ConfigFields = {
  port: z.number().int().min(1024).max(65535),
  codexPath: z.string(),
  model: z.string().optional(),
  extractionEnabled: z.boolean(),
  idleSeconds: z.number().int().min(0),
  workerTimeoutSeconds: z.number().int().min(1),
};
export const ConfigSchema = z.object({
  ...ConfigFields,
  port: ConfigFields.port.default(43123),
  codexPath: ConfigFields.codexPath.default("codex"),
  extractionEnabled: ConfigFields.extractionEnabled.default(true),
  idleSeconds: ConfigFields.idleSeconds.default(30),
  workerTimeoutSeconds: ConfigFields.workerTimeoutSeconds.default(180),
});
export const ConfigPatchSchema = z
  .object(ConfigFields)
  .omit({ port: true })
  .partial();
export type Config = z.infer<typeof ConfigSchema>;
const defaultMemoryHome = () => resolve(homedir(), ".umem");

export function memoryHome(value?: string) {
  return resolve(value ?? process.env.UMEM_HOME ?? defaultMemoryHome());
}

export function canOmitHome(home: string) {
  return home === defaultMemoryHome() && home === memoryHome();
}
export async function atomicWrite(path: string, content: string) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
}
export async function readOptional(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
}
export async function loadConfig(home: string) {
  const raw = await readOptional(join(home, "config.json"));
  return ConfigSchema.parse(raw ? JSON.parse(raw) : {});
}
export async function initHome(home: string) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  for (const dir of [
    "memories/global",
    "memories/projects",
    "history",
    "spool",
    "worker",
    "backups",
    "receipts",
  ])
    await mkdir(join(home, dir), { recursive: true, mode: 0o700 });
  for (const [name, value] of [
    ["config.json", JSON.stringify(ConfigSchema.parse({}), null, 2)],
    ["token", randomBytes(32).toString("hex")],
  ]) {
    if ((await readOptional(join(home, name))) !== undefined) continue;
    const temporary = join(home, `${name}.${randomUUID()}.tmp`);
    await writeFile(temporary, value, { mode: 0o600 });
    try {
      await link(temporary, join(home, name)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
    } finally {
      await unlink(temporary);
    }
  }
  return loadConfig(home);
}
