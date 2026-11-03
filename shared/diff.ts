// 字符级差异（Myers O(ND)），用于预览大模型对文本的改动

export interface DiffPart {
  type: 'same' | 'add' | 'del';
  text: string;
}

export function diffChars(a: string, b: string): DiffPart[] {
  const A = Array.from(a);
  const B = Array.from(b);
  const N = A.length;
  const M = B.length;
  const max = N + M;
  if (max === 0) return [];
  // 过长时退化为整体替换，避免卡顿
  if (N * M > 4_000_000 && max > 6000) {
    return [
      ...(a ? [{ type: 'del' as const, text: a }] : []),
      ...(b ? [{ type: 'add' as const, text: b }] : []),
    ];
  }
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= N && y >= M) { found = true; break; }
    }
  }
  trace.push(v.slice());
  // 回溯
  const ops: DiffPart['type'][] = [];
  const chars: string[] = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vv[offset + k - 1] < vv[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push('same'); chars.push(A[x - 1]); x--; y--; }
    if (d === 0) break;
    if (x === prevX) { ops.push('add'); chars.push(B[y - 1]); y--; }
    else { ops.push('del'); chars.push(A[x - 1]); x--; }
  }
  while (x > 0 && y > 0) { ops.push('same'); chars.push(A[x - 1]); x--; y--; }
  while (x > 0) { ops.push('del'); chars.push(A[x - 1]); x--; }
  while (y > 0) { ops.push('add'); chars.push(B[y - 1]); y--; }
  ops.reverse();
  chars.reverse();
  const out: DiffPart[] = [];
  ops.forEach((t, i) => {
    const last = out[out.length - 1];
    if (last && last.type === t) last.text += chars[i];
    else out.push({ type: t, text: chars[i] });
  });
  return out;
}
