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
