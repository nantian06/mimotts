// 流式播放：接收 24kHz pcm16 分片，用 Web Audio 排队无缝播放
export class StreamPlayer {
  ctx: AudioContext;
  analyser: AnalyserNode;
  private next = 0;
  private sources: AudioBufferSourceNode[] = [];
  private rate: number;

  constructor(sampleRate = 24000) {
    this.ctx = new AudioContext();
    this.rate = sampleRate;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.connect(this.ctx.destination);
  }

  push(b64: string) {
    const bin = atob(b64);
    const n = Math.floor(bin.length / 2);
    if (!n) return;
    const buf = this.ctx.createBuffer(1, n, this.rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
      if (v & 0x8000) v -= 0x10000;
      ch[i] = v / 32768;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.analyser);
    const at = Math.max(this.ctx.currentTime + 0.06, this.next);
    src.start(at);
    this.next = at + buf.duration;
    this.sources.push(src);
    src.onended = () => { this.sources = this.sources.filter((s) => s !== src); };
  }

  /** 剩余待播放秒数 */
  remaining(): number { return Math.max(0, this.next - this.ctx.currentTime); }

  stop() {
    for (const s of this.sources) { try { s.stop(); } catch { /* ignore */ } }
    this.sources = [];
    this.ctx.close().catch(() => undefined);
  }
}
