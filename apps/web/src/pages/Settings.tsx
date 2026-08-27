import { useEffect, useState } from "react";
import { api } from "../api";
import Crumbs from "../components/Crumbs";

export default function Settings() {
  const [region, setRegion] = useState("");
  const [profile, setProfile] = useState("");
  const [gatewayPort, setGatewayPort] = useState("8788");
  const [publicMcpBaseUrl, setPublicMcpBaseUrl] = useState("");
  const [redirectUris, setRedirectUris] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then((s) => {
      setRegion(s.region);
      setProfile(s.profile ?? "");
      setGatewayPort(String(s.localGatewayPort ?? 8788));
      setPublicMcpBaseUrl(s.publicMcpBaseUrl ?? "");
      setRedirectUris((s.oauthRedirectUris ?? []).join("\n"));
    }).catch((e) => setError(e.message));
  }, []);

  async function save() {
    setError(null); setMessage(null);
    try {
      await api.putSettings({
        region,
        ...(profile ? { profile } : {}),
        localGatewayPort: Number(gatewayPort) || 8788,
        publicMcpBaseUrl: publicMcpBaseUrl.trim(),
        oauthRedirectUris: redirectUris.split("\n").map((l) => l.trim()).filter(Boolean),
      });
      setMessage("Saved.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <Crumbs trail={[{ label: "Servers", to: "/" }, { label: "Settings" }]} />
      <h1>Settings</h1>
      {error && <p className="error">{error}</p>}
      {message && <p className="ok">{message}</p>}
      <div className="form">
        <label>AWS region <input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" /></label>
        <label>AWS profile (optional) <input value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="default credentials chain when empty" /></label>
        <label>Local gateway port <input value={gatewayPort} onChange={(e) => setGatewayPort(e.target.value)} placeholder="8788" /></label>
        <p className="hint">Local servers are exposed on this port (all interfaces). Restart rmcp to apply.</p>
        <label>Public MCP base URL (optional) <input value={publicMcpBaseUrl} onChange={(e) => setPublicMcpBaseUrl(e.target.value)} placeholder="https://mcp.example.com/service" /></label>
        <p className="hint">When set, local-server endpoint URLs and client snippets use this base: <code>&lt;base&gt;/&lt;id&gt;</code>. Leave empty for LAN-only URLs.</p>
        <label>
          OAuth redirect URIs (one per line, blank for defaults)
          <textarea
            rows={4}
            value={redirectUris}
            onChange={(e) => setRedirectUris(e.target.value)}
            placeholder={"https://claude.ai/api/mcp/auth_callback\nhttps://claude.com/api/mcp/auth_callback\nhttp://localhost:*\nhttp://127.0.0.1:*"}
          />
        </label>
        <p className="hint">
          Leave empty to use the built-in defaults (Claude.ai/Claude Desktop callbacks and localhost). Entries are
          matched exactly — only <code>http://localhost:*</code> and <code>http://127.0.0.1:*</code> may use a
          wildcard port; a wildcard on any other host (e.g. <code>https://myapp.example:*</code>) will never match.
        </p>
        <button className="primary" onClick={save}>Save</button>
      </div>
    </>
  );
}
