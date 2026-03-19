export type OutputFormat = "webp" | "avif" | "both";

export interface CliOptions {
  format: OutputFormat;
  quality: number;
  lossless: boolean;
  maxWidth?: number;
  maxHeight?: number;
  out?: string;
  inPlace: boolean;
  json: boolean;
}

export interface FileEntry {
  inputPath: string;
  relativePath: string;
}

export interface ConversionResult {
  inputPath: string;
  relativePath: string;
  outputPath: string;
  outputRelativePath: string;
  originalSize: number;
  convertedSize: number;
  success: boolean;
  skipped: boolean;
  error?: string;
}

export interface ConversionSummary {
  totalFiles: number;
  successCount: number;
  failureCount: number;
  skippedCount: number;
  totalOriginalBytes: number;
  totalConvertedBytes: number;
}
