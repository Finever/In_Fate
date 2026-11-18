# IF 插件契约 v0

> 这一版只验证契约，不是插件市场。只允许内置插件和开发者本地插件，二者都在宿主进程内运行。

## 1. 范围

v0 只支持两类能力：

| 类型 | 说明 |
|---|---|
| `tool` | 注册工具，走现有 `ToolDefinition` / `ToolResult` 契约 |
| `ui-panel` | 注册面板，宿主用 sandbox iframe 渲染 |

明确不做：模型 provider、memory source、channel、job、通用事件总线、第三方插件安装、插件市场、HMR、沙箱宿主。

## 2. 清单

dev 插件放在 `dataRoot/plugins/<id>/`，清单文件名固定 `plugin.json`：

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "0.1.0",
  "apiVersion": 1,
  "entry": "index.mjs",
  "description": "示例插件",
  "provides": ["tool", "ui-panel"],
  "capabilities": ["tools.register", "ui.panel", "storage"]
}
```

规则：

- `id` 必须匹配 `[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}`，且必须等于目录名。
- `apiVersion` 是整数大版本，宿主只接受 `1`；不兼容直接拒绝加载。
- `entry` 必须是插件目录内的相对路径，支持 `.js` / `.mjs`，拒绝绝对路径、`..`、反斜杠和 symlink。
- `provides` 与 `capabilities` 必须一致：
  - `tool` 需要 `tools.register`
  - `ui-panel` 需要 `ui.panel`
  - `storage` 可选
- 插件入口模块导出：

```js
export async function activate(ctx) {}
export async function deactivate() {}
```

`deactivate` 可选。注册项由宿主逆序回滚，不需要在 `deactivate` 里手动反注册。

## 3. 上下文

```ts
interface PluginContext {
  plugin: { id, name, version, dataDir }
  signal: AbortSignal
  tools: { register(tool: ToolDefinition): Disposable }
  ui: { registerPanel(panel: PluginPanel): Disposable }
  storage: { get, set, delete, keys }
  assets: { read(path: string): Promise<string> }
  log: { info, warn, error }
  effect(effect: () => Disposable | void): Disposable
}
```

- `ctx.effect(fn)` 会**立即执行** `fn`，把它返回的函数/对象作为卸载时的 disposer。不是“注册一个稍后执行的清理函数”。
- `ctx.assets.read` 只能读插件目录内的文件。
- `ctx.signal` 在插件卸载时 abort；异步工作应观察它。
- `ctx.storage` 是按插件隔离的 KV，单插件上限 5MB，原子落盘；未声明 `storage` 能力时调用会报错。
- 作者侧 helper 在 `src/plugins/sdk.ts`：`definePlugin` / `defineTool` / `definePanel`。v0 先作为仓内模块，后面再拆成独立 npm 包。

## 4. 工具

插件工具直接使用 IF 已有的 `ToolDefinition`：

```js
ctx.tools.register({
  name: 'echo',
  description: '原样返回输入',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  meta: { readOnly: true },
  async run(args, context) {
    return { text: String(args.text ?? ''), structured: { text: String(args.text ?? '') } }
  }
})
```

宿主会：

- 把工具名改成 `<pluginId>__<toolName>`，只保留 `[a-z0-9_-]`；
- 以 `source: 'plugin'` 注册；
- 默认 `enabled: false`、`approval: 'required'`；
- 超时由宿主夹在 1 秒到 120 秒之间；
- dev 插件不信任自报的 `dangerous` / `readOnly`，强制按危险、可写处理；
- 没有 agent 显式白名单时，插件工具不进模型、也不允许执行。

启用顺序：插件页启用插件 → 状态页全局启用工具 → 在 agent 的工具白名单里勾选。

## 5. 面板

```js
ctx.ui.registerPanel({
  id: 'main',
  title: 'Hello',
  slot: 'settings',
  width: 560,
  height: 300,
  html: await ctx.assets.read('panel.html')
})
```

- 宿主用 `iframe sandbox="allow-scripts"` + `srcdoc` 渲染，不加 `allow-same-origin`。
- 面板拿不到宿主 DOM、cookie、localStorage，只能 postMessage。
- 宿主 → 面板：`if.panel.init`（`version` / `pluginId` / `panelId` / `theme` / `locale`）。
- 面板 → 宿主：
  - `{ type: 'if.panel.ready' }`
  - `{ type: 'if.panel.resize', height: number }`
  - `{ type: 'if.panel.action', action: 'notify', message: string }`
- 面板 HTML 上限 1MB，自包含；不要依赖相对路径资源。
- 宿主会注入 CSP：`default-src 'none'`，只允许内联脚本/样式和 `data:` 图片/字体。外部脚本、样式、图片和网络请求都会被挡掉。
- sandbox 隔离的是 DOM，不是网络；CSP 才是 v0 的网络边界。dev 插件仍然按“安装即信任”对待。

## 6. 开发模式

默认不扫描 dev 插件。开启方式：

```json
{
  "patch": {
    "plugins": {
      "dev": true
    }
  }
}
```

或启动时设置 `IF_DEV_PLUGINS=1`。目录默认 `dataRoot/plugins`，可用 `patch.plugins.dir` 覆盖。

dev 插件默认停用；在设置 → 插件里手动启用。清单坏了会在插件页显示扫描错误，不会拖垮宿主。

## 7. 安全边界

v0 的 `capabilities` 是**宿主 API 准入声明**，不是进程隔离。builtin/dev 插件都在宿主进程内，能直接 `import fs`、读进程内存。因此：

- 不开放第三方插件安装；
- dev 插件只给开发者，启用即信任；
- 进程内超时只能处理异步让出的插件，同步死循环仍会卡住宿主；
- `ctx.signal` 和 `deactivate` 超时都不是硬隔离。

真正的第三方隔离留给 v1 的独立插件宿主（子进程/worker + 能力 RPC）。到那时，作者 API 仍是这套，wire 层换成可序列化命令 + handle。

## 8. v1 再做

- 沙箱插件宿主
- 模型 provider 插件
- 事件白名单
- 插件签名、锁文件、更新与权限 diff
- 插件市场
- 面板的只读 `session.summary` 数据桥
