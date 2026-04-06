import { parentPort, workerData } from "worker_threads";
import sharp from "sharp";
import fs from "fs";
import path from "path";
import fse from "fs-extra";
import type { ConversionResult } from "../types.js";
import { assertContained, replaceExtension } from "../scan.js";

/** Serializable job sent from main thread (structured clone). */
export interface EncodeWorkerJob {
  outputDir: string;
  inputPath: string;
  relativePath: string;
  format: "webp" | "avif" | "passthrough";
  quality: number;
  lossless: boolean;
  maxWidth?: number;
  maxHeight?: number;
}

interface WorkerInit {
  libvipsConcurrency?: number;
}

const wd = workerData as WorkerInit | undefined;
const libvipsThreads =
  typeof wd?.libvipsConcurrency === "number" && wd.libvipsConcurrency >= 1
    ? wd.libvipsConcurrency
    : 1;
sharp.concurrency(libvipsThreads);

function applyResize(image: sharp.Sharp, job: EncodeWorkerJob): sharp.Sharp {
  if (!job.maxWidth && !job.maxHeight) return image;
  return image.resize({
    width: job.maxWidth,
    height: job.maxHeight,
    fit: "inside",
    withoutEnlargement: true,
  });
}

async function encodeToFile(job: EncodeWorkerJob): Promise<ConversionResult> {
  const originalSize = (await fs.promises.stat(job.inputPath)).size;
  const outputRelativePath = replaceExtension(job.relativePath, job.format as "webp" | "avif");
  const outputPath = path.join(job.outputDir, outputRelativePath);

  assertContained(outputPath, job.outputDir);
  await fse.ensureDir(path.dirname(outputPath));

  let image = sharp(job.inputPath);
  image = applyResize(image, job);

  if (job.format === "webp") {
    await (
      job.lossless
        ? image.webp({ lossless: true })
        : image.webp({ quality: job.quality })
    ).toFile(outputPath);
  } else {
    await (
      job.lossless
        ? image.avif({ lossless: true, effort: 2 })
        : image.avif({ quality: job.quality, effort: 2 })
    ).toFile(outputPath);
  }

  const convertedSize = (await fs.promises.stat(outputPath)).size;

  return {
    inputPath: job.inputPath,
    relativePath: job.relativePath,
    outputPath,
    outputRelativePath,
    originalSize,
    convertedSize,
    success: true,
    skipped: false,
  };
}

async function passthroughFile(job: EncodeWorkerJob): Promise<ConversionResult> {
  const outputPath = path.join(job.outputDir, job.relativePath);
  assertContained(outputPath, job.outputDir);
  await fse.ensureDir(path.dirname(outputPath));
  await fse.copy(job.inputPath, outputPath);
  const size = (await fs.promises.stat(job.inputPath)).size;

  return {
    inputPath: job.inputPath,
    relativePath: job.relativePath,
    outputPath,
    outputRelativePath: job.relativePath,
    originalSize: size,
    convertedSize: size,
    success: true,
    skipped: true,
  };
}

async function run(job: EncodeWorkerJob): Promise<ConversionResult> {
  try {
    if (job.format === "passthrough") {
      return await passthroughFile(job);
    }
    return await encodeToFile(job);
  } catch (err) {
    const stat = await fs.promises.stat(job.inputPath).catch(() => null);
    const outputRelativePath =
      job.format === "passthrough"
        ? job.relativePath
        : replaceExtension(job.relativePath, job.format);

    return {
      inputPath: job.inputPath,
      relativePath: job.relativePath,
      outputPath: "",
      outputRelativePath,
      originalSize: stat?.size ?? 0,
      convertedSize: 0,
      success: false,
      skipped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

parentPort!.on("message", (job: EncodeWorkerJob) => {
  void run(job).then((result) => {
    parentPort!.postMessage(result);
  });
});
