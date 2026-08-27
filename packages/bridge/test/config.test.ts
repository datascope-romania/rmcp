import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntime, resetRuntimeCache } from "../src/config.js";

const ssmMock = mockClient(SSMClient);

afterEach(() => {
  ssmMock.reset(); resetRuntimeCache();
  delete process.env.RMCP_TEST_CONFIG; delete process.env.RMCP_SERVER_ID;
});

describe("loadRuntime", () => {
  it("uses RMCP_TEST_CONFIG when set", async () => {
    process.env.RMCP_TEST_CONFIG = JSON.stringify({
      serverId: "t1",
      config: { mode: "http-proxy", upstreamUrl: "https://u.example/mcp/", headers: {} },
      token: "tok", secrets: { Authorization: "Bearer pat" },
    });
    const rt = await loadRuntime();
    expect(rt.token).toBe("tok");
    expect(rt.secrets.Authorization).toBe("Bearer pat");
  });

  it("loads and parses params from SSM by path", async () => {
    process.env.RMCP_SERVER_ID = "abc";
    ssmMock.on(GetParametersByPathCommand).resolves({
      Parameters: [
        { Name: "/rmcp/abc/config", Value: JSON.stringify({ mode: "stdio", binPath: "vendor/node_modules/x/cli.js", args: [], env: { A: "1" } }) },
        { Name: "/rmcp/abc/token", Value: "tok123" },
        { Name: "/rmcp/abc/secrets/API_KEY", Value: "sk-1" },
      ],
    });
    const rt = await loadRuntime();
    expect(rt.serverId).toBe("abc");
    expect(rt.config.mode).toBe("stdio");
    expect(rt.token).toBe("tok123");
    expect(rt.secrets).toEqual({ API_KEY: "sk-1" });
    // cached: second call does not hit SSM again
    await loadRuntime();
    expect(ssmMock.commandCalls(GetParametersByPathCommand).length).toBe(1);
  });
});
