// A strict nonce-based Content-Security-Policy on /secure only, the way the Next.js docs set one up.
import { NextResponse } from "next/server";

export function proxy(request) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:`;
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = { matcher: "/secure" };
