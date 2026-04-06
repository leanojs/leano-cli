import os from "os";
import type { FileEntry, CliOptions, ConversionResult } from "./types.js";
import { isPassthrough, replaceExtension } from "./scan.js";
import { EncodeWorkerPool } from "./workers/encodePool.js";
import type { EncodeWorkerJob } from "./workers/encodeWorker.js";

type JobFormat = "webp" | "avif" | "passthrough";

interface Job {
  file: FileEntry;
  format: JobFormat;
}

/**
 * Expand FileEntry items into one Job per output file.
 * A convertible file with --format both yields two jobs (webp + avif).
 */
async function* expandToJobs(
  files: AsyncIterable<FileEntry>,
  format: CliOptions["format"],
): AsyncGenerator<Job> {
  for await (const file of files) {
    if (isPassthrough(file.inputPath)) {
      yield { file, format: "passthrough" };
    } else if (format === "both") {
      yield { file, format: "webp" };
      yield { file, format: "avif" };
    } else {
      yield { file, format };
    }
  }
}

function toWorkerJob(job: Job, outputDir: string, options: CliOptions): EncodeWorkerJob {
  return {
    outputDir,
    inputPath: job.file.inputPath,
    relativePath: job.file.relativePath,
    format: job.format,
    quality: options.quality,
    lossless: options.lossless,
    maxWidth: options.maxWidth,
    maxHeight: options.maxHeight,
  };
}

const CPU_COUNT = Math.max(1, os.cpus().length);

/**
 * Parallel worker threads. When omitted on the CLI, scale with CPU count.
 */
export function resolveConcurrency(options: CliOptions): number {
  if (options.concurrency !== undefined) {
    return Math.max(1, options.concurrency);
  }
  if (options.format === "avif") {
    return Math.min(CPU_COUNT, 8);
  }
  if (options.format === "both") {
    return Math.min(CPU_COUNT, 12);
  }
  return Math.min(CPU_COUNT, 16);
}

/**
 * Libvips threads *per worker*. Workers run one job at a time; spread CPU
 * across workers so total ≈ core count.
 */
function libvipsThreadsPerWorker(workerCount: number): number {
  const capped = Math.min(workerCount, CPU_COUNT);
  return Math.max(1, Math.floor(CPU_COUNT / capped));
}

/**
 * Each encode/copy runs in a dedicated worker thread (separate Node isolate +
 * sharp). This uses multiple CPU cores in parallel instead of multiplexing
 * many sharp pipelines on one event loop.
 */
export async function convertFiles(
  files: AsyncIterable<FileEntry>,
  outputDir: string,
  options: CliOptions,
  onProgress: (result: ConversionResult) => void,
): Promise<ConversionResult[]> {
  const workerCount = resolveConcurrency(options);
  const libvips = libvipsThreadsPerWorker(workerCount);
  const pool = new EncodeWorkerPool(workerCount, libvips);

  const allResults: ConversionResult[] = [];
  const active = new Set<Promise<void>>();

  try {
    for await (const job of expandToJobs(files, options.format)) {
      const payload = toWorkerJob(job, outputDir, options);
      let p!: Promise<void>;
      p = pool.run(payload).then((result) => {
        allResults.push(result);
        onProgress(result);
        active.delete(p);
      });
      active.add(p);

      if (active.size >= workerCount) {
        await Promise.race([...active]);
      }
    }

    await Promise.all([...active]);
    return allResults;
  } finally {
    await pool.destroy();
  }
}
