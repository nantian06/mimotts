// 端到端测试：启动模拟上游 + 工作台（临时数据目录），用 Playwright 走一遍主要界面流程并截图到 e2e-shots/
// 用法：npm run build && npm run e2e      （HEADED=1 显示浏览器，KEEP=1 结束后保留数据目录）
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav } from '../server/audio/wav.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'e2e-shots');
const MOCK_PORT = 19000 + Math.floor(Math.random() * 400);
const APP_PORT = MOCK_PORT + 500;
const base = `http://127.0.0.1:${APP_PORT}`;
const procs: ChildProcess[] = [];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimotts-e2e-'));

function loadPlaywright(): any {
  const req = createRequire(import.meta.url);
  try { return req('playwright'); } catch { /* 项目里没装，试全局 */ }
  const globalRoot = process.env.NODE_PATH?.split(path.delimiter)[0];
  for (const dir of [globalRoot, '/opt/node-tools/node_modules', '/usr/local/lib/node_modules', '/usr/lib/node_modules'].filter(Boolean) as string[]) {
    try { return req(path.join(dir, 'playwright')); } catch { /* 下一个 */ }
  }
  throw new Error('找不到 playwright：npm i -D playwright 后再运行');
}

function startNode(file: string, env: Record<string, string>, ready: RegExp): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    let out = '';
    p.stdout!.on('data', (c: Buffer) => { out += c; if (ready.test(out)) resolve(); });
    p.stderr!.on('data', (c: Buffer) => { out += c; });
    p.on('exit', (code) => reject(new Error(`${file} 退出（${code}）：${out}`)));
    setTimeout(() => reject(new Error(`${file} 启动超时：${out}`)), 15000);
  });
}

function sampleVoice(file: string) {
  const sr = 44100;
  const n = sr * 12;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const on = (t > 0.8 && t < 4) || (t > 5.2 && t < 8.5) || (t > 9.4 && t < 11.3);
    const f = 150 + 25 * Math.sin(2 * Math.PI * 0.7 * t);
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t) / h;
    x[i] = on ? 0.08 * v * (0.55 + 0.45 * Math.sin(2 * Math.PI * 3.5 * t)) : (Math.random() - 0.5) * 0.002;
  }
  fs.writeFileSync(file, encodeWav(x, sr));
}

let step = 0;
async function check(name: string, fn: () => Promise<void>) {
  step++;
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ✓ ${step}. ${name}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  } catch (e) {
    console.log(`  ✗ ${step}. ${name}`);
    throw e;
  }
}

