// Pages with a Content-Security-Policy would block the inline client script
// and maybe its POSTs. For each policy the page sends (header or <meta>):
//  - a nonce for scripts: the client script carries the same nonce, the
//    policy is left as it is;
//  - inline scripts allowed already ('unsafe-inline' with no nonce or hash):
//    nothing to do;
//  - otherwise the client script's own sha256 hash is added to the script
//    directive, which allows that one script and nothing else.
// POSTs go to the page's own origin. When connect-src (or default-src) does
// not allow 'self', the one private endpoint URL is added.
import { createHash } from "node:crypto";

export function scriptHash(body: string): string {
  return `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
}

interface Directive {
  name: string;
  tokens: string[];
}

function parse(policy: string): Directive[] {
  return policy
    .split(";")
    .map((d) => d.trim().split(/\s+/).filter(Boolean))
    .filter((t) => t.length > 0)
    .map(([name, ...tokens]) => ({ name: name.toLowerCase(), tokens }));
}

function effective(ds: Directive[], names: string[]): Directive | undefined {
  for (const n of names) {
    const d = ds.find((x) => x.name === n);
    if (d) return d;
  }
  return undefined;
}

export interface Allowed {
  /** The policy to send instead (the same text when nothing had to change). */
  policy: string;
  /** A nonce the policy already trusts: put it on the client script. */
  nonce?: string;
}

/** One policy (no commas). `endpoint` is the absolute URL the client posts to. */
export function allowClient(policy: string, hash: string, endpoint: string): Allowed {
  const ds = parse(policy);
  let changed = false;
  let nonce: string | undefined;
  const script = effective(ds, ["script-src-elem", "script-src", "default-src"]);
  if (script) {
    const lower = script.tokens.map((t) => t.toLowerCase());
    // A page that runs no script at all has nothing to show: left alone.
    if (lower.includes("'none'")) return { policy };
    const n = script.tokens.find((t) => /^'nonce-[^']+'$/i.test(t));
    const hashes = lower.some((t) => /^'sha(256|384|512)-/.test(t));
    if (n) nonce = n.slice(7, -1);
    else if (!(lower.includes("'unsafe-inline'") && !hashes && !lower.includes("'strict-dynamic'")) && !script.tokens.includes(hash)) {
      script.tokens.push(hash);
      changed = true;
    }
  }
  const connect = effective(ds, ["connect-src", "default-src"]);
  if (connect) {
    const lower = connect.tokens.map((t) => t.toLowerCase());
    if (!lower.includes("'self'") && !lower.includes("*") && !connect.tokens.includes(endpoint)) {
      connect.tokens = connect.tokens.filter((t) => t.toLowerCase() !== "'none'");
      connect.tokens.push(endpoint);
      changed = true;
    }
  }
  return { policy: changed ? ds.map((d) => [d.name, ...d.tokens].join(" ")).join("; ") : policy, nonce };
}

/** A header value may hold several policies separated by commas; each one must allow the client. */
export function allowClientAll(value: string, hash: string, endpoint: string): Allowed {
  let nonce: string | undefined;
  const parts = value.split(",").map((p) => {
    const a = allowClient(p, hash, endpoint);
    nonce ??= a.nonce;
    return a.policy.trim();
  });
  return { policy: parts.join(", "), nonce };
}

/** Rewrites <meta http-equiv="Content-Security-Policy"> tags in an HTML chunk. Tags with entities in the policy are left alone. */
export function allowClientInMeta(html: string, hash: string, endpoint: string): Allowed & { html: string } {
  let nonce: string | undefined;
  const out = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, (tag) => {
    const m = /\bcontent\s*=\s*(")([^"]*)"|\bcontent\s*=\s*(')([^']*)'/i.exec(tag);
    if (!m) return tag;
    const quote = m[1] ?? m[3];
    const value = m[2] ?? m[4];
    if (value.includes("&")) return tag;
    const a = allowClientAll(value, hash, endpoint);
    nonce ??= a.nonce;
    // A policy in single quotes cannot hold the quoted keywords we add.
    if (a.policy === value || (quote === "'" && a.policy.includes("'"))) return tag;
    return tag.slice(0, m.index) + `content=${quote}${a.policy}${quote}` + tag.slice(m.index + m[0].length);
  });
  return { html: out, policy: "", nonce };
}
