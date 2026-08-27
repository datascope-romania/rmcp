import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(here, "..");
const fixtureDir = path.join(here, "fixtures", "fake-mcp-server");

describe("bundle", () => {
  it("builds and serves an initialize request end-to-end", { timeout: 60_000 }, async () => {
    await exec(process.execPath, ["build.mjs"], { cwd: pkgDir });
    const event = {
      requestContext: { http: { method: "POST" } },
      headers: { authorization: "Bearer tok" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    };
    const { stdout } = await exec(
      process.execPath,
      [path.join(here, "fixtures", "invoke-bundle.mjs"), JSON.stringify(event)],
      {
        env: {
          ...process.env,
          RMCP_TASK_ROOT: fixtureDir,
          RMCP_CHILD_CWD: fixtureDir,
          RMCP_TEST_CONFIG: JSON.stringify({
            serverId: "bundle-test", token: "tok", secrets: {},
            config: { mode: "stdio", binPath: "server.mjs", args: [], env: {} },
          }),
        },
      },
    );
    const res = JSON.parse(stdout.trim());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).result.serverInfo.name).toBe("fake-mcp-server");
  });
});
