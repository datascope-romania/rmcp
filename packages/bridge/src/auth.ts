import { createHash, timingSafeEqual } from "node:crypto";

export function checkToken(authHeader: string | undefined, expected: string): boolean {
  const m = /^Bearer (.+)$/.exec(authHeader ?? "");
  if (!m) return false;
  const a = createHash("sha256").update(m[1]).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
