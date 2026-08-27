import { createHash, timingSafeEqual } from "node:crypto";

export function checkToken(authHeader: string | undefined, expected: string): boolean {
  // Case-insensitive scheme per RFC 6750 §2.1 / RFC 7235 §2.1, and `\s+` for
  // RFC 7230's allowance of extra space. Matches the OAuth path's parsing, so a
  // client that authenticates over OAuth cannot be rejected on its bearer token.
  const m = /^Bearer\s+(.+)$/i.exec(authHeader ?? "");
  if (!m) return false;
  const a = createHash("sha256").update(m[1]).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
