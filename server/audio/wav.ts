// WAV 编解码与 PCM 工具（单声道 Float32 为内部统一格式）

export interface PcmAudio {
  sampleRate: number;
  /** 单声道，-1..1 */
  samples: Float32Array;
}

export function decodeWav(buf: Uint8Array): PcmAudio & { channels: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (buf.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('不是 WAV 文件');
  let p = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataOff = -1;
  let dataLen = 0;
  while (p + 8 <= buf.length) {
    const id = tag(p);
    let size = dv.getUint32(p + 4, true);
    const body = p + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      const channels = dv.getUint16(body + 2, true);
      const sampleRate = dv.getUint32(body + 4, true);
      const bits = dv.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true);
      fmt = { format, channels, sampleRate, bits };
    } else if (id === 'data') {
      dataOff = body;
      // 流式写出的 WAV 可能把长度写成 0 或 0xFFFFFFFF
      if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      dataLen = size;
      break;
    }
    p = body + size + (size & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('WAV 文件缺少 fmt/data 块');
  const { format, channels, sampleRate, bits } = fmt;
  const bps = bits / 8;
  const frames = Math.floor(dataLen / (bps * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const o = dataOff + (i * channels + c) * bps;
      let v: number;
      if (format === 3 && bits === 32) v = dv.getFloat32(o, true);
      else if (format === 3 && bits === 64) v = dv.getFloat64(o, true);
      else if (bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (bits === 24) {
        let x = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
        if (x & 0x800000) x |= ~0xffffff;
        v = x / 8388608;
      } else if (bits === 32) v = dv.getInt32(o, true) / 2147483648;
      else if (bits === 8) v = (buf[o] - 128) / 128;
      else throw new Error(`不支持的 WAV 位深：${bits}`);
      acc += v;
    }
    out[i] = acc / channels;
  }
  return { sampleRate, samples: out, channels };
}

/** 编码为 16-bit PCM 单声道 WAV */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

export function pcm16ToFloat(buf: Uint8Array): Float32Array {
  const n = Math.floor(buf.length / 2);
  const dv = new DataView(buf.buffer, buf.byteOffset, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
  return out;
}

export function concatFloat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function silence(ms: number, sampleRate: number): Float32Array {
  return new Float32Array(Math.max(0, Math.round((ms / 1000) * sampleRate)));
}

/** 波形峰值（0..1），用于前端绘制缩略波形 */
export function computePeaks(samples: Float32Array, count = 160): number[] {
  const out: number[] = [];
  if (!samples.length) return new Array(count).fill(0);
  const step = samples.length / count;
  for (let i = 0; i < count; i++) {
    const a = Math.floor(i * step);
    const b = Math.max(a + 1, Math.floor((i + 1) * step));
    let m = 0;
    for (let j = a; j < b && j < samples.length; j++) {
      const v = Math.abs(samples[j]);
      if (v > m) m = v;
    }
    out.push(Math.round(Math.min(1, m) * 1000) / 1000);
  }
  return out;
}

export function durationMs(a: PcmAudio): number {
  return Math.round((a.samples.length / a.sampleRate) * 1000);
}
