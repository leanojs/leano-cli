import { Command } from 'commander';
import path from 'path';
import type { CliOptions, OutputFormat } from './types.js';

const VALID_FORMATS: OutputFormat[] = ['webp', 'avif', 'both'];

export function parseArgs(argv: string[]): { inputDir: string; options: CliOptions } {
  const program = new Command();

  program
    .name('webpocalypse')
    .description('Batch convert images to WebP/AVIF with quality control and directory structure preservation')
    .version('1.0.0')
    .argument('<input>', 'Input directory containing images to convert')
    .option('-f, --format <format>', 'Output format: webp, avif, or both', 'webp')
    .option('-q, --quality <number>', 'Compression quality (50–100)', '80')
    .option('--lossless', 'Use lossless compression', false)
    .option('--max-width <number>', 'Maximum output width in pixels (no upscaling)')
    .option('--max-height <number>', 'Maximum output height in pixels (no upscaling)')
    .option('-o, --out <path>', 'Output directory (default: <input>-optimized)')
    .option('--in-place', 'Overwrite source directory safely via temp dir', false);

  program.parse(argv);

  const opts = program.opts();
  const [inputArg] = program.args;

  if (!inputArg) {
    program.error('Missing required argument: <input>');
  }

  const format = opts.format as string;
  if (!VALID_FORMATS.includes(format as OutputFormat)) {
    program.error(`Invalid format "${format}". Must be one of: ${VALID_FORMATS.join(', ')}`);
  }

  const quality = parseInt(opts.quality as string, 10);
  if (isNaN(quality) || quality < 1 || quality > 100) {
    program.error(`Invalid quality "${opts.quality}". Must be a number between 1 and 100`);
  }

  let maxWidth: number | undefined;
  if (opts.maxWidth !== undefined) {
    maxWidth = parseInt(opts.maxWidth as string, 10);
    if (isNaN(maxWidth) || maxWidth <= 0) {
      program.error(`Invalid --max-width "${opts.maxWidth}". Must be a positive integer`);
    }
  }

  let maxHeight: number | undefined;
  if (opts.maxHeight !== undefined) {
    maxHeight = parseInt(opts.maxHeight as string, 10);
    if (isNaN(maxHeight) || maxHeight <= 0) {
      program.error(`Invalid --max-height "${opts.maxHeight}". Must be a positive integer`);
    }
  }

  const inputDir = path.resolve(inputArg);

  return {
    inputDir,
    options: {
      format: format as OutputFormat,
      quality,
      lossless: opts.lossless as boolean,
      maxWidth,
      maxHeight,
      out: opts.out ? path.resolve(opts.out as string) : undefined,
      inPlace: opts.inPlace as boolean,
    },
  };
}
