export type JsonRpcId = string | number;

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface FnUrlEvent {
  requestContext: { http: { method: string } };
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface FnUrlResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

export interface RequestCtx { headers: Record<string, string> }

export interface BackendResult { message: JsonRpcMessage; headers?: Record<string, string> }

export interface Backend {
  handleRequest(msg: JsonRpcMessage, ctx: RequestCtx): Promise<BackendResult>;
  handleNotification(msg: JsonRpcMessage, ctx: RequestCtx): Promise<void>;
  handleDelete?(ctx: RequestCtx): Promise<number>;
  dispose?(): void;
}
