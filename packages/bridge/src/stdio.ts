import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { MCP_PROTOCOL_VERSION } from "@rmcp/shared";
import type { Runtime } from "./config.js";
import type { Backend, BackendResult, JsonRpcMessage } from "./types.js";

interface ChildOpts {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  requestTimeoutMs?: number;
}

type Pending = { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class StdioChild {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private cachedInit: unknown = null;

  constructor(private opts: ChildOpts) {}

  get initResult(): unknown { return this.cachedInit; }

  async ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null && !this.child.killed) return;
    if (!this.starting) {
      const starting = this.start().finally(() => {
        if (this.starting === starting) this.starting = null;
      });
      this.starting = starting;
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    const child = spawn(this.opts.command, this.opts.args, {
      env: { ...process.env, ...this.opts.env },
      cwd: this.opts.cwd ?? "/tmp",
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child = child;
    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
    child.on("exit", (code) => {
      if (this.child === child) {
        this.failAllPending(new Error(`mcp server process exited (code ${code})`));
      }
    });
    child.on("error", (err) => {
      if (this.child === child) {
        this.failAllPending(err);
      }
    });

    const init = await this.rawRequest("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "rmcp-bridge", version: "1.0.0" },
    });
    if (init.error) throw new Error(`child initialize failed: ${init.error.message}`);
    this.cachedInit = init.result;
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private onLine(line: string): void {
    let msg: JsonRpcMessage;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method !== undefined && msg.id !== undefined) {
      // server->client request: unsupported in stateless mode, answer immediately
      this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "client capabilities unavailable in stateless bridge" } });
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id as number);
      if (p) {
        this.pending.delete(msg.id as number);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }
    // server notifications are dropped: no client channel in stateless mode
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  kill(): void {
    this.failAllPending(new Error("backend disposed"));
    this.child?.kill();
    this.child = null;
    this.starting = null;
    this.cachedInit = null;
  }

  private write(msg: JsonRpcMessage): void {
    this.child!.stdin!.write(JSON.stringify(msg) + "\n");
  }

  private rawRequest(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const timeoutMs = this.opts.requestTimeoutMs ?? 110_000;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async forwardRequest(msg: JsonRpcMessage): Promise<JsonRpcMessage> {
    try {
      const resp = await this.rawRequest(msg.method!, msg.params);
      return { jsonrpc: "2.0", id: msg.id, ...(resp.error ? { error: resp.error } : { result: resp.result }) };
    } catch (err) {
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: err instanceof Error ? err.message : "internal error" } };
    }
  }

  async sendNotification(msg: JsonRpcMessage): Promise<void> {
    this.write({ jsonrpc: "2.0", method: msg.method, params: msg.params });
  }
}

export function createStdioBackend(rt: Runtime): Backend {
  if (rt.config.mode !== "stdio") throw new Error("not a stdio config");
  const cfg = rt.config;
  const taskRoot = rt.taskRoot ?? process.env.RMCP_TASK_ROOT ?? "/var/task";
  const child = new StdioChild({
    command: process.execPath,
    args: [path.join(taskRoot, cfg.binPath), ...cfg.args],
    env: { ...cfg.env, ...rt.secrets },
    cwd: process.env.RMCP_CHILD_CWD ?? "/tmp",
  });

  return {
    async handleRequest(msg): Promise<BackendResult> {
      await child.ensureStarted();
      if (msg.method === "initialize") {
        return { message: { jsonrpc: "2.0", id: msg.id, result: child.initResult } };
      }
      return { message: await child.forwardRequest(msg) };
    },
    async handleNotification(msg): Promise<void> {
      await child.ensureStarted();
      if (msg.method === "notifications/initialized") return; // child was initialized at spawn
      await child.sendNotification(msg);
    },
    dispose(): void { child.kill(); },
  };
}
