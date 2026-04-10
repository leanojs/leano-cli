import fs from "fs";
import path from "path";

export function assertInsideRoot(targetPath: string, rootDir: string): string {
  const resolvedRoot = fs.realpathSync(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Access denied: "${targetPath}" escapes configured root "${resolvedRoot}"`,
    );
  }

  return resolvedTarget;
}
