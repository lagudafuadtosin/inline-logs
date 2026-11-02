// A route handler in the Edge runtime.
export const runtime = "edge";

export async function GET() {
  const body = { ok: true, at: "edge" };
  console.log("edge handler", body); // @expect edge
  return Response.json(body);
}
