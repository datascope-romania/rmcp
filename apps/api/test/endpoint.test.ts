import { describe, expect, it } from "vitest";
import type { ServerRecord } from "@rmcp/shared";
import { localMcpEndpoint, withDisplayEndpoint } from "../src/endpoint.js";

const base: ServerRecord = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "demo",
  config: { type: "stdio", package: "x", version: "1", args: [], env: {} },
  status: "deployed", deployedTarget: "local", awsFootprint: false, folder: null, sortIndex: 0,
  endpointUrl: "http://rmcp-host.local:8788/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", bearerToken: "t",
  oauthClientId: null, oauthClientSecret: null,
  lastError: null, createdAt: "2026-07-21T00:00:00Z", updatedAt: "2026-07-21T00:00:00Z",
};

describe("endpoint url", () => {
  it("uses publicMcpBaseUrl and trims a trailing slash", () => {
    expect(localMcpEndpoint(base.id, { region: "us-east-1", publicMcpBaseUrl: "https://mcp.example.com/service/" }, 8788))
      .toBe("https://mcp.example.com/service/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("falls back to the LAN gateway host when the setting is empty", () => {
    const url = localMcpEndpoint(base.id, { region: "us-east-1", publicMcpBaseUrl: "" }, 8788);
    expect(url).toMatch(/^http:\/\/.+:8788\/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa$/);
  });

  it("overrides endpointUrl for local deployed servers only", () => {
    const s = { region: "us-east-1", publicMcpBaseUrl: "https://mcp.example.com/service" };
    expect(withDisplayEndpoint(base, s, 8788).endpointUrl).toBe("https://mcp.example.com/service/" + base.id);
    const lambda = { ...base, deployedTarget: "lambda" as const, endpointUrl: "https://fn.example/mcp" };
    expect(withDisplayEndpoint(lambda, s, 8788).endpointUrl).toBe("https://fn.example/mcp");
  });
});
