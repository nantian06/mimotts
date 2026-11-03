// 小型通用对话框：输入名称、送入剧本项目
import { useState } from 'react';
import type { ProjectSummary, Project } from '../../../shared/types.ts';
import { post } from '../lib/api.ts';
import { useApi } from '../lib/store.ts';
import { toast, toastError } from '../lib/toast.ts';
import { navigate } from '../lib/router.ts';
import { Button, Field, Modal, Notice } from './ui.tsx';

export function NamePrompt({ title, label = '名称', initial = '', ok = '确定', hint, onSubmit, onClose }: {
  title: string; label?: string; initial?: string; ok?: string; hint?: string;
  onSubmit: (name: string) => Promise<void> | void; onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await onSubmit(name.trim()); onClose(); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} width={440} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" busy={busy} disabled={!name.trim()} onClick={go}>{ok}</Button></>}>
      <Field label={label} hint={hint}>
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); }} data-autofocus />
      </Field>
    </Modal>
  );
}

/** 把快速合成结果送进某个剧本项目 */
export function SendToProject({ resultId, onClose }: { resultId: string; onClose: () => void }) {
  const { data: list } = useApi<ProjectSummary[]>('/api/projects');
  const [projectId, setProjectId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const pid = projectId || list?.[0]?.id || '';
  const { data: project } = useApi<Project>(pid ? `/api/projects/${pid}` : null);
  const go = async () => {
    setBusy(true);
    try {
      await post(`/api/quick/${resultId}/to-project`, { projectId: pid, roleId: roleId || null });
      toast('已追加到剧本末尾');
      onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="送入剧本" width={480} onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" busy={busy} disabled={!pid} onClick={go}>追加到末尾</Button>
      </>}>
      {list && !list.length ? (
        <Notice kind="info" action={<Button size="sm" onClick={() => { onClose(); navigate('/projects'); }}>去新建</Button>}>还没有剧本项目。</Notice>
      ) : (
        <>
          <Field label="项目">
            <select value={pid} onChange={(e) => { setProjectId(e.target.value); setRoleId(''); }}>
              {(list ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}（{p.segmentCount} 段）</option>)}
            </select>
          </Field>
          <Field label="角色" hint="自动：优先找绑定了同一音色的角色，找不到就新建一个">
            <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              <option value="">自动匹配</option>
              {(project?.roles ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
          <p className="muted small">这条音频会作为新片段的已生成版本，不会重新合成。</p>
        </>
      )}
    </Modal>
  );
}
