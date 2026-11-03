# MiMo TTS 工作台：进度与交接说明

> 最后更新：2026-11-03。后端已完成并通过测试，前端完成了一部分。接手的人先读完本文件。

## 1. 已确认的需求

- 新建项目（不是 fork 别人的）。交互形态 = **快速合成** + **剧本 / 时间轴**；单人使用，不做账号；不和图片工作台合并。
- 适配小米 MiMo 的三个 TTS 模型：`mimo-v2.5-tts`（预置音色）、`-voicedesign`（音色设计）、`-voiceclone`（音色克隆）。
- **音色库**要区分「设计」和「克隆」，并且方便管理。设计音色的流程是：试听抽卡 → 挑一条「固化」→ 之后走 voiceclone。
- **克隆参考音频的标准化处理**（用户特别强调）：转单声道、重采样、高通、降噪、裁首尾静音、压缩长停顿、BS.1770 响度归一、真峰值限幅，并出质量报告。
- 大模型辅助走 OpenAI 兼容接口，**默认模型由用户自己在设置里配置**，代码里不要写死。
- git 提交**不要带 Claude-Session 会话链接**。

## 2. 技术栈与约束

- 构建环境里 npm 源不可用，所以服务端是**零运行时依赖**：Node ≥ 22.18 原生剥离类型，直接跑 `.ts`。
  - import 必须写 `.ts` 后缀。
  - 不能用 enum、namespace、参数属性。
  - 类型导入用 `import type`。
- 前端：React 19 + esbuild 打包，这两个是仅有的依赖。前端的 React 类型要等 `npm i` 装上 `@types/react` 后才能做类型检查。
- 系统依赖 ffmpeg：解码任意格式、afftdn 降噪、MP3 导出。可以用 `FFMPEG_PATH` 指定路径；如果装了 `ffmpeg-static` 也会自动识别。
- 端口 8788（图片工作台用 8787）。数据目录 `DATA_DIR`，默认 `./data`。可选访问口令 `ACCESS_TOKEN`。
- 首次启动可以用这些环境变量初始化：`MIMO_API_KEY`、`MIMO_BASE_URL`、`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`。

## 3. 完成情况

### 后端（已完成，测试全部通过）

`npm test` 共 33 项：单元测试加接口集成测试，跑的是模拟上游。

| 模块 | 文件 | 说明 |
|---|---|---|
| HTTP 框架 | `server/http.ts`、`server/index.ts`、`server/routes.ts` | 路由、JSON/原始请求体、Range 文件服务、SSE、口令 Cookie |
| MiMo 适配 | `server/mimo/request.ts`、`client.ts` | 三模型请求构造（文本放 assistant，指令/描述放 user）；流式 pcm16 SSE；错误映射 |
| 合成引擎 | `server/synth/engine.ts` | 长文本切块，开头 (风格) 标签按设置沿用；429/5xx 退避重试；裁静音；按句/段停顿拼接 |
| 任务队列 | `server/synth/queue.ts`、`server/events.ts` | 并发上限、取消、进度；通过 SSE 推送 `job` 和 `change` 事件 |
| 业务编排 | `server/synth/service.ts` | 快速合成（含 NDJSON 流式）、设计抽卡、标准试听、片段批量生成（missing/stale/all/selected）、导出 |
| 音频 | `server/audio/dsp.ts`、`preprocess.ts`、`ffmpeg.ts`、`wav.ts` | BS.1770 响度、4 倍过采样真峰值、前瞻限幅、VAD、停顿压缩、自动推荐截取区间、质量报告与分级 |
| 存储 | `server/store/*.ts` | 一个音色/项目一个文件夹；回收站；音色和项目包的 zip 导入导出 |
| 大模型 | `server/llm/*.ts`、`server/llm/prompts/*.md` | 9 个任务的模板，用户可在 `data/prompts/` 覆盖；JSON 解析失败自动重试一次；剧本拆分带原文覆盖率校验 |
| 共享 | `shared/*.ts` | 类型、预置音色/标签/处理预设、切块、导演模式、差异对比、SRT、片段生效配置与过期检测 |
| 模拟上游 | `scripts/mock-upstream.ts` | 模拟 MiMo 三模型（严格校验请求规则）和 LLM；`npm run mock`，端口 18790 |

接口清单直接看 `server/routes.ts`，按「系统 / 音色库 / 上传与预处理 / 快速合成 / 任务 / 剧本 / 大模型」分区。

### 前端（进行中）

已完成，都在 `web/src/` 下：

