import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import lockfile from "proper-lockfile";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { initHome } from "./config.js";
import { MemoryStore } from "./memory/store.js";
import { MemoryWorker } from "./memory/worker.js";
import { createApp } from "./server.js";

export async function startDaemon(
  home: string,
  options: { worker?: boolean; quiet?: boolean } = {},
) {
  const config = await initHome(home);
  if (options.worker === false) config.extractionEnabled = false;
  const release = await lockfile.lock(home, { realpath: true, stale: 30000 });
  const store = await MemoryStore.open(home).catch(async (error) => {
    await release();
    throw error;
  });
  const worker = new MemoryWorker(store, config);
  const app = createApp(
    store,
    (await readFile(join(home, "token"), "utf8")).trim(),
    worker,
  );
  const webRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "dist",
    "web",
  );
  app.use("/*", serveStatic({ root: webRoot }));
  let server: ReturnType<typeof serve>;
  try {
    server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      const s = serve(
        { fetch: app.fetch, port: config.port, hostname: "127.0.0.1" },
        () => resolve(s),
      );
      s.on("error", reject);
    });
  } catch (error) {
    store.close();
    await release();
    throw error;
  }
  worker.start();
  if (!options.quiet)
    console.log(
      `公共记忆已启动：http://127.0.0.1:${config.port}\n数据目录：${home}\n使用 umem web 打开已授权的管理页。`,
    );
  const close = async () => {
    await worker.stop();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    store.close();
    await release();
  };
  return { server, store, worker, app, close };
}
