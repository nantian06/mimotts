# MiMo TTS 工作台：进度与交接说明

> 最后更新：2026-11-03。后端、前端、构建脚本、Docker 部署、README、端到端测试都已完成。接手的人先读完本文件。

## 1. 已确认的需求

- 新建项目（不是 fork 别人的）。交互形态 = **快速合成** + **剧本 / 时间轴**；单人使用，不做账号；不和图片工作台合并。
- 适配小米 MiMo 的三个 TTS 模型：`mimo-v2.5-tts`（预置音色）、`-voicedesign`（音色设计）、`-voiceclone`（音色克隆）。
- **音色库**要区分「设计」和「克隆」，并且方便管理。设计音色的流程是：试听抽卡 → 挑一条「固化」→ 之后走 voiceclone。
- **克隆参考音频的标准化处理**（用户特别强调）：转单声道、重采样、高通、降噪、裁首尾静音、压缩长停顿、BS.1770 响度归一、真峰值限幅，并出质量报告。
- 大模型辅助走 OpenAI 兼容接口，**默认模型由用户自己在设置里配置**，代码里不要写死。
- git 提交**不要带 Claude-Session 会话链接**。

## 2. 技术栈与约束

- 服务端是**零运行时依赖**：Node ≥ 22.18 原生剥离类型，直接跑 `.ts`。
  - import 必须写 `.ts` 后缀。
  - 不能用 enum、namespace、参数属性。
  - 类型导入用 `import type`。
- 前端：React 19 + esbuild 打包，这两个是仅有的依赖。`npm run typecheck` 同时检查前后端。
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

### 前端（已完成）

都在 `web/src/` 下。

| 部分 | 文件 | 说明 |
|---|---|---|
| 入口 | `main.tsx`、`App.tsx`、`env.d.ts` | 左侧导航、hash 路由、底部走带条、Toast、访问口令弹窗、主题、未配置 Key / 缺 ffmpeg 的提示条 |
| 基础库 | `lib/*.ts` | 请求封装（含 `startDownload`/`downloadFile`）、`useApi` 缓存 + SSE 失效、任务状态、全局播放器、流式 PCM 播放 |
| 通用组件 | `components/*.tsx` | 按钮/弹窗/菜单等、波形与区间编辑器、指令与文本编辑器、音色选择、克隆参考音频编辑器（支持沿用旧版本参数 `initial`）、大模型辅助对话框、`Dialogs.tsx`（命名、送入剧本） |
| 快速合成 | `pages/QuickPage.tsx` | 草稿存 localStorage；预置音色流式（NDJSON）边生成边播放，其他走任务队列；Ctrl/⌘+Enter；历史：播放、下载 WAV/MP3、复用参数、收藏、删除、清空未收藏、存为克隆/设计音色、送入剧本 |
| 音色库 | `pages/VoicesPage.tsx`、`pages/VoiceDetail.tsx` | 列表筛选（类型/收藏/性别/语言/标签/搜索）、多选对比试听与导出、导入、回收站；新建设计/克隆/预置变体；详情页：基本信息、标准试听、设计音色描述与抽卡/固化/取消固化/另存克隆、参考音频版本（启用/删除/调整预处理/替换） |
| 剧本 | `pages/ProjectsPage.tsx`、`pages/ProjectEditor.tsx`、`pages/ProjectDialogs.tsx` | 列表、新建、导入项目包、复制、回收站；编辑器：角色面板（颜色、音色、指令、设定、删除时转移片段）、片段行（继承来源、过期原因、错误、任务状态、版本切换与收藏、锁定、光标处拆分、插入、拖动排序、段后停顿）、批量（设角色、生成、补指令、打标签、锁定、合并、删除）、AI 拆分预览可编辑、按行导入（识别「角色：台词」）、配音推荐、导出与导出记录、连播 |
| 设置 | `pages/SettingsPage.tsx` | MiMo（地址预设、Key、测试连接并播放）、大模型端点增删改与获取模型列表、默认模型、额外参数 JSON 校验、预处理默认预设与参数、提示词模板编辑/恢复默认、界面与剧本默认值、系统状态 |
| 样式 | `styles/app.css` | 录音棚控制台风格；三类音色色条；深色模式（跟随系统或手动）；`prefers-reduced-motion`；窄屏布局 |

### 构建、部署与测试

- `scripts/build.ts`：esbuild → `dist/web/assets/app.js` + `app.css`，生成 `dist/web/index.html`（带版本号防缓存）。
- `scripts/dev.ts`：esbuild watch + `node --watch-path=server --watch-path=shared`。
- `Dockerfile`（多阶段，运行阶段只装 ffmpeg，带 HEALTHCHECK）、`docker-compose.yml`（含 `host.docker.internal`）、`.dockerignore`。**镜像构建还没有实际跑过**（开发环境没有 Docker 守护进程）。
- `scripts/e2e.ts`：Playwright + 模拟上游，10 步覆盖快速合成（流式）、设计抽卡与固化、克隆上传与标准化、音色库筛选、剧本导入/配音推荐/生成/过期检测/导出、AI 拆分预览、设置各页、深色模式、窄屏无横向滚动；截图在 `e2e-shots/`。页面有 JS 报错也会判失败。
- 下载文件名：服务端 `Content-Disposition` 同时带 ASCII `filename=` 兜底和 UTF-8 `filename*=`（`server/http.ts` 的 `contentDisposition`）。

### 后续可以做的

- 实际构建一次 Docker 镜像并在容器里跑通。
- 剧本片段很多（上百段）时可以考虑虚拟列表。
- 拿真实 Key 测完第 5 节的问题后调整默认值。

## 4. 本地运行

```bash
npm i                # 安装 react/esbuild/types
npm run mock         # 另开终端：模拟 MiMo + LLM（http://localhost:18790/v1）
npm run build && npm start   # http://localhost:8788
npm run dev          # 开发模式
npm test             # 后端测试（需要 ffmpeg）
npm run e2e          # 端到端测试（需要先 build；需要 Playwright）
```

## 5. 待用户实测确认的事项

需要拿真实 Key 测，测完再调默认值：

1. 同一段描述多次调用 voicedesign，音色是否一致（决定「固化」有多必要）。
2. 克隆参考音频的最佳时长。目前阈值：短于 4 秒提示偏短，长于 30 秒提示偏长，长于 90 秒禁止保存。在设置里可以改。
3. 单次请求实际能放多少字。目前默认 `maxChars` 为 300。
4. Token Plan 的 Key（`tp-`）能不能调用 TTS。
5. 鉴权头：目前同时发送 `Authorization: Bearer` 和 `api-key`。
