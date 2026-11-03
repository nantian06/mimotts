// 应用外壳：左侧导航、页面路由、底部走带条、全局提示、访问口令
import { useEffect, useState } from 'react';
import { connectEvents, invalidate } from './lib/store.ts';
import { onUnauthorized, post } from './lib/api.ts';
import { useRoute, navigate } from './lib/router.ts';
import { useSettings, useStatus } from './lib/hooks.ts';
import { lsSet } from './lib/format.ts';
import { useToasts } from './lib/toast.ts';
import { Transport } from './components/Transport.tsx';
import { Icon } from './components/icons.tsx';
import { Button, Field, Modal, Notice } from './components/ui.tsx';
import { QuickPage } from './pages/QuickPage.tsx';
import { VoicesPage } from './pages/VoicesPage.tsx';
import { VoiceDetail } from './pages/VoiceDetail.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { ProjectEditor } from './pages/ProjectEditor.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';

const NAV = [
  { path: '/quick', label: '快速合成', icon: 'bolt' },
  { path: '/projects', label: '剧本', icon: 'script' },
  { path: '/voices', label: '音色库', icon: 'library' },
  { path: '/settings', label: '设置', icon: 'settings' },
];

function Toasts() {
  const list = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <Icon name={t.kind === 'err' ? 'error' : t.kind === 'info' ? 'info' : 'check'} size={16} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await post('/api/login', { token });
      onDone();
    } catch (e: any) { setErr(e?.message ?? String(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title="需要访问口令" width={400} onClose={() => undefined}
      footer={<Button variant="primary" busy={busy} disabled={!token} onClick={submit}>进入</Button>}>
      <p className="muted small">这个工作台设置了访问口令（环境变量 ACCESS_TOKEN）。输入一次后浏览器会记住。</p>
      <Field label="口令" error={err}>
        <input type="password" value={token} autoComplete="current-password" onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && token) submit(); }} data-autofocus />
      </Field>
    </Modal>
  );
}

function useTheme() {
  const { data } = useSettings();
  const theme = data?.ui.theme;
  useEffect(() => {
    if (!theme) return;
    const root = document.documentElement;
    if (theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = theme;
    lsSet('mt.theme', theme);
  }, [theme]);
}

function SetupBanner({ path }: { path: string }) {
  const { data: st } = useStatus();
  if (!st || path.startsWith('/settings')) return null;
  if (!st.mimoConfigured) {
    return (
      <div className="setup-banner">
        <Notice kind="warn" action={<Button size="sm" variant="primary" onClick={() => navigate('/settings?tab=mimo')}>去填写</Button>}>
          还没有填写 MiMo 的 API Key，合成不了。到「设置 → MiMo 接口」填一下。
        </Notice>
      </div>
    );
  }
  if (!st.ffmpeg.ok) {
    return (
      <div className="setup-banner">
        <Notice kind="warn">服务端没有找到 ffmpeg：克隆参考音频处理和 MP3 导出用不了。安装 ffmpeg 或设置 FFMPEG_PATH 后重启。</Notice>
      </div>
    );
  }
  return null;
}

export function App() {
  const route = useRoute();
  const [needLogin, setNeedLogin] = useState(false);
  useTheme();
  useEffect(() => {
    onUnauthorized(() => setNeedLogin(true));
    connectEvents();
  }, []);

  const [section, id] = route.parts;
  let page;
  if (section === 'voices' && id) page = <VoiceDetail key={id} id={id} />;
  else if (section === 'voices') page = <VoicesPage />;
  else if (section === 'projects' && id) page = <ProjectEditor key={id} id={id} />;
  else if (section === 'projects') page = <ProjectsPage />;
  else if (section === 'settings') page = <SettingsPage tab={route.query.get('tab') ?? 'mimo'} />;
  else page = <QuickPage />;

  return (
    <div className="app">
      <nav className="sidebar" aria-label="主导航">
        <a className="brand" href="#/quick" aria-label="MiMo TTS 工作台">
          <span className="brand-mark" aria-hidden="true"><Icon name="wave" size={18} /></span>
          <span className="brand-text"><b>MiMo</b> 语音工作台</span>
        </a>
        <ul>
          {NAV.map((n) => {
            const on = `/${section ?? 'quick'}` === n.path;
            return (
              <li key={n.path}>
                <a href={`#${n.path}`} className={on ? 'is-on' : ''} aria-current={on ? 'page' : undefined}>
                  <Icon name={n.icon} size={18} /><span>{n.label}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      <main className="main">
        <SetupBanner path={route.path} />
        {page}
      </main>
      <Transport />
      <Toasts />
      {needLogin && <Login onDone={() => { setNeedLogin(false); invalidate(() => true); }} />}
    </div>
  );
}
