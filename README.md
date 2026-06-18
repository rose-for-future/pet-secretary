# 喵秘书 · 桌面宠物秘书 (Pet Secretary)

一只浮在桌面右下角的灰白英短猫，**单击它就能用语音聊天、建/查/删提醒**。听懂中文口语、到点主动提醒你，安静时就在桌面卖萌。

> macOS / Windows 桌面应用，基于 Electron。

## 功能

- 🐱 **桌宠**：透明置顶小窗，播放猫的帧动画，可拖动。单击 = 开/关一次语音对话。
- 🎙️ **端到端语音**：接通义千问 Qwen-Omni-Realtime，自带语音活动检测，听→想→说一条连接搞定。
- ⏰ **本地提醒引擎**：全本地、离线、免费。中文自然语言时间解析（「明天8点半提前20分钟」），到点用系统 TTS 主动播报，断网也响。
- 🗂️ **待办清单**：纯列表 + 详情（完成/推迟/删除），也支持一个轻量「＋」手动加一条。
- 🔢 **同名区分**：待办带序号，语音可以说「删第2条」精准操作。

## 技术栈

Electron + electron-vite + TypeScript；提醒引擎 chrono-node（中文时间解析）+ Luxon（时区换算）；语音走 DashScope Qwen-Omni-Realtime WebSocket。

## 本地运行

```bash
npm install
npm run dev          # 启动（开发模式）
npm run typecheck    # 类型检查
npm test             # 单元测试
npm run build        # 打包产物
```

### 配置 API Key

语音功能需要 DashScope（通义千问）API Key。在应用数据目录下放一个 `secrets.json`（**不进仓库**）：

- macOS：`~/Library/Application Support/pet-secretary/secrets.json`

```json
{ "dashscopeApiKey": "你的 DashScope Key" }
```

提醒引擎本身全本地、不需要任何 Key。

## 目录结构

- `src/main/` — 主进程：窗口/托盘/IPC、语音会话（`omni.ts`）、本地提醒引擎（`store` / `task-service` / `reminder-engine`）
- `src/renderer/` — 桌宠窗（`pet.*`）与待办清单窗（`note.ts` / `index.html`）
- `src/shared/` — 类型、preload 契约、时间换算、中文时间解析、标题匹配

## 许可证

私人项目，暂未声明开源许可证。
