import { IAMClient, GetRoleCommand } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, CreateFunctionUrlConfigCommand, DeleteFunctionCommand, GetFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerRecord } from "@rmcp/shared";
import { deployServer, undeployServer, type StepEvent } from "../src/pipeline.js";

const iamMock = mockClient(IAMClient);
const lambdaMock = mockClient(LambdaClient);
const ssmMock = mockClient(SSMClient);
const s3Mock = mockClient(S3Client);

const record: ServerRecord = {
  id: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
  name: "github-proxy",
  config: {
    type: "http", url: "https://api.example.com/mcp/",
    headers: { "X-Plain": { kind: "plain", value: "1" }, Authorization: { kind: "secret", set: true } },
  },
  status: "draft", deployedTarget: null, awsFootprint: false, folder: null, sortIndex: 0, endpointUrl: null, bearerToken: "fixed-token",
  oauthClientId: null, oauthClientSecret: null,
  lastError: null, createdAt: "2026-07-06T00:00:00Z", updatedAt: "2026-07-06T00:00:00Z",
};

// Stateless fake endpoint: answers by inspecting the JSON-RPC request body,
// so it behaves correctly no matter how many times a test deploys.
function makeHealthFetch(): typeof fetch {
  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  });
  return (async (_url: unknown, init?: RequestInit) => {
    const msg = JSON.parse(String(init?.body ?? "{}"));
    if (msg.method === "initialize") {
      return json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "srv", version: "1" } } });
    }
    if (msg.id === undefined) return new Response("", { status: 202 });
    return json({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
  }) as unknown as typeof fetch;
}

let workRoot: string;
let bridgeBundlePath: string;

beforeEach(async () => {
  iamMock.reset(); lambdaMock.reset(); ssmMock.reset(); s3Mock.reset();
  iamMock.onAnyCommand().resolves({});
  iamMock.on(GetRoleCommand).resolves({ Role: { Arn: "arn:aws:iam::123456789012:role/rmcp-lambda-role" } as never });
  s3Mock.onAnyCommand().resolves({});
  lambdaMock.onAnyCommand().resolves({});
  lambdaMock.on(GetFunctionCommand).resolves({ Configuration: { State: "Active", LastUpdateStatus: "Successful" } });
  lambdaMock.on(CreateFunctionUrlConfigCommand).resolves({ FunctionUrl: "https://f.lambda-url.aws/" });
  ssmMock.onAnyCommand().resolves({});
  workRoot = await mkdtemp(path.join(os.tmpdir(), "rmcp-pipe-"));
  bridgeBundlePath = path.join(workRoot, "bridge.mjs");
  await writeFile(bridgeBundlePath, "export const handler = async () => ({});\n");
});

function clients() {
  return { lambda: new LambdaClient({}), iam: new IAMClient({}), ssm: new SSMClient({}), s3: new S3Client({ region: "us-east-1" }) };
}

