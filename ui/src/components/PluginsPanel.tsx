import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { PluginInfo, PluginListResult, PluginPanelContent } from '../types'

const STATUS_LABEL: Record<PluginInfo['status'], string> = {
  active: '已启用',
  activating: '激活中',
  disabled: '已停用',
  inactive: '未启用',
  error: '错误',
}

const KIND_LABEL: Record<string, string> = {
  tool: '工具',
  'ui-panel': '面板',
}

export function PluginsPanel() {
  const [data, setData] = useState<PluginListResult>()
  const [selected, setSelected] = useState<string>()
  const [panel, setPanel] = useState<PluginPanelContent>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [frameHeight, setFrameHeight] = useState(300)
  const frameRef = useRef<HTMLIFrameElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const next = await api.plugins()
      setData(next)
      setSelected(current => {
        if (current && next.plugins.some(plugin => plugin.id === current)) return current
        return next.plugins.find(plugin => plugin.panels.length > 0)?.id
          ?? next.plugins[0]?.id
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const plugin = data?.plugins.find(item => item.id === selected)

  const openPanel = useCallback(async (pluginId: string, panelId: string): Promise<void> => {
    setError(undefined)
    try {
      const next = await api.pluginPanel(pluginId, panelId)
      setPanel(next)
      setFrameHeight(Math.min(800, Math.max(160, next.height ?? 300)))
    } catch (reason) {
      setPanel(undefined)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  useEffect(() => {
    setPanel(undefined)
    setNotice(undefined)
    if (!plugin || plugin.panels.length === 0) return
    void openPanel(plugin.id, plugin.panels[0]!.id)
  }, [plugin?.id, plugin?.panels.length, openPanel])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const payload = event.data
      if (typeof payload !== 'object' || payload === null) return
      const record = payload as Record<string, unknown>
      if (record.type === 'if.panel.ready' && panel) {
        frame.contentWindow?.postMessage({
          type: 'if.panel.init',
          version: 1,
          pluginId: panel.pluginId,
          panelId: panel.id,
          theme: 'dark',
          locale: navigator.language,
        }, '*')
        return
      }
      if (record.type === 'if.panel.resize') {
        const height = Number(record.height)
        if (Number.isFinite(height)) {
          setFrameHeight(Math.min(800, Math.max(160, Math.round(height))))
        }
        return
      }
      if (record.type === 'if.panel.action' && record.action === 'notify') {
        const message = typeof record.message === 'string' ? record.message : ''
        if (message) setNotice(message.slice(0, 500))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [panel])

  async function toggle(target: PluginInfo): Promise<void> {
    setBusy(target.id)
    setError(undefined)
    setNotice(undefined)
    try {
      if (target.status === 'active' || target.status === 'activating') {
        await api.disablePlugin(target.id)
      } else {
        await api.enablePlugin(target.id)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
      // 激活失败时 record 会变成 error；刷新一次让状态和错误可见。
      void refresh()
    }
  }

  if (loading && !data) {
    return <div className="fw-panel-loading"><span className="fw-spinner" /> 载入插件…</div>
  }

  return (
    <div className="fw-plugins">
      <div className="fw-plugins-head">
        <div>
          <h3>插件</h3>
          <small>v0 只支持内置与开发模式插件；全部在宿主进程内运行。</small>
        </div>
        <button type="button" className="fw-mem-btn" onClick={() => void refresh()} disabled={loading}>
          刷新
        </button>
      </div>

      {error && <div className="fw-dialog-error fw-plugins-error">{error}</div>}
      {notice && <div className="fw-mem-notice">{notice}</div>}
      {data?.errors.map(item => (
        <div className="fw-plugins-error" key={`${item.path}:${item.error}`}>
          <b>{item.path}</b>
          <span>{item.error}</span>
        </div>
      ))}

      <div className="fw-plugins-layout">
        <aside className="fw-plugin-list" aria-label="插件列表">
          {(data?.plugins.length ?? 0) === 0 && (
            <div className="fw-panel-empty">
              没有插件。把 dev 插件放进 data 目录的 <code>plugins/&lt;id&gt;/</code>，
              并在 config 的 <code>patch.plugins.dev</code> 打开开关。
            </div>
          )}
          {(data?.plugins ?? []).map(item => (
            <button
              key={item.id}
              type="button"
              className={`fw-plugin-card${item.id === selected ? ' is-active' : ''}${item.status === 'error' ? ' is-error' : ''}`}
              onClick={() => setSelected(item.id)}
            >
              <span className="fw-plugin-card-head">
                <b>{item.name}</b>
                <span className={`fw-plugin-status is-${item.status}`}>
                  {STATUS_LABEL[item.status]}
                </span>
              </span>
              <span className="fw-plugin-card-meta">
                {item.id} · v{item.version} · {item.trust === 'builtin' ? '内置' : '开发'}
              </span>
              <span className="fw-plugin-card-kinds">
                {item.provides.map(kind => KIND_LABEL[kind] ?? kind).join(' / ') || '无能力'}
              </span>
            </button>
          ))}
        </aside>

        <section className="fw-plugin-detail">
          {!plugin ? (
            <div className="fw-panel-empty">选一个插件。</div>
          ) : (
            <>
              <div className="fw-plugin-detail-head">
                <div>
                  <h3>{plugin.name}</h3>
                  <small>{plugin.id} · apiVersion {plugin.apiVersion}</small>
                </div>
                <button
                  type="button"
                  className={`fw-mem-btn${plugin.status === 'error' ? ' is-danger' : ''}`}
                  onClick={() => void toggle(plugin)}
                  disabled={busy === plugin.id}
                >
                  {busy === plugin.id
                    ? '处理中…'
                    : plugin.status === 'active' || plugin.status === 'activating'
                      ? '停用'
                      : '启用'}
                </button>
              </div>

              {plugin.description && <p className="fw-plugin-description">{plugin.description}</p>}
              {plugin.error && <div className="fw-plugins-error">{plugin.error}</div>}

              <div className="fw-plugin-meta-grid">
                <div>
                  <span>能力</span>
                  <b>{plugin.capabilities.join('、') || '无'}</b>
                </div>
                <div>
                  <span>工具</span>
                  <b>{plugin.tools.length ? plugin.tools.join('、') : '无'}</b>
                </div>
                <div>
                  <span>面板</span>
                  <b>{plugin.panels.length ? plugin.panels.map(item => item.title).join('、') : '无'}</b>
                </div>
              </div>

              {plugin.panels.length > 0 && (
                <div className="fw-plugin-panel-tabs">
                  {plugin.panels.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      className={panel?.id === item.id ? 'is-active' : ''}
                      onClick={() => {
                        setSelected(plugin.id)
                        void openPanel(plugin.id, item.id)
                      }}
                    >
                      {item.title}
                    </button>
                  ))}
                </div>
              )}

              {panel ? (
                <div className="fw-plugin-frame-wrap">
                  <iframe
                    ref={frameRef}
                    className="fw-plugin-frame"
                    title={`${plugin.name} / ${panel.title}`}
                    sandbox="allow-scripts"
                    referrerPolicy="no-referrer"
                    srcDoc={panel.html}
                    style={{ height: frameHeight }}
                  />
                  <small>sandbox iframe · 只能通过 postMessage 与宿主通信</small>
                </div>
              ) : plugin.panels.length === 0 ? (
                <div className="fw-plugin-detail-empty">
                  这个插件没有面板。工具在「状态 → 工具与权限」里启用，并按 agent 加白名单。
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
