export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const username = value.trim();
  if (!username || username.length > 64) return null;
  return username;
}

// PostgREST ilike uses SQL pattern syntax. Escape wildcard characters so an input
// username cannot turn identity resolution into a pattern search.
export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

// Only use the platform-provided Cloudflare client-IP header. Never trust a
// client-supplied X-Forwarded-For value for authentication rate limiting.
export function isTrustedClientIp(value: string): boolean {
  if (!value || value.includes(",") || value.length > 64) return false;
  const parts = value.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return true;
  if (!value.includes(":") || !/^[0-9a-f:]+$/i.test(value)) return false;
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

export function publicAuthFailure(status: number): { status: number; body: Record<string, unknown> } {
  if (status === 429) {
    return { status: 429, body: { session: null, error: "RATE_LIMIT", isRateLimited: true } };
  }
  if (status >= 500) {
    return { status: 503, body: { error: "Username sign-in is temporarily unavailable" } };
  }
  // Never surface whether a username exists or whether its Auth account is confirmed.
  return {
    status: 401,
    body: { session: null, error: "Invalid login credentials", isInvalidCredentials: true },
  };
}

export async function hashRateLimitKey(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
