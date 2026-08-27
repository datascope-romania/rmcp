import { LambdaClient, ListFunctionsCommand, ListTagsCommand } from "@aws-sdk/client-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { listRmcpFunctions } from "../src/orphans.js";

const lambdaMock = mockClient(LambdaClient);
beforeEach(() => lambdaMock.reset());

describe("listRmcpFunctions", () => {
  it("returns rmcp-prefixed functions with their server-id tag", async () => {
    lambdaMock.on(ListFunctionsCommand).resolves({
      Functions: [
        { FunctionName: "rmcp-github", FunctionArn: "arn:1" },
        { FunctionName: "unrelated", FunctionArn: "arn:2" },
      ],
    });
    lambdaMock.on(ListTagsCommand, { Resource: "arn:1" }).resolves({ Tags: { "rmcp:server-id": "abc" } });
    const result = await listRmcpFunctions(new LambdaClient({}));
    expect(result).toEqual([{ functionName: "rmcp-github", serverId: "abc" }]);
    expect(lambdaMock.commandCalls(ListTagsCommand)).toHaveLength(1);
  });
});
