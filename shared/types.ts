// 前后端共享的类型定义（只使用可擦除的 TS 语法：服务端由 Node 原生剥离类型运行，前端由 esbuild 打包）

// ───────────────────────── 音色 ─────────────────────────

/** 音色库里的三种音色 */
export type VoiceKind = 'preset' | 'design' | 'clone';

/** 实际合成时走的方式（设计音色固化后走 clone） */
export type SynthMode = 'preset' | 'design' | 'clone';

export type VoiceLang = '' | 'zh' | 'en' | 'mixed' | 'other';
export type VoiceGender = '' | 'female' | 'male' | 'other';

/** 音频基础信息（来自 ffmpeg 探测） */
export interface AudioInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  durationSec: number;
  bitrateKbps?: number;
}

/** 克隆参考音频的标准化参数 */
export interface ProcessParams {
  /** 输出采样率 */
  sampleRate: number;
  /** 高通滤波截止频率，0 = 关闭 */
  highpassHz: number;
  /** 降噪强度（ffmpeg afftdn） */
  denoise: 'off' | 'light' | 'medium' | 'strong';
  /** 裁掉首尾静音 */
  trimEdges: boolean;
  /** 裁剪后首尾保留的静音（毫秒） */
  edgePadMs: number;
  /** 压缩过长停顿 */
  compressPauses: boolean;
  /** 超过这个长度的停顿才压缩（毫秒） */
  maxPauseMs: number;
  /** 压缩后保留的停顿长度（毫秒） */
  keepPauseMs: number;
  /** 响度归一 */
  normalize: boolean;
  /** 目标响度 LUFS（ITU-R BS.1770） */
  targetLufs: number;
  /** 真峰值上限 dBTP */
  ceilingDb: number;
  /** 首尾淡入淡出（毫秒） */
  fadeMs: number;
}

export type ProcessPresetId = 'standard' | 'noisy' | 'light' | 'fix' | 'raw' | 'custom';

export interface AudioMetrics {
  durationSec: number;
  /** 整合响度 LUFS；过短无法测量时为 null */
  lufs: number | null;
  truePeakDb: number;
  samplePeakDb: number;
  noiseFloorDb: number;
  speechLevelDb: number;
  snrDb: number;
  /** 有效语音占比 0..1 */
  speechRatio: number;
  /** 削波事件数 */
  clipEvents: number;
  longestPauseSec: number;
  dcOffset: number;
}

export interface QualityWarning {
  level: 'error' | 'warn' | 'info';
  code: string;
  message: string;
}

export type QualityGrade = 'good' | 'ok' | 'poor';

export interface QualityReport {
  before: AudioMetrics;
  after: AudioMetrics;
  /** 实际执行的处理步骤（人类可读） */
  steps: string[];
  warnings: QualityWarning[];
  grade: QualityGrade;
  /** data URI 形式 base64 后的字节数（官方上限 10MB） */
  base64Bytes: number;
  sampleRate: number;
  params: ProcessParams;
  /** 是否可以作为参考音频保存（没有 error 级问题） */
  usable: boolean;
}

export interface Region {
  start: number;
  end: number;
}

export type RefSource = 'upload' | 'record' | 'design-take' | 'quick' | 'segment-take' | 'voice-ref' | 'import';

/** 参考音频的一个版本（克隆音色、已固化的设计音色） */
export interface RefVersion {
  version: number;
  createdAt: number;
  source: RefSource;
  sourceLabel?: string;
  takeId?: string;
  original: { file: string; name: string; mime: string; bytes: number; info: AudioInfo };
  sourceFile: string;
  processedFile: string;
  region: Region | null;
  params: ProcessParams;
  preset: ProcessPresetId;
  report: QualityReport;
  processedDurationMs: number;
  processedBytes: number;
  peaks: number[];
}

/** 设计音色的一次试听（抽卡） */
export interface DesignTake {
  id: string;
  file: string;
  createdAt: number;
  /** 生成这一条时用的描述（描述之后改了也能看到当时的） */
  description: string;
  /** 发送的合成文本 */
  text: string;
  /** 接口返回的实际朗读文本（开启智能润色时可能有） */
  actualText?: string;
  optimizeTextPreview: boolean;
  durationMs: number;
  peaks: number[];
  starred: boolean;
  note: string;
}

export interface VoicePreview {
  file: string;
  text: string;
  voiceVersion: string;
  createdAt: number;
  durationMs: number;
  peaks: number[];
}

export interface VoiceOrigin {
  type: 'design-take' | 'quick' | 'segment-take' | 'duplicate' | 'import' | 'adhoc-design';
  voiceId?: string;
  voiceName?: string;
  takeId?: string;
  resultId?: string;
  projectId?: string;
  segmentId?: string;
  label?: string;
}

