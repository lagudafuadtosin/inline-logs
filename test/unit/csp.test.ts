import { test } from "node:test";
import assert from "node:assert/strict";
import { allowClient, allowClientAll, allowClientInMeta, scriptHash } from "../../src/hook/csp";

const hash = scriptHash("window.x=1");
const ep = "http://localhost:5173/__inline-logs/abc";

test("the hash is the script's own sha256, quoted the CSP way", () => {
  assert.match(hash, /^'sha256-[A-Za-z0-9+/]+=*'$/);
  assert.notEqual(scriptHash("other"), hash);
});

test("no policy, or inline scripts already allowed: nothing changes", () => {
  assert.equal(allowClient("img-src 'self'", hash, ep).policy, "img-src 'self'");
  const open = "script-src 'self' 'unsafe-inline'; connect-src 'self'";
  assert.equal(allowClient(open, hash, ep).policy, open);
});

test("a nonce the policy trusts is reused and the policy stays as it is", () => {
  const p = "script-src 'nonce-r4nd0m' 'strict-dynamic'; connect-src 'self'";
  assert.deepEqual(allowClient(p, hash, ep), { policy: p, nonce: "r4nd0m" });
});

test("a strict policy gets the script's hash, in the directive that applies", () => {
  assert.equal(allowClient("script-src 'self'", hash, ep).policy, `script-src 'self' ${hash}`);
  assert.equal(allowClient("default-src 'self'", hash, ep).policy, `default-src 'self' ${hash}`);
  // script-src-elem wins over script-src for <script> elements.
  assert.equal(allowClient("script-src 'self'; script-src-elem 'self'", hash, ep).policy, `script-src 'self'; script-src-elem 'self' ${hash}`);
  // 'unsafe-inline' next to a hash or 'strict-dynamic' is ignored by browsers, so a hash is needed.
  assert.equal(allowClient("script-src 'unsafe-inline' 'strict-dynamic'", hash, ep).policy, `script-src 'unsafe-inline' 'strict-dynamic' ${hash}`);
});

test("a page that allows no script at all is left alone", () => {
  assert.equal(allowClient("script-src 'none'", hash, ep).policy, "script-src 'none'");
});

test("posts to the page's own origin: only the one endpoint is added when 'self' is not allowed", () => {
  assert.equal(allowClient("connect-src 'self' ws:", hash, ep).policy, "connect-src 'self' ws:");
  assert.equal(allowClient("connect-src ws:", hash, ep).policy, `connect-src ws: ${ep}`);
  assert.equal(allowClient("connect-src 'none'", hash, ep).policy, `connect-src ${ep}`);
  assert.equal(allowClient("default-src 'none'", hash, ep).policy, `default-src 'none'`, "no script runs at all: nothing to post either");
});

test("several policies in one header value are each fixed", () => {
  const a = allowClientAll("script-src 'self', script-src 'nonce-n1'", hash, ep);
  assert.equal(a.policy, `script-src 'self' ${hash}, script-src 'nonce-n1'`);
  assert.equal(a.nonce, "n1");
});

test("a <meta> policy in the page is fixed in place", () => {
  const html = `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'self'; connect-src ws:"></head>`;
  const out = allowClientInMeta(html, hash, ep);
  assert.equal(out.html, `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'self' ${hash}; connect-src ws: ${ep}"></head>`);
  const nonce = allowClientInMeta(`<meta http-equiv="content-security-policy" content="script-src 'nonce-xyz'">`, hash, ep);
  assert.equal(nonce.nonce, "xyz");
  const entity = `<meta http-equiv="Content-Security-Policy" content="script-src &#39;self&#39;">`;
  assert.equal(allowClientInMeta(entity, hash, ep).html, entity, "a policy written with entities is not touched");
});
