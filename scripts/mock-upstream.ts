// 模拟上游：MiMo TTS（三个模型，含流式）+ OpenAI 兼容大模型。用于本地演示与自动化测试。
// 用法：npm run mock  （默认端口 18790；MiMo Base URL 填 http://localhost:18790/v1，Key 随便填）
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 18790);
const DELAY = Number(process.env.MOCK_DELAY_MS ?? 150);
const FAIL_EVERY = Number(process.env.MOCK_FAIL_EVERY ?? 0); // 每 N 次 TTS 请求返回一次 429，测试重试
const SR = 24000;
let ttsCount = 0;
export const received: any[] = [];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** 生成一段“像说话”的音频：基频由音色决定，长度与字数成正比，标点处停顿 */
function speak(text: string, voiceKey: string): Float32Array {
  const clean = text.replace(/[(（\[][^)）\]]*[)）\]]/g, '');
  const f0 = 110 + (hash(voiceKey) % 160);
  const parts: number[] = [];
  const lead = Math.round(0.12 * SR);
  for (let i = 0; i < lead; i++) parts.push(0);
  let t = 0;
  for (const ch of Array.from(clean)) {
    if (/\s/.test(ch)) continue;
    const pause = /[，,、；;：:]/.test(ch) ? 0.18 : /[。！？!?…]/.test(ch) ? 0.32 : 0;
    if (pause) { for (let i = 0; i < pause * SR; i++) parts.push(0); continue; }
    const dur = 0.15;
    const n = Math.round(dur * SR);
    for (let i = 0; i < n; i++) {
      const tt = t + i / SR;
      const env = Math.sin((Math.PI * i) / n) ** 0.6;
      const f = f0 * (1 + 0.06 * Math.sin(2 * Math.PI * 1.3 * tt));
      let v = 0;
      for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f * h * tt) / (h * 1.4);
      parts.push(0.22 * env * v);
    }
    t += dur;
  }
  for (let i = 0; i < lead; i++) parts.push(0);
  return Float32Array.from(parts);
}

function pcm16(x: Float32Array): Buffer {
  const b = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), i * 2);
  return b;
}

