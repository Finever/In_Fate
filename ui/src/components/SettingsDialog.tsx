import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { ModelConfig, ModelConfigProvider, ModelPricing } from '../types'
import { AddProviderDialog } from './AddProviderDialog'
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
  const [memoryDirty, setMemoryDirty] = useState(false)
  const [providerId, setProviderId] = useState('')
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({})
  const [editing, setEditing] = useState<{ providerId: string; modelId: string }>()
  const [addProviderOpen, setAddProviderOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState<string>()
  const [discovered, setDiscovered] = useState<string[]>()
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())
  const [newModel, setNewModel] = useState('')
  const [addingModels, setAddingModels] = useState(false)

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

  const requestClose = useCallback((): void => {
    if (memoryDirty && !window.confirm('全局记忆有未保存的改动，确定关闭设置？')) return
    onClose()
  }, [memoryDirty, onClose])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving && !editing) requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, requestClose, saving])

  useEffect(() => {
    setProbing(false)
    setProbeError(undefined)
    setDiscovered(undefined)
    setSelectedModels(new Set())
    setNewModel('')
    setAddingModels(false)
  }, [providerId])

  const provider = config?.providers.find(item => item.id === providerId)
  const draft = provider ? drafts[provider.id] : undefined
  const editingProvider = editing
    ? config?.providers.find(item => item.id === editing.providerId)
    : undefined
  const editingModel = editingProvider?.models.find(model => model.id === editing?.modelId)

  function chooseProvider(nextId: string): void {
    if (memoryDirty && !window.confirm('全局记忆有未保存的改动，切回模型服务会丢失。继续？')) return
    setView('models')
    setProviderId(nextId)
    setError(undefined)
    setNotice(undefined)
  }

  function openModels(): void {
    if (memoryDirty && !window.confirm('全局记忆有未保存的改动，切回模型服务会丢失。继续？')) return
    setView('models')
    setError(undefined)
    setNotice(undefined)
    if (!config?.providers.some(item => item.id === providerId)) {
      setProviderId(config?.providers[0]?.id ?? '')
    }
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

  async function probeModels(): Promise<void> {
    if (!provider) return
    setProbing(true)
    setProbeError(undefined)
    setNotice(undefined)
    setDiscovered(undefined)
    setSelectedModels(new Set())
    try {
      const result = await api.probeModelProvider(provider.id, {
        ...(draft?.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        ...(draft?.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
      })
      setDiscovered(result.models)
    } catch (reason) {
      setProbeError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setProbing(false)
    }
  }

  async function addModels(ids: string[]): Promise<void> {
    if (!provider) return
    const fresh = ids.filter(id => !provider.models.some(model => model.id === id))
    if (fresh.length === 0) {
      setProbeError('这些模型已经在列表里。')
      return
    }
    setAddingModels(true)
    setProbeError(undefined)
    setNotice(undefined)
    try {
      const next = await api.addProviderModels(
        provider.id,
        fresh.map(id => ({ id })),
      )
      applyConfig(next)
      setDiscovered(undefined)
      setSelectedModels(new Set())
      setNewModel('')
      setNotice(`已添加 ${fresh.length} 个模型`)
    } catch (reason) {
      setProbeError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setAddingModels(false)
    }
  }

  async function addManualModel(): Promise<void> {
    const id = newModel.trim()
    if (!id || !provider) return
    if (provider.models.some(model => model.id === id)) {
      setProbeError('这个模型已经在列表里。')
      return
    }
    await addModels([id])
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
        if (!saving && !editing) requestClose()
      }}
    >
      <div
        className={`fw-settings-dialog${view === 'memory' ? ' is-memory' : ''}`}
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
            onClick={requestClose}
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
                <div className="fw-settings-nav-title">设置</div>
                <button
                  type="button"
                  className={`fw-settings-category${view === 'models' ? ' is-active' : ''}`}
                  onClick={openModels}
                  disabled={saving || Boolean(editing)}
                >
                  <span className="fw-settings-category-mark">
                    <Icon name="layers" size={13} />
                  </span>
                  <span className="fw-settings-category-text">
                    <b>模型服务</b>
                    <small>{config ? `${config.providers.length} 个服务商` : '载入中'}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={`fw-settings-category${view === 'memory' ? ' is-active' : ''}`}
                  onClick={() => {
                    setView('memory')
                    setError(undefined)
                    setNotice(undefined)
                  }}
                  disabled={saving || Boolean(editing)}
                >
                  <span className="fw-settings-category-mark">
                    <Icon name="search" size={13} />
                  </span>
                  <span className="fw-settings-category-text">
                    <b>全局记忆</b>
                    <small>detail 记忆库</small>
                  </span>
                </button>
              </aside>

              <div className={`fw-settings-main${view === 'memory' ? ' is-memory' : ''}`}>
                {view === 'memory' ? (
                  <MemoryBrowser onDirtyChange={setMemoryDirty} />
                ) : (
                  <>
                    <div className="fw-model-head">
                      <div>
                        <h3>模型服务</h3>
                        <small>{config ? `${config.providers.length} 个服务商` : '没有配置'}</small>
                      </div>
                      <button
                        type="button"
                        className="fw-settings-add-provider"
                        onClick={() => setAddProviderOpen(true)}
                        disabled={saving || Boolean(editing)}
                      >
                        <Icon name="plus" size={13} />
                        添加服务商
                      </button>
                    </div>

                    {config && (
                      <div className="fw-model-provider-grid">
                        {config.providers.map(item => {
                          const active = item.id === providerId
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
                                <small>
                                  {item.models.length} 个模型
                                  {!item.hasApiKey ? ' · 未配置 key' : ''}
                                </small>
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    )}

                    {provider && draft ? (
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
                        <span className="fw-model-head-spacer" />
                        <button
                          type="button"
                          className="fw-settings-probe"
                          onClick={() => void probeModels()}
                          disabled={probing || addingModels || saving}
                        >
                          {probing ? '读取中…' : '读取模型列表'}
                        </button>
                      </div>

                      {probeError && (
                        <div className="fw-dialog-error fw-model-probe-error">{probeError}</div>
                      )}

                      {discovered && (
                        <div className="fw-model-discovered">
                          <div className="fw-model-discovered-head">
                            <span>读到 {discovered.length} 个模型</span>
                            <span className="fw-model-head-spacer" />
                            <button
                              type="button"
                              onClick={() => setSelectedModels(new Set(
                                discovered.filter(id =>
                                  !provider.models.some(model => model.id === id)),
                              ))}
                            >
                              全选新模型
                            </button>
                            <button type="button" onClick={() => setSelectedModels(new Set())}>
                              清空
                            </button>
                            <button
                              type="button"
                              className="fw-dialog-submit fw-mem-btn"
                              onClick={() => void addModels([...selectedModels])}
                              disabled={selectedModels.size === 0 || addingModels}
                            >
                              {addingModels
                                ? '添加中…'
                                : `添加所选${selectedModels.size ? `（${selectedModels.size}）` : ''}`}
                            </button>
                          </div>
                          <div className="fw-model-discovered-list">
                            {discovered.map(id => {
                              const exists = provider.models.some(model => model.id === id)
                              return (
                                <label
                                  key={id}
                                  className={`fw-model-discovered-item${exists ? ' is-existing' : ''}`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={selectedModels.has(id)}
                                    disabled={exists || addingModels}
                                    onChange={event => {
                                      setSelectedModels(current => {
                                        const next = new Set(current)
                                        if (event.target.checked) next.add(id)
                                        else next.delete(id)
                                        return next
                                      })
                                    }}
                                  />
                                  <span>{id}</span>
                                  {exists && <em>已有</em>}
                                </label>
                              )
                            })}
                          </div>
                        </div>
                      )}

                      {provider.models.length === 0 && (
                        <div className="fw-settings-models-empty">
                          还没有模型；点「读取模型列表」或手动添加。
                        </div>
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

                      <div className="fw-model-manual">
                        <input
                          value={newModel}
                          onChange={event => setNewModel(event.target.value)}
                          placeholder="手动添加 model id"
                          spellCheck={false}
                          disabled={addingModels}
                          onKeyDown={event => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void addManualModel()
                            }
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => void addManualModel()}
                          disabled={!newModel.trim() || addingModels}
                        >
                          添加
                        </button>
                      </div>
                    </section>
                      </>
                    ) : (
                      <div className="fw-panel-error">{error ?? '没有可用的模型配置。'}</div>
                    )}
                  </>
                )}
              </div>
            </div>

            <footer className="fw-settings-footer">
              <div className="fw-settings-feedback">
                {view === 'memory' ? (
                  <span className="fw-settings-hint">全局 detail 记忆库 · 保存前校验</span>
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
                  onClick={requestClose}
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

        {addProviderOpen && (
          <AddProviderDialog
            onClose={() => setAddProviderOpen(false)}
            onCreated={(next, providerId) => {
              applyConfig(next)
              setProviderId(providerId)
              setView('models')
              setError(undefined)
              setNotice('模型服务商已添加')
              setAddProviderOpen(false)
            }}
          />
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
