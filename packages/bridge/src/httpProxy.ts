import type { Runtime } from "./config.js";
import type { Backend, BackendResult, JsonRpcMessage, RequestCtx } from "./types.js";

const PASSTHROUGH_REQUEST_HEADERS = ["mcp-session-id", "mcp-protocol-version"];

function parseSse(text: string, id: JsonRpcMessage["id"]): JsonRpcMessage {
  const messages: JsonRpcMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try { messages.push(JSON.parse(line.slice(5).trim())); } catch { /* skip non-JSON data lines */ }
  }
  const match = messages.find((m) => m.id === id);
  const chosen = match ?? messages.at(-1);
  if (!chosen) throw new Error("upstream SSE response contained no JSON-RPC message");
  return chosen;
}

export function createHttpProxyBackend(rt: Runtime, fetchImpl: typeof fetch = fetch): Backend {
  if (rt.config.mode !== "http-proxy") throw new Error("not an http-proxy config");
  const cfg = rt.config;

  function upstreamHeaders(ctx: RequestCtx): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...cfg.headers,
      ...rt.secrets,
    };
    for (const name of PASSTHROUGH_REQUEST_HEADERS) {
      if (ctx.headers[name]) h[name] = ctx.headers[name];
    }
    return h;
  }

  return {
    async handleRequest(msg, ctx): Promise<BackendResult> {
      const res = await fetchImpl(cfg.upstreamUrl, {
        method: "POST", headers: upstreamHeaders(ctx), body: JSON.stringify(msg),
      });
      const text = await res.text();
      if (res.status >= 400) throw new Error(`upstream returned ${res.status}: ${text.slice(0, 200)}`);
      const message = (res.headers.get("content-type") ?? "").includes("text/event-stream")
        ? parseSse(text, msg.id)
        : (JSON.parse(text) as JsonRpcMessage);
      const sessionId = res.headers.get("mcp-session-id");
      return { message, headers: sessionId ? { "mcp-session-id": sessionId } : undefined };
    },
    async handleNotification(msg, ctx): Promise<void> {
      await fetchImpl(cfg.upstreamUrl, {
        method: "POST", headers: upstreamHeaders(ctx), body: JSON.stringify(msg),
      });
    },
    async handleDelete(ctx): Promise<number> {
      const res = await fetchImpl(cfg.upstreamUrl, { method: "DELETE", headers: upstreamHeaders(ctx) });
      return res.status;
    },
  };
}
