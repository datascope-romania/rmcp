#!/usr/bin/env node
// Minimal MCP stdio server (newline-delimited JSON-RPC) used as a test fixture.
import { createInterface } from "node:readline";

const tools = [
  { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "env", description: "Read an env var", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "crash", description: "Exit the process", inputSchema: { type: "object", properties: {} } },
  { name: "pid", description: "Return the process pid", inputSchema: { type: "object", properties: {} } },
];

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fake-mcp-server", version: "1.0.0" },
    });
  } else if (msg.method === "notifications/initialized") {
    // notification: no response
  } else if (msg.method === "tools/list") {
    reply(msg.id, { tools });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    if (name === "crash") process.exit(1);
    else if (name === "echo") reply(msg.id, { content: [{ type: "text", text: args.text }] });
    else if (name === "env") reply(msg.id, { content: [{ type: "text", text: process.env[args.name] ?? "" }] });
    else if (name === "pid") reply(msg.id, { content: [{ type: "text", text: String(process.pid) }] });
    else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
});
