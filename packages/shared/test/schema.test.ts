import { describe, expect, it } from "vitest";
import {
  BridgeConfigSchema, ServerConfigSchema, ServerRecordSchema, ssmPaths,
} from "../src/index.js";

describe("ServerConfigSchema", () => {
  it("parses a stdio config and applies defaults", () => {
    const cfg = ServerConfigSchema.parse({
      type: "stdio", package: "mcp-server-monday", version: "1.2.3",
    });
    expect(cfg).toEqual({
      type: "stdio", package: "mcp-server-monday", version: "1.2.3", args: [], env: {},
    });
  });

  it("parses env values of both kinds", () => {
    const cfg = ServerConfigSchema.parse({
      type: "stdio", package: "x", version: "1.0.0",
      env: { A: { kind: "plain", value: "1" }, B: { kind: "secret", set: false } },
    });
    expect(cfg.type).toBe("stdio");
  });

  it("rejects an http config with a bad url", () => {
    expect(() => ServerConfigSchema.parse({ type: "http", url: "not-a-url" })).toThrow();
  });

  it("rejects unknown types", () => {
    expect(() => ServerConfigSchema.parse({ type: "sse", url: "https://x.example" })).toThrow();
  });
});

describe("ServerRecordSchema", () => {
  const base = {
    id: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    config: { type: "http", url: "https://api.example.com/mcp/", headers: {} },
    status: "draft", deployedTarget: null, awsFootprint: false, folder: null, sortIndex: 0, endpointUrl: null, bearerToken: null, oauthClientId: null, oauthClientSecret: null, lastError: null,
    createdAt: "2026-07-06T00:00:00Z", updatedAt: "2026-07-06T00:00:00Z",
  };
  it("accepts a valid record", () => {
    expect(ServerRecordSchema.parse({ ...base, name: "github-proxy" }).name).toBe("github-proxy");
  });
  it("rejects invalid names", () => {
    expect(() => ServerRecordSchema.parse({ ...base, name: "Bad Name!" })).toThrow();
  });
});

describe("BridgeConfigSchema", () => {
  it("parses both modes", () => {
    expect(BridgeConfigSchema.parse({
      mode: "stdio", binPath: "vendor/node_modules/x/cli.js", args: [], env: {},
    }).mode).toBe("stdio");
    expect(BridgeConfigSchema.parse({
      mode: "http-proxy", upstreamUrl: "https://u.example/mcp/", headers: {},
    }).mode).toBe("http-proxy");
  });
});

describe("ssmPaths", () => {
  it("builds paths under /rmcp/<id>/", () => {
    expect(ssmPaths.root("abc")).toBe("/rmcp/abc/");
    expect(ssmPaths.config("abc")).toBe("/rmcp/abc/config");
    expect(ssmPaths.token("abc")).toBe("/rmcp/abc/token");
    expect(ssmPaths.secret("abc", "API_KEY")).toBe("/rmcp/abc/secrets/API_KEY");
  });
});
