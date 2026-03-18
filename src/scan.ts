import fs from 'fs';
import path from 'path';
import type { FileEntry } from './types.js';

// Extensions that will be re-encoded by sharp
const CONVERTIBLE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

// Extensions that are already in a target format — copy as-is
const PASSTHROUGH_EXTENSIONS = new Set(['.webp', '.avif']);

const ALL_SUPPORTED = new Set([...CONVERTIBLE_EXTENSIONS, ...PASSTHROUGH_EXTENSIONS]);

export function isSupportedImage(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return ALL_SUPPORTED.has(ext);
}

export function isPassthrough(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return PASSTHROUGH_EXTENSIONS.has(ext);
}

export function replaceExtension(filePath: string, newExt: string): string {
  const dotIndex = filePath.lastIndexOf('.');
  const base = dotIndex !== -1 ? filePath.slice(0, dotIndex) : filePath;
  return `${base}.${newExt}`;
}

/**
 * Recursively walk a directory and collect all supported image files.
 * Returns paths relative to the given root so that directory structure
 * can be replicated in the output.
 */
export function scanDirectory(rootDir: string): FileEntry[] {
  const entries: FileEntry[] = [];

  function walk(dir: string): void {
    const items = fs.readdirSync(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile() && isSupportedImage(item.name)) {
        const relativePath = path.relative(rootDir, fullPath);
        entries.push({ inputPath: fullPath, relativePath });
      }
    }
  }

  walk(rootDir);
  return entries;
}
