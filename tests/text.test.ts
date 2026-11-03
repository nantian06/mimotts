import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addLeadingStyle, chunkText, composeDirector, isSinging, normalizeForCompare, parseDirector, parseLeadingTag, removeLeadingStyle,
  splitSentences, stripTags, visibleLength,
} from '../shared/text.ts';
import { diffChars } from '../shared/diff.ts';
import { buildCues, toSrt } from '../shared/srt.ts';
import { createZip, readZip } from '../server/util/zip.ts';

test('开头风格标签解析（三种括号）', () => {
  assert.deepEqual(parseLeadingTag('(开心 温柔)你好')?.items, ['开心', '温柔']);
  assert.equal(parseLeadingTag('（东北话）哎呀妈呀')?.inner, '东北话');
  assert.equal(parseLeadingTag('[慵懒]再睡五分钟')?.rest, '再睡五分钟');
  assert.equal(parseLeadingTag('你好(笑)'), null);
});

test('唱歌模式识别', () => {
  assert.equal(isSinging('(唱歌)原谅我这一生'), true);
  assert.equal(isSinging('(Singing)la la'), true);
  assert.equal(isSinging('(开心)唱歌吧'), false);
});

test('标签增删与剥离', () => {
  assert.equal(addLeadingStyle('你好', '开心'), '(开心)你好');
  assert.equal(addLeadingStyle('(开心)你好', '温柔'), '(开心 温柔)你好');
  assert.equal(removeLeadingStyle('(开心 温柔)你好', '开心'), '(温柔)你好');
  assert.equal(removeLeadingStyle('(开心)你好', '开心'), '你好');
  assert.equal(stripTags('（紧张，深呼吸）呼……冷静[叹气]。'), '呼……冷静。');
  assert.equal(normalizeForCompare('你好， 世界！'), normalizeForCompare('你好,世界!'));
  assert.equal(visibleLength('(开心)你好 啊'), 3);
});

test('分句：保留标点与引号，英文句点', () => {
  assert.deepEqual(splitSentences('他说：“走吧！”然后离开了。真的？'), ['他说：“走吧！”', '然后离开了。', '真的？']);
  assert.deepEqual(splitSentences('Hello there. Pi is 3.14 ok? Yes'), ['Hello there.', 'Pi is 3.14 ok?', 'Yes']);
});

test('长文本切块：不超长、带开头标签、段落停顿', () => {
  const para1 = '第一句话比较短。'.repeat(10);
  const para2 = '第二段的内容，' + '很长很长的一句话没有句号'.repeat(8) + '。';
  const chunks = chunkText(`(温柔)${para1}\n\n${para2}`, { maxChars: 40, carryLeadingTag: true });
  assert.ok(chunks.length >= 4);
  for (const c of chunks) {
    assert.ok(c.text.startsWith('(温柔)'), c.text);
    assert.ok(visibleLength(c.text) <= 40, `${visibleLength(c.text)} ${c.text}`);
  }
  assert.ok(chunks.some((c) => c.gapAfter === 'paragraph'));
  assert.equal(chunks[chunks.length - 1].gapAfter, 'none');
  // 拼回去与原文一致
  const joined = chunks.map((c) => c.text.replace('(温柔)', '')).join('');
  assert.equal(normalizeForCompare(joined), normalizeForCompare(para1 + para2));
  // 不沿用标签
  const c2 = chunkText(`(温柔)${para1}`, { maxChars: 40, carryLeadingTag: false });
  assert.ok(c2[0].text.startsWith('(温柔)') && !c2[1].text.startsWith('(温柔)'));
  // 唱歌标签总是沿用
  const c3 = chunkText(`(唱歌)${para1}`, { maxChars: 40, carryLeadingTag: false });
  assert.ok(c3.every((c) => c.text.startsWith('(唱歌)')));
  assert.equal(chunkText('短句。', { maxChars: 300, carryLeadingTag: true }).length, 1);
});

test('导演模式拼装与识别', () => {
  const s = composeDirector({ role: '门阀当家', scene: '祠堂对峙', guidance: '- 语速极慢\n- 气声收尾' });
  assert.ok(s.startsWith('角色：门阀当家'));
  const p = parseDirector(s)!;
  assert.equal(p.scene, '祠堂对峙');
  assert.equal(p.guidance, '- 语速极慢\n- 气声收尾');
  assert.equal(parseDirector('用温柔的语气'), null);
});

test('字符差异', () => {
  const d = diffChars('今天天气不错', '（开心）今天天气真不错');
  assert.equal(d.filter((x) => x.type !== 'del').map((x) => x.text).join(''), '（开心）今天天气真不错');
  assert.equal(d.filter((x) => x.type !== 'add').map((x) => x.text).join(''), '今天天气不错');
  assert.deepEqual(d.filter((x) => x.type === 'add').map((x) => x.text), ['（开心）', '真']);
  assert.deepEqual(diffChars('', 'ab'), [{ type: 'add', text: 'ab' }]);
  assert.deepEqual(diffChars('abc', 'abc'), [{ type: 'same', text: 'abc' }]);
});

test('SRT：按时长与分块生成', () => {
  const cues = buildCues([
    { text: '(开心)你好。很高兴见到你！', roleName: '小明', startMs: 0, durationMs: 3000, chunks: [] },
    { text: '再见。', roleName: '小红', startMs: 3400, durationMs: 1000, chunks: [] },
  ], { includeRole: true, splitSentences: true, maxCueChars: 4 });
  assert.equal(cues[0].text, '小明：你好。');
  assert.equal(cues[cues.length - 1].endMs, 4400);
  const srt = toSrt(cues);
  assert.match(srt, /^1\n00:00:00,000 --> /);
  assert.match(srt, /00:00:03,400 --> 00:00:04,400\n小红：再见。/);
});

test('ZIP 读写往返', () => {
  const zip = createZip([{ name: 'a/voice.json', data: '{"x":"中文"}' }, { name: 'a/ref.wav', data: new Uint8Array([1, 2, 3, 4]) }]);
  const entries = readZip(zip);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].data.toString('utf8'), '{"x":"中文"}');
  assert.deepEqual([...entries[1].data], [1, 2, 3, 4]);
});
