import fs from "fs";
import path from "path";
import { assertInsideRoot } from "./pathGuard.js";

export interface ScanItem {
  relativePath: string;
  size: number;
  mtimeMs: number;
}

const DEFAULT_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);
const ARCHIVE_SUFFIX = "_unoptimized";

function normalizeExtensions(exts?: string[]): Set<string> {
  if (!exts || exts.length === 0) return DEFAULT_EXTENSIONS;
  const normalized = exts
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0)
    .map((e) => (e.startsWith(".") ? e : `.${e}`));
  return new Set(normalized.length > 0 ? normalized : [...DEFAULT_EXTENSIONS]);
}

export function scanFiles(
  rootDir: string,
  targetRelativeDir: string,
  extensions?: string[],
): ScanItem[] {
  const rootReal = fs.realpathSync(rootDir);
  const targetAbs = assertInsideRoot(path.join(rootReal, targetRelativeDir), rootReal);
  const items: ScanItem[] = [];
  const extSet = normalizeExtensions(extensions);

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Keep archived originals out of future optimize scans.
        if (entry.name.endsWith(ARCHIVE_SUFFIX) || entry.name === ".leano-tmp") {
          continue;
        }
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!extSet.has(ext)) continue;

      const stat = fs.statSync(abs);
      const relativePath = path.relative(rootReal, abs).split(path.sep).join("/");
      items.push({
        relativePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  walk(targetAbs);
  items.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return items;
}
