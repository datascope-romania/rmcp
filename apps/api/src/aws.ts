import { IAMClient } from "@aws-sdk/client-iam";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import { fromIni } from "@aws-sdk/credential-providers";
import type { AwsClients } from "@rmcp/deployer";
import type { Settings } from "./repo.js";

export function makeAwsClients(settings: Settings): AwsClients {
  const shared = {
    region: settings.region,
    credentials: settings.profile ? fromIni({ profile: settings.profile }) : undefined,
  };
  return {
    lambda: new LambdaClient(shared),
    iam: new IAMClient(shared),
    ssm: new SSMClient(shared),
    s3: new S3Client(shared),
  };
}
