import { CreateRoleCommand, GetRoleCommand, IAMClient, NoSuchEntityException, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureRole } from "../src/role.js";

const iamMock = mockClient(IAMClient);
beforeEach(() => iamMock.reset());

describe("ensureRole", () => {
  it("returns the existing role's arn and refreshes the policy", async () => {
    iamMock.on(GetRoleCommand).resolves({ Role: { Arn: "arn:aws:iam::1:role/rmcp-lambda-role" } as never });
    const arn = await ensureRole(new IAMClient({}));
    expect(arn).toBe("arn:aws:iam::1:role/rmcp-lambda-role");
    expect(iamMock.commandCalls(CreateRoleCommand)).toHaveLength(0);
    expect(iamMock.commandCalls(PutRolePolicyCommand)).toHaveLength(1);
  });

  it("creates the role when missing", async () => {
    iamMock.on(GetRoleCommand).rejects(new NoSuchEntityException({ message: "nope", $metadata: {} }));
    iamMock.on(CreateRoleCommand).resolves({ Role: { Arn: "arn:aws:iam::1:role/rmcp-lambda-role" } as never });
    const arn = await ensureRole(new IAMClient({}));
    expect(arn).toBe("arn:aws:iam::1:role/rmcp-lambda-role");
    const create = iamMock.commandCalls(CreateRoleCommand)[0].args[0].input;
    expect(JSON.parse(create.AssumeRolePolicyDocument!).Statement[0].Principal.Service).toBe("lambda.amazonaws.com");
    const policy = JSON.parse(iamMock.commandCalls(PutRolePolicyCommand)[0].args[0].input.PolicyDocument!);
    expect(JSON.stringify(policy)).toContain("parameter/rmcp/*");
  });
});
