// 克隆参考音频编辑器：上传/录音 → 截取 → 标准化（实时质量报告）→ 保存为音色或新版本
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { ProcessParams, ProcessPresetId, ProcessResult, QualityReport, Region, UploadInfo, VoiceGender, VoiceLang, VoiceRecord } from '../../../shared/types.ts';
import { GENDER_LABELS, LANG_LABELS, PROCESS_PRESETS, REF_BASE64_LIMIT } from '../../../shared/presets.ts';
import { ApiError, get, post, uploadRaw } from '../lib/api.ts';
import { useDebounced, useSettings, useStatus } from '../lib/hooks.ts';
import { bytes } from '../lib/format.ts';
import { toast, toastError } from '../lib/toast.ts';
import { Button, Field, GradeBadge, Modal, Notice, Progress, Segmented, Spinner, TagInput, Toggle } from './ui.tsx';
import { RegionEditor, WavePlayer } from './Wave.tsx';
import { Icon } from './icons.tsx';

const ACCEPT = 'audio/*,video/*,.wav,.mp3,.m4a,.aac,.flac,.ogg,.opus,.webm,.mp4,.mov';

export function QualityReportView({ report, compact }: { report: QualityReport; compact?: boolean }) {
  const b = report.before;
  const a = report.after;
  const f = (v: number | null, unit = '') => (v === null || !isFinite(v) ? '—' : `${v.toFixed(1)}${unit}`);
  const rows: [string, string, string, string?][] = [
    ['时长', `${b.durationSec.toFixed(1)} 秒`, `${a.durationSec.toFixed(1)} 秒`],
    ['响度', f(b.lufs, ' LUFS'), f(a.lufs, ' LUFS'), '整合响度（ITU-R BS.1770）'],
    ['真峰值', f(b.truePeakDb, ' dBTP'), f(a.truePeakDb, ' dBTP'), '4 倍过采样估算，防止样本间削波'],
    ['底噪', f(b.noiseFloorDb, ' dB'), f(a.noiseFloorDb, ' dB')],
    ['信噪比', f(b.snrDb, ' dB'), f(a.snrDb, ' dB'), '人声电平与底噪之差，越高越干净'],
    ['人声占比', `${Math.round(b.speechRatio * 100)}%`, `${Math.round(a.speechRatio * 100)}%`],
    ['最长停顿', `${b.longestPauseSec.toFixed(1)} 秒`, `${a.longestPauseSec.toFixed(1)} 秒`],
    ['削波', `${b.clipEvents} 处`, `${a.clipEvents} 处`],
  ];
  const sizePct = report.base64Bytes / REF_BASE64_LIMIT;
  return (
    <div className={`report ${compact ? 'is-compact' : ''}`}>
      <div className="report-head">
        <span>质量评估</span><GradeBadge grade={report.grade} />
        <span className="spacer" />
        <span className="muted small">编码后 {bytes(report.base64Bytes)} / 10 MB</span>
      </div>
      <Progress value={sizePct} tone={sizePct > 1 ? 'error' : sizePct > 0.8 ? 'warn' : undefined} />
      {report.warnings.length > 0 && (
        <ul className="report-warnings">
          {report.warnings.map((w) => (
            <li key={w.code} className={`lvl-${w.level}`}><Icon name={w.level === 'error' ? 'error' : w.level === 'warn' ? 'warn' : 'info'} size={15} />{w.message}</li>
          ))}
        </ul>
      )}
      {!compact && (
        <>
          <table className="report-table">
            <thead><tr><th /><th>处理前</th><th>处理后</th></tr></thead>
            <tbody>{rows.map(([k, x, y, t]) => <tr key={k} title={t}><th>{k}</th><td>{x}</td><td>{y}</td></tr>)}</tbody>
          </table>
          <ol className="report-steps">{report.steps.map((s) => <li key={s}>{s}</li>)}</ol>
        </>
      )}
    </div>
  );
}

const PRESET_OPTIONS: { value: ProcessPresetId; label: string }[] = [
  { value: 'standard', label: '标准' },
  { value: 'noisy', label: '嘈杂素材' },
  { value: 'light', label: '轻处理' },
  { value: 'fix', label: '模型生成' },
  { value: 'raw', label: '不处理' },
  { value: 'custom', label: '自定义' },
];

