// HTTP Basic Auth in front of the whole site, as a Netlify Edge Function (runs on
// every request, before the CDN cache, on the free plan too).
//
// Credentials come from the site's environment variables:
//   BASIC_AUTH_USER      username
//   BASIC_AUTH_PASSWORD  password (UTF-8, so æøå are fine)
// If either is missing the site stays closed (503) rather than silently public.
import type { Config, Context } from "@netlify/edge-functions";

const REALM = "Clicker Generator";

function unauthorized(message = "Authentication required"): Response {
  return new Response(message, {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Constant-time string comparison (no early exit on the first differing byte). */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Browsers send `user:pass` as base64 of the UTF-8 bytes. */
function decodeCredentials(encoded: string): { user: string; pass: string } | null {
  let decoded: string;
  try {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

export default async (request: Request, context: Context): Promise<Response> => {
  const user = Netlify.env.get("BASIC_AUTH_USER");
  const pass = Netlify.env.get("BASIC_AUTH_PASSWORD");
  if (!user || !pass) {
    return new Response(
      "Site protection is not configured: set BASIC_AUTH_USER and BASIC_AUTH_PASSWORD in the Netlify environment variables.",
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme?.toLowerCase() !== "basic" || !encoded) return unauthorized();
  const creds = decodeCredentials(encoded);
  if (!creds) return unauthorized();
  // Evaluate both comparisons so timing does not reveal which half was wrong.
  const userOk = safeEqual(creds.user, user);
  const passOk = safeEqual(creds.pass, pass);
  if (!(userOk && passOk)) return unauthorized("Wrong username or password");

  return context.next();
};

export const config: Config = { path: "/*" };
