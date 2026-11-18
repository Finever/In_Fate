import assert from 'node:assert/strict'
import test from 'node:test'
import type { App } from '../src/app/bundle.ts'
import { startServer } from '../src/app/server.ts'
import type { PluginInfo, PluginPanelContent } from '../src/plugins/types.ts'

const plugin: PluginInfo = {
  id: 'if.example',
  name: 'IF 示例插件',
  version: '0.1.0',
  apiVersion: 1,
  trust: 'builtin',
  status: 'active',
  provides: ['tool', 'ui-panel'],
  capabilities: ['tools.register', 'ui.panel'],
  tools: ['if_example__echo'],
  panels: [{ id: 'hello', title: '示例面板', slot: 'settings' }],
}

const panel: PluginPanelContent = {
  pluginId: plugin.id,
  id: 'hello',
  title: '示例面板',
  slot: 'settings',
  html: '<!doctype html><html><body>panel</body></html>',
}

test('插件 API 列出、启停并取 sandbox 面板 HTML', async () => {
  const app = {
    pluginList: () => ({
      plugins: [plugin],
      errors: [{ path: 'plugins/bad/plugin.json', error: 'bad manifest' }],
    }),
    pluginEnable: async (id: string) => ({ ...plugin, id, status: 'active' as const }),
    pluginDisable: async (id: string) => ({ ...plugin, id, status: 'disabled' as const }),
    pluginPanel: (id: string, panelId: string) =>
      id === plugin.id && panelId === 'hello' ? panel : undefined,
  } as unknown as App
  const handle = await startServer(app, { port: 0, token: 'test-token' })
  try {
    const headers = { authorization: 'Bearer test-token' }
    const list = await fetch(`${handle.url}/api/plugins`, { headers })
    assert.equal(list.status, 200)
    const body = await list.json() as {
      plugins: PluginInfo[]
      errors: { path: string; error: string }[]
    }
    assert.equal(body.plugins[0]!.id, 'if.example')
    assert.equal(body.errors[0]!.error, 'bad manifest')

    const enable = await fetch(`${handle.url}/api/plugins/if.example/enable`, {
      method: 'POST',
      headers,
    })
    assert.equal(enable.status, 200)
    assert.equal((await enable.json() as { plugin: PluginInfo }).plugin.status, 'active')

    const disable = await fetch(`${handle.url}/api/plugins/if.example/disable`, {
      method: 'POST',
      headers,
    })
    assert.equal(disable.status, 200)
    assert.equal((await disable.json() as { plugin: PluginInfo }).plugin.status, 'disabled')

    const panelResponse = await fetch(
      `${handle.url}/api/plugins/if.example/panels/hello`,
      { headers },
    )
    assert.equal(panelResponse.status, 200)
    assert.match(
      (await panelResponse.json() as { panel: PluginPanelContent }).panel.html,
      /panel/,
    )

    const missing = await fetch(`${handle.url}/api/plugins/if.example/panels/missing`, { headers })
    assert.equal(missing.status, 404)
  } finally {
    await handle.close()
  }
})