export function ParamsForm({ params, onChange, denoiseOk }: { params: ProcessParams; onChange: (p: ProcessParams) => void; denoiseOk: boolean }) {
  const set = <K extends keyof ProcessParams>(k: K, v: ProcessParams[K]) => onChange({ ...params, [k]: v });
  const num = (k: keyof ProcessParams, step = 1) => ({
    type: 'number' as const, step, value: String(params[k]),
    onChange: (e: ChangeEvent<HTMLInputElement>) => { const n = Number(e.target.value); if (isFinite(n)) set(k, n as never); },
  });
  return (
    <div className="params-grid">
      <Field label="采样率">
        <select value={params.sampleRate} onChange={(e) => set('sampleRate', Number(e.target.value))}>
          {[16000, 22050, 24000, 44100, 48000].map((r) => <option key={r} value={r}>{r / 1000} kHz{r === 24000 ? '（与 MiMo 输出一致）' : ''}</option>)}
        </select>
      </Field>
      <Field label="高通滤波" hint="去掉低频轰鸣和直流，0 = 关闭"><span className="unit-input"><input {...num('highpassHz', 10)} min={0} max={300} /><i>Hz</i></span></Field>
      <Field label="降噪" hint={denoiseOk ? '会带来轻微音色变化' : '当前 ffmpeg 不支持 afftdn'}>
        <select value={params.denoise} disabled={!denoiseOk} onChange={(e) => set('denoise', e.target.value as ProcessParams['denoise'])}>
          <option value="off">关闭</option><option value="light">轻度</option><option value="medium">中度</option><option value="strong">强</option>
        </select>
      </Field>
      <div className="params-pair">
        <Toggle checked={params.trimEdges} onChange={(v) => set('trimEdges', v)} label="裁掉首尾静音" />
        <span className="unit-input"><input {...num('edgePadMs', 10)} disabled={!params.trimEdges} aria-label="首尾保留" /><i>ms 保留</i></span>
      </div>
      <div className="params-pair">
        <Toggle checked={params.compressPauses} onChange={(v) => set('compressPauses', v)} label="压缩长停顿" />
        <span className="unit-input"><input {...num('maxPauseMs', 50)} disabled={!params.compressPauses} aria-label="超过多长算长停顿" /><i>ms 以上</i></span>
        <span className="unit-input"><input {...num('keepPauseMs', 50)} disabled={!params.compressPauses} aria-label="压缩后保留" /><i>ms 保留</i></span>
      </div>
      <div className="params-pair">
        <Toggle checked={params.normalize} onChange={(v) => set('normalize', v)} label="响度归一" />
        <span className="unit-input"><input {...num('targetLufs', 0.5)} disabled={!params.normalize} aria-label="目标响度" /><i>LUFS</i></span>
        <span className="unit-input"><input {...num('ceilingDb', 0.1)} disabled={!params.normalize} aria-label="峰值上限" /><i>dBTP 上限</i></span>
      </div>
      <Field label="首尾淡入淡出"><span className="unit-input"><input {...num('fadeMs', 1)} min={0} max={200} /><i>ms</i></span></Field>
    </div>
  );
}

function Recorder({ onDone }: { onDone: (b: Blob) => void }) {
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [secs, setSecs] = useState(0);
  const [raw, setRaw] = useState(true);
  const meter = useRef<HTMLSpanElement>(null);
  const stop = useRef<() => void>(() => undefined);
  useEffect(() => () => stop.current(), []);
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: !raw, noiseSuppression: !raw, autoGainControl: !raw, channelCount: 1 } });
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m));
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(1024);
      let raf = 0;
      const t0 = Date.now();
      const tick = () => {
        an.getFloatTimeDomainData(buf);
        let pk = 0;
        for (const v of buf) pk = Math.max(pk, Math.abs(v));
        if (meter.current) { meter.current.style.width = `${Math.min(100, pk * 100)}%`; meter.current.dataset.hot = pk > 0.95 ? '1' : ''; }
        setSecs((Date.now() - t0) / 1000);
        raf = requestAnimationFrame(tick);
      };
      tick();
      stop.current = () => { cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); ctx.close().catch(() => undefined); };
      mr.onstop = () => { stop.current(); setRec(null); onDone(new Blob(chunks, { type: mr.mimeType || 'audio/webm' })); };
      mr.start(250);
      setRec(mr);
    } catch (e: any) {
      toast(e?.name === 'NotAllowedError' ? '没有麦克风权限：请在浏览器地址栏允许使用麦克风' : `无法录音：${e?.message ?? e}（局域网 http 访问时浏览器会禁用麦克风，请用 localhost 或 https）`, 'err');
    }
  };
  return (
    <div className={`recorder ${rec ? 'is-on' : ''}`}>
      {rec ? (
        <>
          <span className="tally" aria-hidden="true" />
          <span className="rec-time">{secs.toFixed(1)} 秒</span>
          <span className="rec-meter"><span ref={meter} /></span>
          <Button variant="danger" icon="stop" onClick={() => rec.stop()}>结束录音</Button>
        </>
      ) : (
        <>
          <Button icon="mic" onClick={start}>录一段</Button>
          <Toggle checked={raw} onChange={setRaw} label="原声录制" hint="关闭浏览器的降噪和自动增益，音色更真实" />
        </>
      )}
    </div>
  );
}

