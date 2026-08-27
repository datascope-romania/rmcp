import type { ServerRecord } from "@rmcp/shared";

export function exportSnippets(rec: ServerRecord): { vscode: string; cursor: string; claudeCli: string; claudeDesktop: string; notion: string } {
  if (!rec.endpointUrl || !rec.bearerToken) throw new Error("server is not deployed");
  const headers = { Authorization: `Bearer ${rec.bearerToken}` };
  // Claude Desktop's connector UI is OAuth-only and its config file cannot put
  // custom headers on remote servers, so bearer-token endpoints go through the
  // mcp-remote stdio bridge. The header is passed via env because args with
  // spaces are split on some platforms (documented mcp-remote workaround).
  const claudeDesktopConfig = {
    mcpServers: {
      [rec.name]: {
        command: "npx",
        args: ["-y", "mcp-remote", rec.endpointUrl, "--header", "Authorization:${AUTH_HEADER}"],
        env: { AUTH_HEADER: `Bearer ${rec.bearerToken}` },
      },
    },
  };
  // Local servers front an OAuth authorization server, which Claude Desktop
  // speaks natively — no Node.js and no mcp-remote hop. Lambda servers have no
  // authorization server, so they keep the bridge.
  const useOAuth = rec.deployedTarget === "local" && rec.oauthClientId && rec.oauthClientSecret;
  const claudeDesktop = useOAuth
    ? [
        "Claude Desktop → Settings → Connectors → Add custom connector",
        "",
        `  Name:        ${rec.name}`,
        `  Remote MCP server URL:  ${rec.endpointUrl}`,
        "",
        "Expand \"Advanced settings\" and paste:",
        "",
        `  OAuth Client ID:      ${rec.oauthClientId}`,
        `  OAuth Client Secret:  ${rec.oauthClientSecret}`,
        "",
        "Click Add, then Connect. A browser tab opens and closes by itself —",
        "there is nothing to approve.",
        "",
        "If the connection is rejected, check that Public MCP base URL is set in",
        "rmcp Settings and that the callback Claude uses is in the redirect URI",
        "allowlist there.",
      ].join("\n")
    : [
        "Requires Node.js installed (the config runs npx).",
        "",
        "1. Open the config file — Claude Desktop → Settings → Developer → Edit Config, or directly:",
        "     macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json",
        "     Windows: %APPDATA%\\Claude\\claude_desktop_config.json",
        "",
        "2. Merge this into the file (create it if missing). Claude Desktop cannot send",
        "   custom auth headers to remote servers itself, so this uses the mcp-remote bridge:",
        "",
        JSON.stringify(claudeDesktopConfig, null, 2),
        "",
        `3. Fully quit Claude Desktop (macOS: Cmd+Q) and reopen it. "${rec.name}" appears`,
        "   under the tools icon in the chat input once connected.",
      ].join("\n");
  return {
    vscode: JSON.stringify({ servers: { [rec.name]: { type: "http", url: rec.endpointUrl, headers } } }, null, 2),
    cursor: JSON.stringify({ mcpServers: { [rec.name]: { url: rec.endpointUrl, headers } } }, null, 2),
    claudeCli: `claude mcp add --transport http ${rec.name} ${rec.endpointUrl} --header "Authorization: Bearer ${rec.bearerToken}"`,
    claudeDesktop,
    // Notion has no config file: custom MCP servers are added per Custom Agent
    // in the UI, with header-based auth (bearer token) supported.
    notion: [
      "One-time (workspace admin): Settings → Notion AI → AI connectors → Enable Custom MCP servers",
      "",
      "In your Custom Agent: Settings → Tools & Access → Add connection → Custom MCP server",
      `  Server URL:      ${rec.endpointUrl}`,
      `  Display name:    ${rec.name}`,
      `  Authentication:  header "Authorization" with value "Bearer ${rec.bearerToken}"`,
    ].join("\n"),
  };
}
