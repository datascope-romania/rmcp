import { checkToken } from "./auth.js";
import type { Runtime } from "./config.js";
import type { Backend, FnUrlEvent, FnUrlResponse, JsonRpcMessage } from "./types.js";

const JSON_HEADERS = { "content-type": "application/json" };

function rpcError(status: number, id: JsonRpcMessage["id"] | null, code: number, message: string): FnUrlResponse {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }) };
}

export function makeHandler(
  load: () => Promise<Runtime>,
  create: (rt: Runtime) => Backend,
): (event: FnUrlEvent) => Promise<FnUrlResponse> {
  let backend: Backend | null = null;

  return async (event) => {
    const rt = await load();
    backend ??= create(rt);
    const headers = Object.fromEntries(
      Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    if (!checkToken(headers.authorization, rt.token)) {
      return { statusCode: 401, headers: JSON_HEADERS, body: JSON.stringify({ error: "unauthorized" }) };
    }
    const method = event.requestContext.http.method;
    if (method === "DELETE") {
      const status = backend.handleDelete ? await backend.handleDelete({ headers }) : 200;
      return { statusCode: status, body: "" };
    }
    if (method !== "POST") {
      return { statusCode: 405, headers: { allow: "POST, DELETE" }, body: "" };
    }

    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body ?? "";
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return rpcError(400, null, -32700, "parse error");
    }
    if (Array.isArray(msg)) return rpcError(400, null, -32600, "batch requests are not supported");
    if (typeof msg.method !== "string") return rpcError(400, msg.id, -32600, "invalid request");

    try {
      if (msg.id === undefined) {
        await backend.handleNotification(msg, { headers });
        return { statusCode: 202, body: "" };
      }
      const res = await backend.handleRequest(msg, { headers });
      return { statusCode: 200, headers: { ...JSON_HEADERS, ...res.headers }, body: JSON.stringify(res.message) };
    } catch (err) {
      console.error("bridge error", err);
      return rpcError(500, msg.id, -32603, err instanceof Error ? err.message : "internal error");
    }
  };
}
