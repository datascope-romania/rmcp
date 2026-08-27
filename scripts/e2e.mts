import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IAMClient } from "@aws-sdk/client-iam";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import { deleteAllParams, deployServer, undeployServer } from "@rmcp/deployer";
import { MCP_PROTOCOL_VERSION, type ServerRecord } from "@rmcp/shared";

if (process.env.RMCP_E2E !== "1") {
  console.error("This deploys real AWS resources. Set RMCP_E2E=1 to run (uses your AWS credentials).");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const region = process.env.AWS_REGION ?? "us-east-1";
const clients = { lambda: new LambdaClient({ region }), iam: new IAMClient({ region }), ssm: new SSMClient({ region }), s3: new S3Client({ region }) };

const record: ServerRecord = {
  id: randomUUID(),
  name: "e2e-everything",
  config: { type: "stdio", package: "@modelcontextprotocol/server-everything", version: "latest", args: [], env: {} },
  status: "draft", deployedTarget: null, awsFootprint: false, folder: null, sortIndex: 0,
  endpointUrl: null, bearerToken: null, oauthClientId: null, oauthClientSecret: null, lastError: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

async function rpc(url: string, token: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify(body),
  });
  const msg = await res.json();
  if (msg.error) throw new Error(`JSON-RPC error: ${msg.error.message}`);
  return msg.result;
}

console.log("building bridge bundle…");
execFileSync("pnpm", ["--filter", "@rmcp/bridge", "build"], { stdio: "inherit" });
const bridgeBundlePath = path.resolve(here, "../packages/bridge/dist/index.mjs");

try {
  console.log(`deploying @modelcontextprotocol/server-everything to ${region}…`);
  const { endpointUrl, bearerToken } = await deployServer(record, {
    clients, bridgeBundlePath,
    workRoot: mkdtempSync(path.join(os.tmpdir(), "rmcp-e2e-")),
    onEvent: (e) => console.log(`  [${e.step}] ${e.status}${e.detail ? ` — ${e.detail}` : ""}`),
  });
  console.log(`deployed: ${endpointUrl}`);

  const echo = await rpc(endpointUrl, bearerToken, {
    jsonrpc: "2.0", id: 10, method: "tools/call",
    params: { name: "echo", arguments: { message: "hello from rmcp e2e" } },
  });
  const text = echo.content?.[0]?.text ?? "";
  if (!text.includes("hello from rmcp e2e")) throw new Error(`echo returned unexpected result: ${JSON.stringify(echo)}`);
  console.log(`tools/call echo ok: "${text}"`);

  const unauth = await fetch(endpointUrl, { method: "POST", body: "{}" });
  if (unauth.status !== 401) throw new Error(`expected 401 without token, got ${unauth.status}`);
  console.log("401 without bearer token ok");
  console.log("\nE2E PASSED");
} finally {
  console.log("cleaning up…");
  await undeployServer(record, { clients });
  await deleteAllParams(clients.ssm, record.id);
}
