// 开发模式：esbuild 监听前端 + node --watch 运行服务端
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { buildOptions, writeIndex } from './build.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<void> {
  await writeIndex('dev');
  const ctx = await esbuild.context(buildOptions(true));
  await ctx.watch();
  console.log('前端监听中（改完刷新浏览器即可）');
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--watch-path=server', '--watch-path=shared', path.join(root, 'server', 'index.ts')], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  const quit = () => { server.kill(); ctx.dispose().finally(() => process.exit(0)); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  server.on('exit', (code) => { if (code) console.error(`服务端退出：${code}`); });
}

main().catch((e) => { console.error(e); process.exit(1); });
