import { describe, expect, it } from "vitest";
import { checkToken } from "../src/auth.js";

describe("checkToken", () => {
  it("accepts the exact bearer token", () => {
    expect(checkToken("Bearer s3cret", "s3cret")).toBe(true);
  });
  // RFC 6750 §2.1: the auth-scheme is case-insensitive (RFC 7235 §2.1), and
  // RFC 7230 allows more than one space between scheme and credentials. The
  // OAuth path already accepts both, so the static-token path must agree —
  // otherwise the same client works over OAuth and 401s on its bearer token.
  it("accepts the scheme case-insensitively", () => {
    expect(checkToken("bearer s3cret", "s3cret")).toBe(true);
    expect(checkToken("BEARER s3cret", "s3cret")).toBe(true);
    expect(checkToken("BeArEr s3cret", "s3cret")).toBe(true);
  });
  it("tolerates extra whitespace after the scheme", () => {
    expect(checkToken("Bearer   s3cret", "s3cret")).toBe(true);
  });
  it("rejects wrong token, wrong scheme, missing header", () => {
    expect(checkToken("Bearer nope", "s3cret")).toBe(false);
    expect(checkToken("Basic s3cret", "s3cret")).toBe(false);
    expect(checkToken(undefined, "s3cret")).toBe(false);
  });
  it("does not treat a scheme that merely starts with bearer as a match", () => {
    expect(checkToken("Bearerish s3cret", "s3cret")).toBe(false);
  });
});
