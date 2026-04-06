#!/usr/bin/env node
import fs from 'fs';
import ora from 'ora';
import chalk from 'chalk';
import { parseArgs } from './cli.js';
import { scanDirectory, isConvertible } from './scan.js';
import { writeOutput } from './writer.js';
import {
  printTableHeader,
  printResultRow,
  buildSummary,
  printSummary,
  progressText,
} from './logger.js';
import type { ConversionResult } from './types.js';

async function main(): Promise<void> {
  const { inputDir, options } = parseArgs(process.argv);

  // ── Validate input directory ──────────────────────────────────────────────
  if (!fs.existsSync(inputDir)) {
    console.error(chalk.red(`✖ Input directory not found: ${inputDir}`));
    process.exit(1);
  }

  const stat = fs.statSync(inputDir);
  if (!stat.isDirectory()) {
    console.error(chalk.red(`✖ Input path is not a directory: ${inputDir}`));
    process.exit(1);
  }

  // ── Scan ──────────────────────────────────────────────────────────────────
  const spinner = ora({ text: 'Scanning for images…', stream: process.stderr }).start();
  const files = scanDirectory(inputDir);
  spinner.stop();

  if (files.length === 0) {
    console.log(chalk.yellow('⚠ No files found in: ') + inputDir);
    process.exit(0);
  }

  const convertibleCount = files.filter(f => isConvertible(f.inputPath)).length;
  const passthroughCount = files.length - convertibleCount;

  // Convertible files produce 1 or 2 outputs (--format both); pass-throughs always 1
  const totalOutputs = files.reduce((sum, f) => {
    return sum + (isConvertible(f.inputPath) && options.format === 'both' ? 2 : 1);
  }, 0);

  const outputDir = options.inPlace
    ? inputDir
    : (options.out ?? `${inputDir}-optimized`);

  console.log();
  console.log(
    chalk.bold('leano') +
    chalk.dim(` v${getVersion()}`)
  );
  console.log(
    chalk.dim('  Input:   ') + inputDir
  );
  console.log(
    chalk.dim('  Output:  ') + (options.inPlace ? chalk.yellow(outputDir + ' (in-place)') : outputDir)
  );
  console.log(
    chalk.dim('  Format:  ') + options.format +
    chalk.dim('  Quality: ') + (options.lossless ? 'lossless' : String(options.quality)) +
    (options.maxWidth ? chalk.dim('  Max-W: ') + options.maxWidth : '') +
    (options.maxHeight ? chalk.dim('  Max-H: ') + options.maxHeight : '')
  );
  const filesSummary = passthroughCount > 0
    ? `${convertibleCount} image${convertibleCount !== 1 ? 's' : ''} to convert, ${passthroughCount} asset${passthroughCount !== 1 ? 's' : ''} copied as-is`
    : `${convertibleCount} image${convertibleCount !== 1 ? 's' : ''} to convert`;
  console.log(
    chalk.dim(`  Files:   ${filesSummary} → ${totalOutputs} output${totalOutputs !== 1 ? 's' : ''}`)
  );

  // ── Convert ───────────────────────────────────────────────────────────────
  printTableHeader();

  let doneCount = 0;
  const isTTY = Boolean(process.stderr.isTTY);

  // Only spin in interactive terminals; in CI/piped output just print rows.
  const progressSpinner = isTTY
    ? ora({ text: progressText(0, totalOutputs, ''), stream: process.stderr }).start()
    : null;

  const allResults: ConversionResult[] = [];

  function onProgress(result: ConversionResult): void {
    doneCount++;

    if (progressSpinner) {
      progressSpinner.clear();
    }

    printResultRow(result);
    allResults.push(result);

    if (progressSpinner && doneCount < totalOutputs) {
      progressSpinner.text = progressText(doneCount, totalOutputs, result.outputRelativePath);
      progressSpinner.render();
    }
  }

  try {
    const { results, outputDir: finalOutputDir } = await writeOutput(
      inputDir,
      files,
      options,
      onProgress
    );

    progressSpinner?.stop();

    // Sort results by path for a stable display order
    results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    const summary = buildSummary(results);
    printSummary(summary, finalOutputDir);

    if (options.json) {
      const jsonOutput = {
        files: results
          .filter((r) => r.success && !r.skipped)
          .map((r) => ({
            path: r.relativePath,
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
    console.error(chalk.red('✖ Fatal error: ') + (err instanceof Error ? err.message : String(err)));
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
