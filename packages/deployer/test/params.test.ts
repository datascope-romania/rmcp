import { AddTagsToResourceCommand, DeleteParameterCommand, DeleteParametersCommand, GetParametersByPathCommand, ParameterNotFound, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteAllParams, deleteSecret, putSecret, upsertServerParams } from "../src/params.js";

const ssmMock = mockClient(SSMClient);
beforeEach(() => ssmMock.reset());
const client = new SSMClient({});

describe("params", () => {
  it("upserts config (String) and token (SecureString) with tags", async () => {
    ssmMock.on(PutParameterCommand).resolves({});
    ssmMock.on(AddTagsToResourceCommand).resolves({});
    await upsertServerParams(client, {
      serverId: "abc", token: "tok",
      bridgeConfig: { mode: "http-proxy", upstreamUrl: "https://u.example/", headers: {} },
    });
    const puts = ssmMock.commandCalls(PutParameterCommand).map((c) => c.args[0].input);
    expect(puts).toHaveLength(2);
    expect(puts.find((p) => p.Name === "/rmcp/abc/config")!.Type).toBe("String");
    expect(puts.find((p) => p.Name === "/rmcp/abc/token")!.Type).toBe("SecureString");
    expect(puts.every((p) => p.Overwrite)).toBe(true);
    expect(ssmMock.commandCalls(AddTagsToResourceCommand)).toHaveLength(2);
  });

  it("putSecret writes a SecureString under secrets/", async () => {
    ssmMock.on(PutParameterCommand).resolves({});
    ssmMock.on(AddTagsToResourceCommand).resolves({});
    await putSecret(client, "abc", "API_KEY", "sk-1");
    const put = ssmMock.commandCalls(PutParameterCommand)[0].args[0].input;
    expect(put.Name).toBe("/rmcp/abc/secrets/API_KEY");
    expect(put.Type).toBe("SecureString");
  });

  it("deleteSecret tolerates a missing parameter", async () => {
    ssmMock.on(DeleteParameterCommand).rejects(new ParameterNotFound({ message: "x", $metadata: {} }));
    await expect(deleteSecret(client, "abc", "GONE")).resolves.toBeUndefined();
  });

  it("deleteAllParams pages and deletes in chunks of 10", async () => {
    const names = Array.from({ length: 12 }, (_, i) => ({ Name: `/rmcp/abc/secrets/K${i}` }));
    ssmMock.on(GetParametersByPathCommand).resolves({ Parameters: names });
    ssmMock.on(DeleteParametersCommand).resolves({});
    await deleteAllParams(client, "abc");
    const dels = ssmMock.commandCalls(DeleteParametersCommand).map((c) => c.args[0].input.Names!.length);
    expect(dels).toEqual([10, 2]);
  });
});
