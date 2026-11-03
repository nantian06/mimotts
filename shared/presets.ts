import type { ProcessParams, ProcessPresetId, Settings, VoiceGender, VoiceLang } from './types.ts';

export const MODELS = {
  preset: 'mimo-v2.5-tts',
  design: 'mimo-v2.5-tts-voicedesign',
  clone: 'mimo-v2.5-tts-voiceclone',
} as const;

/** MiMo 输出音频采样率（流式 pcm16 固定 24kHz 单声道） */
export const MIMO_SAMPLE_RATE = 24000;

/** 参考音频 data URI 的官方大小上限 */
export const REF_BASE64_LIMIT = 10 * 1024 * 1024;

export const MIMO_BASE_URLS = [
  { label: '按量付费', url: 'https://api.xiaomimimo.com/v1' },
  { label: 'Token Plan（中国）', url: 'https://token-plan-cn.xiaomimimo.com/v1' },
];

export interface BuiltinVoice {
  id: string;
  presetId: string;
  name: string;
  lang: VoiceLang;
  gender: VoiceGender;
  notes: string;
}

/** 官方预置音色 */
export const BUILTIN_VOICES: BuiltinVoice[] = [
  { id: 'builtin-default', presetId: 'mimo_default', name: 'MiMo-默认', lang: '', gender: '', notes: '因部署集群而异：中国集群默认为冰糖，其他集群默认为 Mia' },
  { id: 'builtin-bingtang', presetId: '冰糖', name: '冰糖', lang: 'zh', gender: 'female', notes: '中文女声' },
  { id: 'builtin-moli', presetId: '茉莉', name: '茉莉', lang: 'zh', gender: 'female', notes: '中文女声' },
  { id: 'builtin-suda', presetId: '苏打', name: '苏打', lang: 'zh', gender: 'male', notes: '中文男声' },
  { id: 'builtin-baihua', presetId: '白桦', name: '白桦', lang: 'zh', gender: 'male', notes: '中文男声' },
  { id: 'builtin-mia', presetId: 'Mia', name: 'Mia', lang: 'en', gender: 'female', notes: 'English female' },
  { id: 'builtin-chloe', presetId: 'Chloe', name: 'Chloe', lang: 'en', gender: 'female', notes: 'English female' },
  { id: 'builtin-milo', presetId: 'Milo', name: 'Milo', lang: 'en', gender: 'male', notes: 'English male' },
  { id: 'builtin-dean', presetId: 'Dean', name: 'Dean', lang: 'en', gender: 'male', notes: 'English male' },
];

export function builtinById(id: string): BuiltinVoice | undefined {
  return BUILTIN_VOICES.find((v) => v.id === id);
}

export function builtinByPresetId(presetId: string): BuiltinVoice | undefined {
  return BUILTIN_VOICES.find((v) => v.presetId === presetId);
}

/** 开头的整体风格标签 (风格) —— 放在 assistant 文本最前面 */
export const STYLE_TAG_GROUPS: { label: string; items: string[] }[] = [
  { label: '基础情绪', items: ['开心', '悲伤', '愤怒', '恐惧', '惊讶', '兴奋', '委屈', '平静', '冷漠'] },
  { label: '复合情绪', items: ['怅然', '欣慰', '无奈', '愧疚', '释然', '嫉妒', '厌倦', '忐忑', '动情'] },
  { label: '整体语调', items: ['温柔', '高冷', '活泼', '严肃', '慵懒', '俏皮', '深沉', '干练', '凌厉'] },
  { label: '音色定位', items: ['磁性', '醇厚', '清亮', '空灵', '稚嫩', '苍老', '甜美', '沙哑', '醇雅'] },
  { label: '人设腔调', items: ['夹子音', '御姐音', '正太音', '大叔音', '台湾腔'] },
  { label: '方言', items: ['东北话', '四川话', '河南话', '粤语'] },
  { label: '角色扮演', items: ['孙悟空', '林黛玉'] },
  { label: '唱歌（仅预置音色）', items: ['唱歌'] },
];

/** 行内音频标签 —— 可插在文本任意位置 */
export const INLINE_TAG_GROUPS: { label: string; items: string[] }[] = [
  { label: '呼吸与节奏', items: ['吸气', '深呼吸', '叹气', '长叹一口气', '喘息', '屏息', '停顿', '沉默片刻', '语速加快', '语速放慢'] },
  { label: '情绪状态', items: ['紧张', '害怕', '激动', '疲惫', '委屈', '撒娇', '心虚', '震惊', '不耐烦'] },
  { label: '语音特征', items: ['颤抖', '声音颤抖', '变调', '破音', '鼻音', '气声', '沙哑', '小声', '提高音量'] },
  { label: '哭笑', items: ['笑', '轻笑', '大笑', '冷笑', '苦笑', '抽泣', '呜咽', '哽咽', '嚎啕大哭'] },
  { label: '其他', items: ['咳嗽', '清嗓子', '打哈欠'] },
];

