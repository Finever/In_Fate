# IF Desktop（Electron 壳 v1）

这版桌面壳只做四件事：

1. 用系统 Node 拉起 `if serve`，随机端口 + 随机 token；
2. 等 `/api/health` 通过；
3. 用 Electron 窗口加载本地 UI；
4. 退出时杀掉后端。

还没做：原生应用嵌入、`WebContentsView`、终端、code-server、文件管理器、安装包。

## 准备

```bash
# 1. 构建 UI
cd ui
npm run build
cd ..

# 2. 配置：复制一份本机配置
cp config/if.example.json config/if.local.json
# 填好 provider / model / apiKey

# 3. 安装 Electron
cd desktop
npm install
```

如果 Electron 下载卡住，用镜像重装：

```bash
cd desktop
rm -rf node_modules/electron
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

## 启动

```bash
cd desktop
npm start
```

或者从仓库根目录：

```bash
npm run desktop
```

启动后窗口标题是 `In_Fate`。日志在 Electron 的 `userData` 目录下：

- Windows：`%APPDATA%/In_Fate/if-desktop.log`（实际以 Electron 的 `app.getPath('userData')` 为准）
- 失败时会弹框并给出日志路径。

## 快捷键

- `F11`：全屏切换
- `F12`：开发者工具（未打包时）
- UI 内 `Ctrl / ⌘ + K`：命令面板
- UI 内 `Ctrl / ⌘ + Enter`：发送消息

## 环境变量

| 变量 | 作用 |
|---|---|
| `IF_CONFIG` | 指定配置文件；默认 `config/if.local.json` |
| `IF_PORT` | 固定后端端口；默认随机空闲端口 |
| `IF_TOKEN` | 固定后端 token；默认随机 |
| `IF_NODE` | 指定 Node 可执行文件；默认 `node` |

`run.mjs` 会清掉 `ELECTRON_RUN_AS_NODE` / `ELECTRON_NO_ATTACH_CONSOLE`，避免在 Cherry Studio 这类终端里 Electron 被当成 Node 跑。

## 冒烟测试

```bash
cd desktop
npm run smoke
```

它会启动后端、加载 UI、打印 `ready:`，然后 1.5 秒后自动退出，并杀掉后端。

## 已知限制

- 需要系统里有 `node`；打包版后面再内置 Node。
- 后端和 Electron 是同一个 dataRoot 的单 host；如果已经手动跑了 `if serve`，桌面壳会因为 host 锁被拒绝。
- 窗口状态存在 Electron 的 userData 目录，不进仓库。
- 不做自动更新、托盘、安装包。
