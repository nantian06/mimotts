# MiMo TTS 工作台

小米 MiMo 语音合成（`mimo-v2.5-tts` 系列）的本地网页工作台。单人使用、不需要账号，数据全部存在本地文件夹里。

- **快速合成**：选音色、写风格指令和文本，一键生成；预置音色支持边生成边播放。长文本自动按句切分、拼接。
- **音色库**：官方预置音色、预置变体（官方音色 + 默认指令）、**设计音色**（文字描述 → 抽卡试听 → 挑一条「固化」）、**克隆音色**（上传或录制参考音频）。支持收藏、标签、筛选、对比试听、回收站、导入导出音色包。
- **克隆参考音频标准化**：转单声道、重采样、高通、降噪、裁首尾静音、压缩长停顿、ITU-R BS.1770 响度归一、4 倍过采样真峰值限幅，并给出处理前后的质量报告。可以拖选波形截取一段，长素材会自动推荐区间。
- **剧本**：多角色、按片段生成。角色绑定音色，片段可单独写指令；改了文本、指令或音色后自动标记「过期」。批量生成、版本管理、拖动排序、拆分合并、连播，导出整段 WAV / MP3、SRT 字幕、分段 ZIP 或项目包。
- **大模型辅助**（任意 OpenAI 兼容接口，模型由你在设置里选）：写风格指令（自然语言 / 导演模式）、自动打音频标签、润色音色描述、写试听文本、把小说拆成角色和片段、按角色推荐音色、批量补指令和标签。每次都能查看实际发送的请求，提示词模板可以自己改。

## 运行

### Docker（推荐）

```bash
docker compose up -d --build
```

打开 <http://localhost:8788>，在「设置 → MiMo 接口」填 API Key。数据保存在 `./data`。

第一次启动时也可以用环境变量预先填好（之后以网页里的设置为准）：

| 变量 | 说明 |
|---|---|
| `MIMO_API_KEY` | MiMo 的 API Key |
| `MIMO_BASE_URL` | 默认 `https://api.xiaomimimo.com/v1`；Token Plan 用 `https://token-plan-cn.xiaomimimo.com/v1` |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 辅助大模型（OpenAI 兼容）。容器里访问宿主机服务用 `http://host.docker.internal:端口/v1` |
| `ACCESS_TOKEN` | 设置后打开页面需要输入口令。暴露到局域网或公网时建议设置 |
| `PORT` / `HOST` / `DATA_DIR` | 端口（默认 8788）、监听地址、数据目录 |
| `FFMPEG_PATH` | ffmpeg 路径（默认从 PATH 找） |

### 本地运行

需要 Node.js ≥ 22.18（直接运行 TypeScript）和 ffmpeg。

```bash
npm i
```

```bash
npm run build && npm start
```

开发时用 `npm run dev`（前端改动自动重新打包，服务端改动自动重启）。

没有 Key 也可以先体验：另开一个终端运行 `npm run mock`，把 MiMo 和大模型的 Base URL 都填成 `http://localhost:18790/v1`，Key 随便填。模拟上游会生成「像说话」的合成音。

> 浏览器只在 `localhost` 或 https 下允许使用麦克风。通过局域网 IP 用 http 访问时，录音功能不可用，可以上传文件代替。

## 使用提示

- **风格指令** 放在 user 消息里，决定整体语气；文本开头的 `(风格)` 标签和句中的 `（叹气）`、`（轻笑）` 等音频标签做细粒度控制。唱歌只支持预置音色。
- **设计音色** 每次生成都会有差异。多抽几条试听，挑一条满意的「固化」：之后合成改走克隆模型，音色稳定，也能叠加风格指令。没固化的设计音色不能用风格指令。
- **克隆参考音频** 最好是一个人说话、安静无回声、10–20 秒、语气自然。克隆会把噪声和房间声一起学走，所以降噪要谨慎，质量报告里有提示。
- **剧本指令继承**：片段指令 → 角色指令 → 音色默认指令，取第一个非空的。

## 数据目录

```
data/
  settings.json          设置（含 API Key，注意保管）
  voices/<id>/           每个音色一个文件夹：voice.json、试听、参考音频各版本
  projects/<id>/         每个剧本一个文件夹：project.json、takes/、exports/
  quick/                 快速合成历史
  presets/               官方预置音色的标准试听
  prompts/               改过的提示词模板（删掉即恢复默认）
  trash/                 回收站
  uploads/               上传的临时文件（自动清理）
```

整个文件夹可以直接备份或拷到另一台机器。

## 开发

```bash
npm test          # 后端单元测试 + 接口集成测试（模拟上游，需要 ffmpeg）
npm run typecheck # 类型检查
npm run e2e       # 端到端界面测试（Playwright + 模拟上游），截图在 e2e-shots/
```

- 服务端零运行时依赖，由 Node 原生剥离类型运行 `.ts`：import 要写 `.ts` 后缀，不能用 enum、namespace、参数属性，类型导入用 `import type`。
- 前端是 React 19，用 esbuild 打包（`scripts/build.ts`）。
- 接口都在 `server/routes.ts`；大模型提示词默认模板在 `server/llm/prompts/`。
- 开发进度和待确认事项见 `PROGRESS.md`。

## 许可

MIT
