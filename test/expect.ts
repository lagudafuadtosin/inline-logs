import { readFileSync } from "node:fs";

/** Reads "// @expect <name>" markers: name -> 1-based line. */
export function expectedLines(file: string): Map<string, number> {
  const out = new Map<string, number>();
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((text, i) => {
      const m = /\/\/ @expect ([\w-]+)/.exec(text);
      if (m) out.set(m[1], i + 1);
    });
  return out;
}

/** An env with nothing of ours in it (and no NODE_OPTIONS at all). */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^INLINE_LOGS_|^NODE_OPTIONS$/i.test(k)) delete env[k];
  return env;
}