function wav(x: Float32Array): Buffer {
  const d = pcm16(x);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + d.length, 4); h.write('WAVE', 8, 'ascii'); h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36, 'ascii'); h.writeUInt32LE(d.length, 40);
  return Buffer.concat([h, d]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function err(res: http.ServerResponse, status: number, message: string) {
  json(res, status, { error: { message, type: 'invalid_request_error' } });
}

async function tts(body: any, res: http.ServerResponse) {
  const msgs: any[] = body.messages ?? [];
  const user = msgs.find((m) => m.role === 'user');
  const asst = msgs.find((m) => m.role === 'assistant');
  const audio = body.audio ?? {};
  // 严格按官方规则校验，便于发现请求构造错误
  if (msgs.some((m) => m.role !== 'user' && m.role !== 'assistant')) return err(res, 400, 'only user/assistant roles allowed');
  let voiceKey = '';
  if (body.model === 'mimo-v2.5-tts') {
    if (!asst?.content) return err(res, 400, 'assistant text required');
    if (!audio.voice || String(audio.voice).startsWith('data:')) return err(res, 400, 'preset voice id required');
    voiceKey = `preset:${audio.voice}`;
  } else if (body.model === 'mimo-v2.5-tts-voicedesign') {
    if (!user?.content) return err(res, 400, 'voice description (user) required for voicedesign');
    if (audio.voice) return err(res, 400, 'voicedesign does not accept audio.voice');
    if (!asst?.content && !audio.optimize_text_preview) return err(res, 400, 'assistant text required');
    if (/^\s*[(（\[](唱歌|sing)/i.test(asst?.content ?? '')) return err(res, 400, 'singing not supported');
    voiceKey = `design:${user.content}:${Math.random()}`; // 设计音色每次都不一样
  } else if (body.model === 'mimo-v2.5-tts-voiceclone') {
    if (!asst?.content) return err(res, 400, 'assistant text required');
    if (!String(audio.voice ?? '').startsWith('data:audio/')) return err(res, 400, 'voice must be data URI');
    if (String(audio.voice).length > 10 * 1024 * 1024) return err(res, 400, 'voice sample too large');
    voiceKey = `clone:${String(audio.voice).length}:${String(audio.voice).slice(-64)}`;
  } else return err(res, 404, `unknown model ${body.model}`);
  if (body.stream && audio.format !== 'pcm16') return err(res, 400, 'stream requires pcm16');
  if (!body.stream && audio.format !== 'wav') return err(res, 400, 'mock expects wav for non-stream');

  ttsCount++;
  received.push({ model: body.model, user: user?.content, assistant: asst?.content, audio: { ...audio, voice: String(audio.voice ?? '').slice(0, 40) } });
  if (FAIL_EVERY && ttsCount % FAIL_EVERY === 0) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
    res.end(JSON.stringify({ error: { message: 'rate limited (mock)' } }));
    return;
  }
  const text = asst?.content || '这是智能润色后生成的示范文本，用来试听这个声音。';
  const x = speak(text, voiceKey);
  await sleep(DELAY);
  if (!body.stream) {
    return json(res, 200, {
      id: 'mock', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: asst?.content ? '' : text, audio: { id: 'a', data: wav(x).toString('base64') } }, finish_reason: 'stop' }],
    });
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const step = Math.round(0.25 * SR);
  for (let i = 0; i < x.length; i += step) {
    const chunk = pcm16(x.subarray(i, i + step));
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { audio: { data: chunk.toString('base64') } } }] })}\n\n`);
    await sleep(Math.min(60, DELAY / 4));
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function between(s: string, a: string, b: string): string {
  const i = s.indexOf(a);
  if (i < 0) return '';
  const j = s.indexOf(b, i + a.length);
  return s.slice(i + a.length, j < 0 ? undefined : j).trim();
}

function llm(body: any): string {
  const sys = String(body.messages?.find((m: any) => m.role === 'system')?.content ?? '');
  const user = String(body.messages?.filter((m: any) => m.role === 'user').pop()?.content ?? '');
  if (user.includes('不是合法 JSON')) return '{"description":"修复后的输出","previewText":"你好","role":"r","scene":"s","guidance":"g"}';
  if (sys.includes('导演模式')) return '```json\n{"role":"沉稳的中年讲述者，见过风浪","scene":"深夜对着老朋友回忆往事","guidance":"低沉温暖的声线。\\n- 语速偏慢\\n- 句尾轻微气声"}\n```';
  if (sys.includes('多个剧本片段插入音频标签')) {
    const items = JSON.parse(user.slice(user.indexOf('[')));
    return JSON.stringify(items.map((it: any) => ({ id: it.id, text: `(平静)${it.text}` })));
  }
  if (sys.includes('逐段写给 MiMo TTS 的风格指令')) {
    const items = JSON.parse(user.slice(user.indexOf('[')));
    return JSON.stringify(items.map((it: any, i: number) => ({ id: it.id, instruction: i % 2 ? '语气急切，语速稍快' : '平稳自然地叙述，语速适中' })));
  }
  if (sys.includes('音频标签')) {
    const text = between(user, '<<<', '>>>');
    const i = text.indexOf('，');
    return `(平静)${i > 0 ? text.slice(0, i + 1) + '（轻笑）' + text.slice(i + 1) : text}`;
  }
  if (sys.includes('VoiceDesign')) return '{"description":"一位三十岁左右的女性，嗓音温润清亮，语速舒缓，带着让人安心的笑意。","previewText":"晚上好呀，今天辛苦了。把灯调暗一点，我给你讲个小故事，好不好？"}';
  if (sys.includes('试听写台词')) return '晚上好，欢迎回来。今天过得怎么样？先坐下歇一会儿吧。';
  if (sys.includes('拆成适合多角色语音合成的片段')) {
    const text = between(user, '<<<', '>>>');
    const segs: any[] = [];
    const roles = new Map<string, string>();
    for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const m = /^(.{1,6}?)(?:说|问|喊|道)?[：:]\s*[“「](.+)[”」]$/.exec(line);
      if (m) { roles.set(m[1], `${m[1]}，故事人物`); segs.push({ role: m[1], text: m[2], instruction: '' }); }
      else segs.push({ role: '旁白', text: line, instruction: '' });
    }
    return JSON.stringify({ roles: [{ name: '旁白', description: '叙述者', instruction: '' }, ...[...roles].map(([name, description]) => ({ name, description, instruction: '' }))], segments: segs });
  }
  if (sys.includes('选角导演')) {
    const roles = JSON.parse(between(user, '角色列表：', '音色库：'));
    const vs = JSON.parse(user.slice(user.indexOf('音色库：') + 4));
    return JSON.stringify(roles.map((r: any, i: number) => ({ role: r.name, voiceId: vs[(i + 1) % vs.length].id, reason: '音色气质与人设相符' })));
  }
  return '用温柔舒缓的语调，像在讲睡前故事，语速稍慢，句尾自然放轻。';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'GET' && url.pathname.endsWith('/models')) return json(res, 200, { data: [{ id: 'mock-llm' }, { id: 'mock-llm-pro' }] });
  if (req.method === 'GET' && url.pathname === '/__received') return json(res, 200, received);
  if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) return err(res, 404, 'not found');
  const auth = req.headers.authorization ?? '';
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let body: any;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return err(res, 400, 'bad json'); }
  if (String(body.model ?? '').startsWith('mimo-v2.5-tts')) {
    if (!auth.startsWith('Bearer ') || auth.length < 9) return err(res, 401, 'invalid api key');
    return tts(body, res);
  }
  await sleep(Math.min(DELAY, 200));
  const content = llm(body);
  json(res, 200, { id: 'mock', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
});

server.listen(PORT, () => console.log(`mock upstream on http://localhost:${PORT}/v1`));
