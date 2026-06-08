import { rmSync, existsSync, readdirSync } from "fs";
import { build } from "esbuild";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log("CWD:", process.cwd());
console.log("__dirname:", __dirname);

const outDir = join(__dirname, "dist");
console.log("Output dir:", outDir);

if (existsSync(outDir)) rmSync(outDir, { recursive: true });

await build({
  entryPoints: [join(__dirname, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir: outDir,
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

console.log("Build output:", readdirSync(outDir));
