# IF UI（默认工作台 v1）

全屏、非列表式的默认工作台：

- **星图**：会话是节点，连接是线；没有侧栏列表。
- **聚焦窗口**：选中会话后放大成聊天窗口，其他节点退到背景。
- **dock**：底部切换会话、新建、审批、子 agent、回到星图。
- **抽屉**：会话详情、审批、子 agent 都不切页。
- **命令面板**：`Ctrl / ⌘ + K`，搜索会话、执行动作。
- **生命周期**：归档 / 恢复 / 软删除；409 时会给出强制操作。

## 运行

生产模式（`if serve` 直接托管 `ui/dist`）：

```bash
cd ui
npm run build
cd ..
node bin/if.ts serve -c config/if.local.json --port 8787 --token dev
```

打开 `http://127.0.0.1:8787/?token=dev`。

开发模式（Vite 热更新 + API 代理）：

```bash
# 终端 1
node bin/if.ts serve -c config/if.local.json --port 8787 --token dev

# 终端 2
cd ui
npm run dev
```

打开 `http://127.0.0.1:5173/?token=dev`。

## 这一版没有做

- 插件加载：组件边界按“窗口内容”留好了，但还没有 manifest / 注册表。
- 浮动/平铺多窗口：现在是单聚焦窗口 + dock。
- 终端 / code-server / 文件管理器 / 浏览器窗口：等后面单独做。
- Electron：现在是全屏 Web 工作台，不是 OS 窗口。

## 目录

```text
src/
  App.tsx                 壳：星图、聚焦窗口、dock、抽屉、生命周期
  api.ts / types.ts
  hooks/useWorkspace.ts   会话/连接/agent/审批，5 秒轮询
  hooks/useSession.ts     当前会话 turns/inspect/stats，3 秒轮询
  lib/constellation.ts    确定性力导向布局
  lib/markdown.tsx        轻量 Markdown 渲染
  components/
    Constellation.tsx     星图
    FocusWindow.tsx       聚焦聊天窗口
    Timeline.tsx / TurnBlock.tsx / ItemCard.tsx
    Dock.tsx
    Inspector.tsx
    ApprovalsPanel.tsx / AgentsPanel.tsx
    CommandPalette.tsx
    TopBar.tsx
    Ui.tsx / Icon.tsx
```
