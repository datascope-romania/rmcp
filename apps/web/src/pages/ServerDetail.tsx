import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { ServerRecord } from "@rmcp/shared";
import { api, type DeployLogRow, type ExportSnippets } from "../api";
import Crumbs from "../components/Crumbs";

const CLIENT_OPTIONS = [
  ["vscode", "VS Code (.vscode/mcp.json)"],
  ["cursor", "Cursor"],
  ["claudeCli", "Claude Code CLI"],
  ["claudeDesktop", "Claude Desktop (claude_desktop_config.json)"],
  ["notion", "Notion (Custom Agent connector)"],
] as const;
type ClientKey = (typeof CLIENT_OPTIONS)[number][0];

interface StepSummary { step: string; status: string; detail: string | null }

function summarizeDeploy(logs: DeployLogRow[]) {
  const steps: StepSummary[] = [];
  for (const l of logs) {
    const existing = steps.find((s) => s.step === l.step);
    if (existing) {
      existing.status = l.status;
      existing.detail = l.detail;
    } else {
      steps.push({ step: l.step, status: l.status, detail: l.detail });
    }
  }
  const failed = steps.find((s) => s.status === "fail");
  const running = failed ? undefined : steps.find((s) => s.status === "start");
  const ms = new Date(logs.at(-1)!.ts).getTime() - new Date(logs[0].ts).getTime();
  const duration = ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${Math.round(ms / 1000)}s`;
  return { steps, failed, running, duration };
}

export default function ServerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [server, setServer] = useState<ServerRecord | null>(null);
  const [logs, setLogs] = useState<DeployLogRow[]>([]);
  const [snippets, setSnippets] = useState<ExportSnippets | null>(null);
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [client, setClient] = useState<ClientKey>("vscode");
  const [secretShown, setSecretShown] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await api.getServer(id!);
    setServer(s);
    setLogs(await api.logs(id!));
    setSnippets(s.status === "deployed" ? await api.exportSnippets(id!) : null);
  }, [id]);

  useEffect(() => { refresh().catch((e) => setError(e.message)); }, [refresh]);

  useEffect(() => {
    if (server?.status !== "deploying") return;
    const t = setInterval(() => refresh().catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [server?.status, refresh]);

  // Full-page error only when the server itself failed to load; action errors
  // render inline below so the page (and the secrets re-entry UI) stays usable.
  if (!server) return error ? <p className="error">{error}</p> : <p>Loading…</p>;

  const bag = server.config.type === "stdio" ? server.config.env : server.config.headers;
  const secrets = Object.entries(bag).filter(([, v]) => v.kind === "secret") as [string, { kind: "secret"; set: boolean }][];
  const act = (fn: () => Promise<unknown>) => () => { setError(null); fn().then(refresh).catch((e) => setError(e.message)); };

  return (
    <>
      <Crumbs trail={[{ label: "Servers", to: "/" }, { label: server.name }]} />
      <div className="title-group">
        <h1>{server.name}</h1>
        <span className={`status status-${server.status}`}>{server.status}</span>
        {server.deployedTarget && (
          <span className={`badge target-${server.deployedTarget}`}>{server.deployedTarget}</span>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {server.lastError && <p className="error">Last error: {server.lastError}</p>}
      <p className="mono">{server.endpointUrl ?? "not deployed"}</p>

      <div className="actions">
        {(() => {
          const lastTarget = server.deployedTarget ?? "lambda";
          const other = lastTarget === "local" ? "lambda" : "local";
          const label = (t: "lambda" | "local") => (t === "local" ? "locally" : "to Lambda");
          return (
            <>
              <button className="primary" disabled={server.status === "deploying"}
                onClick={act(() => api.deploy(server.id, lastTarget))}>
                {server.status === "deployed" ? "Redeploy" : "Deploy"} {label(lastTarget)}
              </button>
              <button disabled={server.status === "deploying"}
                onClick={act(() => api.deploy(server.id, other))}>
                Deploy {label(other)}
              </button>
            </>
          );
        })()}
        <button disabled={server.status !== "deployed"} onClick={act(() => api.undeploy(server.id))}>Undeploy</button>
        <Link className="button" to={`/servers/${server.id}/edit`}>Edit</Link>
        <button className="danger" disabled={["deployed", "deploying"].includes(server.status)}
          onClick={() => {
            setError(null);
            api.deleteServer(server.id).then(() => navigate("/")).catch((e) => setError(e.message));
          }}>Delete</button>
      </div>

      {secrets.length > 0 && (
        <section>
          <h2>Secrets</h2>
          {secrets.map(([key, v]) => (
            <div className="kv-row" key={key}>
              <span className="mono">{key}</span>
              <span className={v.set ? "ok" : "warn"}>{v.set ? "set" : "not set"}</span>
              <input type="password" placeholder="new value" value={secretInputs[key] ?? ""}
                onChange={(e) => setSecretInputs({ ...secretInputs, [key]: e.target.value })} />
              <button disabled={!secretInputs[key]}
                onClick={act(async () => { await api.putSecret(server.id, key, secretInputs[key]); setSecretInputs({ ...secretInputs, [key]: "" }); })}>
                Save
              </button>
            </div>
          ))}
        </section>
      )}

      {logs.length > 0 && (() => {
        const { steps, failed, running, duration } = summarizeDeploy(logs);
        return (
          <section>
            <h2>
              Last deploy{" "}
              <span className={`deploy-summary ${failed ? "warn" : "ok"}`}>
                {failed ? `✗ failed at ${failed.step}` : running ? `⟳ ${running.step}…` : `✓ completed in ${duration}`}
              </span>
            </h2>
            <div className="steps-row">
              {steps.map((s) => (
                <span key={s.step} className={`chip chip-${s.status}`}>
                  {s.step} {s.status === "ok" ? "✓" : s.status === "fail" ? "✗" : "…"}
                </span>
              ))}
            </div>
            {failed?.detail && <p className="error">{failed.detail}</p>}
          </section>
        );
      })()}

      {server.deployedTarget === "local" && server.oauthClientId && (
        <section>
          <h2>OAuth connector</h2>
          <p>Paste these into Claude Desktop → Add custom connector → Advanced settings.</p>
          <div className="kv-row">
            <span className="mono">Client ID</span>
            <input readOnly className="mono" value={server.oauthClientId} />
            <button type="button" onClick={() => navigator.clipboard.writeText(server.oauthClientId!)}>Copy</button>
          </div>
          <div className="kv-row">
            <span className="mono">Client secret</span>
            <input readOnly className="mono" type={secretShown ? "text" : "password"} value={server.oauthClientSecret ?? ""} />
            <button type="button" onClick={() => setSecretShown((v) => !v)}>{secretShown ? "Hide" : "Show"}</button>
            <button type="button" onClick={() => navigator.clipboard.writeText(server.oauthClientSecret ?? "")}>Copy</button>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!confirm("Regenerate? Every connected client will have to be reconnected.")) return;
              setError(null);
              api.regenerateOAuth(server.id).then(setServer).catch((e) => setError((e as Error).message));
            }}
          >
            Regenerate
          </button>
        </section>
      )}

      {snippets && (
        <section>
          <h2>Connect a client</h2>
          <div className="kv-row">
            <select value={client} onChange={(e) => setClient(e.target.value as ClientKey)}>
              {CLIENT_OPTIONS.map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            <button onClick={() => navigator.clipboard.writeText(snippets[client])}>Copy</button>
          </div>
          <pre>{snippets[client]}</pre>
        </section>
      )}
    </>
  );
}
