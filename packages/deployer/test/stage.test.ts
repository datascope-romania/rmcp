import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import { beforeAll, describe, expect, it } from "vitest";
import { VENDOR_INSTALL_ARGS, pruneVendor, resolveBin, stageBundle } from "../src/stage.js";
import { dirSize, zipDir } from "../src/zip.js";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, "..", "..", "bridge", "test", "fixtures", "fake-mcp-server");

let tgzPath: string;
let bridgeBundlePath: string;

beforeAll(async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rmcp-pack-"));
  const { stdout } = await exec("npm", ["pack", fixtureDir, "--pack-destination", tmp]);
  tgzPath = path.join(tmp, stdout.trim().split("\n").at(-1)!);
  bridgeBundlePath = path.join(tmp, "index.mjs");
  await writeFile(bridgeBundlePath, "export const handler = async () => ({ statusCode: 200, body: '' });\n");
}, 60_000);

describe("stageBundle", () => {
  it("stages a stdio server: bridge + vendored package with resolved bin", { timeout: 120_000 }, async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "rmcp-stage-"));
    const result = await stageBundle({
      config: { type: "stdio", package: "fake-mcp-server", version: tgzPath, args: [], env: {} },
      bridgeBundlePath, workDir,
    });
    expect(result.binPath).toBe("vendor/node_modules/fake-mcp-server/server.mjs");
    await stat(path.join(workDir, "index.mjs"));
    await stat(path.join(workDir, result.binPath!));
  });

  it("pins the public npm registry for the vendored install", { timeout: 120_000 }, async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "rmcp-stage-"));
    await stageBundle({
      config: { type: "stdio", package: "fake-mcp-server", version: tgzPath, args: [], env: {} },
      bridgeBundlePath, workDir,
    });
    const npmrc = await readFile(path.join(workDir, "vendor", ".npmrc"), "utf8");
    expect(npmrc).toContain("registry=https://registry.npmjs.org/");
  });

  it("stages an http server: bridge only, no vendor dir", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "rmcp-stage-"));
    const result = await stageBundle({
      config: { type: "http", url: "https://u.example/mcp/", headers: {} },
      bridgeBundlePath, workDir,
    });
    expect(result.binPath).toBeUndefined();
    await stat(path.join(workDir, "index.mjs"));
    await expect(stat(path.join(workDir, "vendor"))).rejects.toThrow();
  });

  it("stages without a bridge bundle when bridgeBundlePath is omitted", { timeout: 120_000 }, async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "rmcp-stage-"));
    const result = await stageBundle({
      config: { type: "stdio", package: "fake-mcp-server", version: tgzPath, args: [], env: {} },
      workDir,
    });
    expect(result.binPath).toBe("vendor/node_modules/fake-mcp-server/server.mjs");
    await expect(stat(path.join(workDir, "index.mjs"))).rejects.toThrow();
  });
});

describe("pruneVendor", () => {
  it("removes source maps and TypeScript sources but keeps runtime files", async () => {
    const vendor = await mkdtemp(path.join(os.tmpdir(), "rmcp-prune-"));
    const pkgDir = path.join(vendor, "node_modules", "dep", "dist");
    await mkdir(pkgDir, { recursive: true });
    const files: Record<string, boolean> = {
      "index.js": true, "index.js.map": false, "index.d.ts": false,
      "source.ts": false, "component.tsx": false, "mod.mts": false,
      "data.json": true, "esm.mjs": true, "README.md": true,
    };
    for (const name of Object.keys(files)) await writeFile(path.join(pkgDir, name), "x".repeat(100));
    const { removedFiles, removedBytes } = await pruneVendor(vendor);
    expect(removedFiles).toBe(5);
    expect(removedBytes).toBe(500);
    for (const [name, kept] of Object.entries(files)) {
      const p = stat(path.join(pkgDir, name));
      await (kept ? expect(p).resolves.toBeTruthy() : expect(p).rejects.toThrow());
    }
  });

  it("is applied during stdio staging", { timeout: 120_000 }, async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "rmcp-stage-"));
    await stageBundle({
      config: { type: "stdio", package: "fake-mcp-server", version: tgzPath, args: [], env: {} },
      bridgeBundlePath, workDir,
    });
    const leftovers: string[] = [];
    for (const entry of await readdir(path.join(workDir, "vendor"), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /\.(map|ts|tsx|mts|cts)$/.test(entry.name)) leftovers.push(entry.name);
    }
    expect(leftovers).toEqual([]);
  });

  it("removes node_modules/.bin symlink dirs, including nested ones", async () => {
    const vendor = await mkdtemp(path.join(os.tmpdir(), "rmcp-prune-bin-"));
    const depDir = path.join(vendor, "node_modules", "dep");
    const topBin = path.join(vendor, "node_modules", ".bin");
    const nestedBin = path.join(depDir, "node_modules", ".bin");
    await mkdir(depDir, { recursive: true });
    await mkdir(topBin, { recursive: true });
    await mkdir(nestedBin, { recursive: true });
    await writeFile(path.join(depDir, "cli.js"), "x".repeat(10));
    await symlink(path.join("..", "dep", "cli.js"), path.join(topBin, "dep"));
    await symlink(path.join("..", "..", "cli.js"), path.join(nestedBin, "inner"));

    await pruneVendor(vendor);

    await expect(stat(topBin)).rejects.toThrow();
    await expect(stat(nestedBin)).rejects.toThrow();
    await stat(path.join(depDir, "cli.js")); // the real file the links pointed at survives
  });

  it("leaves no .bin dir in a staged vendor tree", { timeout: 120_000 }, async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "rmcp-stage-"));
    await stageBundle({
      config: { type: "stdio", package: "fake-mcp-server", version: tgzPath, args: [], env: {} },
      bridgeBundlePath, workDir,
    });
    await expect(stat(path.join(workDir, "vendor", "node_modules", ".bin"))).rejects.toThrow();
  });
});

