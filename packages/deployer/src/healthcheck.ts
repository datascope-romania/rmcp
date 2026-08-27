import { MCP_PROTOCOL_VERSION } from "@rmcp/shared";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface HealthOpts { fetchImpl?: typeof fetch; delayMs?: number }

async function post(url: string, token: string, body: unknown, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify(body),
  });
}

async function rpc(url: string, token: string, body: unknown, fetchImpl: typeof fetch): Promise<any> {
  const res = await post(url, token, body, fetchImpl);
  const text = await res.text();
  if (res.status >= 400) {
    // AWS answers 403 "Forbidden" itself when anonymous Function URL access is
    // denied — briefly during policy propagation, or permanently under org guardrails.
    const hint = res.status === 403 && text.includes("Forbidden")
      ? " (if this persists, your AWS account or organization may block public Lambda Function URLs)"
      : "";
    throw new Error(`healthcheck got HTTP ${res.status}: ${text.slice(0, 200)}${hint}`);
  }
  const msg = JSON.parse(text);
  if (msg.error) throw new Error(`healthcheck got JSON-RPC error: ${msg.error.message}`);
  return msg.result;
}

export async function healthCheck(url: string, token: string, opts: HealthOpts = {}): Promise<{ serverName: string; toolCount: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const delayMs = opts.delayMs ?? 2000;
  const initBody = {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "rmcp-healthcheck", version: "1.0.0" } },
  };

  let init: any;
  for (let attempt = 1; ; attempt++) {
    try {
      init = await rpc(url, token, initBody, fetchImpl);
      break;
    } catch (err) {
      const retryable = err instanceof Error && (/HTTP (5\d\d|403)/.test(err.message) || err.name === "TypeError");
      if (!retryable || attempt >= 5) throw err;
      await sleep(delayMs);
    }
  }
  await post(url, token, { jsonrpc: "2.0", method: "notifications/initialized" }, fetchImpl);
  const tools = await rpc(url, token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, fetchImpl);
  return { serverName: init.serverInfo.name, toolCount: tools.tools.length };
}
