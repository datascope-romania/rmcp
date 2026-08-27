import { LambdaClient, ListFunctionsCommand, ListTagsCommand } from "@aws-sdk/client-lambda";
import { FUNCTION_PREFIX, TAG_KEY } from "@rmcp/shared";

export async function listRmcpFunctions(lambda: LambdaClient): Promise<{ functionName: string; serverId: string }[]> {
  const result: { functionName: string; serverId: string }[] = [];
  let Marker: string | undefined;
  do {
    const page = await lambda.send(new ListFunctionsCommand({ Marker }));
    for (const fn of page.Functions ?? []) {
      if (!fn.FunctionName?.startsWith(FUNCTION_PREFIX)) continue;
      const tags = await lambda.send(new ListTagsCommand({ Resource: fn.FunctionArn! }));
      const serverId = tags.Tags?.[TAG_KEY];
      if (serverId) result.push({ functionName: fn.FunctionName, serverId });
    }
    Marker = page.NextMarker;
  } while (Marker);
  return result;
}
