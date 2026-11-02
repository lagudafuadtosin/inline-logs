// A page behind a nonce Content-Security-Policy (see proxy.js).
import Secret from "./secret";

export const dynamic = "force-dynamic";

export default function Secure() {
  return <Secret />;
}
