import { Fragment, useEffect, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import type { ServerRecord } from "@rmcp/shared";
import { api } from "../api";

const COLLAPSE_KEY = "rmcp-folders-collapsed";

function loadCollapsed(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(names: Set<string>): void {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...names])); } catch { /* presentation-only */ }
}

interface Group { folder: string | null; servers: ServerRecord[] }

// servers arrive in manual order; ungrouped first, then folders alphabetically
function groupServers(servers: ServerRecord[]): Group[] {
  const ungrouped: Group = { folder: null, servers: [] };
  const byFolder = new Map<string, ServerRecord[]>();
  for (const s of servers) {
    if (!s.folder) { ungrouped.servers.push(s); continue; }
    const list = byFolder.get(s.folder);
    if (list) list.push(s); else byFolder.set(s.folder, [s]);
  }
  const folders = [...byFolder.keys()].sort((a, b) => a.localeCompare(b));
  return [ungrouped, ...folders.map((f) => ({ folder: f, servers: byFolder.get(f)! }))];
}

type DropSpot = { kind: "row"; id: string } | { kind: "folder"; folder: string } | { kind: "ungrouped" };
const spotKey = (s: DropSpot) =>
  s.kind === "row" ? `row:${s.id}` : s.kind === "folder" ? `folder:${s.folder}` : "ungrouped";

export default function ServerList() {
  const [servers, setServers] = useState<ServerRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [dragging, setDragging] = useState(false);
  const [dropSpot, setDropSpot] = useState<string | null>(null);

  const refresh = () => api.listServers().then(setServers).catch((e) => setError(e.message));
  useEffect(() => { void refresh(); }, []);

  if (error && !servers) return <p className="error">{error}</p>;
  if (!servers) return <p>Loading…</p>;

  const groups = groupServers(servers);

  function toggleFolder(name: string) {
    const next = new Set(collapsed);
    if (next.has(name)) next.delete(name); else next.add(name);
    setCollapsed(next);
    saveCollapsed(next);
  }

  async function applyDrop(draggedId: string, spot: DropSpot) {
    if (spot.kind === "row" && spot.id === draggedId) return; // dropped on itself
    const current = groupServers(servers!);
    let dragged: ServerRecord | undefined;
    for (const g of current) {
      const i = g.servers.findIndex((s) => s.id === draggedId);
      if (i >= 0) [dragged] = g.servers.splice(i, 1);
    }
    if (!dragged) return;
    let newFolder = dragged.folder;
    if (spot.kind === "row") {
      const g = current.find((x) => x.servers.some((s) => s.id === spot.id));
      if (!g) return;
      g.servers.splice(g.servers.findIndex((s) => s.id === spot.id), 0, dragged); // insert before target
      newFolder = g.folder;
    } else if (spot.kind === "folder") {
      const g = current.find((x) => x.folder === spot.folder);
      if (!g) return;
      g.servers.push(dragged); // append to folder
      newFolder = spot.folder;
    } else {
      current[0].servers.push(dragged); // append to ungrouped
      newFolder = null;
    }
    const flat = current.flatMap((g) => g.servers.map((s) => (s.id === draggedId ? { ...s, folder: newFolder } : s)));
    setServers(flat); // optimistic; refresh below restores server truth either way
    setError(null);
    try {
      if (newFolder !== dragged.folder) await api.updateServer(draggedId, { folder: newFolder });
      await api.setOrder(flat.map((s) => s.id));
    } catch (e) {
      setError((e as Error).message);
    }
    void refresh();
  }

  const dragProps = (spot: DropSpot) => ({
    onDragOver: (e: DragEvent) => { e.preventDefault(); setDropSpot(spotKey(spot)); },
    onDragLeave: () => setDropSpot((k) => (k === spotKey(spot) ? null : k)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const id = e.dataTransfer.getData("text/plain");
      setDropSpot(null);
      setDragging(false);
      if (id) void applyDrop(id, spot);
    },
  });

  const row = (s: ServerRecord) => (
    <tr
      key={s.id}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", s.id); e.dataTransfer.effectAllowed = "move"; setDragging(true); }}
      onDragEnd={() => { setDragging(false); setDropSpot(null); }}
      className={dropSpot === `row:${s.id}` ? "drop-target" : undefined}
      {...dragProps({ kind: "row", id: s.id })}
    >
      <td><Link to={`/servers/${s.id}`}>{s.name}</Link></td>
      <td>{s.config.type}</td>
      <td className="status-cell">
        <span className={`status status-${s.status}`}>{s.status}</span>
        {s.deployedTarget && (
          <span className={`badge target-${s.deployedTarget}`}>{s.deployedTarget}</span>
        )}
      </td>
      <td className="mono">{s.endpointUrl ?? "—"}</td>
    </tr>
  );

  return (
    <>
      <div className="toolbar">
        <h1>Servers</h1>
        <Link className="button" to="/servers/new">New server</Link>
      </div>
      {error && <p className="error">{error}</p>}
      {servers.length === 0 ? (
        <p>No servers yet. Create one to get started.</p>
      ) : (
        <table>
          <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Endpoint</th></tr></thead>
          <tbody>
            {groups[0].servers.map(row)}
            {dragging && (
              <tr
                className={`ungrouped-hint${dropSpot === "ungrouped" ? " drop-target" : ""}`}
                {...dragProps({ kind: "ungrouped" })}
              >
                <td colSpan={4}>drop here to remove from folder</td>
              </tr>
            )}
            {groups.slice(1).map((g) => (
              <Fragment key={g.folder}>
                <tr
                  className={`folder-row${dropSpot === `folder:${g.folder}` ? " drop-target" : ""}`}
                  onClick={() => toggleFolder(g.folder!)}
                  {...dragProps({ kind: "folder", folder: g.folder! })}
                >
                  <td colSpan={4}>
                    <span className="chevron">{collapsed.has(g.folder!) ? "▸" : "▾"}</span>
                    {g.folder}
                    <span className="folder-count">{g.servers.length}</span>
                  </td>
                </tr>
                {!collapsed.has(g.folder!) && g.servers.map(row)}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
