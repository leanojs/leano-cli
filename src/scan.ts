import fs from "fs";
import path from "path";
import type { FileEntry } from "./types.js";

// Extensions that will be re-encoded by sharp
const CONVERTIBLE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

// OS/editor-generated files that should never appear in the output
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

/**
 * Returns true for files that should be copied verbatim to the output.
 * This includes already-optimised images (.webp, .avif) as well as any
 * other asset (.svg, .ico, .gif, fonts, JSON, etc.) that sharp cannot or
 * should not re-encode.
 */
export function isPassthrough(filename: string): boolean {
  return !isConvertible(filename) && !isIgnored(filename);
}

export function replaceExtension(filePath: string, newExt: string): string {
  const dotIndex = filePath.lastIndexOf(".");
  const base = dotIndex !== -1 ? filePath.slice(0, dotIndex) : filePath;
  return `${base}.${newExt}`;
}

/**
 * Recursively walk a directory and collect every file that should appear in
 * the output — both convertible images (.jpg, .jpeg, .png) and pass-through
 * assets (.webp, .avif, .svg, .ico, fonts, etc.).
 * OS-generated junk (.DS_Store, Thumbs.db …) is silently skipped.
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
