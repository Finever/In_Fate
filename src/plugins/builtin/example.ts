import type { ToolDefinition } from '../../tools/types.ts'
import type { PluginDefinition, PluginPanel } from '../types.ts'
import { definePlugin, defineTool } from '../sdk.ts'

const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0;
    padding: 18px;
    background: #14161c;
    color: #d9dce6;
    font: 13px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  h1 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
  p { margin: 0 0 14px; color: #8f96a8; }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 16px;
    padding: 5px 9px;
    border: 1px solid #2a2e3a;
    border-radius: 999px;
    color: #aeb5c6;
    background: #1a1d25;
    font-size: 11px;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: #6f7688; }
  .status.ready .dot { background: #6ee7a8; box-shadow: 0 0 8px rgba(110, 231, 168, .6); }
  button {
    padding: 7px 11px;
    border: 1px solid #343948;
    border-radius: 7px;
    background: #20242e;
    color: #e7e9f0;
    font: inherit;
    cursor: pointer;
  }
  button:hover { border-color: #4c5368; background: #272c38; }
  code { color: #b9c2d8; }
</style>
</head>
<body>
  <h1>IF 插件面板</h1>
  <p>这是一个 sandbox iframe。它拿不到宿主 DOM，只能通过 postMessage 说话。</p>
  <div class="status" id="status"><span class="dot"></span><span id="status-text">等待宿主握手…</span></div>
  <div><button id="ping" type="button">向宿主发一条通知</button></div>
  <p style="margin-top:16px">工具名：<code>if_example__echo</code>，默认停用。</p>
<script>
  const status = document.getElementById('status')
  const statusText = document.getElementById('status-text')
  window.addEventListener('message', event => {
    const data = event.data
    if (!data || data.type !== 'if.panel.init') return
    status.classList.add('ready')
    statusText.textContent = '已连接：' + data.pluginId + ' / ' + data.panelId
  })
  document.getElementById('ping').addEventListener('click', () => {
    parent.postMessage({
      type: 'if.panel.action',
      action: 'notify',
      message: '来自示例面板的问候。'
    }, '*')
  })
  parent.postMessage({ type: 'if.panel.ready' }, '*')
</script>
</body>
</html>`

const echoTool: ToolDefinition = defineTool({
  name: 'echo',
  description: '示例插件工具：原样返回输入文本。默认停用，需要显式启用。',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    mime: 'application/json',
  },
  meta: { readOnly: true },
  async run(args) {
    const text = typeof args === 'object' && args !== null
      ? (args as { text?: unknown }).text
      : undefined
    if (typeof text !== 'string') {
      return { text: 'text must be a string', isError: true }
    }
    return {
      text,
      structured: { text },
      mime: 'application/json',
    }
  },
})

const helloPanel: PluginPanel = {
  id: 'hello',
  title: '示例面板',
  slot: 'settings',
  width: 560,
  height: 300,
  html: PANEL_HTML,
}

export function createExamplePlugin(): PluginDefinition {
  return definePlugin({
    manifest: {
      id: 'if.example',
      name: 'IF 示例插件',
      version: '0.1.0',
      apiVersion: 1,
      description: '工具 + 面板契约示例；工具默认停用。',
      provides: ['tool', 'ui-panel'],
      capabilities: ['tools.register', 'ui.panel', 'storage'],
    },
    activate(ctx) {
      ctx.tools.register(echoTool)
      ctx.ui.registerPanel(helloPanel)
    },
    deactivate() {
      // 注册项由宿主按逆序回滚，这里只留生命周期钩子。
    },
  })
}
