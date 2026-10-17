import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { escapeLikeLiteral, hashRateLimitKey, isTrustedClientIp, normalizeUsername, publicAuthFailure } from "./requestValidation.ts";

Deno.test("username input is normalized and bounded", () => {
  assertEquals(normalizeUsername("  operator  "), "operator");
  assertEquals(normalizeUsername(""), null);
  assertEquals(normalizeUsername("x".repeat(65)), null);
  assertEquals(normalizeUsername("admin\n"), null);
  assertEquals(normalizeUsername(7), null);
});

Deno.test("username lookup treats SQL LIKE metacharacters literally", () => {
  assertEquals(escapeLikeLiteral("a%_\\b"), "a\\%\\_\\\\b");
});

Deno.test("only a single trusted IP address is accepted for Auth rate-limit forwarding", () => {
  assertEquals(isTrustedClientIp("203.0.113.8"), true);
  assertEquals(isTrustedClientIp("2001:db8::1"), true);
  assertEquals(isTrustedClientIp("203.0.113.8, 10.0.0.1"), false);
  assertEquals(isTrustedClientIp("spoofed"), false);
  assertEquals(isTrustedClientIp("999.1.1.1"), false);
});

Deno.test("unknown usernames and bad passwords share one public failure response", () => {
  assertEquals(publicAuthFailure(400), publicAuthFailure(401));
  assertEquals(publicAuthFailure(400).body, {
    session: null,
    error: "Invalid login credentials",
    isInvalidCredentials: true,
  });
  assertEquals(publicAuthFailure(429).status, 429);
  assertEquals(publicAuthFailure(429).body, {
    session: null,
    error: "RATE_LIMIT",
    isRateLimited: true,
  });
});

Deno.test("rate-limit keys are stable HMAC digests and do not expose raw identifiers", async () => {
  const first = await hashRateLimitKey("a sufficiently long test secret for rate limits", "ip:203.0.113.8");
  const repeat = await hashRateLimitKey("a sufficiently long test secret for rate limits", "ip:203.0.113.8");
  const different = await hashRateLimitKey("a sufficiently long test secret for rate limits", "ip:203.0.113.9");
  assertEquals(first, repeat);
  assertEquals(first.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(first), true);
  assertEquals(first === different, false);
  assertEquals(first.includes("203.0.113.8"), false);
});

Deno.test("Auth infrastructure failures stay distinct from invalid credentials without exposing account state", () => {
  assertEquals(publicAuthFailure(503).status, 503);
  assertEquals(publicAuthFailure(503).body, {
    error: "Username sign-in is temporarily unavailable",
  });
});