- `lib/api.ts`：请求封装。
- `lib/store.ts`：`useApi` 缓存 + SSE 自动失效 + 任务状态 `useJobs`/`waitForJob`。
- `lib/player.ts`：全局播放器，支持连播和电平表。
- `lib/stream.ts`：流式 PCM 播放。
- `lib/router.ts`：hash 路由。
- `lib/hooks.ts`、`lib/format.ts`、`lib/toast.ts`。
- `components/ui.tsx`：Button、Modal、Menu、Segmented、Toggle、TagInput、AutoTextarea、Notice、GradeBadge、Progress、useConfirm。
- `components/icons.tsx`、`components/Wave.tsx`（缩略波形播放器 `WavePlayer`、区间编辑器 `RegionEditor`）。
- `components/Assist.tsx`：模型选择、请求查看 DebugPanel、差异视图，以及指令、标签、描述三个辅助对话框。
- `components/Editors.tsx`：风格指令编辑器（自然语言/导演模式）、带标签面板和切块预览的文本编辑器。
- `components/VoicePicker.tsx`：音色选择，包括临时设计音色。
- `components/CloneEditor.tsx`：上传/录音 → 截取 → 预设/自定义参数 → 实时质量报告 → 保存为音色或新版本。导出 `QualityReportView`、`ParamsForm`、`uploadFrom`。
- `components/Transport.tsx`：底部走带条（播放、进度、电平、任务队列）。

**还没写**（按这个顺序做）：

1. `web/index.html`、`web/src/main.tsx`、`web/src/App.tsx`
   - 左侧导航：快速合成 `#/quick`、剧本 `#/projects`、音色库 `#/voices`、设置 `#/settings`。
   - 底部放 `<Transport/>`，全局放 Toast 容器。
   - 启动时调用 `connectEvents()`。
   - 用 `onUnauthorized` 弹出口令框，提交到 `POST /api/login {token}`。
2. `web/src/pages/QuickPage.tsx`
   - 左侧：`VoiceSlot` + `InstructionEditor` + `TextEditor` + 生成按钮。未固化的设计音色要禁用指令并说明原因；草稿存 localStorage。
   - 预置音色且设置里开了 `streamPreset` 时：`fetch POST /api/synth/stream`，按行读 NDJSON（类型有 start/audio/progress/retry/done/error），用 `StreamPlayer.push`，并调用 `setLive()`。
   - 其他情况：`POST /api/synth` 得到 job，`waitForJob` 后播放。
   - 右侧是历史 `GET /api/quick`，每条的操作：
     - 播放；下载 WAV/MP3，用 `downloadUrl(url, name, mp3)`。
     - 复用参数；收藏/删除（`PATCH`/`DELETE /api/quick/:id`）；清空未收藏（`POST /api/quick/clear`）。
     - 存为克隆音色：`uploadFrom({type:'quick', id})` 后打开 `CloneEditor`，传入 `initialUpload`。
     - 存为设计音色：只有临时设计的结果才有，`POST /api/voices/from-quick {resultId,name}`。
     - 送入项目：`POST /api/quick/:id/to-project {projectId, roleId}`。
3. `web/src/pages/VoicesPage.tsx` + `VoiceDetail.tsx`
   - 列表：`GET /api/voices` 和 `?trash=1`。按类型/收藏/标签/性别/语言筛选，支持搜索。
   - 卡片用 `kind-edge-*` 色条区分类型，显示状态（复用 `voiceStatusText`）、试听、被引用数 `refCount`。
   - 新建：设计音色 `POST /api/voices {kind:'design', name, description}`；克隆音色走 `CloneEditor`；预置变体 `{kind:'preset', presetId}`。
   - 导入/导出：`POST /api/voices/import`（原始 zip 请求体）、`POST /api/voices/export {ids}`（用 `downloadPost`）。
   - 对比试听：`POST /api/voices/compare {ids, text}`，等任务完成后依次 `playSequence`。
   - 详情页：`GET /api/voices/:id`，返回 `urls.takes`、`urls.refs[version]`、`references`。
     - 通用字段：`PATCH`，包括名称、标签、语言、性别、备注、收藏、`defaultInstruction`。
     - 标准试听：`POST /api/voices/:id/preview`。
     - 复制、移入回收站、恢复、彻底删除、导出。
   - 设计音色详情：
     - 描述编辑，可用 `DesignAssist` 润色。
     - 抽卡：`POST /api/voices/:id/takes {count,text,optimizeTextPreview}`。
     - 试听列表：收藏/备注 `PATCH`、删除。
     - 固化：`POST /fix {takeId}`；取消固化：`POST /unfix`。
     - 另存为克隆：`uploadFrom({type:'design-take', voiceId, takeId})`。
     - 已固化时显示当前固化的是哪一条，并显示 `refs` 的质量报告。
   - 克隆音色详情：
     - 当前版本：处理后的音频 + 原始音频 + `QualityReportView`。
     - 版本列表：`activate`/`DELETE`。
     - 调整预处理：`uploadFrom({type:'voice-ref', voiceId, version})`，再用 `CloneEditor`，target 设为 version。
     - 替换参考音频：`CloneEditor`，target 设为 version，不传 initialUpload。
