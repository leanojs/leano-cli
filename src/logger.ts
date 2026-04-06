import chalk from 'chalk';
import type { ConversionResult, ConversionSummary } from './types.js';

// All output goes to stderr so stdout stays clean for --json consumers.
const err = (...args: Parameters<typeof console.error>) => console.error(...args);

// ─── Formatting helpers ──────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[exp]}`;
}

function pct(original: number, converted: number): string {
  if (original === 0) return '—';
  const saved = ((original - converted) / original) * 100;
  return `${saved >= 0 ? saved.toFixed(0) : '+' + Math.abs(saved).toFixed(0)}%`;
}

function truncatePath(p: string, maxLen: number): string {
  if (p.length <= maxLen) return p.padEnd(maxLen);
  return '…' + p.slice(-(maxLen - 1));
}

// ─── Results table ───────────────────────────────────────────────────────────

const COL = {
  file: 40,
  original: 10,
  converted: 11,
  savings: 10,
};

const HEADER =
  chalk.bold(
    truncatePath('File', COL.file) + '  ' +
    'Original'.padStart(COL.original) + '  ' +
    'Converted'.padStart(COL.converted) + '  ' +
    'Savings'.padStart(COL.savings),
  );

const DIVIDER = '─'.repeat(COL.file + COL.original + COL.converted + COL.savings + 6);

export function printTableHeader(): void {
  err();
  err(HEADER);
  err(chalk.dim(DIVIDER));
}

export function printResultRow(result: ConversionResult): void {
  if (!result.success) {
    err(
      chalk.red('✖ ') +
      chalk.red(truncatePath(result.relativePath, COL.file - 2)) +
      '  ' +
      chalk.dim(`Failed: ${result.error ?? 'unknown error'}`),
    );
    return;
  }

  const displayPath = result.skipped
    ? result.relativePath + chalk.dim(' (copy)')
    : result.outputRelativePath;

  const fileCol = truncatePath(displayPath, COL.file);

  const savings = pct(result.originalSize, result.convertedSize);
  const savingsNum = result.originalSize
    ? ((result.originalSize - result.convertedSize) / result.originalSize) * 100
    : 0;

  let savingsStr: string;
  if (result.skipped) {
    savingsStr = chalk.dim('—');
  } else if (savingsNum >= 20) {
    savingsStr = chalk.green(savings.padStart(COL.savings));
  } else if (savingsNum >= 0) {
    savingsStr = chalk.yellow(savings.padStart(COL.savings));
  } else {
    savingsStr = chalk.red(savings.padStart(COL.savings));
  }

  err(
    chalk.dim('  ') +
    fileCol.padEnd(COL.file) + '  ' +
    chalk.dim(formatBytes(result.originalSize).padStart(COL.original)) + '  ' +
    chalk.cyan(formatBytes(result.convertedSize).padStart(COL.converted)) + '  ' +
    savingsStr,
  );
}

// ─── Summary ─────────────────────────────────────────────────────────────────

export function buildSummary(results: ConversionResult[]): ConversionSummary {
  let totalOriginalBytes = 0;
  let totalConvertedBytes = 0;
  let successCount = 0;
  let failureCount = 0;
  let skippedCount = 0;

  for (const r of results) {
    if (!r.success) {
      failureCount++;
      totalOriginalBytes += r.originalSize;
    } else if (r.skipped) {
      skippedCount++;
      totalOriginalBytes += r.originalSize;
      totalConvertedBytes += r.convertedSize;
    } else {
      successCount++;
      totalOriginalBytes += r.originalSize;
      totalConvertedBytes += r.convertedSize;
    }
  }

  return {
    totalFiles: results.length,
    successCount,
    failureCount,
    skippedCount,
    totalOriginalBytes,
    totalConvertedBytes,
  };
}

export function printSummary(summary: ConversionSummary, outputDir: string): void {
  err(chalk.dim(DIVIDER));
  err();

  const { successCount, failureCount, skippedCount, totalOriginalBytes, totalConvertedBytes } =
    summary;

  if (successCount > 0) {
    const savings = totalOriginalBytes > 0
      ? Math.round(((totalOriginalBytes - totalConvertedBytes) / totalOriginalBytes) * 100)
      : 0;

    err(chalk.green('✔') + ' ' + chalk.bold(`${successCount} file${successCount !== 1 ? 's' : ''} converted`));
    err(
      chalk.green('✔') + ' ' +
      `${formatBytes(totalOriginalBytes)} → ${formatBytes(totalConvertedBytes)} ` +
      chalk.bold.green(`(${savings}% saved)`),
    );
  }

  if (skippedCount > 0) {
    err(chalk.dim('·') + ' ' + chalk.dim(`${skippedCount} file${skippedCount !== 1 ? 's' : ''} copied as-is`));
  }

  if (failureCount > 0) {
    err(chalk.red('✖') + ' ' + chalk.red.bold(`${failureCount} file${failureCount !== 1 ? 's' : ''} failed`));
  }

  err();
  err(chalk.dim('Output: ') + chalk.cyan(outputDir));
  err();
}

// ─── Spinner helpers ─────────────────────────────────────────────────────────

export function progressText(done: number, total: number, currentFile: string): string {
  const pctDone = total > 0 ? Math.round((done / total) * 100) : 0;
  const truncated = currentFile.length > 40 ? '…' + currentFile.slice(-39) : currentFile;
  return `[${done}/${total}] ${pctDone}% — ${truncated}`;
}
