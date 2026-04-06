import path from 'path';
import os from 'os';
import fse from 'fs-extra';
import type { CliOptions, ConversionResult } from './types.js';
import { convertFiles } from './convert.js';
import type { FileEntry } from './types.js';

/**
 * Determine the final output directory from CLI options.
 * - `--out <path>` wins if provided
 * - `--in-place` uses a temp dir (caller must finalize after success)
 * - Default: `<inputDir>-optimized`
 */
export function resolveOutputDir(inputDir: string, options: CliOptions): string {
  if (options.out) return options.out;
  if (options.inPlace) return ''; // placeholder; writer uses a temp dir internally
  return `${inputDir}-optimized`;
}

/**
 * Run conversion and write output.
 *
 * For --in-place:
 *   1. Write everything to a temporary directory.
 *   2. Only if ALL conversions succeed, atomically replace the source directory.
 *   3. On any failure, leave the source untouched and clean up the temp dir.
 *
 * For normal output:
 *   Write directly to the resolved output directory.
 */
export async function writeOutput(
  inputDir: string,
  files: FileEntry[],
  options: CliOptions,
  onProgress: (result: ConversionResult) => void
): Promise<{ results: ConversionResult[]; outputDir: string }> {
  if (options.inPlace) {
    return runInPlace(inputDir, files, options, onProgress);
  }

  const outputDir = resolveOutputDir(inputDir, options);
  await fse.ensureDir(outputDir);
  const results = await convertFiles(files, outputDir, options, onProgress);
  return { results, outputDir };
}

async function runInPlace(
  inputDir: string,
  files: FileEntry[],
  options: CliOptions,
  onProgress: (result: ConversionResult) => void
): Promise<{ results: ConversionResult[]; outputDir: string }> {
  const tempDir = path.join(
    os.tmpdir(),
    `leano-${process.pid}-${Date.now()}`
  );

  try {
    await fse.ensureDir(tempDir);
    const results = await convertFiles(files, tempDir, options, onProgress);

    const hasFailures = results.some((r) => !r.success);
    if (hasFailures) {
      // Leave source untouched; clean up temp
      await fse.remove(tempDir);
      return { results, outputDir: inputDir };
    }

    // All succeeded — replace source directory atomically
    const backupDir = `${inputDir}.bak-${Date.now()}`;
    await fse.move(inputDir, backupDir);

    try {
      await fse.move(tempDir, inputDir);
      await fse.remove(backupDir);
    } catch (moveErr) {
      // Restore from backup on failure
      await fse.move(backupDir, inputDir);
      await fse.remove(tempDir).catch(() => undefined);
      throw moveErr;
    }

    return { results, outputDir: inputDir };
  } catch (err) {
    await fse.remove(tempDir).catch(() => undefined);
    throw err;
  }
}
