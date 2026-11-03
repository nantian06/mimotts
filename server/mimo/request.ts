// MiMo 三个 TTS 模型的请求构造（纯函数，便于测试）
//  - 合成文本永远在 assistant 消息里；风格指令/音色描述在 user 消息里
//  - 预置：audio.voice = 预置 ID；设计：user = 音色描述（必填），不传 voice；克隆：audio.voice = data URI
import { MODELS } from '../../shared/presets.ts';
import { isSinging } from '../../shared/text.ts';
import type { SynthMode } from '../../shared/types.ts';

export type ResolvedVoice =
  | { mode: 'preset'; presetId: string }
  | { mode: 'design'; description: string }
  | { mode: 'clone'; refDataUri: string };

export interface BuildInput {
  text: string;
  instruction?: string;
  stream?: boolean;
  /** 仅音色设计：让模型自动润色/生成试听文本 */
  optimizeTextPreview?: boolean;
}

export interface MimoBody {
  model: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  audio: Record<string, unknown>;
  stream?: boolean;
}

export class SynthInputError extends Error {}

export function modelFor(mode: SynthMode): string {
  return MODELS[mode];
}

export function buildMimoBody(voice: ResolvedVoice, input: BuildInput): { body: MimoBody; warnings: string[] } {
  const warnings: string[] = [];
  const text = input.text.trim();
  const instruction = (input.instruction ?? '').trim();
  const stream = !!input.stream;
  const format = stream ? 'pcm16' : 'wav';

  if (voice.mode !== 'preset' && isSinging(text)) {
    throw new SynthInputError('唱歌模式只支持预置音色（mimo-v2.5-tts）');
  }

  if (voice.mode === 'preset') {
    if (!text) throw new SynthInputError('合成文本不能为空');
    const messages: MimoBody['messages'] = [];
    if (instruction) messages.push({ role: 'user', content: instruction });
    messages.push({ role: 'assistant', content: text });
    return { body: { model: MODELS.preset, messages, audio: { format, voice: voice.presetId }, ...(stream ? { stream: true } : {}) }, warnings };
  }

  if (voice.mode === 'design') {
    const desc = voice.description.trim();
    if (!desc) throw new SynthInputError('音色设计需要填写音色描述');
    if (instruction) warnings.push('未固化的设计音色不能单独加风格指令（user 消息已用于音色描述），指令已忽略；可用文本内的 (风格) / [标签] 控制演绎，或先固化');
    const optimize = !!input.optimizeTextPreview;
    if (!text && !optimize) throw new SynthInputError('合成文本不能为空（或开启智能润色）');
    const messages: MimoBody['messages'] = [{ role: 'user', content: desc }];
    if (text) messages.push({ role: 'assistant', content: text });
    const audio: Record<string, unknown> = { format };
    if (optimize) audio.optimize_text_preview = true;
    return { body: { model: MODELS.design, messages, audio, ...(stream ? { stream: true } : {}) }, warnings };
  }

  if (!text) throw new SynthInputError('合成文本不能为空');
  if (!voice.refDataUri.startsWith('data:audio/')) throw new SynthInputError('参考音频格式不正确');
  // 官方示例在没有指令时也带一条空的 user 消息
  const messages: MimoBody['messages'] = [
    { role: 'user', content: instruction },
    { role: 'assistant', content: text },
  ];
  return { body: { model: MODELS.clone, messages, audio: { format, voice: voice.refDataUri }, ...(stream ? { stream: true } : {}) }, warnings };
}

/** 日志/调试用：把 data URI 缩写，避免把几 MB base64 打出来 */
export function redactBody(body: MimoBody): MimoBody {
  const audio = { ...body.audio };
  if (typeof audio.voice === 'string' && audio.voice.startsWith('data:')) {
    audio.voice = `${audio.voice.slice(0, 32)}…（${Math.round(audio.voice.length / 1024)} KB）`;
  }
  return { ...body, audio };
}