describe("deployServer", () => {
  it("runs all steps in order and returns the endpoint + stable token", async () => {
    const events: StepEvent[] = [];
    const result = await deployServer(record, {
      clients: clients(), bridgeBundlePath, workRoot,
      onEvent: (e) => events.push(e), fetchImpl: makeHealthFetch(), healthDelayMs: 1,
    });
    expect(result).toEqual({ endpointUrl: "https://f.lambda-url.aws/", bearerToken: "fixed-token" });
    expect(events.filter((e) => e.status === "start").map((e) => e.step))
      .toEqual(["stage", "zip", "role", "params", "function", "healthcheck"]);
    expect(events.every((e) => e.status !== "fail")).toBe(true);

    const configPut = ssmMock.commandCalls(PutParameterCommand).map((c) => c.args[0].input)
      .find((p) => p.Name === `/rmcp/${record.id}/config`)!;
    const bridgeConfig = JSON.parse(configPut.Value!);
    // plain header inlined; secret header omitted (bridge merges it from SSM)
    expect(bridgeConfig).toEqual({ mode: "http-proxy", upstreamUrl: "https://api.example.com/mcp/", headers: { "X-Plain": "1" } });
    const fn = lambdaMock.commandCalls(CreateFunctionCommand)[0].args[0].input;
    expect(fn.FunctionName).toBe("rmcp-github-proxy");
    expect((fn.Code!.ZipFile as Uint8Array).byteLength).toBeGreaterThan(0);
  });

  it("generates a token when the record has none", async () => {
    const result = await deployServer({ ...record, bearerToken: null }, {
      clients: clients(), bridgeBundlePath, workRoot, fetchImpl: makeHealthFetch(), healthDelayMs: 1,
    });
    expect(result.bearerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("uploads via S3 and deletes the object when the zip exceeds the direct limit", async () => {
    const events: StepEvent[] = [];
    await deployServer(record, {
      clients: clients(), bridgeBundlePath, workRoot, onEvent: (e) => events.push(e),
      fetchImpl: makeHealthFetch(), healthDelayMs: 1,
      limits: { directUpload: 1 },
    });
    expect(events.filter((e) => e.status === "start").map((e) => e.step))
      .toEqual(["stage", "zip", "role", "params", "upload", "function", "healthcheck"]);
    const put = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(put.Bucket).toBe("rmcp-deploy-123456789012-us-east-1");
    expect(put.Key).toBe(`functions/${record.id}.zip`);
    const fn = lambdaMock.commandCalls(CreateFunctionCommand)[0].args[0].input;
    expect(fn.Code?.S3Bucket).toBe("rmcp-deploy-123456789012-us-east-1");
    expect(fn.Code?.ZipFile).toBeUndefined();
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });

  it("fails the zip step clearly when the unpacked size exceeds the Lambda limit", async () => {
    const events: StepEvent[] = [];
    await expect(deployServer(record, {
      clients: clients(), bridgeBundlePath, workRoot, onEvent: (e) => events.push(e),
      fetchImpl: makeHealthFetch(), healthDelayMs: 1,
      limits: { unpacked: 1 },
    })).rejects.toThrow(/exceeds Lambda's .* unpacked limit/);
    expect(events.at(-1)).toMatchObject({ step: "zip", status: "fail" });
  });

  it("emits a fail event and throws with step context when a step fails", async () => {
    lambdaMock.on(CreateFunctionCommand).rejects(new Error("AccessDenied"));
    const events: StepEvent[] = [];
    await expect(deployServer(record, {
      clients: clients(), bridgeBundlePath, workRoot, onEvent: (e) => events.push(e),
      fetchImpl: makeHealthFetch(), healthDelayMs: 1, retryDelayMs: 1,
    })).rejects.toThrow(/function: AccessDenied/);
    expect(events.at(-1)).toMatchObject({ step: "function", status: "fail" });
  });

  it("pushes provided secrets to SSM during the params step", async () => {
    await deployServer(record, {
      clients: clients(), bridgeBundlePath, workRoot,
      fetchImpl: makeHealthFetch(), healthDelayMs: 1,
      secrets: { API_KEY: "shh", OTHER: "x" },
    });
    const puts = ssmMock.commandCalls(PutParameterCommand).map((c) => c.args[0].input);
    const secretPut = puts.find((p) => p.Name === `/rmcp/${record.id}/secrets/API_KEY`)!;
    expect(secretPut.Value).toBe("shh");
    expect(secretPut.Type).toBe("SecureString");
    expect(puts.some((p) => p.Name === `/rmcp/${record.id}/secrets/OTHER`)).toBe(true);
  });
});

describe("undeployServer", () => {
  it("deletes only compute, never SSM params", async () => {
    await undeployServer(record, { clients: clients() });
    expect(lambdaMock.commandCalls(DeleteFunctionCommand)).toHaveLength(1);
    expect(ssmMock.calls()).toHaveLength(0);
  });
});
