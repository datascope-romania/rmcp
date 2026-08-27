import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { EnvValue, ServerConfig } from "@rmcp/shared";
import { api } from "../api";
import Crumbs from "../components/Crumbs";

interface KvRow { key: string; kind: "plain" | "secret"; value: string }

const toRows = (bag: Record<string, EnvValue>): KvRow[] =>
  Object.entries(bag).map(([key, v]) => ({ key, kind: v.kind, value: v.kind === "plain" ? v.value : "" }));

const toBag = (rows: KvRow[]): Record<string, EnvValue> =>
  Object.fromEntries(rows.filter((r) => r.key).map((r) => [
    r.key, r.kind === "plain" ? { kind: "plain", value: r.value } : { kind: "secret", set: false },
  ]));

export default function ServerEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [type, setType] = useState<"stdio" | "http">("stdio");
  const [pkg, setPkg] = useState("");
  const [version, setVersion] = useState("latest");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [rows, setRows] = useState<KvRow[]>([]);
  const [existingBag, setExistingBag] = useState<Record<string, EnvValue>>({});
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [folderNames, setFolderNames] = useState<string[]>([]);

  useEffect(() => {
    if (!id) return;
    api.getServer(id).then((s) => {
      setName(s.name);
      setType(s.config.type === "stdio" ? "stdio" : "http");
      setFolder(s.folder ?? "");
      if (s.config.type === "stdio") {
        setPkg(s.config.package); setVersion(s.config.version); setArgs(s.config.args.join(" "));
        setRows(toRows(s.config.env)); setExistingBag(s.config.env);
      } else {
        setUrl(s.config.url); setRows(toRows(s.config.headers)); setExistingBag(s.config.headers);
      }
    }).catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    api.listServers()
      .then((list) => setFolderNames([...new Set(list.map((s) => s.folder).filter((f): f is string => !!f))].sort()))
      .catch(() => setFolderNames([]));
  }, []);

  async function save() {
    setError(null);
    // preserve `set: true` flags for secrets that already have a stored value
    const bag = Object.fromEntries(Object.entries(toBag(rows)).map(([k, v]) => {
      const prev = existingBag[k];
      return [k, v.kind === "secret" && prev?.kind === "secret" ? { ...v, set: prev.set } : v];
    }));
    const config: ServerConfig = type === "stdio"
      ? { type: "stdio", package: pkg, version, args: args.split(/\s+/).filter(Boolean), env: bag }
      : { type: "http", url, headers: bag };
    const folderValue = folder.trim() || null;
    try {
      const saved = id ? await api.updateServer(id, { name, config, folder: folderValue }) : await api.createServer(name, config, folderValue);
      navigate(`/servers/${saved.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const bagLabel = type === "stdio" ? "Environment variables" : "Headers";
  const trail = id
    ? [{ label: "Servers", to: "/" }, { label: name || "Server", to: `/servers/${id}` }, { label: "Edit" }]
    : [{ label: "Servers", to: "/" }, { label: "New server" }];
  return (
    <>
      <Crumbs trail={trail} />
      <h1>{id ? "Edit server" : "New server"}</h1>
      {error && <p className="error">{error}</p>}
      <div className="form">
        <label>Name <input value={name} onChange={(e) => setName(e.target.value)} placeholder="monday" /></label>
        <label>Folder (optional)
          <input list="folder-names" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="ungrouped" />
          <datalist id="folder-names">
            {folderNames.map((f) => <option key={f} value={f} />)}
          </datalist>
        </label>
        <label>Type
          <select value={type} onChange={(e) => setType(e.target.value as "stdio" | "http")}>
            <option value="stdio">stdio (npm package, run behind the bridge)</option>
            <option value="http">http (proxy to a remote MCP server)</option>
          </select>
        </label>
        {type === "stdio" ? (
          <>
            <label>npm package <input value={pkg} onChange={(e) => setPkg(e.target.value)} placeholder="@modelcontextprotocol/server-everything" /></label>
            <label>Version <input value={version} onChange={(e) => setVersion(e.target.value)} /></label>
            <label>Arguments <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="--flag value" /></label>
          </>
        ) : (
          <label>Upstream URL <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.githubcopilot.com/mcp/" /></label>
        )}
        <fieldset>
          <legend>{bagLabel}</legend>
          {rows.map((row, i) => (
            <div className="kv-row" key={i}>
              <input placeholder="KEY" value={row.key} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))} />
              <select value={row.kind} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, kind: e.target.value as "plain" | "secret" } : r)))}>
                <option value="plain">plain</option>
                <option value="secret">secret</option>
              </select>
              {row.kind === "plain" ? (
                <input placeholder="value" value={row.value} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))} />
              ) : (
                <span className="hint">value is set on the server page</span>
              )}
              <button onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button onClick={() => setRows([...rows, { key: "", kind: "plain", value: "" }])}>Add {type === "stdio" ? "env var" : "header"}</button>
        </fieldset>
        <button className="primary" onClick={save}>Save</button>
      </div>
    </>
  );
}
