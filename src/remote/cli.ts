import { Command } from "commander";
import chalk from "chalk";
import sharp from "sharp";
import { getProfile, getProfilesPath, saveProfile } from "./profiles.js";
import {
  buildOperationKey,
  createJournal,
  loadJournal,
  removeJournal,
  saveJournal,
} from "./journal.js";

type JsonRecord = Record<string, unknown>;
type OutputFormat = "webp" | "avif" | "both";
type SourcePolicy = "keep" | "delete";

interface ScanItem {
  relativePath: string;
  size: number;
  mtimeMs: number;
}

interface OptimizeResult {
  input: string;
  output: string;
  originalBytes: number;
  convertedBytes: number;
  success: boolean;
  error?: string;
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ status: number; json: JsonRecord }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let payload: JsonRecord = {};
  if (text.trim().length > 0) {
    try {
      payload = JSON.parse(text) as JsonRecord;
    } catch {
      payload = { raw: text };
    }
  }
  return { status: res.status, json: payload };
}

function authHeaders(token?: string): Record<string, string> {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

function baseUrl(input: string): string {
  return input.replace(/\/+$/, "");
}

function parsePositiveInt(value: string, fieldName: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return n;
}

function replaceExtension(filePath: string, ext: string): string {
  const idx = filePath.lastIndexOf(".");
  if (idx <= 0) return `${filePath}.${ext}`;
  return `${filePath.slice(0, idx)}.${ext}`;
}

function outputPathsFor(input: string, format: OutputFormat): string[] {
  if (format === "both") {
    return [replaceExtension(input, "webp"), replaceExtension(input, "avif")];
  }
  return [replaceExtension(input, format)];
}

function archivePrefixForTarget(targetDir: string): string {
  const t = targetDir.trim().replace(/\\/g, "/");
  if (!t || t === ".") return "root_unoptimized";
  const clean = t.replace(/^\/+|\/+$/g, "");
  const parts = clean.split("/").filter(Boolean);
  const base = parts.length > 0 ? parts[parts.length - 1] : "root";
  return `${base}_unoptimized`;
}

async function fetchScanPage(
  url: string,
  token: string | undefined,
  sessionId: string,
  targetDir: string,
  offset: number,
  limit: number,
): Promise<{ total: number; hasMore: boolean; items: ScanItem[] }> {
  const scan = await fetchJson(`${url}/v1/scan`, {
    method: "POST",
    headers: {
      ...authHeaders(token),
      "content-type": "application/json",
      "x-session-id": sessionId,
    },
    body: JSON.stringify({
      targetDir,
      offset,
      limit,
    }),
  });

  if (scan.status !== 200) {
    const msg = typeof scan.json.error === "string" ? scan.json.error : "scan failed";
    throw new Error(`${msg} (status ${scan.status})`);
  }

  const items = Array.isArray(scan.json.items)
    ? (scan.json.items as ScanItem[])
    : [];
  const total = typeof scan.json.total === "number" ? scan.json.total : items.length;
  const hasMore = Boolean(scan.json.hasMore);
  return { total, hasMore, items };
}

async function fetchAllScanItems(
  url: string,
  token: string | undefined,
  sessionId: string,
  targetDir: string,
  pageSize: number,
): Promise<{ total: number; items: ScanItem[] }> {
  let offset = 0;
  let total = 0;
  const all: ScanItem[] = [];

  while (true) {
    const page = await fetchScanPage(url, token, sessionId, targetDir, offset, pageSize);
    total = page.total;
    all.push(...page.items);
    if (!page.hasMore || page.items.length === 0) break;
    offset += page.items.length;
  }

  return { total, items: all };
}

async function readRemoteFile(
  url: string,
  token: string | undefined,
  sessionId: string,
  relativePath: string,
): Promise<Buffer> {
  const reqUrl = `${url}/v1/file/read?path=${encodeURIComponent(relativePath)}`;
  const res = await fetch(reqUrl, {
    method: "GET",
    headers: {
      ...authHeaders(token),
      "x-session-id": sessionId,
    },
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`read failed (${res.status}) ${msg}`.trim());
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function writeRemoteFile(
  url: string,
  token: string | undefined,
  sessionId: string,
  relativePath: string,
  payload: Buffer,
): Promise<void> {
  const reqUrl = `${url}/v1/file/write?path=${encodeURIComponent(relativePath)}&mode=replace`;
  const res = await fetch(reqUrl, {
    method: "PUT",
    headers: {
      ...authHeaders(token),
      "x-session-id": sessionId,
      "content-type": "application/octet-stream",
      "content-length": String(payload.length),
    },
    body: payload,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`write failed (${res.status}) ${msg}`.trim());
  }
}

async function deleteRemoteFile(
  url: string,
  token: string | undefined,
  sessionId: string,
  relativePath: string,
): Promise<void> {
  const reqUrl = `${url}/v1/file/delete?path=${encodeURIComponent(relativePath)}`;
  const res = await fetch(reqUrl, {
    method: "DELETE",
    headers: {
      ...authHeaders(token),
      "x-session-id": sessionId,
    },
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`delete failed (${res.status}) ${msg}`.trim());
  }
}

async function moveRemoteFile(
  url: string,
  token: string | undefined,
  sessionId: string,
  fromPath: string,
  toPath: string,
): Promise<void> {
  const reqUrl = `${url}/v1/file/move`;
  const res = await fetch(reqUrl, {
    method: "POST",
    headers: {
      ...authHeaders(token),
      "x-session-id": sessionId,
      "content-type": "application/json",
    },
    body: JSON.stringify({ fromPath, toPath }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`move failed (${res.status}) ${msg}`.trim());
  }
}

async function encodeBuffer(
  input: Buffer,
  format: "webp" | "avif",
  quality: number,
  lossless: boolean,
  maxWidth?: number,
  maxHeight?: number,
): Promise<Buffer> {
  let image = sharp(input, { failOn: "none" });
  if (maxWidth || maxHeight) {
    image = image.resize({
      width: maxWidth,
      height: maxHeight,
      fit: "inside",
      withoutEnlargement: true,
    });
  }
  if (format === "webp") {
    image = lossless ? image.webp({ lossless: true }) : image.webp({ quality });
  } else {
    image = lossless
      ? image.avif({ lossless: true, effort: 2 })
      : image.avif({ quality, effort: 2 });
  }
  return image.toBuffer();
}

async function runWithConcurrency(
  items: ScanItem[],
  concurrency: number,
  worker: (item: ScanItem) => Promise<void>,
): Promise<void> {
  const active = new Set<Promise<void>>();
  for (const item of items) {
    const p = worker(item).finally(() => active.delete(p));
    active.add(p);
    if (active.size >= concurrency) {
      await Promise.race([...active]);
    }
  }
  await Promise.all([...active]);
}

export async function runRemoteCli(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("leano remote")
    .description("Connect to and scan a leano-agent")
    .showHelpAfterError();

  program
    .command("connect")
    .requiredOption("--name <name>", "Profile name (saved locally)")
    .requiredOption("--url <url>", "Agent base URL, e.g. http://127.0.0.1:4310")
    .option("--token <token>", "Agent auth token")
    .action(async (opts: { name: string; url: string; token?: string }) => {
      const url = baseUrl(opts.url);
      const { status, json } = await fetchJson(`${url}/v1/health`, {
        method: "GET",
        headers: authHeaders(opts.token),
      });

      if (status !== 200) {
        const msg = typeof json.error === "string" ? json.error : "health check failed";
        console.error(chalk.red(`✖ Cannot connect: ${msg} (status ${status})`));
        process.exit(1);
      }

      saveProfile({
        name: opts.name,
        url,
        token: opts.token,
      });

      console.error(chalk.green("✔ Connected and profile saved"));
      console.error(chalk.dim(`  Profile: ${opts.name}`));
      console.error(chalk.dim(`  URL:     ${url}`));
      console.error(chalk.dim(`  Store:   ${getProfilesPath()}`));
    });

  program
    .command("scan")
    .requiredOption("--profile <name>", "Saved profile name")
    .option("--target-dir <path>", "Relative target dir under agent root", ".")
    .option("--offset <n>", "Pagination offset", "0")
    .option("--limit <n>", "Pagination limit", "1000")
    .option("--json", "Print raw JSON to stdout", false)
    .action(async (opts: {
      profile: string;
      targetDir: string;
      offset: string;
      limit: string;
      json: boolean;
    }) => {
      const profile = getProfile(opts.profile);
      if (!profile) {
        console.error(chalk.red(`✖ Unknown profile "${opts.profile}"`));
        process.exit(1);
      }

      const url = baseUrl(profile.url);
      const open = await fetchJson(`${url}/v1/session/open`, {
        method: "POST",
        headers: {
          ...authHeaders(profile.token),
          "content-type": "application/json",
        },
        body: "{}",
      });
      if (open.status !== 200 || typeof open.json.sessionId !== "string") {
        const msg = typeof open.json.error === "string" ? open.json.error : "cannot open session";
        console.error(chalk.red(`✖ ${msg} (status ${open.status})`));
        process.exit(1);
      }
      const sessionId = open.json.sessionId;

      try {
        const scan = await fetchJson(`${url}/v1/scan`, {
          method: "POST",
          headers: {
            ...authHeaders(profile.token),
            "content-type": "application/json",
            "x-session-id": sessionId,
          },
          body: JSON.stringify({
            targetDir: opts.targetDir,
            offset: Number.parseInt(opts.offset, 10) || 0,
            limit: Number.parseInt(opts.limit, 10) || 1000,
          }),
        });

        if (scan.status !== 200) {
          const msg = typeof scan.json.error === "string" ? scan.json.error : "scan failed";
          console.error(chalk.red(`✖ ${msg} (status ${scan.status})`));
          process.exit(1);
        }

        if (opts.json) {
          process.stdout.write(JSON.stringify(scan.json) + "\n");
          return;
        }

        const total = typeof scan.json.total === "number" ? scan.json.total : 0;
        const hasMore = Boolean(scan.json.hasMore);
        const items = Array.isArray(scan.json.items)
          ? (scan.json.items as Array<{ relativePath?: string; size?: number }>)
          : [];

        console.error(chalk.green("✔ Scan complete"));
        console.error(chalk.dim(`  Profile: ${opts.profile}`));
        console.error(chalk.dim(`  Target:  ${opts.targetDir}`));
        console.error(chalk.dim(`  Total:   ${total}`));
        console.error(chalk.dim(`  Page:    ${items.length} item(s)`));
        if (hasMore) console.error(chalk.dim("  More:    yes (use offset/limit)"));

        const preview = items.slice(0, 20);
        for (const item of preview) {
          const p = item.relativePath ?? "?";
          const s = typeof item.size === "number" ? `${item.size} B` : "?";
          console.error(`  ${p}  ${chalk.dim(s)}`);
        }
        if (items.length > preview.length) {
          console.error(chalk.dim(`  … and ${items.length - preview.length} more`));
        }
      } finally {
        await fetchJson(`${url}/v1/session/close`, {
          method: "POST",
          headers: {
            ...authHeaders(profile.token),
            "content-type": "application/json",
          },
          body: JSON.stringify({ sessionId }),
        }).catch(() => undefined);
      }
    });

  program
    .command("optimize")
    .requiredOption("--profile <name>", "Saved profile name")
    .option("--target-dir <path>", "Relative target dir under agent root", ".")
    .option("-f, --format <format>", "Output format: webp, avif, both", "webp")
    .option("-q, --quality <n>", "Compression quality 1-100", "80")
    .option("--lossless", "Use lossless encoding", false)
    .option("--max-width <n>", "Maximum output width (no upscaling)")
    .option("--max-height <n>", "Maximum output height (no upscaling)")
    .option("-c, --concurrency <n>", "Parallel file jobs", "4")
    .option(
      "--source-policy <mode>",
      "Source handling: keep original file, or delete after successful optimize (keep|delete)",
      "keep",
    )
    .option("--dry-run", "Preview outputs without reading/writing files", false)
    .option("--quiet", "Suppress per-file lines", false)
    .option("--json", "Write structured JSON output to stdout", false)
    .option("--resume", "Resume from persisted journal state", false)
    .option("--reset-journal", "Discard previous journal before optimize", false)
    .action(async (opts: {
      profile: string;
      targetDir: string;
      format: string;
      quality: string;
      lossless: boolean;
      maxWidth?: string;
      maxHeight?: string;
      concurrency: string;
      sourcePolicy: string;
      dryRun: boolean;
      quiet: boolean;
      json: boolean;
      resume: boolean;
      resetJournal: boolean;
    }) => {
      const profile = getProfile(opts.profile);
      if (!profile) {
        console.error(chalk.red(`✖ Unknown profile "${opts.profile}"`));
        process.exit(1);
      }

      const format = opts.format as OutputFormat;
      if (!["webp", "avif", "both"].includes(format)) {
        console.error(chalk.red(`✖ Invalid --format "${opts.format}"`));
        process.exit(1);
      }
      const quality = Number.parseInt(opts.quality, 10);
      if (!Number.isFinite(quality) || quality < 1 || quality > 100) {
        console.error(chalk.red(`✖ Invalid --quality "${opts.quality}"`));
        process.exit(1);
      }
      const concurrency = parsePositiveInt(opts.concurrency, "concurrency");
      const sourcePolicy = opts.sourcePolicy as SourcePolicy;
      if (!["keep", "delete"].includes(sourcePolicy)) {
        console.error(chalk.red(`✖ Invalid --source-policy "${opts.sourcePolicy}" (use keep|delete)`));
        process.exit(1);
      }
      const maxWidth = opts.maxWidth ? parsePositiveInt(opts.maxWidth, "max-width") : undefined;
      const maxHeight = opts.maxHeight ? parsePositiveInt(opts.maxHeight, "max-height") : undefined;
      const operationKey = buildOperationKey(
        JSON.stringify({
          profile: opts.profile,
          targetDir: opts.targetDir,
          format,
          quality,
          lossless: opts.lossless,
          sourcePolicy,
          maxWidth: maxWidth ?? null,
          maxHeight: maxHeight ?? null,
        }),
      );
      if (opts.resetJournal) {
        removeJournal(opts.profile, operationKey);
      }
      const journal = opts.resume
        ? (loadJournal(opts.profile, operationKey) ?? createJournal(operationKey))
        : createJournal(operationKey);
      const completedSet = new Set(journal.completedOutputs);
      const failedSet = new Set(journal.failedInputs);

      const url = baseUrl(profile.url);
      const open = await fetchJson(`${url}/v1/session/open`, {
        method: "POST",
        headers: {
          ...authHeaders(profile.token),
          "content-type": "application/json",
        },
        body: "{}",
      });
      if (open.status !== 200 || typeof open.json.sessionId !== "string") {
        const msg = typeof open.json.error === "string" ? open.json.error : "cannot open session";
        console.error(chalk.red(`✖ ${msg} (status ${open.status})`));
        process.exit(1);
      }
      const sessionId = open.json.sessionId;

      try {
        const scanned = await fetchAllScanItems(url, profile.token, sessionId, opts.targetDir, 1000);
        const items = scanned.items;

        if (opts.dryRun) {
          const planned = items.flatMap((item) => outputPathsFor(item.relativePath, format));
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({
                dryRun: true,
                totalInputs: items.length,
                totalPlannedOutputs: planned.length,
                outputs: planned,
                sourcePolicy,
              }) + "\n",
            );
            return;
          }
          console.error(chalk.yellow("Dry run - no files written"));
          console.error(chalk.dim(`  Inputs:  ${items.length}`));
          console.error(chalk.dim(`  Outputs: ${planned.length}`));
          console.error(chalk.dim(`  Source policy: ${sourcePolicy}`));
          for (const p of planned.slice(0, 30)) console.error(`  ${p}`);
          if (planned.length > 30) {
            console.error(chalk.dim(`  ... and ${planned.length - 30} more`));
          }
          return;
        }

        const resumableItems = opts.resume
          ? items.filter((item) => {
              const outputs = outputPathsFor(item.relativePath, format);
              return outputs.some((out) => !completedSet.has(out));
            })
          : items;

        if (!opts.quiet) {
          console.error(chalk.dim(`Optimizing ${resumableItems.length} file(s) with ${concurrency} workers...`));
          if (opts.resume) {
            const skipped = items.length - resumableItems.length;
            console.error(chalk.dim(`Resume enabled: skipping ${skipped} already-completed input(s)`));
          }
        }

        let totalOriginalBytes = 0;
        let totalConvertedBytes = 0;
        const results: OptimizeResult[] = [];
        const startedAt = Date.now();

        await runWithConcurrency(resumableItems, concurrency, async (item) => {
          try {
            const src = await readRemoteFile(url, profile.token, sessionId, item.relativePath);
            totalOriginalBytes += src.length;

            const formats: Array<"webp" | "avif"> =
              format === "both" ? ["webp", "avif"] : [format];

            let itemSucceeded = true;
            for (const fmt of formats) {
              const outPath = replaceExtension(item.relativePath, fmt);
              if (opts.resume && completedSet.has(outPath)) {
                continue;
              }
              const out = await encodeBuffer(
                src,
                fmt,
                quality,
                opts.lossless,
                maxWidth,
                maxHeight,
              );
              totalConvertedBytes += out.length;
              await writeRemoteFile(url, profile.token, sessionId, outPath, out);
              const row: OptimizeResult = {
                input: item.relativePath,
                output: outPath,
                originalBytes: src.length,
                convertedBytes: out.length,
                success: true,
              };
              results.push(row);
              completedSet.add(outPath);
              journal.completedOutputs = [...completedSet];
              saveJournal(opts.profile, journal);
              if (!opts.quiet) {
                console.error(`  ${item.relativePath} -> ${outPath}`);
              }
            }

            if (itemSucceeded) {
              if (sourcePolicy === "delete") {
                await deleteRemoteFile(url, profile.token, sessionId, item.relativePath);
                if (!opts.quiet) {
                  console.error(chalk.dim(`  deleted source: ${item.relativePath}`));
                }
              } else {
                const archivePrefix = archivePrefixForTarget(opts.targetDir);
                const archivePath = `${archivePrefix}/${item.relativePath}`;
                await moveRemoteFile(url, profile.token, sessionId, item.relativePath, archivePath);
                if (!opts.quiet) {
                  console.error(chalk.dim(`  moved source: ${item.relativePath} -> ${archivePath}`));
                }
              }
            }
          } catch (err) {
            const row: OptimizeResult = {
              input: item.relativePath,
              output: outputPathsFor(item.relativePath, format).join(","),
              originalBytes: item.size,
              convertedBytes: 0,
              success: false,
              error: err instanceof Error ? err.message : String(err),
            };
            results.push(row);
            failedSet.add(item.relativePath);
            journal.failedInputs = [...failedSet];
            saveJournal(opts.profile, journal);
            if (!opts.quiet) {
              console.error(chalk.red(`  failed: ${item.relativePath} (${row.error})`));
            }
          }
        });

        const successCount = results.filter((r) => r.success).length;
        const failureCount = results.length - successCount;
        const elapsedMs = Date.now() - startedAt;
        const resumedSkippedInputs = items.length - resumableItems.length;
        const throughputBytesPerSec =
          elapsedMs > 0 ? Math.round((totalConvertedBytes / elapsedMs) * 1000) : 0;
        const payload = {
          totalInputs: items.length,
          resumedSkippedInputs,
          processedInputs: resumableItems.length,
          totalOutputs: results.length,
          successCount,
          failureCount,
          totalOriginalBytes,
          totalConvertedBytes,
          elapsedMs,
          throughputBytesPerSec,
          sourcePolicy,
          journal: {
            operationKey,
            path: saveJournal(opts.profile, journal),
          },
          results,
        };

        if (opts.json) {
          process.stdout.write(JSON.stringify(payload) + "\n");
        } else {
          console.error();
          console.error(chalk.green(`✔ Completed remote optimize (${successCount} outputs)`));
          if (failureCount > 0) {
            console.error(chalk.red(`✖ Failures: ${failureCount}`));
          }
          console.error(chalk.dim(`  Inputs skipped via resume: ${resumedSkippedInputs}`));
          console.error(chalk.dim(`  Original bytes:  ${totalOriginalBytes}`));
          console.error(chalk.dim(`  Converted bytes: ${totalConvertedBytes}`));
          console.error(chalk.dim(`  Elapsed:         ${elapsedMs} ms`));
          console.error(chalk.dim(`  Throughput:      ${throughputBytesPerSec} B/s`));
          console.error(chalk.dim(`  Journal key:     ${operationKey}`));
        }

        process.exit(failureCount > 0 ? 1 : 0);
      } finally {
        await fetchJson(`${url}/v1/session/close`, {
          method: "POST",
          headers: {
            ...authHeaders(profile.token),
            "content-type": "application/json",
          },
          body: JSON.stringify({ sessionId }),
        }).catch(() => undefined);
      }
    });

  await program.parseAsync(argv);
}
