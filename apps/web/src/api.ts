import type { ServerConfig, ServerRecord } from "@rmcp/shared";

export interface DeployLogRow { attempt: string; step: string; status: string; detail: string | null; ts: string }
export interface ExportSnippets { vscode: string; cursor: string; claudeCli: string; claudeDesktop: string; notion: string }
export interface Settings { region: string; profile?: string; localGatewayPort?: number; publicMcpBaseUrl?: string; oauthRedirectUris?: string[] }

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  listServers: () => http<ServerRecord[]>("/api/servers"),
  getServer: (id: string) => http<ServerRecord>(`/api/servers/${id}`),
  createServer: (name: string, config: ServerConfig, folder: string | null) =>
    http<ServerRecord>("/api/servers", { method: "POST", body: JSON.stringify({ name, config, ...(folder ? { folder } : {}) }) }),
  updateServer: (id: string, patch: { name?: string; config?: ServerConfig; folder?: string | null }) =>
    http<ServerRecord>(`/api/servers/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  setOrder: (ids: string[]) =>
    http<void>("/api/servers/order", { method: "PUT", body: JSON.stringify({ ids }) }),
  deleteServer: (id: string) => http<void>(`/api/servers/${id}`, { method: "DELETE" }),
  deploy: (id: string, target: "lambda" | "local") =>
    http<{ attempt: string }>(`/api/servers/${id}/deploy`, { method: "POST", body: JSON.stringify({ target }) }),
  undeploy: (id: string) => http<ServerRecord>(`/api/servers/${id}/undeploy`, { method: "POST" }),
  regenerateOAuth: (id: string) =>
    http<ServerRecord>(`/api/servers/${id}/oauth/regenerate`, { method: "POST" }),
  logs: (id: string) => http<DeployLogRow[]>(`/api/servers/${id}/logs`),
  putSecret: (id: string, key: string, value: string) =>
    http<ServerRecord>(`/api/servers/${id}/secrets/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ value }) }),
  exportSnippets: (id: string) => http<ExportSnippets>(`/api/servers/${id}/export`),
  getSettings: () => http<Settings>("/api/settings"),
  putSettings: (s: Settings) => http<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
};
