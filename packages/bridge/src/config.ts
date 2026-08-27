import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";
import { BridgeConfigSchema, ssmPaths, type BridgeConfig } from "@rmcp/shared";

export interface Runtime {
  serverId: string;
  config: BridgeConfig;
  token: string;
  secrets: Record<string, string>;
  taskRoot?: string;
}

let cached: Promise<Runtime> | null = null;

export function resetRuntimeCache(): void { cached = null; }

export function loadRuntime(): Promise<Runtime> {
  cached ??= load();
  return cached;
}

async function load(): Promise<Runtime> {
  if (process.env.RMCP_TEST_CONFIG) {
    const raw = JSON.parse(process.env.RMCP_TEST_CONFIG);
    return { ...raw, config: BridgeConfigSchema.parse(raw.config) };
  }
  const serverId = process.env.RMCP_SERVER_ID;
  if (!serverId) throw new Error("RMCP_SERVER_ID is not set");
  const ssm = new SSMClient({});
  const root = ssmPaths.root(serverId);
  const params: { Name?: string; Value?: string }[] = [];
  let NextToken: string | undefined;
  do {
    const page = await ssm.send(new GetParametersByPathCommand({
      Path: root, Recursive: true, WithDecryption: true, NextToken,
    }));
    params.push(...(page.Parameters ?? []));
    NextToken = page.NextToken;
  } while (NextToken);

  let config: BridgeConfig | null = null;
  let token: string | null = null;
  const secrets: Record<string, string> = {};
  for (const p of params) {
    const suffix = p.Name!.slice(root.length);
    if (suffix === "config") config = BridgeConfigSchema.parse(JSON.parse(p.Value!));
    else if (suffix === "token") token = p.Value!;
    else if (suffix.startsWith("secrets/")) secrets[suffix.slice("secrets/".length)] = p.Value!;
  }
  if (!config || !token) throw new Error(`missing config/token parameters under ${root}`);
  return { serverId, config, token, secrets };
}
