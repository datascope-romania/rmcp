import { describe, expect, it } from "vitest";
import type { ServerRecord } from "@rmcp/shared";
import { exportSnippets } from "../src/export.js";

const base: ServerRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "alpha",
  config: { type: "http", url: "https://example.com/mcp", headers: {} },
  status: "deployed",
  deployedTarget: "local",
  awsFootprint: false,
  folder: null,
  sortIndex: 0,
  endpointUrl: "https://mcp.example.com/service/11111111-1111-4111-8111-111111111111",
  bearerToken: "static-bearer",
  oauthClientId: "cid-1",
  oauthClientSecret: "secret-1",
  lastError: null,
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
};

describe("claudeDesktop export", () => {
  it("gives OAuth instructions for a local server with credentials", () => {
    const { claudeDesktop } = exportSnippets(base);
    expect(claudeDesktop).toContain(base.endpointUrl);
    expect(claudeDesktop).toContain("Advanced settings");
    expect(claudeDesktop).toContain("cid-1");
    expect(claudeDesktop).toContain("secret-1");
    expect(claudeDesktop).not.toContain("mcp-remote");
  });

  it("falls back to mcp-remote for a lambda server", () => {
    const { claudeDesktop } = exportSnippets({
      ...base, deployedTarget: "lambda", oauthClientId: null, oauthClientSecret: null,
    });
    expect(claudeDesktop).toContain("mcp-remote");
  });

  it("falls back to mcp-remote for a local server that has no credentials yet", () => {
    const { claudeDesktop } = exportSnippets({ ...base, oauthClientId: null, oauthClientSecret: null });
    expect(claudeDesktop).toContain("mcp-remote");
  });

  it("leaves the header-based snippets alone", () => {
    const s = exportSnippets(base);
    expect(s.vscode).toContain("Bearer static-bearer");
    expect(s.cursor).toContain("Bearer static-bearer");
    expect(s.claudeCli).toContain("Bearer static-bearer");
    expect(s.notion).toContain("Bearer static-bearer");
  });
});