describe("VENDOR_INSTALL_ARGS", () => {
  // Regression guard for --no-bin-links: without .bin populated, a dependency's
  // install script cannot invoke helpers like node-gyp-build by bare name, so
  // native packages silently fall back to compiling from source.
  it("installs with bin links populated", { timeout: 120_000 }, async () => {
    const vendor = await mkdtemp(path.join(os.tmpdir(), "rmcp-binlinks-"));
    await writeFile(path.join(vendor, "package.json"), JSON.stringify({
      name: "rmcp-vendor-binlinks", private: true,
      dependencies: { "fake-mcp-server": tgzPath },
    }));
    await writeFile(path.join(vendor, ".npmrc"), "registry=https://registry.npmjs.org/\n");
    await exec("npm", VENDOR_INSTALL_ARGS, { cwd: vendor, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    await stat(path.join(vendor, "node_modules", ".bin", "fake-mcp-server"));
  });
});

describe("dirSize", () => {
  it("sums apparent file bytes recursively", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rmcp-size-"));
    await mkdir(path.join(dir, "sub"), { recursive: true });
    await writeFile(path.join(dir, "a.bin"), Buffer.alloc(1000));
    await writeFile(path.join(dir, "sub", "b.bin"), Buffer.alloc(500));
    expect(await dirSize(dir)).toBe(1500);
  });
});

describe("resolveBin", () => {
  it("picks the bin whose key matches the package base name from an object bin", async () => {
    const vendor = await mkdtemp(path.join(os.tmpdir(), "rmcp-bin-"));
    const pkgDir = path.join(vendor, "node_modules", "@scope", "multi");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(path.join(pkgDir, "package.json"), JSON.stringify({
      name: "@scope/multi", version: "1.0.0",
      bin: { other: "./other.js", multi: "./cli/main.js" },
    }));
    expect(await resolveBin(vendor, "@scope/multi")).toBe("vendor/node_modules/@scope/multi/cli/main.js");
  });

  it("throws for a package without a bin", async () => {
    const vendor = await mkdtemp(path.join(os.tmpdir(), "rmcp-bin-"));
    const pkgDir = path.join(vendor, "node_modules", "nobin");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ name: "nobin", version: "1.0.0" }));
    await expect(resolveBin(vendor, "nobin")).rejects.toThrow(/has no "bin"/);
  });
});

describe("zipDir", () => {
  it("zips the staged dir with entries at the root", { timeout: 120_000 }, async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "rmcp-zip-"));
    await stageBundle({
      config: { type: "stdio", package: "fake-mcp-server", version: tgzPath, args: [], env: {} },
      bridgeBundlePath, workDir,
    });
    const outFile = path.join(workDir, "..", `${path.basename(workDir)}.zip`);
    const size = await zipDir(workDir, outFile);
    expect(size).toBeGreaterThan(0);
    const names = new AdmZip(outFile).getEntries().map((e) => e.entryName);
    expect(names).toContain("index.mjs");
    expect(names).toContain("vendor/node_modules/fake-mcp-server/server.mjs");
  });
});
