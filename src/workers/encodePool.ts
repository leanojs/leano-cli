import path from "path";
import { Worker } from "worker_threads";
import type { ConversionResult } from "../types.js";
import { replaceExtension } from "../scan.js";
import type { EncodeWorkerJob } from "./encodeWorker.js";

type Pending = {
  resolve: (r: ConversionResult) => void;
  job: EncodeWorkerJob;
};

function failureFromJob(job: EncodeWorkerJob, message: string): ConversionResult {
  const outputRelativePath =
    job.format === "passthrough"
      ? job.relativePath
      : replaceExtension(job.relativePath, job.format);

  return {
    inputPath: job.inputPath,
    relativePath: job.relativePath,
    outputPath: "",
    outputRelativePath,
    originalSize: 0,
    convertedSize: 0,
    success: false,
    skipped: false,
    error: message,
  };
}

/**
 * Pool of Node worker threads, each running sharp in isolation. Real parallel
 * CPU work across cores (not only concurrent I/O on one event loop).
 */
export class EncodeWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly free: Worker[] = [];
  private readonly waiters: Array<(w: Worker) => void> = [];
  private readonly inflight = new Map<Worker, Pending>();
  /** Prevents duplicate replace logic when both `error` and `exit` fire. */
  private readonly retiringWorkers = new Set<Worker>();
  private readonly script: string;
  private readonly libvipsConcurrency: number;

  constructor(size: number, libvipsConcurrency: number) {
    this.script = path.join(__dirname, "encodeWorker.js");
    this.libvipsConcurrency = libvipsConcurrency;

    for (let i = 0; i < size; i++) {
      const w = this.spawnWorker();
      this.workers.push(w);
      this.free.push(w);
    }
  }

  private spawnWorker(): Worker {
    const w = new Worker(this.script, {
      workerData: { libvipsConcurrency: this.libvipsConcurrency },
    });

    w.on("message", (result: ConversionResult) => {
      // Stale `message` can arrive after `error`/`exit` (or interleaved). Never
      // `release` a worker that is retired or already removed — that recycles
      // a dead Worker into `free` / waiters and breaks `postMessage`.
      if (this.retiringWorkers.has(w) || this.workers.indexOf(w) === -1) {
        return;
      }
      const pending = this.inflight.get(w);
      if (!pending) {
        // Duplicate or stale `message` — no matching `run()` slot. Releasing
        // would put this worker in `free` again without a completed job and
        // corrupt pool accounting (double-free of the same Worker).
        return;
      }
      this.inflight.delete(w);
      pending.resolve(result);
      this.releaseIfActive(w);
    });

    w.on("error", (err: Error) => {
      const pending = this.inflight.get(w);
      if (pending) {
        this.inflight.delete(w);
        pending.resolve(failureFromJob(pending.job, err.message));
      }
      void this.replaceDeadWorker(w);
    });

    w.on("exit", (code) => {
      if (code === 0) return;
      const pending = this.inflight.get(w);
      if (pending) {
        this.inflight.delete(w);
        pending.resolve(
          failureFromJob(pending.job, `Worker stopped (exit ${code})`),
        );
      }
      void this.replaceDeadWorker(w);
    });

    return w;
  }

  /**
   * Remove a crashed / unusable worker from the pool and substitute a new one.
   * Never recycle the dead Worker — postMessage after exit throws.
   */
  private async replaceDeadWorker(w: Worker): Promise<void> {
    if (this.retiringWorkers.has(w)) return;
    this.retiringWorkers.add(w);
    try {
      const idx = this.workers.indexOf(w);
      if (idx === -1) return;

      this.workers.splice(idx, 1);
      const fi = this.free.indexOf(w);
      if (fi !== -1) this.free.splice(fi, 1);

      const stillPending = this.inflight.get(w);
      if (stillPending) {
        this.inflight.delete(w);
        stillPending.resolve(
          failureFromJob(stillPending.job, "Worker thread crashed"),
        );
      }

      await w.terminate().catch(() => undefined);

      const fresh = this.spawnWorker();
      this.workers.push(fresh);
      this.release(fresh);
    } finally {
      this.retiringWorkers.delete(w);
    }
  }

  private release(w: Worker): void {
    const next = this.waiters.shift();
    if (next) next(w);
    else this.free.push(w);
  }

  /** Only recycle workers that are still registered and not mid-retirement. */
  private releaseIfActive(w: Worker): void {
    if (this.retiringWorkers.has(w)) return;
    if (this.workers.indexOf(w) === -1) return;
    this.release(w);
  }

  run(job: EncodeWorkerJob): Promise<ConversionResult> {
    return new Promise((resolve) => {
      const start = (w: Worker) => {
        this.inflight.set(w, { resolve, job });
        try {
          w.postMessage(job);
        } catch (err) {
          this.inflight.delete(w);
          resolve(
            failureFromJob(
              job,
              err instanceof Error ? err.message : String(err),
            ),
          );
          void this.replaceDeadWorker(w);
        }
      };
      const w = this.free.pop();
      if (w) start(w);
      else this.waiters.push(start);
    });
  }

  async destroy(): Promise<void> {
    for (const [, pending] of this.inflight) {
      pending.resolve(failureFromJob(pending.job, "Worker pool shut down"));
    }
    this.inflight.clear();
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers.length = 0;
    this.free.length = 0;
    this.waiters.length = 0;
  }
}
