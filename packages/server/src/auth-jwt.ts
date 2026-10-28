import { jwtVerify } from "jose";

/** Verify a Supabase Auth access token (HS256 locally). Returns the auth user id, or null. */
export async function verifyToken(req: Request, secret: string): Promise<string | null> {
  const h = req.headers.get("authorization");
  if (!h?.startsWith("Bearer ")) return null;
  try {
    const { payload } = await jwtVerify(h.slice(7), new TextEncoder().encode(secret), { algorithms: ["HS256"] });
    return typeof payload.sub === "string" && payload.role === "authenticated" ? payload.sub : null;
  } catch { return null; }
}

