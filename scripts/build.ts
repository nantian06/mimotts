// 前端构建：web/src/main.tsx → dist/web/assets/app.js + app.css，并生成 dist/web/index.html
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist', 'web');

export function buildOptions(dev = false): esbuild.BuildOptions {
  return {
    entryPoints: [path.join(root, 'web', 'src', 'main.tsx')],
    outdir: path.join(outDir, 'assets'),
    entryNames: 'app',
    bundle: true,
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    target: 'es2022',
    format: 'esm',
    jsx: 'automatic',
    loader: { '.svg': 'dataurl', '.woff2': 'file' },
    define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
    logLevel: 'info',
    legalComments: 'none',
  };
}

export async function writeIndex(version: string): Promise<void> {
  const src = await fs.readFile(path.join(root, 'web', 'index.html'), 'utf8');
  const html = src
    .replace('</head>', `  <link rel="stylesheet" href="/assets/app.css?v=${version}">\n</head>`)
    .replace('</body>', `  <script type="module" src="/assets/app.js?v=${version}"></script>\n</body>`);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'index.html'), html);
}

async function main(): Promise<void> {
  await fs.rm(outDir, { recursive: true, force: true });
  await esbuild.build(buildOptions(false));
  await writeIndex(Date.now().toString(36));
  const files = await fs.readdir(path.join(outDir, 'assets'));
  for (const f of files) {
    const st = await fs.stat(path.join(outDir, 'assets', f));
    console.log(`  dist/web/assets/${f}  ${(st.size / 1024).toFixed(1)} KB`);
  }
  console.log('前端构建完成：dist/web');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
