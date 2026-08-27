import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IAMClient } from "@aws-sdk/client-iam";
import type { LambdaClient } from "@aws-sdk/client-lambda";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SSMClient } from "@aws-sdk/client-ssm";
import { FUNCTION_PREFIX, type BridgeConfig, type EnvValue, type ServerRecord } from "@rmcp/shared";
import { destroyFunction, deployFunction, type FunctionCode } from "./function.js";
import { healthCheck } from "./healthcheck.js";
import { putSecret, upsertServerParams } from "./params.js";
import { ensureRole } from "./role.js";
import { bucketName, deleteZip, ensureBucket, uploadZip } from "./s3.js";
import { stageBundle } from "./stage.js";
import { dirSize, zipDir } from "./zip.js";

export type DeployStep = "stage" | "zip" | "role" | "params" | "upload" | "function" | "healthcheck" | "register";
export interface StepEvent { step: DeployStep; status: "start" | "ok" | "fail"; detail?: string }
export interface AwsClients { lambda: LambdaClient; iam: IAMClient; ssm: SSMClient; s3: S3Client }

// Lambda accepts ~50 MB zips inline; larger code must come from S3, and the
// unzipped tree must stay under 250 MiB either way.
const DIRECT_UPLOAD_LIMIT = 45 * 1024 * 1024;
const UNPACKED_LIMIT = 250 * 1024 * 1024;

export interface DeployOptions {
  clients: AwsClients;
  bridgeBundlePath: string;
  workRoot: string;
  onEvent?: (e: StepEvent) => void;
  fetchImpl?: typeof fetch;
  healthDelayMs?: number;
  retryDelayMs?: number;
  limits?: { directUpload?: number; unpacked?: number };
  secrets?: Record<string, string>;
}

function plainOnly(values: Record<string, EnvValue>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).flatMap(([k, v]) => (v.kind === "plain" ? [[k, v.value]] : [])),
  );
}

export function toBridgeConfig(record: ServerRecord, binPath?: string): BridgeConfig {
  if (record.config.type === "stdio") {
    if (!binPath) throw new Error("binPath is required for stdio configs");
    return { mode: "stdio", binPath, args: record.config.args, env: plainOnly(record.config.env) };
  }
  return { mode: "http-proxy", upstreamUrl: record.config.url, headers: plainOnly(record.config.headers) };
}

export async function deployServer(record: ServerRecord, opts: DeployOptions): Promise<{ endpointUrl: string; bearerToken: string }> {
  const emit = opts.onEvent ?? (() => {});
  async function step<T>(name: DeployStep, fn: () => Promise<T>): Promise<T> {
    emit({ step: name, status: "start" });
    try {
      const result = await fn();
      emit({ step: name, status: "ok" });
      return result;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      emit({ step: name, status: "fail", detail });
      throw new Error(`${name}: ${detail}`, { cause: err });
    }
  }

  const workDir = path.join(opts.workRoot, `${record.id}-${randomUUID()}`);
  const staged = await step("stage", () => stageBundle({
    config: record.config, bridgeBundlePath: opts.bridgeBundlePath, workDir,
  }));
  const zipPath = path.join(opts.workRoot, `${record.id}.zip`);
  const unpackedLimit = opts.limits?.unpacked ?? UNPACKED_LIMIT;
  const zipBytes = await step("zip", async () => {
    const unpacked = await dirSize(staged.dir);
    if (unpacked > unpackedLimit) {
      throw new Error(`staged package is ${unpacked} bytes; exceeds Lambda's ${unpackedLimit}-byte unpacked limit — this server cannot run on Lambda`);
    }
    return zipDir(staged.dir, zipPath);
  });
  const roleArn = await step("role", () => ensureRole(opts.clients.iam));
  const bearerToken = record.bearerToken ?? randomBytes(32).toString("base64url");
  await step("params", async () => {
    await upsertServerParams(opts.clients.ssm, {
      serverId: record.id, bridgeConfig: toBridgeConfig(record, staged.binPath), token: bearerToken,
    });
    for (const [key, value] of Object.entries(opts.secrets ?? {})) {
      await putSecret(opts.clients.ssm, record.id, key, value);
    }
  });

  let uploaded: { bucket: string; key: string } | null = null;
  let code: FunctionCode;
  if (zipBytes > (opts.limits?.directUpload ?? DIRECT_UPLOAD_LIMIT)) {
    code = await step("upload", async () => {
      const accountId = /^arn:aws:iam::(\d+):/.exec(roleArn)?.[1];
      if (!accountId) throw new Error(`cannot determine account id from role ARN ${roleArn}`);
      const region = await opts.clients.s3.config.region();
      const bucket = bucketName(accountId, region);
      await ensureBucket(opts.clients.s3, bucket, region);
      uploaded = { bucket, key: `functions/${record.id}.zip` };
      await uploadZip(opts.clients.s3, uploaded.bucket, uploaded.key, await readFile(zipPath));
      return { s3: uploaded };
    });
  } else {
    code = { zipFile: await readFile(zipPath) };
  }

  const { url } = await step("function", async () => deployFunction(opts.clients.lambda, {
    functionName: `${FUNCTION_PREFIX}${record.name}`,
    serverId: record.id,
    roleArn,
    code,
    retryDelayMs: opts.retryDelayMs,
  }));
  if (uploaded) {
    // Lambda copied the code during create/update; the staging object is no longer needed.
    const { bucket, key } = uploaded;
    await deleteZip(opts.clients.s3, bucket, key).catch(() => {});
  }
  await step("healthcheck", () => healthCheck(url, bearerToken, {
    fetchImpl: opts.fetchImpl, delayMs: opts.healthDelayMs,
  }));
  return { endpointUrl: url, bearerToken };
}

export async function undeployServer(record: ServerRecord, opts: { clients: AwsClients }): Promise<void> {
  await destroyFunction(opts.clients.lambda, `${FUNCTION_PREFIX}${record.name}`);
}
