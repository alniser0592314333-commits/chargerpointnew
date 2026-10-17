export function isAllowedReceiptPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 300) return false;
  if (path.startsWith("/") || path.includes("..") || path.includes("\\")) return false;
  return /^(?:orders|customers)\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,100}\.(?:jpg|jpeg|png|webp)$/i.test(path);
}
