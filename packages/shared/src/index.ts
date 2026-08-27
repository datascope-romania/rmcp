import { z } from "zod";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const FUNCTION_PREFIX = "rmcp-";
export const TAG_KEY = "rmcp:server-id";
export const SERVER_NAME_RE = /^[a-z0-9-]{1,40}$/;

export const EnvValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plain"), value: z.string() }),
  z.object({ kind: z.literal("secret"), set: z.boolean() }),
]);
export type EnvValue = z.infer<typeof EnvValueSchema>;

export const StdioServerConfigSchema = z.object({
  type: z.literal("stdio"),
  package: z.string().min(1),
  version: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), EnvValueSchema).default({}),
});
export type StdioServerConfig = z.infer<typeof StdioServerConfigSchema>;

export const HttpServerConfigSchema = z.object({
  type: z.literal("http"),
  url: z.url(),
  headers: z.record(z.string(), EnvValueSchema).default({}),
});
export type HttpServerConfig = z.infer<typeof HttpServerConfigSchema>;

export const ServerConfigSchema = z.discriminatedUnion("type", [
  StdioServerConfigSchema,
  HttpServerConfigSchema,
]);
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export const ServerStatusSchema = z.enum(["draft", "deploying", "deployed", "error", "undeployed"]);
export type ServerStatus = z.infer<typeof ServerStatusSchema>;

export const DeployTargetSchema = z.enum(["lambda", "local"]);
export type DeployTarget = z.infer<typeof DeployTargetSchema>;

export const ServerRecordSchema = z.object({
  id: z.uuid(),
  name: z.string().regex(SERVER_NAME_RE),
  config: ServerConfigSchema,
  status: ServerStatusSchema,
  deployedTarget: DeployTargetSchema.nullable(),
  awsFootprint: z.boolean(),
  folder: z.string().trim().min(1).max(60).nullable(),
  sortIndex: z.number().int(),
  endpointUrl: z.url().nullable(),
  bearerToken: z.string().nullable(),
  oauthClientId: z.string().nullable(),
  oauthClientSecret: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ServerRecord = z.infer<typeof ServerRecordSchema>;

export const BridgeConfigSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("stdio"),
    binPath: z.string(),                       // relative to the Lambda task root
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),     // plain env only; secrets merged from SSM
  }),
  z.object({
    mode: z.literal("http-proxy"),
    upstreamUrl: z.url(),
    headers: z.record(z.string(), z.string()), // plain headers only; secrets merged from SSM
  }),
]);
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

export const ssmPaths = {
  root: (id: string) => `/rmcp/${id}/`,
  config: (id: string) => `/rmcp/${id}/config`,
  token: (id: string) => `/rmcp/${id}/token`,
  secret: (id: string, key: string) => `/rmcp/${id}/secrets/${key}`,
};