/** 音色库里的一条音色（磁盘上的 voice.json） */
export interface VoiceRecord {
  id: string;
  kind: VoiceKind;
  name: string;
  tags: string[];
  lang: VoiceLang;
  gender: VoiceGender;
  notes: string;
  favorite: boolean;
  /** 默认风格指令（放在 user 消息里；未固化的设计音色不可用） */
  defaultInstruction: string;
  /** 预置变体：官方音色 ID */
  presetId?: string;
  /** 设计音色：音色描述 */
  description?: string;
  /** 设计音色：抽卡记录 */
  takes?: DesignTake[];
  /** 参考音频版本（克隆 / 设计固化） */
  refs: RefVersion[];
  /** 正在使用的参考音频版本号；设计音色为 null 表示未固化 */
  currentRef: number | null;
  preview?: VoicePreview;
  origin?: VoiceOrigin;
  createdAt: number;
  updatedAt: number;
  trashedAt?: number;
}

/** 列表里用的音色摘要（含内置预置音色） */
export interface VoiceSummary {
  id: string;
  kind: VoiceKind;
  builtin: boolean;
  name: string;
  tags: string[];
  lang: VoiceLang;
  gender: VoiceGender;
  notes: string;
  favorite: boolean;
  defaultInstruction: string;
  presetId?: string;
  description?: string;
  /** 实际合成方式 */
  mode: SynthMode;
  /** 音色版本标识：参考音频或描述变了它就会变，用来判断片段是否过期 */
  version: string;
  /** 设计：draft 草稿 / drafting 抽卡中 / fixed 已固化；克隆：ready */
  status: 'builtin' | 'ready' | 'draft' | 'drafting' | 'fixed';
  takeCount: number;
  grade?: QualityGrade;
  refDurationMs?: number;
  preview?: { url: string; text: string; voiceVersion: string; durationMs: number; peaks: number[] };
  createdAt: number;
  updatedAt: number;
  trashed: boolean;
}

/** 合成时如何指定音色 */
export type VoiceSelector =
  | { type: 'library'; id: string }
  | { type: 'adhoc-design'; description: string };

// ───────────────────────── 合成结果 ─────────────────────────

export interface ChunkTiming {
  text: string;
  startMs: number;
  endMs: number;
}

export interface VoiceSnapshot {
  type: 'library' | 'adhoc-design';
  id?: string;
  name: string;
  kind?: VoiceKind;
  mode: SynthMode;
  version: string;
  description?: string;
}

export interface QuickResult {
  id: string;
  createdAt: number;
  voice: VoiceSnapshot;
  text: string;
  /** 实际生效的风格指令 */
  instruction: string;
  instructionIgnored: boolean;
  model: string;
  chunks: ChunkTiming[];
  durationMs: number;
  file: string;
  peaks: number[];
  warnings: string[];
  starred: boolean;
  actualText?: string;
  elapsedMs: number;
}

// ───────────────────────── 剧本项目 ─────────────────────────

export interface Role {
  id: string;
  name: string;
  color: string;
  /** 音色库 ID（含 builtin-*），null = 未绑定 */
  voiceId: string | null;
  /** 角色默认指令（为空时用音色默认指令） */
  instruction: string;
  notes: string;
}

export interface SegmentTake {
  id: string;
  file: string;
  createdAt: number;
  durationMs: number;
  peaks: number[];
  voiceId: string;
  voiceName: string;
  voiceVersion: string;
  model: string;
  /** 生成时实际使用的风格指令 */
  instruction: string;
  /** 生成时实际发送的文本 */
  text: string;
  chunks: ChunkTiming[];
  warnings: string[];
  starred: boolean;
}

export interface Segment {
  id: string;
  roleId: string | null;
  text: string;
  /** 片段级指令，空 = 继承角色/音色 */
  instruction: string;
  /** 段后停顿，null = 用项目默认 */
  pauseAfterMs: number | null;
  locked: boolean;
  note: string;
  takes: SegmentTake[];
  activeTakeId: string | null;
  lastError?: string;
}

export interface ProjectSettings {
  defaultGapMs: number;
  /** 每段最多保留的版本数（收藏的版本不计入） */
  keepTakes: number;
}

export interface Project {
  id: string;
  name: string;
  notes: string;
  roles: Role[];
  segments: Segment[];
  settings: ProjectSettings;
  createdAt: number;
  updatedAt: number;
  trashedAt?: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  notes: string;
  roleCount: number;
  segmentCount: number;
  doneCount: number;
  durationMs: number;
  createdAt: number;
  updatedAt: number;
  trashed: boolean;
}

export interface ProjectExportFile {
  name: string;
  url: string;
  bytes: number;
  createdAt: number;
}

// ───────────────────────── 任务 ─────────────────────────

export type JobKind = 'quick' | 'design-take' | 'preview' | 'segment' | 'llm';
export type JobStatus = 'queued' | 'running' | 'retrying' | 'done' | 'failed' | 'canceled';

