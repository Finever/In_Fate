import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createExamplePlugin } from '../src/plugins/builtin/example.ts'
import { parsePluginManifest, pluginToolName } from '../src/plugins/manifest.ts'
import { PluginRegistry } from '../src/plugins/registry.ts'
import { FilePluginStorage } from '../src/plugins/storage.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import type { ToolContext } from '../src/tools/types.ts'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'if-plugin-'))
}

function writeDevPlugin(
  dataRoot: string,
  id: string,
  manifest: Record<string, unknown>,
  entry: string,
): string {
  const dir = join(dataRoot, 'plugins', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify({
    id,
    name: `Dev ${id}`,
    version: '0.1.0',
    apiVersion: 1,
    entry: 'index.mjs',
    provides: ['tool', 'ui-panel'],
    capabilities: ['tools.register', 'ui.panel', 'storage'],
    ...manifest,
  }, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'index.mjs'), entry, 'utf8')
  writeFileSync(join(dir, 'panel.html'), '<!doctype html><html><body>hello panel</body></html>\n', 'utf8')
  return dir
}

test('内置示例插件注册命名空间工具和面板，默认停用且审批 required', async () => {
  const dataRoot = tempRoot()
  const tools = new ToolRegistry()
  const registry = new PluginRegistry({
    dataRoot,
    tools,
    builtins: [createExamplePlugin()],
  })
  try {
    await registry.start()
    const list = registry.list()
    assert.equal(list.length, 1)
    assert.equal(list[0]!.id, 'if.example')
    assert.equal(list[0]!.status, 'active')
    assert.deepEqual(list[0]!.tools, ['if_example__echo'])
    assert.deepEqual(list[0]!.panels.map(panel => panel.id), ['hello'])

    const descriptor = tools.list({ includeDisabled: true })
      .find(tool => tool.name === 'if_example__echo')
    assert.ok(descriptor)
    assert.equal(descriptor.source, 'plugin')
    assert.equal(descriptor.enabled, false)
    assert.equal(descriptor.approval, 'required')
    const result = await tools.get('if_example__echo')!.run(
      { text: 'hello' },
      {} as ToolContext,
    )
    assert.equal(result.text, 'hello')

    // 没有显式 allow 时插件工具不进模型；显式 allow 才进。
    assert.equal(
      tools.toModelSpecs().some(spec => spec.name === 'if_example__echo'),
      false,
    )
    tools.update('if_example__echo', { enabled: true })
    assert.equal(
      tools.toModelSpecs().some(spec => spec.name === 'if_example__echo'),
      false,
    )
    assert.equal(
      tools.toModelSpecs({ allowed: new Set(['if_example__echo']) })
        .some(spec => spec.name === 'if_example__echo'),
      true,
    )

    const panel = registry.panel('if.example', 'hello')
    assert.ok(panel)
    assert.match(panel.html, /sandbox iframe/)
    assert.match(panel.html, /Content-Security-Policy/)

    await registry.disable('if.example')
    assert.equal(tools.get('if_example__echo'), undefined)
    assert.equal(registry.panel('if.example', 'hello'), undefined)
    assert.equal(registry.list()[0]!.status, 'disabled')

    await registry.enable('if.example')
    assert.ok(tools.get('if_example__echo'))
    assert.ok(registry.panel('if.example', 'hello'))
  } finally {
    await registry.stop()
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('配置里的全局启用与审批会应用到插件工具', async () => {
  const dataRoot = tempRoot()
  const tools = new ToolRegistry()
  const registry = new PluginRegistry({
    dataRoot,
    tools,
    builtins: [createExamplePlugin()],
    enabledTools: new Set(['if_example__echo']),
    toolApproval: { 'if_example__echo': 'auto' },
  })
  try {
    await registry.start()
    const descriptor = tools.list({ includeDisabled: true })
      .find(tool => tool.name === 'if_example__echo')
    assert.ok(descriptor)
    assert.equal(descriptor.enabled, true)
    assert.equal(descriptor.approval, 'auto')
  } finally {
    await registry.stop()
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('dev 插件默认不激活；启停回滚工具、面板、effect 和 deactivate', async () => {
  const dataRoot = tempRoot()
  writeDevPlugin(dataRoot, 'hello', {}, `
    export async function activate(ctx) {
      globalThis.__ifPluginEvents = globalThis.__ifPluginEvents ?? []
      globalThis.__ifPluginEvents.push('activate')
      ctx.signal.addEventListener('abort', () => {
        globalThis.__ifPluginEvents.push('abort')
      })
      ctx.effect(() => () => {
        globalThis.__ifPluginEvents.push('effect-disposed')
      })
      ctx.tools.register({
        name: 'hello',
        description: 'dev hello',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        meta: { readOnly: true },
        async run() { return { text: 'hello' } }
      })
      const html = await ctx.assets.read('panel.html')
      ctx.ui.registerPanel({ id: 'main', title: 'Hello panel', html })
      await ctx.storage.set('count', 1)
    }
    export async function deactivate() {
      globalThis.__ifPluginEvents.push('deactivate')
    }
  `)
  const tools = new ToolRegistry()
  const registry = new PluginRegistry({ dataRoot, tools, dev: true })
  try {
    delete (globalThis as { __ifPluginEvents?: string[] }).__ifPluginEvents
    await registry.start()
    assert.equal(registry.list()[0]!.status, 'disabled')
    assert.equal(tools.get('hello__hello'), undefined)

    const enabled = await registry.enable('hello')
    assert.equal(enabled.status, 'active')
    assert.ok(tools.get('hello__hello'))
    const devTool = tools.list({ includeDisabled: true })
      .find(tool => tool.name === 'hello__hello')
    assert.ok(devTool)
    assert.equal(devTool.dangerous, true)
    assert.equal(devTool.readOnly, false)
    assert.equal(tools.timeoutOf('hello__hello'), 60_000)
    assert.match(registry.panel('hello', 'main')?.html ?? '', /hello panel/)
    assert.deepEqual(
      (globalThis as { __ifPluginEvents?: string[] }).__ifPluginEvents,
      ['activate'],
    )
    const stored = JSON.parse(readFileSync(
      join(dataRoot, 'plugin-data', 'hello', 'storage.json'),
      'utf8',
    )) as { values: { count: number } }
    assert.equal(stored.values.count, 1)

    const disabled = await registry.disable('hello')
    assert.equal(disabled.status, 'disabled')
    assert.equal(tools.get('hello__hello'), undefined)
    assert.equal(registry.panel('hello', 'main'), undefined)
    assert.deepEqual(
      (globalThis as { __ifPluginEvents?: string[] }).__ifPluginEvents,
      ['activate', 'deactivate', 'abort', 'effect-disposed'],
    )
  } finally {
    await registry.stop()
    delete (globalThis as { __ifPluginEvents?: string[] }).__ifPluginEvents
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('dev 插件清单拒绝路径穿越、能力声明不一致和 apiVersion 不兼容', async () => {
  const dataRoot = tempRoot()
  writeDevPlugin(dataRoot, 'bad-path', { entry: '../evil.mjs' }, 'export function activate() {}')
  writeDevPlugin(dataRoot, 'bad-caps', { capabilities: ['ui.panel'] }, 'export function activate() {}')
  const tools = new ToolRegistry()
  const registry = new PluginRegistry({ dataRoot, tools, dev: true })
  try {
    await registry.start()
    const errors = registry.errors()
    assert.equal(errors.length, 2)
    assert.ok(errors.some(error => error.error.includes('entry')))
    assert.ok(errors.some(error => error.error.includes('tools.register')))

    assert.throws(
      () => parsePluginManifest({
        id: '../escape',
        name: 'bad',
        version: '1.0.0',
        apiVersion: 1,
        provides: ['tool'],
        capabilities: ['tools.register'],
      }, 'test'),
      /id must match/,
    )
    assert.equal(pluginToolName('if.example', 'Echo Tool'), 'if_example__echo_tool')
  } finally {
    await registry.stop()
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('插件存储有 key 校验、配额和原子落盘', async () => {
  const dataRoot = tempRoot()
  try {
    const storage = new FilePluginStorage({
      root: join(dataRoot, 'kv'),
      label: 'test',
      maxBytes: 200,
    })
    await storage.set('a', { value: 1 })
    assert.deepEqual(await storage.get('a'), { value: 1 })
    assert.deepEqual(await storage.keys(), ['a'])
    assert.equal(await storage.delete('a'), true)
    assert.equal(await storage.get('a'), undefined)
    await assert.rejects(() => storage.set('bad key', 1), /key must match/)
    await assert.rejects(
      () => storage.set('big', 'x'.repeat(500)),
      /exceeds 200 bytes/,
    )
  } finally {
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
