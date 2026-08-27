import { describe, expect, it } from "vitest";
import { checkToken } from "../src/auth.js";

describe("checkToken", () => {
  it("accepts the exact bearer token", () => {
    expect(checkToken("Bearer s3cret", "s3cret")).toBe(true);
  });
  it("rejects wrong token, wrong scheme, missing header", () => {
    expect(checkToken("Bearer nope", "s3cret")).toBe(false);
    expect(checkToken("Basic s3cret", "s3cret")).toBe(false);
    expect(checkToken(undefined, "s3cret")).toBe(false);
  });
});