export interface JobInfo {
  id: string;
  kind: JobKind;
  status: JobStatus;
  label: string;
  projectId?: string;
  segmentId?: string;
  voiceId?: string;
  group?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  attempt: number;
  progress?: { done: number; total: number; note?: string };
  error?: string;
  result?: unknown;
}

// ───────────────────────── 设置 ─────────────────────────

export interface MimoSettings {
  baseUrl: string;
  apiKey: string;
  concurrency: number;
  retries: number;
  timeoutSec: number;
  /** 单次请求最大字数（超出自动按句切分） */
  maxChars: number;
  sentenceGapMs: number;
  paragraphGapMs: number;
  trimChunkSilence: boolean;
  /** 切分后每段沿用开头的 (风格) 标签 */
  carryLeadingTag: boolean;
  /** 预置音色使用流式（边生成边播放） */
  streamPreset: boolean;
}

export interface LlmEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export interface LlmModelRef {
  endpointId: string;
  model: string;
}

export interface LlmSettings {
  endpoints: LlmEndpoint[];
  /** 默认辅助模型（用户自己配置） */
  defaultModel: LlmModelRef | null;
  temperature: number;
  timeoutSec: number;
  /** 额外请求体参数（JSON 字符串），比如 {"reasoning_effort":"low"} */
  extraBody: string;
}

export interface PreprocessSettings {
  defaultPreset: ProcessPresetId;
  custom: ProcessParams;
  /** 少于此秒数提示过短 */
  minSec: number;
  /** 超过此秒数提示偏长 */
  recommendMaxSec: number;
  /** 超过此秒数不允许保存 */
  hardMaxSec: number;
  /** 自动选取片段的目标长度 */
  autoPickSec: number;
}

export interface UiSettings {
  /** 插入行内音频标签时使用的括号 */
  tagBracket: 'full' | 'half' | 'square';
  previewText: string;
  theme: 'auto' | 'light' | 'dark';
}

export interface Settings {
  mimo: MimoSettings;
  llm: LlmSettings;
  preprocess: PreprocessSettings;
  ui: UiSettings;
  project: ProjectSettings;
  builtinFavorites: string[];
}

/** 发给前端的设置（Key 脱敏） */
export interface PublicSettings extends Omit<Settings, 'mimo' | 'llm'> {
  mimo: Omit<MimoSettings, 'apiKey'> & { apiKeySet: boolean; apiKeyHint: string };
  llm: Omit<LlmSettings, 'endpoints'> & {
    endpoints: (Omit<LlmEndpoint, 'apiKey'> & { apiKeySet: boolean; apiKeyHint: string })[];
  };
}

export interface SystemStatus {
  version: string;
  dataDir: string;
  ffmpeg: { ok: boolean; path: string; version: string; denoise: boolean; mp3: boolean };
  mimoConfigured: boolean;
  llmConfigured: boolean;
  accessToken: boolean;
}

// ───────────────────────── 上传 / 预处理 ─────────────────────────

export interface UploadInfo {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  info: AudioInfo;
  source: RefSource;
  sourceLabel?: string;
  takeId?: string;
  sourceUrl: string;
  sourceDurationSec: number;
  peaks: number[];
  /** 自动推荐的截取区间（素材偏长时） */
  suggestion: Region | null;
  createdAt: number;
}

export interface ProcessResult {
  hash: string;
  url: string;
  durationMs: number;
  peaks: number[];
  report: QualityReport;
}

// ───────────────────────── 大模型 ─────────────────────────

export type LlmTask =
  | 'instruction-natural'
  | 'instruction-director'
  | 'tags'
  | 'design-desc'
  | 'preview-text'
  | 'split-script'
  | 'cast'
  | 'batch-instruction'
  | 'batch-tags';

export interface PromptTemplate {
  task: LlmTask;
  title: string;
  description: string;
  output: 'text' | 'json';
  variables: string[];
  temperature: number | null;
  system: string;
  user: string;
  overridden: boolean;
}

export interface LlmDebug {
  url: string;
  model: string;
  request: unknown;
  rawContent: string;
  durationMs: number;
  usage?: unknown;
  attempts: number;
}

export interface LlmRunResult<T = unknown> {
  output: T;
  raw: string;
  warnings: string[];
  debug: LlmDebug;
}

export interface SplitPreviewSegment {
  role: string;
  text: string;
  instruction: string;
}

export interface SplitPreview {
  roles: { name: string; description: string; instruction: string }[];
  segments: SplitPreviewSegment[];
  coverage: number;
  warnings: string[];
  debug: LlmDebug[];
}

export interface CastSuggestion {
  role: string;
  voiceId: string;
  voiceName: string;
  reason: string;
}

export type ChangeTopic = 'voices' | 'project' | 'projects' | 'quick' | 'settings' | 'prompts';

export interface ChangeEvent {
  topic: ChangeTopic;
  id?: string;
}
