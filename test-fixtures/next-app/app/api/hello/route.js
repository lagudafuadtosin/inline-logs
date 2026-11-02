// A route handler (app router API).
export async function GET() {
  const body = { ok: true, at: "route" };
  console.info("route handler", body); // @expect route
  return Response.json(body);
}
