// 片段的「实际生效配置」：角色 → 音色 → 指令的继承关系，以及判断已生成音频是否过期
import type { Project, Segment, SegmentTake, VoiceSummary } from './types.ts';

export type InstructionSource = 'segment' | 'role' | 'voice' | 'none';

export interface EffectiveSegment {
  roleId: string | null;
  roleName: string;
  voiceId: string | null;
  voice: VoiceSummary | null;
  voiceVersion: string;
  instruction: string;
  instructionSource: InstructionSource;
  /** 未固化的设计音色不能带风格指令 */
  instructionIgnored: boolean;
  text: string;
  problems: string[];
}

export function effectiveSegment(project: Project, seg: Segment, voices: Map<string, VoiceSummary>): EffectiveSegment {
  const role = seg.roleId ? project.roles.find((r) => r.id === seg.roleId) ?? null : null;
  const voiceId = role?.voiceId ?? null;
  const voice = voiceId ? voices.get(voiceId) ?? null : null;
  const problems: string[] = [];
  if (!role) problems.push('未指定角色');
  else if (!voiceId) problems.push(`角色「${role.name}」未绑定音色`);
  else if (!voice) problems.push('绑定的音色不存在');
  else if (voice.trashed) problems.push('绑定的音色在回收站中');
  if (!seg.text.trim()) problems.push('文本为空');

  let instruction = '';
  let instructionSource: InstructionSource = 'none';
  if (seg.instruction.trim()) { instruction = seg.instruction.trim(); instructionSource = 'segment'; }
  else if (role?.instruction.trim()) { instruction = role.instruction.trim(); instructionSource = 'role'; }
  else if (voice?.defaultInstruction.trim()) { instruction = voice.defaultInstruction.trim(); instructionSource = 'voice'; }

  const instructionIgnored = !!voice && voice.mode === 'design' && !!instruction;
  return {
    roleId: role?.id ?? null,
    roleName: role?.name ?? '',
    voiceId,
    voice,
    voiceVersion: voice?.version ?? '',
    instruction: instructionIgnored ? '' : instruction,
    instructionSource,
    instructionIgnored,
    text: seg.text.trim(),
    problems,
  };
}

export function activeTake(seg: Segment): SegmentTake | null {
  if (!seg.activeTakeId) return null;
  return seg.takes.find((t) => t.id === seg.activeTakeId) ?? null;
}

/** 已生成的音频与当前配置不一致的原因（空数组 = 没过期） */
export function staleReasons(seg: Segment, eff: EffectiveSegment): string[] {
  const take = activeTake(seg);
  if (!take) return [];
  const out: string[] = [];
  if (take.text !== eff.text) out.push('文本已改');
  if (take.instruction !== eff.instruction) out.push('指令已改');
  if (eff.voiceId && take.voiceId !== eff.voiceId) out.push('音色已换');
  else if (eff.voiceId && take.voiceVersion !== eff.voiceVersion) out.push('音色已更新');
  return out;
}

export function segmentPause(project: Project, seg: Segment): number {
  return seg.pauseAfterMs ?? project.settings.defaultGapMs;
}
