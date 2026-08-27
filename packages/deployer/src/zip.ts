import { createWriteStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";

export async function zipDir(dir: string, outFile: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outFile);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(dir, false);
    void archive.finalize();
  });
  const { size } = await stat(outFile);
  return size;
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += (await stat(path.join(entry.parentPath, entry.name))).size;
  }
  return total;
}
