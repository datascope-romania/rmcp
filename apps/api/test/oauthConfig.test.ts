import { describe, expect, it } from "vitest";
import { DEFAULT_REDIRECT_URIS, oauthIssuer, redirectUriAllowed, redirectUris } from "../src/endpoint.js";

const base = { region: "us-east-1" };

describe("oauthIssuer", () => {
  it("is the origin of publicMcpBaseUrl", () => {
    expect(oauthIssuer({ ...base, publicMcpBaseUrl: "https://mcp.example.com/service" })).toBe("https://mcp.example.com");
    expect(oauthIssuer({ ...base, publicMcpBaseUrl: "https://mcp.example.com/service/" })).toBe("https://mcp.example.com");
  });

  it("is null when publicMcpBaseUrl is unset, blank or unparseable", () => {
    expect(oauthIssuer(base)).toBeNull();
    expect(oauthIssuer({ ...base, publicMcpBaseUrl: "   " })).toBeNull();
    expect(oauthIssuer({ ...base, publicMcpBaseUrl: "not a url" })).toBeNull();
  });
});

describe("redirectUris", () => {
  it("falls back to the defaults when unset or empty", () => {
    expect(redirectUris(base)).toEqual([...DEFAULT_REDIRECT_URIS]);
    expect(redirectUris({ ...base, oauthRedirectUris: [] })).toEqual([...DEFAULT_REDIRECT_URIS]);
  });

  it("uses the configured list when present", () => {
    expect(redirectUris({ ...base, oauthRedirectUris: ["https://x/cb"] })).toEqual(["https://x/cb"]);
  });
});

describe("redirectUriAllowed", () => {
  const list = [...DEFAULT_REDIRECT_URIS];

  it("matches Claude's callbacks exactly", () => {
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback", list)).toBe(true);
    expect(redirectUriAllowed("https://claude.com/api/mcp/auth_callback", list)).toBe(true);
  });

  it("rejects near-misses and other hosts", () => {
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback/evil", list)).toBe(false);
    expect(redirectUriAllowed("https://claude.ai.evil.com/api/mcp/auth_callback", list)).toBe(false);
    expect(redirectUriAllowed("https://evil.com/cb", list)).toBe(false);
    expect(redirectUriAllowed("not a url", list)).toBe(false);
  });

  it("allows any port and path on the loopback wildcards", () => {
    expect(redirectUriAllowed("http://localhost:53821/callback", list)).toBe(true);
    expect(redirectUriAllowed("http://127.0.0.1:9000/oauth/cb", list)).toBe(true);
    // the wildcard is scoped to loopback hosts only
    expect(redirectUriAllowed("http://localhost.evil.com:9000/cb", list)).toBe(false);
    // and only over http on loopback, not to some other host on the same port
    expect(redirectUriAllowed("http://192.0.2.9:9000/cb", list)).toBe(false);
  });

  // Regression tests for classic redirect_uri bypass shapes. This allowlist becomes
  // the only thing stopping an OAuth code from being redirected to an attacker's
  // server once /oauth/authorize auto-approves, so every one of these must stay
  // rejected (or, where noted, stay accepted only because it is genuinely loopback).
  // Verified against the real implementation before writing these assertions —
  // see .superpowers/sdd/task-2-report.md for the empirical run.
  it("resists classic redirect_uri bypass shapes", () => {
    // userinfo trick: browsers/parsers can be tricked into reading "localhost" as
    // a username with the real host being evil.com. URL#hostname is unaffected.
    expect(redirectUriAllowed("http://localhost@evil.com/cb", list)).toBe(false);
    expect(
      redirectUriAllowed("https://claude.ai@evil.com/api/mcp/auth_callback", list),
    ).toBe(false);

    // case is not a bypass: hostnames are case-insensitive and the parsed URL
    // lowercases them, so this is genuinely loopback.
    expect(redirectUriAllowed("http://LOCALHOST:9000/cb", list)).toBe(true);

    // IPv6 loopback ("[::1]") is rejected only because it is not one of the two
    // literal hosts in DEFAULT_REDIRECT_URIS ("localhost", "127.0.0.1"). This is
    // a deliberate completeness gap, not a bypass — do not "fix" it by adding
    // "[::1]" to LOOPBACK_HOSTS without a deliberate product decision to do so.
    expect(redirectUriAllowed("http://[::1]:9000/cb", list)).toBe(false);

    // trailing-dot FQDN: "localhost." string-compares unequal to "localhost", so
    // it is rejected even though some resolvers would treat it as equivalent.
    expect(redirectUriAllowed("http://localhost./cb", list)).toBe(false);

    // subdomain trick: "127.0.0.1.evil.com" is a real, distinct hostname owned by
    // the attacker, not the loopback address.
    expect(redirectUriAllowed("http://127.0.0.1.evil.com:9000/cb", list)).toBe(false);

    // alternate IPv4 encodings of 127.0.0.1 (shorthand, octal, hex, and decimal
    // integer forms) all normalize to "127.0.0.1" via the WHATWG URL parser
    // before we ever compare — so these are genuinely loopback, not a bypass.
    expect(redirectUriAllowed("http://127.1:9000/cb", list)).toBe(true);
    expect(redirectUriAllowed("http://0177.0.0.1:9000/cb", list)).toBe(true);
    expect(redirectUriAllowed("http://0x7f.0.0.1:9000/cb", list)).toBe(true);
    expect(redirectUriAllowed("http://2130706433:9000/cb", list)).toBe(true);

    // protocol-relative URI has no scheme and no base to resolve against, so
    // `new URL(...)` throws and the function safely rejects it.
    expect(redirectUriAllowed("//localhost:9000/cb", list)).toBe(false);

    // backslash-as-slash trick: for special schemes "\" terminates the authority
    // section same as "/", so this parses to host "localhost", not "evil.com".
    expect(redirectUriAllowed("http://localhost\\@evil.com/cb", list)).toBe(true);

    // scheme case is not a bypass: URL#protocol is lowercased during parsing.
    expect(redirectUriAllowed("HTTP://localhost:9000/cb", list)).toBe(true);
  });
});
