import sharp from "sharp";
import fs from "fs";
import path from "path";
import fse from "fs-extra";
import pLimit from "p-limit";
import type { FileEntry, CliOptions, ConversionResult } from "./types.js";
import { isPassthrough, replaceExtension } from "./scan.js";

function applyResize(image: sharp.Sharp, options: CliOptions): sharp.Sharp {
  if (!options.maxWidth && !options.maxHeight) return image;

  return image.resize({
    width: options.maxWidth,
    height: options.maxHeight,
    fit: "inside",
    withoutEnlargement: true,
  });
}

async function encodeToFile(
  file: FileEntry,
  format: "webp" | "avif",
  outputDir: string,
  options: CliOptions,
): Promise<ConversionResult> {
  const inputBuffer = fs.readFileSync(file.inputPath);
  const originalSize = inputBuffer.length;
  const outputRelativePath = replaceExtension(file.relativePath, format);
  const outputPath = path.join(outputDir, outputRelativePath);

  await fse.ensureDir(path.dirname(outputPath));

  let image = sharp(inputBuffer);
  image = applyResize(image, options);

  if (format === "webp") {
    await (
      options.lossless
        ? image.webp({ lossless: true })
        : image.webp({ quality: options.quality })
    ).toFile(outputPath);
  } else {
    // effort 2 (scale 0–9): ~10× faster than default 4 with negligible quality
    // loss for web use. The default effort level locks the CPU.
    await (
      options.lossless
        ? image.avif({ lossless: true, effort: 2 })
        : image.avif({ quality: options.quality, effort: 2 })
    ).toFile(outputPath);
  }

  const convertedSize = fs.statSync(outputPath).size;

  return {
    inputPath: file.inputPath,
    relativePath: file.relativePath,
    outputPath,
    outputRelativePath,
    originalSize,
    convertedSize,
    success: true,
    skipped: false,
  };
}

async function passthroughFile(
  file: FileEntry,
  outputDir: string,
): Promise<ConversionResult> {
  const outputPath = path.join(outputDir, file.relativePath);
  await fse.ensureDir(path.dirname(outputPath));
  await fse.copy(file.inputPath, outputPath);

  const size = fs.statSync(file.inputPath).size;

  return {
    inputPath: file.inputPath,
    relativePath: file.relativePath,
    outputPath,
    outputRelativePath: file.relativePath,
    originalSize: size,
    convertedSize: size,
    success: true,
    skipped: true,
  };
}

/**
 * Convert all files and write directly to outputDir.
 * Calls onProgress after each file finishes (success or failure).
 */
export async function convertFiles(
  files: FileEntry[],
  outputDir: string,
  options: CliOptions,
  onProgress: (result: ConversionResult) => void,
): Promise<ConversionResult[]> {
  // AVIF is much heavier to encode — reduce concurrency to avoid CPU saturation
  const concurrency =
    options.format === "avif" ? 3 : options.format === "both" ? 4 : 6;

  const limit = pLimit(concurrency);
  const allResults: ConversionResult[] = [];

  const tasks = files.flatMap((file) => {
    if (isPassthrough(file.inputPath)) {
      return [
        limit(async () => {
          const result = await passthroughFile(file, outputDir);
          allResults.push(result);
          onProgress(result);
        }),
      ];
    }

    const formats: Array<"webp" | "avif"> =
      options.format === "both" ? ["webp", "avif"] : [options.format];

    return formats.map((fmt) =>
      limit(async () => {
        let result: ConversionResult;
        try {
          result = await encodeToFile(file, fmt, outputDir, options);
        } catch (err) {
          const stat = (() => {
            try {
              return fs.statSync(file.inputPath);
            } catch {
              return null;
            }
          })();

          result = {
            inputPath: file.inputPath,
            relativePath: file.relativePath,
            outputPath: "",
            outputRelativePath: replaceExtension(file.relativePath, fmt),
            originalSize: stat?.size ?? 0,
            convertedSize: 0,
            success: false,
            skipped: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }

        allResults.push(result);
        onProgress(result);
      }),
    );
  });

  await Promise.all(tasks);
  return allResults;
}
