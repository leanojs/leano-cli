#!/usr/bin/env node
import fs from 'fs';
import ora from 'ora';
import chalk from 'chalk';
import { parseArgs } from './cli.js';
import {
  scanDirectory,
  fromArray,
  isConvertible,
  replaceExtension,
} from './scan.js';
import { writeOutput } from './writer.js';
import { resolveConcurrency } from './convert.js';
import {
  printTableHeader,
  printResultRow,
  buildSummary,
  printSummary,
  progressText,
} from './logger.js';
import type { ConversionResult } from './types.js';

// All human-readable output goes to stderr so stdout is clean for --json.
const log = (...args: Parameters<typeof console.error>) => console.error(...args);

async function main(): Promise<void> {
  const { inputDir, options } = parseArgs(process.argv);

  // ── Validate input ────────────────────────────────────────────────────────
  if (!fs.existsSync(inputDir)) {
    log(chalk.red(`✖ Input directory not found: ${inputDir}`));
    process.exit(1);
  }

  const stat = fs.statSync(inputDir);
  if (!stat.isDirectory()) {
    log(chalk.red(`✖ Input path is not a directory: ${inputDir}`));
    process.exit(1);
  }

  // ── Scan (sync, fast — directory metadata only, no image reads) ───────────
  const spinner = ora({ text: 'Scanning for images…', stream: process.stderr }).start();
  const files = scanDirectory(inputDir);
  spinner.stop();

  if (files.length === 0) {
    log(chalk.yellow('⚠ No files found in: ') + inputDir);
    process.exit(0);
  }

  const convertibleCount = files.filter(f => isConvertible(f.inputPath)).length;
  const passthroughCount = files.length - convertibleCount;

  const totalOutputs = files.reduce((sum, f) => {
    return sum + (isConvertible(f.inputPath) && options.format === 'both' ? 2 : 1);
  }, 0);

  const outputDir = options.inPlace
    ? inputDir
    : (options.out ?? `${inputDir}-optimized`);

  const jobSlots = resolveConcurrency(options);

  // ── Header ────────────────────────────────────────────────────────────────
  log();
  log(chalk.bold('webpocalypse') + chalk.dim(` v${getVersion()}`));
  log(chalk.dim('  Input:   ') + inputDir);
  log(
    chalk.dim('  Output:  ') +
      (options.inPlace ? chalk.yellow(outputDir + ' (in-place)') : outputDir),
  );
  log(
    chalk.dim('  Format:  ') +
      options.format +
      chalk.dim('  Quality: ') +
      (options.lossless ? 'lossless' : String(options.quality)) +
      (options.maxWidth ? chalk.dim('  Max-W: ') + options.maxWidth : '') +
      (options.maxHeight ? chalk.dim('  Max-H: ') + options.maxHeight : '') +
      chalk.dim('  Jobs: ') +
      jobSlots +
      (options.concurrency === undefined ? chalk.dim(' (auto)') : ''),
  );

  const filesSummary =
    passthroughCount > 0
      ? `${convertibleCount} image${convertibleCount !== 1 ? 's' : ''} to convert, ${passthroughCount} asset${passthroughCount !== 1 ? 's' : ''} copied as-is`
      : `${convertibleCount} image${convertibleCount !== 1 ? 's' : ''} to convert`;

  log(chalk.dim(`  Files:   ${filesSummary} → ${totalOutputs} output${totalOutputs !== 1 ? 's' : ''}`));

  // ── Dry run ───────────────────────────────────────────────────────────────
  if (options.dryRun) {
    log();
    log(chalk.yellow('  Dry run — nothing will be written.'));
    log();

    const PREVIEW_LIMIT = 20;
    const plannedOutputs: string[] = [];

    for (const file of files) {
      if (isConvertible(file.inputPath)) {
        const fmts = options.format === 'both' ? ['webp', 'avif'] : [options.format];
        for (const fmt of fmts) {
          plannedOutputs.push(replaceExtension(file.relativePath, fmt));
        }
      } else {
        plannedOutputs.push(file.relativePath + chalk.dim(' (copy)'));
      }
    }

    const preview = plannedOutputs.slice(0, PREVIEW_LIMIT);
    for (const p of preview) {
      log(chalk.dim('    ') + p);
    }
    if (plannedOutputs.length > PREVIEW_LIMIT) {
      log(chalk.dim(`    … and ${plannedOutputs.length - PREVIEW_LIMIT} more`));
    }

    log();
    process.exit(0);
  }

  // ── Convert ───────────────────────────────────────────────────────────────
  if (!options.quiet) {
    printTableHeader();
  }

  // Huge batches: printing one stderr row per completion blocks the event loop
  // and *feels* sequential even when encodes run in parallel. Sample rows.
  const rowStride =
    options.quiet
      ? 0
      : totalOutputs > 8000
        ? 250
        : totalOutputs > 3000
          ? 100
          : totalOutputs > 800
            ? 25
            : 1;

  if (!options.quiet && rowStride > 1) {
    log(
      chalk.dim(
        `  (Sampling 1 row every ${rowStride} outputs; failures always shown. ` +
          'Use --quiet for spinner-only.)',
      ),
    );
    log();
  }

  let doneCount = 0;
  const isTTY = Boolean(process.stderr.isTTY);

  // Spinner only in interactive terminals; suppressed in CI/pipe or --quiet.
  const progressSpinner =
    isTTY && !options.quiet
      ? ora({ text: progressText(0, totalOutputs, ''), stream: process.stderr }).start()
      : null;

  function onProgress(result: ConversionResult): void {
    doneCount++;

    if (progressSpinner) {
      progressSpinner.clear();
    }

    if (!options.quiet) {
      const sample =
        rowStride <= 1 ||
        !result.success ||
        doneCount === 1 ||
        doneCount === totalOutputs ||
        doneCount % rowStride === 0;
      if (sample) {
        printResultRow(result);
      }
    }

    if (progressSpinner && doneCount < totalOutputs) {
      progressSpinner.text = progressText(doneCount, totalOutputs, result.outputRelativePath);
      progressSpinner.render();
    }
  }

  try {
    // `fromArray` lifts the pre-scanned list into an AsyncIterable so
    // convertFiles can use the pool pattern without re-scanning the directory.
    const { results, outputDir: finalOutputDir } = await writeOutput(
      inputDir,
      fromArray(files),
      options,
      onProgress,
    );

    progressSpinner?.stop();

    results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    const summary = buildSummary(results);
    printSummary(summary, finalOutputDir);

    if (options.json) {
      // Each output is identified by both its input and output relative paths.
      // With --format both, two entries share the same `input` but differ in
      // `output` (e.g. hero.webp vs hero.avif).
      const jsonOutput = {
        files: results
          .filter((r) => r.success && !r.skipped)
          .map((r) => ({
            input: r.relativePath,
            output: r.outputRelativePath,
            originalBytes: r.originalSize,
            convertedBytes: r.convertedSize,
          })),
        totalOriginalBytes: summary.totalOriginalBytes,
        totalConvertedBytes: summary.totalConvertedBytes,
      };
      process.stdout.write(JSON.stringify(jsonOutput) + '\n');
    }

    process.exit(summary.failureCount > 0 ? 1 : 0);
  } catch (err) {
    progressSpinner?.stop();
    console.error();
    console.error(
      chalk.red('✖ Fatal error: ') +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exit(1);
  }
}

function getVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '?';
  }
}

main();
