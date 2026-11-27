# IF Desktop（Electron 壳 v1）

这版桌面壳只做四件事：

1. 用系统 Node 拉起 `if serve`，随机端口 + 随机 token；
2. 等 `/api/health` 通过；
3. 用 Electron 窗口加载本地 UI；
4. 退出时杀掉后端。

还没做：原生应用嵌入、`WebContentsView`、终端、code-server、文件管理器。安装与更新由发布包的 `install.cmd` 和 IF 设置页负责，不塞进 Electron 壳。

## 准备

```bash
# 1. 构建 UI
cd ui
npm run build
cd ..

# 2. 配置：复制一份本机配置
cp config/if.example.json config/if.local.json
# 填好 provider / model / apiKey
# 启动后在右侧“状态”面板为每个主 agent 选择模型；没有配置模型不会发消息

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

启动后窗口标题是 `In_Fate`。

## 快捷启动

安装桌面和开始菜单快捷方式：

```bash
npm run desktop:shortcut
```

安装器会创建 `In_Fate.lnk`（桌面 + 开始菜单）。快捷方式指向 `wscript.exe`，由 `launch.vbs` 隐藏窗口地执行 `node run.mjs`，所以双击不会弹出黑色控制台。

移除：

```bash
npm run desktop:shortcut:remove
```

也可以直接双击 `desktop/launch.cmd` 在终端里启动；排查启动问题时用它能看到输出。

日志在 Electron 的 `userData` 目录下：

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

`run.mjs` 会清掉 `ELECTRON_RUN_AS_NODE` / `ELECTRON_NO_ATTACH_CONSOLE`，避免在某些终端里 Electron 被当成 Node 跑。

## 冒烟测试

```bash
cd desktop
npm run smoke
```

它会启动后端、加载 UI、打印 `ready:`，然后 1.5 秒后自动退出，并杀掉后端。

## 图标

- `if-w3.png` / `if-w3.ico`：当前使用的两环原子 IF 图标（`twobreaks-w3`），ICO 含 16–256px 多尺寸。
- `main.mjs` 的 `BrowserWindow` 用 `if-w3.ico` 作为窗口/任务栏图标；快捷方式也指向同一个文件。
- UI 左上角用的是同一张图的副本 `ui/public/icon.png`；换图标时两处要一起换。
- 旧的 `if.png` / `if.ico` 保留作历史文件，不再被窗口或快捷方式引用。
- 旧版紫底圆角图标备份在 `icon-concepts/_old-brand/`；设计过程和弃案在 `icon-concepts/`。
- Windows 会按文件路径缓存图标；换图时用新文件名（如本次的 `if-w3.ico`）可以绕开缓存，再运行 `npm run desktop:shortcut` 即可。

## 已知限制

- 开发模式需要系统里有 `node`；发布包内置 `runtime/node.exe`，由 `IF_NODE` 指定。
- 后端和 Electron 是同一个 dataRoot 的单 host；如果已经手动跑了 `if serve`，桌面壳会因为 host 锁被拒绝。
- 窗口状态存在 Electron 的 userData 目录，不进仓库。
- 不做托盘；自动更新走 IF 设置页，不放进 Electron 壳。

## 窗口顶栏

- 窗口使用 `frame: false`，原生最小化/全屏/关闭栏已去掉。
- 顶栏在 `ui/src/components/TitleBar.tsx`，只放图标、In_Fate 和三个窗口控制图标。
- 窗口按钮通过 `desktop/preload.cjs` 暴露给页面，再由 `desktop/main.mjs` 的 IPC 调用 Electron 窗口 API。
- 顶栏空白处可拖动窗口；按钮区域标了 `-webkit-app-region: no-drag`。
