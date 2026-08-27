import { AddPermissionCommand, CreateFunctionCommand, CreateFunctionUrlConfigCommand, DeleteFunctionCommand, DeleteFunctionUrlConfigCommand, GetFunctionUrlConfigCommand, InvalidParameterValueException, LambdaClient, ResourceConflictException, ResourceNotFoundException, UpdateFunctionCodeCommand, UpdateFunctionConfigurationCommand, waitUntilFunctionActiveV2, waitUntilFunctionUpdatedV2 } from "@aws-sdk/client-lambda";
import { TAG_KEY } from "@rmcp/shared";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type FunctionCode = { zipFile: Buffer } | { s3: { bucket: string; key: string } };

export interface DeployFunctionOpts {
  functionName: string;
  serverId: string;
  roleArn: string;
  code: FunctionCode;
  retryDelayMs?: number;
}

export async function deployFunction(lambda: LambdaClient, opts: DeployFunctionOpts): Promise<{ url: string }> {
  const config = {
    FunctionName: opts.functionName,
    Role: opts.roleArn,
    MemorySize: 512,
    Timeout: 120,
    Environment: { Variables: { RMCP_SERVER_ID: opts.serverId } },
  };
  const retryDelayMs = opts.retryDelayMs ?? 3000;
  const codeFields = "zipFile" in opts.code
    ? { ZipFile: opts.code.zipFile }
    : { S3Bucket: opts.code.s3.bucket, S3Key: opts.code.s3.key };

  let exists = false;
  for (let attempt = 0; ; attempt++) {
    try {
      await lambda.send(new CreateFunctionCommand({
        ...config,
        Runtime: "nodejs22.x",
        Handler: "index.handler",
        Architectures: ["arm64"],
        Code: codeFields,
        Tags: { [TAG_KEY]: opts.serverId },
      }));
      break;
    } catch (err) {
      if (err instanceof ResourceConflictException) { exists = true; break; }
      // A freshly created IAM role takes a few seconds to become assumable.
      if (err instanceof InvalidParameterValueException && /role/i.test(err.message) && attempt < 10) {
        await sleep(retryDelayMs);
        continue;
      }
      throw err;
    }
  }

  if (exists) {
    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: opts.functionName, ...codeFields }));
    await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 120 }, { FunctionName: opts.functionName });
    await lambda.send(new UpdateFunctionConfigurationCommand(config));
    await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 120 }, { FunctionName: opts.functionName });
  } else {
    await waitUntilFunctionActiveV2({ client: lambda, maxWaitTime: 120 }, { FunctionName: opts.functionName });
  }

  let url: string;
  try {
    const created = await lambda.send(new CreateFunctionUrlConfigCommand({
      FunctionName: opts.functionName, AuthType: "NONE", InvokeMode: "BUFFERED",
    }));
    url = created.FunctionUrl!;
  } catch (err) {
    if (!(err instanceof ResourceConflictException)) throw err;
    const existing = await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: opts.functionName }));
    url = existing.FunctionUrl!;
  }

  // Since Oct 2025, public function URLs need BOTH actions on the resource
  // policy; InvokeFunction rejects the FunctionUrlAuthType condition, so it is
  // granted unconditioned (callers still have to pass the bridge bearer check).
  const permissions = [
    { StatementId: "rmcp-public-url", Action: "lambda:InvokeFunctionUrl", FunctionUrlAuthType: "NONE" as const },
    { StatementId: "rmcp-public-invoke", Action: "lambda:InvokeFunction", FunctionUrlAuthType: undefined },
  ];
  for (const perm of permissions) {
    try {
      await lambda.send(new AddPermissionCommand({
        FunctionName: opts.functionName,
        Principal: "*",
        ...perm,
      }));
    } catch (err) {
      if (!(err instanceof ResourceConflictException)) throw err;
    }
  }
  return { url };
}

export async function destroyFunction(lambda: LambdaClient, functionName: string): Promise<void> {
  try {
    await lambda.send(new DeleteFunctionUrlConfigCommand({ FunctionName: functionName }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
  try {
    await lambda.send(new DeleteFunctionCommand({ FunctionName: functionName }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
}