export const PROCESS_PRESETS: Record<Exclude<ProcessPresetId, 'custom'>, { label: string; hint: string; params: ProcessParams }> = {
  standard: {
    label: '标准（推荐）',
    hint: '单声道 24kHz、高通去低频、裁首尾静音、压缩长停顿、响度归一到 -20 LUFS',
    params: {
      sampleRate: 24000, highpassHz: 70, denoise: 'off', trimEdges: true, edgePadMs: 150,
      compressPauses: true, maxPauseMs: 700, keepPauseMs: 350, normalize: true, targetLufs: -20, ceilingDb: -1.5, fadeMs: 10,
    },
  },
  noisy: {
    label: '嘈杂素材',
    hint: '在标准基础上加中等降噪、高通提高到 90Hz。降噪可能带来金属感，克隆会一并学到',
    params: {
      sampleRate: 24000, highpassHz: 90, denoise: 'medium', trimEdges: true, edgePadMs: 150,
      compressPauses: true, maxPauseMs: 700, keepPauseMs: 350, normalize: true, targetLufs: -20, ceilingDb: -1.5, fadeMs: 10,
    },
  },
  light: {
    label: '轻处理',
    hint: '只做单声道、裁首尾静音和响度归一，最大程度保留原始质感',
    params: {
      sampleRate: 24000, highpassHz: 0, denoise: 'off', trimEdges: true, edgePadMs: 200,
      compressPauses: false, maxPauseMs: 700, keepPauseMs: 350, normalize: true, targetLufs: -20, ceilingDb: -1.0, fadeMs: 8,
    },
  },
  fix: {
    label: '固化（设计音色）',
    hint: '模型生成的音频本身很干净，只裁静音、压停顿、归一响度',
    params: {
      sampleRate: 24000, highpassHz: 0, denoise: 'off', trimEdges: true, edgePadMs: 120,
      compressPauses: true, maxPauseMs: 800, keepPauseMs: 400, normalize: true, targetLufs: -20, ceilingDb: -1.5, fadeMs: 8,
    },
  },
  raw: {
    label: '不处理（仅转码）',
    hint: '只转成单声道 WAV，不做任何修饰',
    params: {
      sampleRate: 24000, highpassHz: 0, denoise: 'off', trimEdges: false, edgePadMs: 0,
      compressPauses: false, maxPauseMs: 700, keepPauseMs: 350, normalize: false, targetLufs: -20, ceilingDb: -1.0, fadeMs: 0,
    },
  },
};

export const ROLE_COLORS = ['#c2410c', '#0f766e', '#7c3aed', '#b45309', '#2563eb', '#be185d', '#4d7c0f', '#0e7490', '#9333ea', '#a16207'];

export const DEFAULT_PREVIEW_TEXT = '你好，很高兴认识你。今天天气不错，我们边走边聊吧——你最近过得怎么样？';

export function defaultSettings(): Settings {
  return {
    mimo: {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: '',
      concurrency: 2,
      retries: 3,
      timeoutSec: 180,
      maxChars: 300,
      sentenceGapMs: 150,
      paragraphGapMs: 450,
      trimChunkSilence: true,
      carryLeadingTag: true,
      streamPreset: true,
    },
    llm: {
      endpoints: [],
      defaultModel: null,
      temperature: 0.7,
      timeoutSec: 120,
      extraBody: '',
    },
    preprocess: {
      defaultPreset: 'standard',
      custom: { ...PROCESS_PRESETS.standard.params },
      minSec: 4,
      recommendMaxSec: 30,
      hardMaxSec: 90,
      autoPickSec: 15,
    },
    ui: {
      tagBracket: 'full',
      previewText: DEFAULT_PREVIEW_TEXT,
      theme: 'auto',
    },
    project: {
      defaultGapMs: 400,
      keepTakes: 5,
    },
    builtinFavorites: [],
  };
}

export const LANG_LABELS: Record<VoiceLang, string> = { '': '未标注', zh: '中文', en: '英文', mixed: '中英', other: '其他' };
export const GENDER_LABELS: Record<VoiceGender, string> = { '': '未标注', female: '女声', male: '男声', other: '其他' };
export const KIND_LABELS = { preset: '预置', design: '设计', clone: '克隆' } as const;
