import fs from "fs";
import path from "path";
import fse from "fs-extra";
import type http from "http";
import { assertInsideRoot } from "./pathGuard.js";

function normalizeRelativePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("path is required");
  }
  return trimmed.replace(/\\/g, "/");
}

export function resolveAgentPath(rootDir: string, relativePath: string): string {
  const rootReal = fs.realpathSync(rootDir);
  const rel = normalizeRelativePath(relativePath);
  const abs = path.join(rootReal, rel);
  return assertInsideRoot(abs, rootReal);
}

export async function streamFileToResponse(
  absolutePath: string,
  res: http.ServerResponse,
): Promise<void> {
  const stat = await fs.promises.stat(absolutePath);
  if (!stat.isFile()) {
    throw new Error("Requested path is not a file");
  }

  res.statusCode = 200;
  res.setHeader("content-type", "application/octet-stream");
  res.setHeader("content-length", stat.size);

  await new Promise<void>((resolve, reject) => {
    const src = fs.createReadStream(absolutePath);
    src.on("error", reject);
    res.on("error", reject);
    res.on("close", resolve);
    src.pipe(res);
  });
}

async function writeRequestBodyToFile(
  req: http.IncomingMessage,
  outputPath: string,
  maxBytes: number,
): Promise<number> {
  await fse.ensureDir(path.dirname(outputPath));

  const out = fs.createWriteStream(outputPath, { flags: "w" });
  let written = 0;

  await new Promise<void>((resolve, reject) => {
    let tooLarge = false;
    req.on("data", (chunk: Buffer | string) => {
      written += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (!tooLarge && written > maxBytes) {
        tooLarge = true;
        req.unpipe(out);
        out.destroy();
        reject(new Error(`Request body too large (max ${maxBytes} bytes)`));
      }
    });
    req.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    req.pipe(out);
  });

  return written;
}

export async function writeAtomicReplace(
  req: http.IncomingMessage,
  targetPath: string,
  sessionId: string,
  maxBytes: number,
): Promise<{ bytesWritten: number; outputPath: string }> {
  const tempPath = `${targetPath}.tmp.${sessionId}.${Date.now()}`;
  let bytesWritten = 0;
  try {
    bytesWritten = await writeRequestBodyToFile(req, tempPath, maxBytes);
    await fs.promises.rename(tempPath, targetPath);
    return { bytesWritten, outputPath: targetPath };
  } finally {
    await fse.remove(tempPath).catch(() => undefined);
  }
}

export async function writeToSessionTemp(
  req: http.IncomingMessage,
  rootDir: string,
  targetRelativePath: string,
  sessionId: string,
  maxBytes: number,
): Promise<{ bytesWritten: number; tempPath: string }> {
  const rootReal = fs.realpathSync(rootDir);
  const tempAbs = assertInsideRoot(
    path.join(rootReal, ".leano-tmp", sessionId, targetRelativePath),
    rootReal,
  );

  const tempPath = `${tempAbs}.part`;
  const bytesWritten = await writeRequestBodyToFile(req, tempPath, maxBytes);
  return { bytesWritten, tempPath };
}
