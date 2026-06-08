import { rmSync, existsSync } from "fs";
import { build } from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "dist");

if (existsSync(distDir)) rmSync(distDir, { recursive: true });

await build({
  entryPoints: [join(__dirname, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir: distDir,
  sourcemap: true,
  external: [
    "bcryptjs",
    "node-pty",
    "sharp",
    "ssh2",
    "fsevents",
  ],
  banner: {
    js: `
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
`.trim(),
  },
});
