import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { atomicWrite, initHome, readOptional } from "./config.js";

const exec = promisify(execFile);

export async function configureService(
  home: string,
  action: "install" | "uninstall",
  print: (value: unknown) => void,
  { force, dryRun }: { force?: boolean; dryRun?: boolean } = {},
  system = {
    platform: process.platform,
    userHome: homedir(),
    getUid: () => process.getuid!(),
    launchctl: async (args: string[]) => {
      await exec("launchctl", args);
    },
  },
) {
  if (system.platform !== "darwin")
    throw new Error(
      "Login services are currently supported only on macOS. Run umem serve on other systems.",
    );
  const label = "local.user-memory";
  const path = join(
    system.userHome,
    "Library",
    "LaunchAgents",
    `${label}.plist`,
  );
  if (dryRun) {
    print({ applied: false, path, uninstall: "umem service uninstall" });
    return;
  }
  const domain = `gui/${system.getUid()}`;
  const target = `${domain}/${label}`;
  const release = await lockfile.lock(system.userHome, {
    lockfilePath: join(system.userHome, ".umem-service.lock"),
  });
  try {
    const isLoaded = () =>
      system.launchctl(["print", target]).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          // launchctl print returns 113 for a missing service in an existing domain.
          if (Number(error.code) === 113) return false;
          throw error;
        },
      );
    const stop = async () => {
      await system.launchctl(["bootout", target]);
      // bootout can return before launchd removes the service from its domain.
      for (let i = 0; i < 100; i++) {
        if (!(await isLoaded())) return;
        await delay(100);
      }
      throw new Error("Timed out waiting for the login service to unload.");
    };
    const loaded = await isLoaded();
    if (action === "uninstall") {
      if (loaded) await stop();
      await rm(path, { force: true });
      print({ installed: false, path });
      return;
    }
    if (loaded && !force) {
      print({
        applied: false,
        installed: true,
        path,
        note: "The login service is already loaded.",
      });
      return;
    }
    if (!force && (await readOptional(path)) !== undefined) {
      await system.launchctl(["bootstrap", domain, path]);
      print({ applied: true, installed: true, path });
      return;
    }
    const esc = (s: string) =>
      s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    const cli = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "dist",
      "cli.js",
    );
    const content = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[process.execPath, cli, "--home", home, "serve"].map((s) => `<string>${esc(s)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH ?? "/usr/bin:/bin")}</string></dict><key>StandardOutPath</key><string>${esc(join(home, "service.log"))}</string><key>StandardErrorPath</key><string>${esc(join(home, "service.log"))}</string></dict></plist>`;
    await initHome(home);
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, content);
    if (loaded) await stop();
    await system.launchctl(["bootstrap", domain, path]);
    print({ applied: true, installed: true, path });
  } finally {
    await release();
  }
}
