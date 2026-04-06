import path from 'path';
import os from 'os';
import fse from 'fs-extra';
import type { CliOptions, ConversionResult, FileEntry } from './types.js';
import { convertFiles } from './convert.js';

export function resolveOutputDir(inputDir: string, options: CliOptions): string {
  if (options.out) return options.out;
  if (options.inPlace) return '';
  return `${inputDir}-optimized`;
}

/**
 * Run conversion and write output.
 *
 * Accepts an AsyncIterable<FileEntry> so callers can pass either a streaming
 * async generator (walkAsync) or a pre-collected array lifted with fromArray —
 * no second directory scan is needed.
 *
 * For --in-place:
 *   1. Write everything to a temp directory.
 *   2. Only if ALL conversions succeed, atomically replace the source directory.
 *   3. On any failure, source is left untouched and temp is cleaned up.
 */
export async function writeOutput(
  inputDir: string,
  files: AsyncIterable<FileEntry>,
  options: CliOptions,
  onProgress: (result: ConversionResult) => void,
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
  files: AsyncIterable<FileEntry>,
  options: CliOptions,
  onProgress: (result: ConversionResult) => void,
): Promise<{ results: ConversionResult[]; outputDir: string }> {
  const tempDir = path.join(
    os.tmpdir(),
    `webpocalypse-${process.pid}-${Date.now()}`,
  );

  try {
    await fse.ensureDir(tempDir);
    const results = await convertFiles(files, tempDir, options, onProgress);

    const hasFailures = results.some((r) => !r.success);
    if (hasFailures) {
      await fse.remove(tempDir);
      return { results, outputDir: inputDir };
    }

    // All succeeded — replace source directory atomically.
    const backupDir = `${inputDir}.bak-${Date.now()}`;
    await fse.move(inputDir, backupDir);

    try {
      await fse.move(tempDir, inputDir);
      await fse.remove(backupDir);
    } catch (moveErr) {
      // Move to final location failed; restore from backup.
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
