// Reads the spool files the hooks write (see hook/transport.ts): one line per
// entry, kept until the same entries arrive over HTTP. They matter only for
// processes that end with no chance to send (Ctrl+C, a test runner stopping
// its worker, a closed terminal). Entries already received are dropped by
// the store, by id. A file is removed once its process is gone and it is
// read to the end. The folder is watched, so a write is read at once, and a
// timer reads it too, for file systems that do not report changes.
// No VS Code imports, so it is unit tested on its own.
import * as fs from "node:fs";
import * as path from "node:path";
import { isEntry } from "./server";
import type { Entry } from "./shared/types";

export interface Spool {
  dir: string;
  /** Reads every file now (also runs on a timer). */
  read(): void;
  close(): void;
}

const WATCH_MS = 20;

export function startSpool(dir: string, onEntries: (entries: Entry[]) => void, every = 400): Spool {
  fs.mkdirSync(dir, { recursive: true });
  const offsets = new Map<string, number>();
  const read = () => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      let off = offsets.get(name) ?? 0;
      try {
        const size = fs.statSync(file).size;
        // Emptied by the hook after an HTTP send: start again.
        if (size < off) off = 0;
        if (size > off) {
          const buf = Buffer.alloc(Math.min(size - off, 8_000_000));
          const fd = fs.openSync(file, "r");
          let got = 0;
          try {
            got = fs.readSync(fd, buf, 0, buf.length, off);
          } finally {
            fs.closeSync(fd);
          }
          // Whole lines only: a line still being written is read next time.
          const end = buf.subarray(0, got).lastIndexOf(0x0a);
          if (end >= 0) {
            const good: Entry[] = [];
            for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
              try {
                const e = JSON.parse(line) as unknown;
                if (isEntry(e)) good.push(e);
              } catch {
                // a torn line: skip
              }
            }
            off += end + 1;
            if (good.length) onEntries(good);
          }
        }
        offsets.set(name, off);
        if (off >= size && !alive(Number(name.split("-")[0]))) {
          fs.unlinkSync(file);
          offsets.delete(name);
        }
      } catch {
        // gone or busy: next time
      }
    }
  };
  const timer = setInterval(read, every);
  timer.unref?.();
  // At most one read per WATCH_MS while writes keep coming.
  let soon: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, () => {
      if (soon) return;
      soon = setTimeout(() => {
        soon = undefined;
        read();
      }, WATCH_MS);
      soon.unref?.();
    });
    watcher.on("error", () => watcher?.close());
  } catch {
    // the timer reads it
  }
  return {
    dir,
    read,
    close: () => {
      clearInterval(timer);
      if (soon) clearTimeout(soon);
      watcher?.close();
      read();
    },
  };
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}
