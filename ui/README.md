# IF UI（默认工作台 v2：列表式）

默认界面改成以会话列表为主入口，参考成熟桌面客户端的会话列表结构：

- **侧栏**：新建、搜索、按日期分组；归档/已删除单独分组；行内悬停可归档、恢复、删除。
- **连接线**：选中会话时，从列表左侧引出曲线连到直接关联的会话；平时不占视觉。
- **对话区**：用户消息右侧气泡，助手左侧 Markdown；思考、工具、压缩收成可展开的轻行。
- **右侧面板**：会话详情、审批、子 agent 共用一栏，默认收起；窄屏改浮层。
- **命令面板**：`Ctrl / ⌘ + K`，搜索会话、执行动作。
- **深链**：`?session=<id>` 可以直接打开某个会话。
- **设置页**：模型服务、全局记忆、本地 embedding、插件；插件 v0 只开放内置/开发插件，面板走 sandbox iframe。

星图不再是默认入口，相关组件已移除；连接关系改由侧栏引出线表达。

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

## 交互

- `Enter` 发送，`Shift + Enter` 换行。
- `Ctrl / ⌘ + N` 新建会话。
- `Ctrl / ⌘ + K` 打开命令面板。
- `Esc` 关闭面板 / 右栏；窄屏下关闭侧栏。

## 这一版没有做

- 第三方插件安装 / 插件市场、浮动/平铺多窗口。
- 会话重命名、置顶、全文消息搜索。
- 终端 / code-server / 文件管理器 / 浏览器窗口。
- 附件上传与图片消息。

## 目录

```text
src/
  App.tsx                 壳：侧栏 + 对话 + 右栏、生命周期、命令面板
  api.ts / types.ts
  hooks/useWorkspace.ts   会话/连接/agent/审批，5 秒轮询
  hooks/useSession.ts     当前会话 turns/inspect/stats，3 秒轮询
  lib/sessions.ts         标题兜底、日期分组、连接关系
  lib/markdown.tsx        轻量 Markdown 渲染
  components/
    Sidebar.tsx           列表、搜索、筛选、行操作
    LinkRail.tsx          选中会话的左侧引出线
    ChatPane.tsx          对话头、空状态、消息区、输入框
    Timeline.tsx / TurnBlock.tsx / ItemCard.tsx
    RightPanel.tsx        详情 / 审批 / 子 agent 的右栏容器
    Inspector.tsx
    ApprovalsPanel.tsx / AgentsPanel.tsx
    CommandPalette.tsx
    Ui.tsx / Icon.tsx
```