4. `web/src/pages/ProjectsPage.tsx` + `ProjectEditor.tsx`
   - 列表、新建、导入项目包、回收站、复制。
   - 编辑器 `GET /api/projects/:id`，返回 `filesBase` + 片段 takes 的 `file`，音频 URL = `filesBase + file`。
   - 角色面板：`POST`/`PATCH`/`DELETE` roles，用 `VoiceSlot` 时设置 `allowAdhoc=false`。
   - 片段行：用 `useDraft` 防止 SSE 刷新覆盖正在输入的内容；`effectiveSegment`/`staleReasons` 显示继承来源与过期原因；`lastError`；任务状态用 `useJobs(j=>j.segmentId===s.id)`；版本切换写 `activeTakeId`；锁定、拆分、合并、上下移动（`reorder`）。
   - 批量：`segments/batch`、`segments/delete`、`generate {mode, ids}`、`cancel`。
   - 导入文本：
     - AI 拆分：`POST /split` 返回 job，`waitForJob` 后 `job.result` 是 `SplitPreview`。预览确认后 `POST /apply-split {roles, segments, replaceAll}`。
     - 按行拆分：不调大模型，直接 `POST /segments {items}`。
   - 配音推荐：`POST /cast`，返回 suggestions，逐个 `PATCH` role 的 voiceId。
   - 批量补指令/标签：`POST /llm-batch {task, ids, intent}`，用 `DiffView` 预览，确认后 `POST /segments/values {values}`。
   - 导出：`POST /export {format: wav|mp3|srt|zip|package, includeRole, splitSentences}`，列表 `GET /exports`。
   - 连播：用 `playSequence(items, start, tag)`，`pauseAfterMs` 取 `segmentPause()`。
5. `web/src/pages/SettingsPage.tsx`
   - MiMo：Base URL（预设见 `MIMO_BASE_URLS`）、Key（留空不改）、`POST /api/settings/test-mimo`、并发、重试、超时、切块字数、停顿、开关项。
   - 大模型：端点增删改；`POST /api/llm/models {endpointId|baseUrl,apiKey}` 获取模型列表；默认模型 `defaultModel`；温度；`extraBody`。端点预设可提供 CPA `http://host.docker.internal:8317/v1`。
   - 预处理：默认预设、自定义参数（`ParamsForm`）、时长阈值。
   - 提示词模板：`GET /api/prompts`、`PUT /api/prompts/:task {system,user,temperature}`、`DELETE` 恢复默认。
   - 界面：标签括号、试听文本、主题、项目默认停顿、版本保留数。
   - 系统状态：`GET /api/status`。
   - 保存都用 `PUT /api/settings`，提交 patch。
6. `web/src/styles/app.css`：在 `main.tsx` 里 import，esbuild 会打包成 `app.css`。组件已经用到的类名在各 tsx 里。
   - 视觉方向：录音棚控制台。冷色纸面 `--paper #F5F6F8`，墨蓝 `--ink #18233D` 作主色，信号红 `--signal #E2463C` 只用于实时/录音/正在播放状态（`.tally`）。
   - 三类音色用色：预置青 `#2F7D8C`、设计紫 `#7A4FD1`、克隆赭 `#C07A12`，对应 `.kind-*` 和 `.kind-edge-*`。
   - 标题用宋体（`Songti SC`/`Noto Serif SC`），正文用系统黑体，数字用 `tabular-nums`。
   - 要支持深色模式，以及 `prefers-reduced-motion`。
7. `scripts/build.ts`：esbuild 入口 `web/src/main.tsx` → `dist/web/assets/app.js` + `app.css`，生成 `dist/web/index.html`。参数：`jsx: 'automatic'`、`bundle`、`minify`、`target: es2022`。
8. `scripts/dev.ts`：esbuild watch + `node --watch server/index.ts`。
9. `Dockerfile`：多阶段，先 node:22-slim `npm i && npm run build`；运行阶段 node:22-slim + `apt-get install ffmpeg`，只复制 `server shared dist package.json`，`CMD node server/index.ts`，`VOLUME /data`，`ENV DATA_DIR=/data PORT=8788`。
   - 再加 `docker-compose.yml`，带 `extra_hosts host.docker.internal:host-gateway`。
10. `README.md`、`scripts/e2e.ts`（Playwright + 模拟上游）。

## 4. 本地运行

```bash
npm i                # 安装 react/esbuild/types
npm run mock         # 另开终端：模拟 MiMo + LLM（http://localhost:18790/v1）
npm run build && npm start   # 前端写完后
npm test             # 后端测试（需要 ffmpeg）
```

## 5. 待用户实测确认的事项

需要拿真实 Key 测，测完再调默认值：

1. 同一段描述多次调用 voicedesign，音色是否一致（决定「固化」有多必要）。
2. 克隆参考音频的最佳时长。目前阈值：短于 4 秒提示偏短，长于 30 秒提示偏长，长于 90 秒禁止保存。在设置里可以改。
3. 单次请求实际能放多少字。目前默认 `maxChars` 为 300。
4. Token Plan 的 Key（`tp-`）能不能调用 TTS。
5. 鉴权头：目前同时发送 `Authorization: Bearer` 和 `api-key`。
