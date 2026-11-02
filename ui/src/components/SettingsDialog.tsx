import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ModelConfig, ModelConfigProvider, ModelPricing } from '../types'
import { Icon } from './Icon'
import { MemoryBrowser } from './MemoryBrowser'
import { ModelEditorDialog } from './ModelEditorDialog'

interface ProviderDraft {
  baseUrl: string
  apiKey: string
}

function initialDraft(provider: ModelConfigProvider): ProviderDraft {
  return { baseUrl: provider.baseUrl, apiKey: '' }
}

function providerMark(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?'
}

function formatTokens(value: number | undefined): string {
  return value === undefined ? '未配置' : Math.round(value).toLocaleString('en-US')
}

function pricingSummary(pricing: ModelPricing | undefined): string {
  if (!pricing) return '未配置单价'
  const rate = (value: number | undefined): string =>
    value === undefined ? '0' : String(Math.round(value * 1_000_000) / 1_000_000)
  const currency = pricing.input?.currency
    ?? pricing.output?.currency
    ?? pricing.cacheRead?.currency
    ?? pricing.offPeak?.input?.currency
    ?? pricing.offPeak?.output?.currency
    ?? 'CNY'
  return `${currency} · 入 ${rate(pricing.input?.perMillionTokens)} / 出 ${rate(pricing.output?.perMillionTokens)} / 缓 ${rate(pricing.cacheRead?.perMillionTokens)}`
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<ModelConfig>()
  const [view, setView] = useState<'models' | 'memory'>('models')
  const [providerId, setProviderId] = useState('')
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({})
  const [editing, setEditing] = useState<{ providerId: string; modelId: string }>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  useEffect(() => {
    let cancelled = false
    void api.modelConfig()
      .then(next => {
        if (cancelled) return
        const nextDrafts: Record<string, ProviderDraft> = {}
        for (const provider of next.providers) {
          nextDrafts[provider.id] = initialDraft(provider)
        }
        setConfig(next)
        setDrafts(nextDrafts)
        setProviderId(next.providers[0]?.id ?? '')
      })
      .catch(reason => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving && !editing) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, onClose, saving])

  const provider = config?.providers.find(item => item.id === providerId)
  const draft = provider ? drafts[provider.id] : undefined
  const editingProvider = editing
    ? config?.providers.find(item => item.id === editing.providerId)
    : undefined
  const editingModel = editingProvider?.models.find(model => model.id === editing?.modelId)

  function chooseProvider(nextId: string): void {
    setView('models')
    setProviderId(nextId)
    setError(undefined)
    setNotice(undefined)
  }

  function updateDraft(patch: Partial<ProviderDraft>): void {
    if (!provider) return
    setDrafts(current => ({
      ...current,
      [provider.id]: {
        ...(current[provider.id] ?? initialDraft(provider)),
        ...patch,
      },
    }))
    setError(undefined)
    setNotice(undefined)
  }

  function applyConfig(next: ModelConfig, savedProvider?: string): void {
    setConfig(next)
    setDrafts(current => {
      const updated = { ...current }
      for (const item of next.providers) {
        const existing = updated[item.id] ?? initialDraft(item)
        updated[item.id] = savedProvider === item.id
          ? { ...existing, baseUrl: item.baseUrl, apiKey: '' }
          : existing
      }
      return updated
    })
  }

  async function saveProvider(): Promise<void> {
    if (!provider || !draft || saving) return
    setSaving(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const next = await api.saveModelConfig({
        provider: provider.id,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        ...(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
      })
      applyConfig(next, provider.id)
      setNotice('服务配置已保存，下一轮生效')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  const keyPlaceholder = provider?.apiKeyEnv
    ? `使用环境变量 ${provider.apiKeyEnv}，留空不改`
    : provider?.hasApiKey
      ? '已配置，留空不改'
      : '输入 API key'

  return (
    <div
      className="fw-modal-backdrop"
      onMouseDown={() => {
        if (!saving && !editing) onClose()
      }}
    >
      <div
        className="fw-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="fw-dialog-head">
          <h2>设置</h2>
          <button
            type="button"
            className="fw-icon-btn"
            onClick={onClose}
            disabled={saving || Boolean(editing)}
            aria-label="关闭设置"
            title="关闭设置"
          >
            <Icon name="close" size={15} />
          </button>
        </header>

        {loading && (
          <div className="fw-panel-loading fw-settings-loading">
            <span className="fw-spinner" /> 载入模型配置…
          </div>
        )}

        {!loading && (
          <>
            <div className="fw-settings-body">
              <aside className="fw-settings-nav">
                <div className="fw-settings-nav-title">全局</div>
                <button
                  type="button"
                  className={`fw-settings-provider${view === 'memory' ? ' is-active' : ''}`}
                  onClick={() => {
                    setView('memory')
                    setError(undefined)
                    setNotice(undefined)
                  }}
                  disabled={saving || Boolean(editing)}
                >
                  <span className="fw-settings-provider-mark">
                    <Icon name="search" size={13} />
                  </span>
                  <span className="fw-settings-provider-text">
                    <b>全局记忆</b>
                    <small>detail 记忆库</small>
                  </span>
                </button>

                {config && (
                  <>
                    <div className="fw-settings-nav-title">模型服务</div>
                    {config.providers.map(item => {
                      const active = view === 'models' && item.id === providerId
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={`fw-settings-provider${active ? ' is-active' : ''}`}
                          onClick={() => chooseProvider(item.id)}
                          disabled={saving || Boolean(editing)}
                        >
                          <span className="fw-settings-provider-mark">
                            {providerMark(item.name)}
                          </span>
                          <span className="fw-settings-provider-text">
                            <b>{item.name}</b>
                            <small>{item.models.length} 个模型</small>
                          </span>
                        </button>
                      )
                    })}
                  </>
                )}
              </aside>

              <div className={`fw-settings-main${view === 'memory' ? ' is-memory' : ''}`}>
                {view === 'memory' ? (
                  <MemoryBrowser />
                ) : provider && draft ? (
                  <>
                    <div className="fw-settings-provider-head">
                      <h3>{provider.name}</h3>
                    </div>

                    <div className="fw-settings-fields">
                      <label className="fw-field">
                        <span>Base URL</span>
                        <input
                          value={draft.baseUrl}
                          onChange={event => updateDraft({ baseUrl: event.target.value })}
                          placeholder="https://…/v1"
                          spellCheck={false}
                          disabled={saving}
                        />
                      </label>

                      <label className="fw-field">
                        <span>API key</span>
                        <input
                          type="password"
                          value={draft.apiKey}
                          onChange={event => updateDraft({ apiKey: event.target.value })}
                          placeholder={keyPlaceholder}
                          autoComplete="off"
                          spellCheck={false}
                          disabled={saving}
                        />
                      </label>
                    </div>

                    <section className="fw-settings-models">
                      <div className="fw-settings-models-head">
                        <span>模型</span>
                        <small>{provider.models.length} 个</small>
                      </div>

                      {provider.models.length === 0 && (
                        <div className="fw-settings-models-empty">没有可用模型。</div>
                      )}

                      <div className="fw-settings-model-list">
                        {provider.models.map(model => (
                          <div className="fw-settings-model" key={model.id}>
                            <span className="fw-settings-model-body">
                              <span className="fw-settings-model-name">
                                {model.name ?? model.id}
                              </span>
                              {model.name && model.name !== model.id && (
                                <span className="fw-settings-model-id">{model.id}</span>
                              )}
                              <span className="fw-settings-model-tokens">
                                <span>上下文 {formatTokens(model.contextWindow)}</span>
                                <span>最大输出 {formatTokens(model.maxOutputTokens)}</span>
                              </span>
                              <span className="fw-settings-model-price">
                                {pricingSummary(model.pricing)}
                                {model.pricing?.offPeak && (
                                  <em>峰谷</em>
                                )}
                              </span>
                            </span>
                            <button
                              type="button"
                              className="fw-settings-model-edit"
                              onClick={() => setEditing({ providerId: provider.id, modelId: model.id })}
                              disabled={saving}
                            >
                              编辑
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>
                  </>
                ) : (
                  <div className="fw-panel-error">{error ?? '没有可用的模型配置。'}</div>
                )}
              </div>
            </div>

            <footer className="fw-settings-footer">
              <div className="fw-settings-feedback">
                {view === 'memory' ? (
                  <span className="fw-settings-hint">全局 detail 记忆库 · 只读</span>
                ) : (
                  <>
                    {error && <div className="fw-dialog-error">{error}</div>}
                    {notice && <div className="fw-settings-notice">{notice}</div>}
                  </>
                )}
              </div>
              <div className="fw-dialog-actions">
                <button
                  type="button"
                  className="fw-dialog-cancel"
                  onClick={onClose}
                  disabled={saving}
                >
                  关闭
                </button>
                {view === 'models' && (
                  <button
                    type="button"
                    className="fw-dialog-submit"
                    onClick={() => void saveProvider()}
                    disabled={saving || !provider}
                  >
                    {saving ? '保存中…' : '保存服务配置'}
                  </button>
                )}
              </div>
            </footer>
          </>
        )}

        {editingProvider && editingModel && config && (
          <ModelEditorDialog
            provider={editingProvider}
            model={editingModel}
            timeZone={config.timeZone}
            onClose={() => setEditing(undefined)}
            onSaved={next => {
              applyConfig(next)
              setNotice('模型参数已保存，下一轮生效')
            }}
          />
        )}
      </div>
    </div>
  )
}