async function main() {
  fs.mkdirSync(shots, { recursive: true });
  if (!fs.existsSync(path.join(root, 'dist', 'web', 'index.html'))) throw new Error('请先 npm run build');
  await startNode(path.join(root, 'scripts', 'mock-upstream.ts'), { MOCK_PORT: String(MOCK_PORT), MOCK_DELAY_MS: '80' }, /on http/);
  await startNode(path.join(root, 'server', 'index.ts'), {
    PORT: String(APP_PORT), HOST: '127.0.0.1', DATA_DIR: dataDir,
    MIMO_API_KEY: 'sk-e2e-test', MIMO_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, LLM_API_KEY: 'x', LLM_MODEL: 'mock-llm', LLM_NAME: '模拟端点',
  }, /已启动/);
  const voiceFile = path.join(dataDir, 'sample-voice.wav');
  sampleVoice(voiceFile);

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: !process.env.HEADED, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'zh-CN' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m: any) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  const shot = (name: string) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });
  const T = 20000;

  console.log('端到端测试：');
  try {
    await check('打开快速合成页', async () => {
      await page.goto(`${base}/#/quick`);
      await page.getByRole('heading', { name: '快速合成' }).waitFor();
      await page.getByText('MiMo-默认').first().waitFor();
    });

    await check('预置音色流式合成，结果进入历史', async () => {
      await page.getByLabel('要合成的文本').fill('(温柔)晚上好，欢迎收听今天的节目。（轻笑）我们慢慢聊。');
      await page.getByRole('button', { name: '生成', exact: true }).click();
      await page.locator('.history-item').first().waitFor({ timeout: T });
      await page.locator('.run-state').waitFor({ state: 'detached', timeout: T });
      await shot('01-quick');
    });

    await check('设计音色：新建 → 抽卡 3 条 → 固化', async () => {
      await page.goto(`${base}/#/voices`);
      await page.getByRole('button', { name: '新建音色' }).click();
      await page.getByRole('menuitem', { name: /设计音色/ }).click();
      await page.getByPlaceholder('例如：温柔大姐姐').fill('深夜电台');
      await page.getByPlaceholder(/二十多岁的年轻女性/).fill('三十岁左右的女性，嗓音温润，语速舒缓，像深夜电台主播');
      await page.getByRole('button', { name: '创建并去抽卡' }).click();
      await page.getByRole('heading', { name: '深夜电台' }).waitFor();
      await page.getByRole('button', { name: '抽卡', exact: true }).click();
      await page.locator('.take:not(.is-pending)').nth(2).waitFor({ timeout: T });
      await page.locator('.take.is-pending').first().waitFor({ state: 'detached', timeout: T });
      await page.locator('.take').first().getByRole('button', { name: '固化' }).click();
      await page.getByText(/已固化：/).first().waitFor({ timeout: T });
      await page.locator('.take.is-fixed').waitFor();
      await shot('02-design');
    });

    await check('克隆音色：上传 → 标准化报告 → 保存', async () => {
      await page.goto(`${base}/#/voices`);
      await page.getByRole('button', { name: '新建音色' }).click();
      await page.getByRole('menuitem', { name: /克隆音色/ }).click();
      await page.locator('.dropzone input[type=file]').setInputFiles(voiceFile);
      await page.locator('.report-table').waitFor({ timeout: T });
      await page.getByRole('radio', { name: '嘈杂素材' }).click();
      await page.locator('.report-steps').getByText(/降噪/).waitFor({ timeout: T }).catch(() => undefined);
      await page.getByRole('radio', { name: '标准', exact: true }).click();
      await page.getByPlaceholder('例如：我的声音、旁白男声').fill('测试克隆');
      await shot('03-clone-editor');
      await page.getByRole('button', { name: '保存为克隆音色' }).click();
      await page.getByRole('heading', { name: '测试克隆' }).waitFor({ timeout: T });
      await page.locator('.ref-current .report').waitFor();
      await shot('04-clone-detail');
    });

    await check('音色库列表与筛选', async () => {
      await page.goto(`${base}/#/voices`);
      await page.locator('.voice-card').nth(10).waitFor();
      await page.getByRole('radio', { name: '克隆' }).click();
      await page.locator('.voice-card').first().getByText('测试克隆').waitFor();
      await page.getByRole('radio', { name: '全部' }).click();
      await shot('05-voices');
    });

    await check('剧本：新建 → 按行导入 → 配音推荐 → 生成 → 导出', async () => {
      await page.goto(`${base}/#/projects`);
      await page.getByRole('button', { name: '新建剧本' }).first().click();
      await page.getByLabel('剧本名称').fill('雨夜');
      await page.getByRole('button', { name: '创建' }).click();
      await page.getByRole('heading', { name: '雨夜' }).waitFor();
      await page.getByRole('button', { name: '导入文本' }).first().click();
      await page.getByRole('radio', { name: '按行导入' }).click();
      await page.locator('.import-modal textarea').fill('旁白：夜色渐深，雨一直没有停。\n小雨：你还在等他吗？\n阿杰：嗯，再等一会儿。\n旁白：窗外的路灯忽明忽暗。');
      await page.getByRole('button', { name: /导入 4 段/ }).click();
      await page.locator('.seg').nth(3).waitFor({ timeout: T });
      await page.getByRole('button', { name: '配音推荐' }).click();
      await page.getByRole('button', { name: '推荐', exact: true }).click();
      await page.locator('.cast-list li').first().waitFor({ timeout: T });
      await page.getByRole('button', { name: /采用所选/ }).click();
      await page.locator('.seg-voice').nth(3).waitFor({ timeout: T });
      await page.getByRole('button', { name: '生成', exact: true }).click();
      await page.getByRole('menuitem', { name: /生成未生成的/ }).click();
      await page.locator('.seg-status.is-ok').nth(3).waitFor({ timeout: 40000 });
      await shot('06-project');
      // 改一段文本 → 显示过期
      const ta = page.getByLabel('第 2 段文本');
      await ta.fill('你还在这里等他吗？');
      await ta.blur();
      await page.locator('.seg-status.is-stale').first().waitFor({ timeout: T });
      // 导出整段 WAV
      await page.getByRole('button', { name: '导出' }).click();
      const dl = page.waitForEvent('download', { timeout: T });
      await page.locator('.modal-foot').getByRole('button', { name: '导出' }).click();
      const d = await dl;
      const buf = fs.readFileSync(await d.path());
      if (buf.length < 1000 || buf.toString('latin1', 0, 4) !== 'RIFF') throw new Error(`导出的不是 WAV（${buf.length} 字节）`);
      const cd = (await page.request.get(d.url())).headers()['content-disposition'] ?? '';
      if (!cd.includes(encodeURIComponent('雨夜'))) throw new Error(`下载文件名不对：${cd}`);
      await page.locator('.export-list li').first().waitFor({ timeout: T });
      await page.keyboard.press('Escape');
    });

    await check('剧本：AI 拆分预览', async () => {
      await page.getByRole('button', { name: '导入文本' }).first().click();
      await page.locator('.import-modal textarea').fill('天快亮了。\n老板说：“今天早点收工吧。”\n伙计们都笑了。');
      await page.getByRole('button', { name: '拆分', exact: true }).click();
      await page.locator('.split-segs li').nth(2).waitFor({ timeout: T });
      await shot('07-split-preview');
      await page.keyboard.press('Escape');
    });

    await check('剧本：采用大模型写的片段指令后能保存', async () => {
      const seg = page.locator('.seg').first();
      await seg.getByRole('button', { name: /加指令|继承/ }).click();
      await seg.getByRole('button', { name: '帮我写' }).click();
      await page.locator('.modal').getByRole('button', { name: '生成', exact: true }).click();
      await page.getByRole('button', { name: '采用这条指令' }).click();
      await page.waitForTimeout(500);
      await page.reload();
      await page.locator('.seg').first().getByLabel('风格指令').waitFor({ timeout: T });
      const v = await page.locator('.seg').first().getByLabel('风格指令').inputValue();
      if (!v.includes('温柔舒缓')) throw new Error(`片段指令没有保存：「${v}」`);
    });

    await check('设置页各分类', async () => {
      for (const tab of ['mimo', 'llm', 'preprocess', 'prompts', 'ui', 'status']) {
        await page.goto(`${base}/#/settings?tab=${tab}`);
        await page.locator('.settings-card').first().waitFor();
      }
      await page.goto(`${base}/#/settings?tab=llm`);
      await page.getByRole('combobox').filter({ hasText: '模拟端点 / mock-llm' }).first().waitFor();
      await shot('08-settings-llm');
      await page.goto(`${base}/#/settings?tab=mimo`);
      await page.getByRole('button', { name: '测试连接' }).click();
      await page.getByText(/连接成功：/).waitFor({ timeout: T });
    });

    await check('深色模式', async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto(`${base}/#/quick`);
      await page.locator('.history-item').first().waitFor();
      await shot('09-quick-dark');
      await page.goto(`${base}/#/voices`);
      await page.locator('.voice-card').first().waitFor();
      await shot('10-voices-dark');
      await page.emulateMedia({ colorScheme: 'light' });
    });

    await check('窄屏布局', async () => {
      await page.setViewportSize({ width: 760, height: 900 });
      await page.goto(`${base}/#/quick`);
      await page.getByRole('heading', { name: '快速合成' }).waitFor();
      await shot('11-quick-narrow');
      const overflow = await page.evaluate(() => document.querySelector('.main')!.scrollWidth - document.querySelector('.main')!.clientWidth);
      if (overflow > 2) throw new Error(`窄屏下出现横向滚动：${overflow}px`);
    });

    if (errors.length) throw new Error(`页面有错误：\n${errors.join('\n')}`);
    console.log(`全部通过，截图在 ${path.relative(root, shots)}/`);
  } catch (e) {
    await shot('failure').catch(() => undefined);
    if (errors.length) console.error(errors.join('\n'));
    throw e;
  } finally {
    await browser.close();
  }
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch((e) => { console.error(e); cleanup(); process.exit(1); });

function cleanup() {
  for (const p of procs) p.kill();
  if (!process.env.KEEP) fs.rmSync(dataDir, { recursive: true, force: true });
  else console.log(`数据目录保留在 ${dataDir}`);
}
