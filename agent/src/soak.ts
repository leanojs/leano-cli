import fs from "fs";
import path from "path";
import sharp from "sharp";

function parseCount(input: string | undefined): number {
  if (!input) return 1000;
  const n = Number.parseInt(input, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`Invalid count "${input}"`);
  }
  return n;
}

async function main(): Promise<void> {
  const outDir = path.resolve(process.argv[2] ?? "./.soak-images");
  const count = parseCount(process.argv[3]);
  fs.mkdirSync(outDir, { recursive: true });

  for (let i = 0; i < count; i++) {
    const file = path.join(outDir, `img-${String(i).padStart(6, "0")}.jpg`);
    await sharp({
      create: {
        width: 1920,
        height: 1080,
        channels: 3,
        background: {
          r: (i * 13) % 255,
          g: (i * 17) % 255,
          b: (i * 19) % 255,
        },
      },
    })
      .jpeg({ quality: 88 })
      .toFile(file);
  }

  console.error(`[soak] generated ${count} images at ${outDir}`);
  console.error(`[soak] run: AGENT_ROOT_DIR=${outDir} npm run dev:agent`);
  console.error(`[soak] then: leano remote optimize --profile <name> --target-dir . --concurrency 8 --quiet`);
}

void main();
