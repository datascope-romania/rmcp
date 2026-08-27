import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ServerConfig } from "@rmcp/shared";

const exec = promisify(execFile);

export interface StageResult { dir: string; binPath?: string }

// Deliberately no --no-bin-links. npm links dependency bins into
// node_modules/.bin and puts that dir on PATH for lifecycle scripts; native
// packages depend on it. isolated-vm's install script is
// `node-gyp-build || node-gyp rebuild --release -j max`, so without the link it
// cannot find the resolver that picks its bundled prebuilt binary and instead
// compiles V8-heavy C++ across every core — which the OOM killer ends on a
// small host. pruneVendor strips .bin afterwards, so the staged bundle is still
// symlink-free for zipping, and nothing needs it at runtime because resolveBin
// returns a direct path into node_modules.
export const VENDOR_INSTALL_ARGS = ["install", "--omit=dev", "--no-audit", "--no-fund"];

export async function stageBundle(opts: {
  config: ServerConfig;
  bridgeBundlePath?: string;
  workDir: string;
}): Promise<StageResult> {
  await mkdir(opts.workDir, { recursive: true });
  if (opts.bridgeBundlePath) {
    await copyFile(opts.bridgeBundlePath, path.join(opts.workDir, "index.mjs"));
  }
  if (opts.config.type === "http") return { dir: opts.workDir };

  const vendor = path.join(opts.workDir, "vendor");
  await mkdir(vendor, { recursive: true });
  await writeFile(path.join(vendor, "package.json"), JSON.stringify({
    name: "rmcp-vendor", private: true,
    dependencies: { [opts.config.package]: opts.config.version },
  }));
  // Resolve from the public registry regardless of the user's global npm
  // config: corporate registries need auth that expires and their URLs end
  // up baked into the staged lockfile.
  await writeFile(path.join(vendor, ".npmrc"), "registry=https://registry.npmjs.org/\n");
  await exec("npm", VENDOR_INSTALL_ARGS, {
    cwd: vendor, timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
  });
  await pruneVendor(vendor);
  const binPath = await resolveBin(vendor, opts.config.package);
  await stat(path.join(opts.workDir, binPath)); // fail here, not at runtime, if the bin is missing
  return { dir: opts.workDir, binPath };
}

// Source maps and TypeScript sources are never loaded by node at runtime but
// routinely make up half of a package's install size (e.g. @opentelemetry).
const PRUNE_RE = /\.(map|ts|tsx|mts|cts)$/;

export async function pruneVendor(vendorDir: string): Promise<{ removedFiles: number; removedBytes: number }> {
  let removedFiles = 0;
  let removedBytes = 0;
  const binDirs: string[] = [];
  for (const entry of await readdir(vendorDir, { recursive: true, withFileTypes: true })) {
    const entryPath = path.join(entry.parentPath, entry.name);
    if (entry.isDirectory()) {
      // Only npm's own link dirs — a package shipping its own ".bin" data
      // directory would not sit directly inside node_modules.
      if (entry.name === ".bin" && path.basename(entry.parentPath) === "node_modules") binDirs.push(entryPath);
      continue;
    }
    if (!entry.isFile() || !PRUNE_RE.test(entry.name)) continue;
    removedBytes += (await stat(entryPath)).size;
    await unlink(entryPath);
    removedFiles++;
  }
  for (const binDir of binDirs) {
    for (const link of await readdir(binDir, { withFileTypes: true })) {
      removedBytes += (await lstat(path.join(binDir, link.name))).size;
      removedFiles++;
    }
    await rm(binDir, { recursive: true, force: true });
  }
  return { removedFiles, removedBytes };
}

export async function resolveBin(vendorDir: string, pkgName: string): Promise<string> {
  const pkgJsonPath = path.join(vendorDir, "node_modules", ...pkgName.split("/"), "package.json");
  const pkg = JSON.parse(await readFile(pkgJsonPath, "utf8")) as { bin?: string | Record<string, string> };
  let binRel: string;
  if (typeof pkg.bin === "string") {
    binRel = pkg.bin;
  } else if (pkg.bin && Object.keys(pkg.bin).length > 0) {
    const baseName = pkgName.split("/").at(-1)!;
    binRel = pkg.bin[baseName] ?? Object.values(pkg.bin)[0];
  } else {
    throw new Error(`package ${pkgName} has no "bin" entry — cannot run it as a stdio MCP server`);
  }
  return path.posix.join("vendor", "node_modules", pkgName, path.posix.normalize(binRel));
}
