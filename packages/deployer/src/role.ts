import { CreateRoleCommand, GetRoleCommand, IAMClient, NoSuchEntityException, PutRolePolicyCommand } from "@aws-sdk/client-iam";

const ASSUME_ROLE_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
});

const INLINE_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    { Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" },
    { Effect: "Allow", Action: ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"], Resource: "arn:aws:ssm:*:*:parameter/rmcp/*" },
  ],
});

export async function ensureRole(iam: IAMClient, roleName = "rmcp-lambda-role"): Promise<string> {
  let arn: string;
  try {
    const existing = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    arn = existing.Role!.Arn!;
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) throw err;
    const created = await iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: ASSUME_ROLE_POLICY,
      Description: "Shared execution role for rmcp-deployed MCP server Lambdas",
    }));
    arn = created.Role!.Arn!;
  }
  await iam.send(new PutRolePolicyCommand({
    RoleName: roleName, PolicyName: "rmcp-lambda-policy", PolicyDocument: INLINE_POLICY,
  }));
  return arn;
}