export interface CloneEditorProps {
  target: { type: 'new' } | { type: 'version'; voiceId: string; voiceName: string };
  /** 已经存在的上传（来自合成结果、试听、旧版本） */
  initialUpload?: UploadInfo;
  /** 沿用已有版本的截取与处理参数（「调整预处理」时） */
  initial?: { preset: ProcessPresetId; params: ProcessParams; region: Region | null };
  onClose: () => void;
  onSaved: (v: VoiceRecord) => void;
}

export function CloneEditor({ target, initialUpload, initial, onClose, onSaved }: CloneEditorProps) {
  const { data: settings } = useSettings();
  const { data: status } = useStatus();
  const [upload, setUpload] = useState<UploadInfo | null>(initialUpload ?? null);
  const [uploading, setUploading] = useState(false);
  const [region, setRegion] = useState<Region | null>(initial ? initial.region : initialUpload?.suggestion ?? null);
  const modelMade = (u: UploadInfo | null) => !!u && ['quick', 'design-take', 'segment-take'].includes(u.source);
  const [preset, setPreset] = useState<ProcessPresetId>(initial?.preset ?? (modelMade(initialUpload ?? null) ? 'fix' : settings?.preprocess.defaultPreset ?? 'standard'));
  const [custom, setCustom] = useState<ProcessParams>(initial?.preset === 'custom' ? initial.params : settings?.preprocess.custom ?? PROCESS_PRESETS.standard.params);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [processing, setProcessing] = useState(false);
  const [procError, setProcError] = useState('');
  const [name, setName] = useState('');
  const [gender, setGender] = useState<VoiceGender>('');
  const [lang, setLang] = useState<VoiceLang>('zh');
  const [tags, setTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const params = preset === 'custom' ? custom : PROCESS_PRESETS[preset].params;
  const req = useDebounced(useMemo(() => ({ upload: upload?.id, region, preset, params }), [upload?.id, region, preset, params]), 350);
  const seq = useRef(0);

  useEffect(() => {
    if (!req.upload) return;
    const my = ++seq.current;
    setProcessing(true);
    setProcError('');
    post<ProcessResult>(`/api/uploads/${req.upload}/process`, { region: req.region, preset: req.preset, params: req.params })
      .then((r) => { if (my === seq.current) setResult(r); })
      .catch((e) => { if (my === seq.current) { setResult(null); setProcError(e.message); } })
      .finally(() => { if (my === seq.current) setProcessing(false); });
  }, [req]);

  const accept = async (file: Blob, nameHint: string, source: 'upload' | 'record') => {
    setUploading(true);
    try {
      const u = await uploadRaw<UploadInfo>(`/api/uploads?name=${encodeURIComponent(nameHint)}&source=${source}`, file);
      setUpload(u);
      setRegion(u.suggestion);
      setResult(null);
      if (!name && target.type === 'new') setName(nameHint.replace(/\.[^.]+$/, '').slice(0, 30));
    } catch (e) { toastError(e); } finally { setUploading(false); }
  };

  const save = async () => {
    if (!upload) return;
    setSaving(true);
    try {
      const ref = { uploadId: upload.id, region, preset, params };
      const v = target.type === 'new'
        ? await post<VoiceRecord>('/api/voices', { kind: 'clone', name: name.trim() || '新克隆音色', gender, lang, tags, ref })
        : await post<VoiceRecord>(`/api/voices/${target.voiceId}/refs`, ref);
      toast(target.type === 'new' ? '克隆音色已保存' : '参考音频已更新为新版本');
      onSaved(v);
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) toast(e.message, 'err');
      else toastError(e);
    } finally { setSaving(false); }
  };

  const denoiseOk = !!status?.ffmpeg.denoise;
  const ffmpegMissing = status && !status.ffmpeg.ok;
  const canSave = !!upload && !!result?.report.usable && !processing && (target.type === 'version' || name.trim());

  return (
    <Modal title={target.type === 'new' ? '新建克隆音色' : `替换参考音频：${target.voiceName}`} width={980} onClose={onClose} className="clone-editor"
      footer={<>
        {upload && <span className="muted small">{upload.sourceLabel ?? upload.name}，原始 {upload.info.codec} {upload.info.sampleRate / 1000} kHz {upload.info.channels > 1 ? `${upload.info.channels} 声道` : '单声道'}</span>}
        <span className="spacer" />
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" busy={saving} disabled={!canSave} onClick={save}>{target.type === 'new' ? '保存为克隆音色' : '保存为新版本并启用'}</Button>
      </>}>
      {ffmpegMissing && <Notice kind="error">服务端没有找到 ffmpeg，参考音频没法解码和处理。Docker 镜像已内置；本地运行请安装 ffmpeg 或设置 FFMPEG_PATH。</Notice>}
      {!upload ? (
        <div className={`dropzone ${drag ? 'is-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) accept(f, f.name, 'upload'); }}>
          {uploading ? <><Spinner size={22} /><p>正在读取音频…</p></> : (
            <>
              <Icon name="upload" size={26} />
              <p className="dropzone-title">把音频或视频文件拖到这里</p>
              <p className="muted small">wav、mp3、m4a、flac、ogg、webm，视频会自动提取音轨。长素材可以在下一步截取。</p>
              <div className="row gap center">
                <Button variant="primary" onClick={() => fileRef.current?.click()}>选择文件</Button>
                <span className="muted">或者</span>
                <Recorder onDone={(b) => accept(b, `录音-${new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '')}.${b.type.includes('mp4') ? 'm4a' : 'webm'}`, 'record')} />
              </div>
              <div className="tips">
                <p><b>好的参考音频</b>：一个人说话，安静无回声，10–20 秒左右，语气自然、有起伏；不要背景音乐和混响。克隆会把噪声、破音、房间声一起学走。</p>
                <p className="muted">录音时可以读这段：今天下午我去了趟菜市场，买了点青菜和豆腐。路上碰到老同学，聊了好一会儿——你猜怎么着？他居然也搬到我们小区了！</p>
              </div>
              <input ref={fileRef} type="file" accept={ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) accept(f, f.name, 'upload'); e.target.value = ''; }} />
            </>
          )}
        </div>
      ) : (
        <div className="clone-grid">
          <section className="clone-left">
            <div className="section-head">
              <h3>截取</h3>
              <span className="spacer" />
              <Button size="sm" variant="quiet" icon="refresh" onClick={() => { setUpload(null); setResult(null); setRegion(null); }}>换一个音频</Button>
            </div>
            <RegionEditor url={upload.sourceUrl} peaks={upload.peaks} duration={upload.sourceDurationSec} region={region} onChange={setRegion} suggestion={upload.suggestion} />
            <div className="section-head"><h3>标准化</h3></div>
            <Segmented value={preset} onChange={(p) => { if (p === 'custom' && preset !== 'custom') setCustom(params); setPreset(p); }} options={PRESET_OPTIONS} ariaLabel="处理预设" />
            <p className="muted small preset-hint">{preset === 'custom' ? '自己调每一项参数，改动后自动重新处理。' : PROCESS_PRESETS[preset].hint}</p>
            {preset === 'custom' && <ParamsForm params={custom} onChange={setCustom} denoiseOk={denoiseOk} />}
            <div className="ab">
              <div className="ab-head">
                <span>处理后</span>
                {processing && <Spinner />}
                {result && <span className="muted small">{(result.durationMs / 1000).toFixed(1)} 秒，{params.sampleRate / 1000} kHz 单声道</span>}
              </div>
              {result ? (
                <WavePlayer size="lg" item={{ id: `proc-${upload.id}-${result.hash}`, url: result.url, title: '处理后的参考音频', subtitle: name || upload.name, peaks: result.peaks, durationMs: result.durationMs }} />
              ) : procError ? <Notice kind="error">{procError}</Notice> : <div className="ab-placeholder"><Spinner /> 正在处理…</div>}
              <p className="muted small">对比原声：用上方波形的「播放选区」。</p>
            </div>
          </section>
          <aside className="clone-right">
            {result ? <QualityReportView report={result.report} /> : <div className="report report-empty">{processing ? <><Spinner /> 正在分析…</> : '处理完成后显示质量报告'}</div>}
            {target.type === 'new' && (
              <div className="clone-meta">
                <Field label="音色名称"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：我的声音、旁白男声" /></Field>
                <div className="row gap">
                  <Field label="性别"><select value={gender} onChange={(e) => setGender(e.target.value as VoiceGender)}>{Object.entries(GENDER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                  <Field label="语言"><select value={lang} onChange={(e) => setLang(e.target.value as VoiceLang)}>{Object.entries(LANG_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                </div>
                <Field label="标签"><TagInput value={tags} onChange={setTags} /></Field>
              </div>
            )}
            {result && !result.report.usable && <Notice kind="error">有必须解决的问题（红色项），解决后才能保存。</Notice>}
          </aside>
        </div>
      )}
    </Modal>
  );
}

/** 从已有音频（合成结果/试听/片段/旧版本）创建上传后打开编辑器 */
export async function uploadFrom(source: Record<string, unknown>): Promise<UploadInfo> {
  return post<UploadInfo>('/api/uploads/from', source);
}

export async function getUpload(id: string): Promise<UploadInfo> {
  return get<UploadInfo>(`/api/uploads/${id}`);
}
