// console.count, time, group and assert: what each call shows at the end of
// its line. Shared by the Node hook and the browser client, so no Node
// imports. The console itself still prints what it prints: this only keeps
// its own copy of the counters, timers and open groups, and uses the text the
// console printed when there was one (Node's console.count calls console.log).
import { formatArgs, FULL, PREVIEW, serialize } from "./serialize";
import type { CounterMethod, Level } from "./types";

export interface CounterShown {
  preview: string;
  full: string;
  level: Level;
  /** The groups the call was made in, before a console.group call opens its own. */
  group?: string;
}

const GROUP_SEP = " › ";

/** A label the way the console reads it, without calling the app's own toString. */
function labelOf(args: readonly unknown[]): string {
  const v = args[0];
  if (v === undefined) return "default";
  if (typeof v === "string") return v;
  if (v === null || typeof v !== "object") return String(v);
  return serialize(v, PREVIEW);
}

/** 1.415ms, 2.031s: the way Node prints a timer. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  return ms < 1000 ? `${ms.toFixed(3)}ms` : `${(ms / 1000).toFixed(3)}s`;
}

export class ConsoleCounters {
  private counts = new Map<string, number>();
  private timers = new Map<string, number>();
  /** Labels of the console groups open now, outermost first. */
  readonly groups: string[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** The open groups as one string, or undefined outside any group. */
  groupPath(): string | undefined {
    return this.groups.length ? this.groups.join(GROUP_SEP) : undefined;
  }

  /**
   * Records one call. Returns what to show, or undefined for calls that
   * show nothing: groupEnd, an assert that passed, a timer that was never
   * started. `heard` is what the console printed for the call through its own
   * log methods, if it did. `assertLevel` is warn in Node (which prints a
   * failed assert with console.warn) and error in browsers.
   */
  call(method: CounterMethod, args: readonly unknown[], heard: readonly unknown[] | undefined, assertLevel: Level): CounterShown | undefined {
    const group = this.groupPath();
    const text = (fallback: string, rest: readonly unknown[] = []) => {
      if (heard) return { preview: formatArgs(heard, PREVIEW), full: formatArgs(heard, FULL) };
      return rest.length ? { preview: `${fallback} ${formatArgs(rest, PREVIEW)}`, full: `${fallback} ${formatArgs(rest, FULL)}` } : { preview: fallback, full: fallback };
    };
    switch (method) {
      case "count": {
        const label = labelOf(args);
        const n = (this.counts.get(label) ?? 0) + 1;
        this.counts.set(label, n);
        return { ...text(`${label}: ${n}`), level: "log", group };
      }
      case "countReset": {
        const label = labelOf(args);
        this.counts.delete(label);
        return { preview: `${label}: 0 (reset)`, full: `${label}: 0 (reset)`, level: "log", group };
      }
      case "time": {
        const label = labelOf(args);
        this.timers.set(label, this.now());
        return { preview: `${label}: timer started`, full: `${label}: timer started`, level: "log", group };
      }
      case "timeLog":
      case "timeEnd": {
        const label = labelOf(args);
        const start = this.timers.get(label);
        if (method === "timeEnd") this.timers.delete(label);
        if (start === undefined && !heard) return undefined;
        return { ...text(`${label}: ${formatMs(this.now() - (start ?? this.now()))}`, method === "timeLog" ? args.slice(1) : []), level: "log", group };
      }
      case "group":
      case "groupCollapsed": {
        const label = heard ? formatArgs(heard, PREVIEW) : args.length ? formatArgs(args, PREVIEW) : "console.group";
        this.groups.push(label);
        if (this.groups.length > 50) this.groups.shift();
        const mark = method === "group" ? "▾" : "▸";
        return { preview: `${mark} ${label}`, full: `${mark} ${heard ? formatArgs(heard, FULL) : args.length ? formatArgs(args, FULL) : "console.group"}`, level: "log", group };
      }
      case "groupEnd":
        this.groups.pop();
        return undefined;
      case "assert": {
        if (args[0]) return undefined;
        return { ...text("Assertion failed" + (args.length > 1 ? ":" : ""), args.slice(1)), level: assertLevel, group };
      }
    }
    return undefined;
  }
}
