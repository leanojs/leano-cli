# Leano

> Batch convert images to WebP/AVIF — fully local, no server, no API calls.

Docs and web app: [leano.dev](https://leano.dev)

```
npx leano ./public --format webp --quality 80 --max-width 1920
```

Recursively scans a directory, converts every `.jpg`, `.jpeg`, `.png` to WebP
and/or AVIF using [sharp](https://sharp.pixelplumbing.com/), preserves the full
folder structure, and reports per-file savings.

---

## Install

```bash
npm install -g leano
# or run without installing:
npx leano <input> [options]
```

---

## Usage

```
leano <input> [options]

Arguments:
  input                   Directory of images to convert

Options:
  -f, --format <format>   Output format: webp | avif | both  (default: webp)
  -q, --quality <number>  Compression quality 1–100          (default: 80)
  --lossless              Lossless compression
  --max-width  <px>       Maximum output width  (no upscaling)
  --max-height <px>       Maximum output height (no upscaling)
  -o, --out <path>        Output directory      (default: <input>-optimized)
  --in-place              Replace source directory safely via temp dir
  --json                  Output structured JSON results to stdout
  -h, --help              Show help
  -V, --version           Show version
```

---

## Examples

```bash
# WebP at quality 80 (default)
leano ./images

# Both WebP + AVIF
leano ./images --format both --quality 75

# Resize + convert
leano ./public/photos --format webp --max-width 1920 --quality 85

# Lossless WebP
leano ./assets --format webp --lossless

# Custom output directory
leano ./src/images --format avif --out ./dist/images

# Overwrite source in-place (safe: uses temp dir, rolls back on failure)
leano ./public --format webp --in-place
```

---

## Output

```
leano v1.0.2
  Input:   /home/user/project/public/images
  Output:  /home/user/project/public/images-optimized
  Format:  both  Quality: 80
  Files:   42 images found → 84 outputs

File                                        Original    Converted     Savings
─────────────────────────────────────────────────────────────────────────────
  hero.webp                                     1.2 MB       149 KB         88%
  hero.avif                                     1.2 MB       218 KB         82%
  icons/logo.webp                                45 KB        12 KB         73%
  icons/logo.avif                                45 KB         9 KB         80%
  ...
─────────────────────────────────────────────────────────────────────────────

✔ 84 files converted
✔ 56.2 MB → 9.1 MB (84% saved)

Output: /home/user/project/public/images-optimized
```

---

## Behavior

| Extension        | Action                         |
|------------------|-------------------------------|
| `.jpg` / `.jpeg` | Re-encoded via sharp           |
| `.png`           | Re-encoded via sharp           |
| `.webp` / `.avif`| Copied as-is (no re-encoding)  |

### `--in-place` safety

1. All files are written to a temporary directory first.
2. **Only if every conversion succeeds**, the source directory is replaced atomically.
3. On any failure the source is left completely untouched and the temp dir is cleaned up.

### Exit codes

| Code | Meaning                  |
|------|--------------------------|
| `0`  | All files processed OK   |
| `1`  | One or more files failed |

---

## Project structure

```
src/
  index.ts    Entry point & orchestration
  cli.ts      Argument parsing (commander)
  scan.ts     Recursive directory traversal
  convert.ts  sharp encoding logic + p-limit concurrency
  writer.ts   Output & in-place replacement logic
  logger.ts   Table, summary, formatting helpers
  types.ts    Shared TypeScript types
```

---

## Requirements

- Node.js ≥ 18
- Runs on Linux, macOS, Windows (sharp ships pre-built binaries)
