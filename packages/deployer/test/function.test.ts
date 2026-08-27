import { AddPermissionCommand, CreateFunctionCommand, CreateFunctionUrlConfigCommand, DeleteFunctionCommand, DeleteFunctionUrlConfigCommand, GetFunctionCommand, GetFunctionUrlConfigCommand, InvalidParameterValueException, LambdaClient, ResourceConflictException, ResourceNotFoundException, UpdateFunctionCodeCommand, UpdateFunctionConfigurationCommand } from "@aws-sdk/client-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { deployFunction, destroyFunction } from "../src/function.js";

const lambdaMock = mockClient(LambdaClient);
const client = new LambdaClient({});
const zipFile = Buffer.from("zip");
const base = { functionName: "rmcp-x", serverId: "abc", roleArn: "arn:role", code: { zipFile }, retryDelayMs: 1 };

beforeEach(() => {
  lambdaMock.reset();
  lambdaMock.on(GetFunctionCommand).resolves({
    Configuration: { State: "Active", LastUpdateStatus: "Successful" },
  });
  lambdaMock.on(CreateFunctionUrlConfigCommand).resolves({ FunctionUrl: "https://f.lambda-url.aws/" });
  lambdaMock.on(AddPermissionCommand).resolves({});
});

describe("deployFunction", () => {
  it("creates a new function with url and both public-invoke permissions", async () => {
    lambdaMock.on(CreateFunctionCommand).resolves({ FunctionArn: "arn:fn" });
    const { url } = await deployFunction(client, base);
    expect(url).toBe("https://f.lambda-url.aws/");
    const input = lambdaMock.commandCalls(CreateFunctionCommand)[0].args[0].input;
    expect(input.Runtime).toBe("nodejs22.x");
    expect(input.Architectures).toEqual(["arm64"]);
    expect(input.Environment?.Variables?.RMCP_SERVER_ID).toBe("abc");
    expect(input.Tags?.["rmcp:server-id"]).toBe("abc");
    // Since Oct 2025 AWS requires BOTH lambda:InvokeFunctionUrl and
    // lambda:InvokeFunction on the resource policy for public function URLs.
    const perms = lambdaMock.commandCalls(AddPermissionCommand).map((c) => c.args[0].input);
    expect(perms).toHaveLength(2);
    const urlPerm = perms.find((p) => p.Action === "lambda:InvokeFunctionUrl")!;
    expect(urlPerm.FunctionUrlAuthType).toBe("NONE");
    expect(urlPerm.Principal).toBe("*");
    const invokePerm = perms.find((p) => p.Action === "lambda:InvokeFunction")!;
    expect(invokePerm.Principal).toBe("*");
    expect(invokePerm.FunctionUrlAuthType).toBeUndefined();
  });

  it("points Code at S3 when given an s3 location", async () => {
    lambdaMock.on(CreateFunctionCommand).resolves({ FunctionArn: "arn:fn" });
    await deployFunction(client, { ...base, code: { s3: { bucket: "rmcp-deploy-1-us-east-1", key: "functions/abc.zip" } } });
    const input = lambdaMock.commandCalls(CreateFunctionCommand)[0].args[0].input;
    expect(input.Code?.S3Bucket).toBe("rmcp-deploy-1-us-east-1");
    expect(input.Code?.S3Key).toBe("functions/abc.zip");
    expect(input.Code?.ZipFile).toBeUndefined();
  });

  it("updates existing function code from S3", async () => {
    lambdaMock.on(CreateFunctionCommand).rejects(new ResourceConflictException({ message: "exists", $metadata: {} }));
    lambdaMock.on(UpdateFunctionCodeCommand).resolves({});
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});
    await deployFunction(client, { ...base, code: { s3: { bucket: "b", key: "k" } } });
    const upd = lambdaMock.commandCalls(UpdateFunctionCodeCommand)[0].args[0].input;
    expect(upd.S3Bucket).toBe("b");
    expect(upd.S3Key).toBe("k");
    expect(upd.ZipFile).toBeUndefined();
  });

  it("retries CreateFunction while the new role propagates", async () => {
    lambdaMock.on(CreateFunctionCommand)
      .rejectsOnce(new InvalidParameterValueException({ message: "The role defined for the function cannot be assumed by Lambda.", $metadata: {} }))
      .resolves({ FunctionArn: "arn:fn" });
    await deployFunction(client, base);
    expect(lambdaMock.commandCalls(CreateFunctionCommand)).toHaveLength(2);
  });

  it("updates code+config when the function exists, reusing the existing url", async () => {
    lambdaMock.on(CreateFunctionCommand).rejects(new ResourceConflictException({ message: "exists", $metadata: {} }));
    lambdaMock.on(UpdateFunctionCodeCommand).resolves({});
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});
    lambdaMock.on(CreateFunctionUrlConfigCommand).rejects(new ResourceConflictException({ message: "exists", $metadata: {} }));
    lambdaMock.on(GetFunctionUrlConfigCommand).resolves({ FunctionUrl: "https://existing.lambda-url.aws/" });
    lambdaMock.on(AddPermissionCommand).rejects(new ResourceConflictException({ message: "exists", $metadata: {} }));
    const { url } = await deployFunction(client, base);
    expect(url).toBe("https://existing.lambda-url.aws/");
    expect(lambdaMock.commandCalls(UpdateFunctionCodeCommand)).toHaveLength(1);
    expect(lambdaMock.commandCalls(UpdateFunctionConfigurationCommand)).toHaveLength(1);
  });
});

describe("destroyFunction", () => {
  it("deletes url config and function, tolerating absence", async () => {
    lambdaMock.on(DeleteFunctionUrlConfigCommand).rejects(new ResourceNotFoundException({ message: "gone", $metadata: {} }));
    lambdaMock.on(DeleteFunctionCommand).rejects(new ResourceNotFoundException({ message: "gone", $metadata: {} }));
    await expect(destroyFunction(client, "rmcp-x")).resolves.toBeUndefined();
  });
});
