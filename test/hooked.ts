// Runs fixture programs as real processes with the hook, the way an
// integrated terminal would start them, next to a run without it.
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { startServer, type LogServer } from "../src/server";
import { ENV_OPTS, ENV_PORT, ENV_TOKEN } from "../src/names";
import type { Entry } from "../src/shared/types";
import { cleanEnv } from "./expect";

// Bundled into .test-build/unit, so the repo is two folders up.
export const root = path.resolve(import.meta.dirname, "..", "..");
export const fixtures = path.join(root, "test-fixtures");
export const hook = path.join(root, "dist", "hook.cjs").replace(/\\/g, "/");

export interface Receiver {
  server: LogServer;
  received: Entry[];
  /** The variables an integrated terminal gets. */
  env(opts?: Record<string, unknown>): NodeJS.ProcessEnv;
}

export async function receiver(): Promise<Receiver> {
  const received: Entry[] = [];
  const server = await startServer((e) => received.push(...e));
  return {
    server,
    received,
    env(opts = {}) {
      const env = cleanEnv();
      env.NODE_OPTIONS = `--require "${hook}"`;
      env[ENV_PORT] = String(server.port);
      env[ENV_TOKEN] = server.token;
      env[ENV_OPTS] = JSON.stringify({ sourceMaps: true, includeNodeModules: false, browser: true, requests: true, requestBodies: true, ...opts });
      return env;
    },
  };
}

export interface Ran {
  stdout: string;
  stderr: string;
  status: number | null;
}

/** Runs to the end. With `env` undefined: without the hook. */
export function runSync(dir: string, args: string[], env?: NodeJS.ProcessEnv): Ran {
  const r = spawnSync(process.execPath, args, { cwd: dir, env: env ?? cleanEnv(), encoding: "utf8", timeout: 60_000, windowsHide: true });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/** The same, without blocking this process (the receiver runs in it). */
export function run(command: string, args: string[], dir: string, env: NodeJS.ProcessEnv, opts: { shell?: boolean } = {}): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: dir, env, windowsHide: true, shell: opts.shell });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status });
    });
  });
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until `f` is true or `ms` passed. */
export async function until(f: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await wait(50);
  return f();
}

/** Entries from one file (any case, either slash). */
export function inFile(entries: readonly Entry[], file: string): Entry[] {
  const want = path.resolve(file).toLowerCase();
  return entries.filter((e) => path.resolve(e.file).toLowerCase() === want);
}
