import { AddTagsToResourceCommand, DeleteParameterCommand, DeleteParametersCommand, GetParametersByPathCommand, ParameterNotFound, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { ssmPaths, TAG_KEY, type BridgeConfig } from "@rmcp/shared";

async function putAndTag(ssm: SSMClient, serverId: string, name: string, value: string, type: "String" | "SecureString"): Promise<void> {
  await ssm.send(new PutParameterCommand({ Name: name, Value: value, Type: type, Overwrite: true }));
  await ssm.send(new AddTagsToResourceCommand({
    ResourceType: "Parameter", ResourceId: name, Tags: [{ Key: TAG_KEY, Value: serverId }],
  }));
}

export async function upsertServerParams(ssm: SSMClient, opts: { serverId: string; bridgeConfig: BridgeConfig; token: string }): Promise<void> {
  await putAndTag(ssm, opts.serverId, ssmPaths.config(opts.serverId), JSON.stringify(opts.bridgeConfig), "String");
  await putAndTag(ssm, opts.serverId, ssmPaths.token(opts.serverId), opts.token, "SecureString");
}

export async function putSecret(ssm: SSMClient, serverId: string, key: string, value: string): Promise<void> {
  await putAndTag(ssm, serverId, ssmPaths.secret(serverId, key), value, "SecureString");
}

export async function deleteSecret(ssm: SSMClient, serverId: string, key: string): Promise<void> {
  try {
    await ssm.send(new DeleteParameterCommand({ Name: ssmPaths.secret(serverId, key) }));
  } catch (err) {
    if (!(err instanceof ParameterNotFound)) throw err;
  }
}

export async function deleteAllParams(ssm: SSMClient, serverId: string): Promise<void> {
  const names: string[] = [];
  let NextToken: string | undefined;
  do {
    const page = await ssm.send(new GetParametersByPathCommand({
      Path: ssmPaths.root(serverId), Recursive: true, NextToken,
    }));
    names.push(...(page.Parameters ?? []).map((p) => p.Name!));
    NextToken = page.NextToken;
  } while (NextToken);
  for (let i = 0; i < names.length; i += 10) {
    await ssm.send(new DeleteParametersCommand({ Names: names.slice(i, i + 10) }));
  }
}
