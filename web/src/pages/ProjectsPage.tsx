// 剧本项目列表：新建、导入项目包、复制、回收站
import { useRef, useState } from 'react';
import type { Project, ProjectSummary } from '../../../shared/types.ts';
import { del, downloadFile, post, uploadRaw } from '../lib/api.ts';
import { useApi } from '../lib/store.ts';
import { ago, formatDuration } from '../lib/format.ts';
import { navigate } from '../lib/router.ts';
import { toast, toastError } from '../lib/toast.ts';
import { Button, Empty, IconButton, Menu, Progress, useConfirm } from '../components/ui.tsx';
import { NamePrompt } from '../components/Dialogs.tsx';
import { Icon } from '../components/icons.tsx';

export function ProjectsPage() {
  const [trash, setTrash] = useState(false);
  const { data, loading } = useApi<ProjectSummary[]>(trash ? '/api/projects?trash=1' : '/api/projects');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { confirm, node } = useConfirm();

  const doImport = async (file: File) => {
    setImporting(true);
    try {
      const p = await uploadRaw<Project>('/api/projects/import', file, 'application/zip');
      toast(`已导入「${p.name}」`);
      navigate(`/projects/${p.id}`);
    } catch (e) { toastError(e); } finally { setImporting(false); }
  };
  const act = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast(ok); } catch (e) { toastError(e); } };

  return (
    <div className="page projects-page">
      <header className="page-head">
        <h1>{trash ? '剧本回收站' : '剧本'}</h1>
        {!trash && <span className="muted small">多角色、按片段生成，拼成完整音频和字幕</span>}
        <span className="spacer" />
        {trash ? <Button icon="back" onClick={() => setTrash(false)}>返回</Button> : (
          <>
            <Menu trigger={(open) => <Button icon="more" onClick={open}>更多</Button>} items={[
              { label: importing ? '正在导入…' : '导入项目包（.zip）', icon: 'import', disabled: importing, onSelect: () => fileRef.current?.click() },
              { label: '回收站', icon: 'trash', onSelect: () => setTrash(true) },
            ]} />
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>新建剧本</Button>
          </>
        )}
        <input ref={fileRef} type="file" accept=".zip,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport(f); e.target.value = ''; }} />
      </header>
      {!data && loading && <p className="muted pad">加载中…</p>}
      {data && !data.length && (
        <Empty icon="script" title={trash ? '回收站是空的' : '还没有剧本'}>
          {!trash && <>新建一个剧本，粘贴小说或台本，让大模型拆成角色和片段；也可以按行导入。<br /><Button variant="primary" icon="plus" onClick={() => setCreating(true)}>新建剧本</Button></>}
        </Empty>
      )}
      <ul className="project-list">
        {(data ?? []).map((p) => (
          <li key={p.id} className="project-card">
            <a className="project-main" href={trash ? undefined : `#/projects/${p.id}`} onClick={(e) => { if (trash) e.preventDefault(); }}>
              <span className="project-name">{p.name}</span>
              {p.notes && <span className="muted small project-notes">{p.notes}</span>}
              <span className="project-stats muted small">
                <span><Icon name="users" size={13} /> {p.roleCount} 角色</span>
                <span><Icon name="list" size={13} /> {p.doneCount}/{p.segmentCount} 段</span>
                {p.durationMs > 0 && <span><Icon name="wave" size={13} /> {formatDuration(p.durationMs)}</span>}
                <span>{ago(p.updatedAt)}更新</span>
              </span>
              {p.segmentCount > 0 && <Progress value={p.doneCount} max={p.segmentCount} tone={p.doneCount === p.segmentCount ? 'ok' : undefined} />}
            </a>
            <div className="project-actions">
              {trash ? (
                <>
                  <Button size="sm" icon="restore" onClick={() => act(() => post(`/api/projects/${p.id}/restore`), '已恢复')}>恢复</Button>
                  <IconButton size="sm" icon="trash" label="彻底删除" onClick={async () => {
                    if (await confirm('彻底删除', `彻底删除「${p.name}」和它生成的所有音频？无法恢复。`, '彻底删除', true)) act(() => del(`/api/projects/${p.id}`), '已删除');
                  }} />
                </>
              ) : (
                <Menu trigger={(open) => <IconButton size="sm" icon="more" label="更多操作" onClick={open} />} items={[
                  { label: '复制', icon: 'copy', onSelect: () => act(() => post(`/api/projects/${p.id}/duplicate`), '已复制') },
                  { label: '导出项目包', icon: 'export', onSelect: () => act(async () => { const r = await post<{ url: string; name: string }>(`/api/projects/${p.id}/export`, { format: 'package' }); downloadFile(r.url, r.name); }) },
                  'sep',
                  { label: '移入回收站', icon: 'trash', danger: true, onSelect: () => act(() => post(`/api/projects/${p.id}/trash`), '已移入回收站') },
                ]} />
              )}
            </div>
          </li>
        ))}
      </ul>
      {creating && (
        <NamePrompt title="新建剧本" label="剧本名称" initial="" ok="创建" onClose={() => setCreating(false)}
          onSubmit={async (name) => { const p = await post<Project>('/api/projects', { name }); navigate(`/projects/${p.id}`); }} />
      )}
      {node}
    </div>
  );
}
