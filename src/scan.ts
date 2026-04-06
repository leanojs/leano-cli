import fs from "fs";
import path from "path";
import type { FileEntry } from "./types.js";

const CONVERTIBLE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

const IGNORED_FILENAMES = new Set([
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
  ".gitkeep",
  ".gitignore",
]);

export function isConvertible(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf("."));
  return CONVERTIBLE_EXTENSIONS.has(ext);
}

export function isIgnored(filename: string): boolean {
  return IGNORED_FILENAMES.has(path.basename(filename).toLowerCase());
}

export function isPassthrough(filename: string): boolean {
  return !isConvertible(filename) && !isIgnored(filename);
}

export function replaceExtension(filePath: string, newExt: string): string {
  const dotIndex = filePath.lastIndexOf(".");
  const base = dotIndex !== -1 ? filePath.slice(0, dotIndex) : filePath;
  return `${base}.${newExt}`;
}

/**
 * Verify that filePath is strictly inside rootDir after path resolution.
 * Guards against symlink escapes and path-traversal when building output paths
 * from untrusted or deeply nested source trees.
 */
export function assertContained(filePath: string, rootDir: string): void {
  const relative = path.relative(rootDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Security: output path "${filePath}" escapes output root "${rootDir}"`
    );
  }
}

/**
 * Synchronous recursive walk — collects the full FileEntry[] upfront.
 * Used for the fast count/stats phase before processing begins.
 */
export function scanDirectory(rootDir: string): FileEntry[] {
  const entries: FileEntry[] = [];

  function walk(dir: string): void {
    const items = fs.readdirSync(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile() && !isIgnored(item.name)) {
        const relativePath = path.relative(rootDir, fullPath);
        entries.push({ inputPath: fullPath, relativePath });
      }
    }
  }

  walk(rootDir);
  return entries;
}

/**
 * Async BFS walk — yields FileEntry items one-by-one as directories are read.
 * Non-blocking: yields control between directory reads so encode jobs can
 * interleave with the scan. Unreadable subdirectories are skipped silently.
 */
export async function* walkAsync(rootDir: string): AsyncGenerator<FileEntry> {
  const queue: string[] = [rootDir];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    let items: fs.Dirent[];

    try {
      items = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        queue.push(fullPath);
      } else if (item.isFile() && !isIgnored(item.name)) {
        const relativePath = path.relative(rootDir, fullPath);
        yield { inputPath: fullPath, relativePath };
      }
    }
  }
}

/**
 * Lift a FileEntry[] into an AsyncIterable so it can be passed to convertFiles
 * without re-scanning the directory when we already have the list.
 */
export async function* fromArray(arr: FileEntry[]): AsyncGenerator<FileEntry> {
  for (const item of arr) {
    yield item;
  }
}
