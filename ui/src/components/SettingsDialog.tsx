import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { ModelConfig, ModelConfigProvider, ModelPricing } from '../types'
import { AddProviderDialog } from './AddProviderDialog'
import { Icon } from './Icon'
import { MemoryBrowser } from './MemoryBrowser'
import { ModelEditorDialog } from './ModelEditorDialog'

interface ProviderDraft {
  baseUrl: string
  format: string
  apiKey: string
}

function initialDraft(provider: ModelConfigProvider): ProviderDraft {
  return { baseUrl: provider.baseUrl, format: provider.endpointFamily, apiKey: '' }
}

function providerMark(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?'
}

function formatTokens(value: number | undefined): string {
  return value === undefined ? '未配置' : Math.round(value).toLocaleString('en-US')
}

function formatLabel(family: string): string {
  switch (family) {
    case 'openai-chat-completions': return 'OpenAI 兼容 · Chat Completions'
    case 'openai-responses': return 'OpenAI Responses'
    case 'anthropic-messages': return 'Anthropic Messages'
    case 'google-generate-content': return 'Google Generate Content'
    default: return family || '未知格式'
  }
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
  const [providerQuery, setProviderQuery] = useState('')
  const [providerFilter, setProviderFilter] = useState<'enabled' | 'disabled' | 'all'>('enabled')
  const [showDisabledModels, setShowDisabledModels] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [keySaving, setKeySaving] = useState(false)

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
    setShowDisabledModels(false)
    setDeleting(false)
  }, [providerId])

  const provider = config?.providers.find(item => item.id === providerId)
  const draft = provider ? drafts[provider.id] : undefined
  const providerList = config?.providers ?? []
  const activeProviderCount = providerList.filter(item => item.enabled !== false).length
  const providerNeedle = providerQuery.trim().toLowerCase()
  const visibleProviders = providerList
    .filter(item => {
      if (providerFilter === 'enabled' && item.enabled === false) return false
      if (providerFilter === 'disabled' && item.enabled !== false) return false
      return !providerNeedle
        || item.name.toLowerCase().includes(providerNeedle)
        || item.id.toLowerCase().includes(providerNeedle)
    })
    .sort((a, b) =>
      Number(b.enabled) - Number(a.enabled)
      || Number(b.hasApiKey) - Number(a.hasApiKey)
      || a.name.localeCompare(b.name, 'zh'))
  const visibleModels = provider
    ? provider.models.filter(model => showDisabledModels || model.enabled !== false)
    : []
  const enabledModelCount = provider
    ? provider.models.filter(model => model.enabled !== false).length
    : 0
  const enabledKeyCount = provider
    ? provider.apiKeys.filter(entry => entry.isEnabled).length
    : 0
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

  function applyConfig(
    next: ModelConfig,
    savedProvider?: string,
    clearKeyFor?: string,
  ): void {
    setConfig(next)
    setDrafts(current => {
      const updated = { ...current }
      for (const item of next.providers) {
        const existing = updated[item.id] ?? initialDraft(item)
        if (savedProvider === item.id) {
          const format = item.endpoints.some(endpoint => endpoint.family === existing.format)
            ? existing.format
            : item.endpointFamily
          const baseUrl = item.endpoints.find(endpoint => endpoint.family === format)?.baseUrl
            ?? item.baseUrl
          updated[item.id] = { ...existing, format, baseUrl, apiKey: '' }
        } else if (clearKeyFor === item.id) {
          updated[item.id] = { ...existing, apiKey: '' }
        } else {
          updated[item.id] = existing
        }
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
        ...(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
        ...(draft.format ? { format: draft.format } : {}),
      })
      applyConfig(next, provider.id)
      setNotice('服务配置已保存，下一轮生效')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  function changeFormat(format: string): void {
    const endpoint = provider?.endpoints.find(item => item.family === format)
    updateDraft({ format, ...(endpoint ? { baseUrl: endpoint.baseUrl } : {}) })
  }

  async function addApiKey(): Promise<void> {
    if (!provider || !draft || keySaving) return
    const key = draft.apiKey.trim()
    if (!key) return
    setKeySaving(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const next = await api.addModelApiKey(provider.id, key)
      applyConfig(next, undefined, provider.id)
      setNotice('API key 已添加；请求会按启用顺序轮换')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setKeySaving(false)
    }
  }

  async function setApiKeyEnabled(keyId: string, isEnabled: boolean): Promise<void> {
    if (!provider || keySaving) return
    setKeySaving(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const next = await api.setModelApiKeyEnabled(provider.id, keyId, isEnabled)
      applyConfig(next)
      setNotice(isEnabled ? 'API key 已启用' : 'API key 已停用')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setKeySaving(false)
    }
  }

  async function removeApiKey(keyId: string): Promise<void> {
    if (!provider || keySaving) return
    if (!window.confirm('删除这个 API key？')) return
    setKeySaving(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const next = await api.removeModelApiKey(provider.id, keyId)
      applyConfig(next)
      setNotice('API key 已删除')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setKeySaving(false)
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
        ...(draft?.format ? { format: draft.format } : {}),
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

  async function setProviderEnabled(enabled: boolean): Promise<void> {
    if (!provider) return
    setSaving(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const next = await api.saveModelConfig({ provider: provider.id, enabled })
      applyConfig(next)
      setNotice(enabled ? '服务商已启用' : '服务商已停用')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  async function setModelEnabled(modelId: string, enabled: boolean): Promise<void> {
    if (!provider) return
    setSaving(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const next = await api.saveModelCard({ provider: provider.id, model: modelId, enabled })
      applyConfig(next)
      setNotice(enabled ? '模型已启用' : '模型已停用')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  async function deleteProvider(): Promise<void> {
    if (!provider || !provider.removable) return
    if (!window.confirm(`删除服务商「${provider.name}」？\n配置里的端点、模型和 key 会一起删掉。`)) return
    setDeleting(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const next = await api.removeModelProvider(provider.id)
      applyConfig(next)
      setProviderId(next.providers[0]?.id ?? '')
      setNotice('服务商已删除')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDeleting(false)
    }
  }

  const keyPlaceholder = provider?.apiKeyEnv
    ? `输入新 key（也可用环境变量 ${provider.apiKeyEnv}）`
    : '输入新的 API key，添加后不回显'

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
                    <small>{config ? `${activeProviderCount} 个启用` : '载入中'}</small>
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
                      <>
                        <div className="fw-model-provider-toolbar">
                          <input
                            value={providerQuery}
                            onChange={event => setProviderQuery(event.target.value)}
                            placeholder="搜索服务商 id / 名称"
                            spellCheck={false}
                          />
                          <div className="fw-model-filter">
                            <button
                              type="button"
                              className={providerFilter === 'enabled' ? 'is-active' : ''}
                              onClick={() => setProviderFilter('enabled')}
                            >
                              启用
                            </button>
                            <button
                              type="button"
                              className={providerFilter === 'disabled' ? 'is-active' : ''}
                              onClick={() => setProviderFilter('disabled')}
                            >
                              已停用
                            </button>
                            <button
                              type="button"
                              className={providerFilter === 'all' ? 'is-active' : ''}
                              onClick={() => setProviderFilter('all')}
                            >
                              全部
                            </button>
                          </div>
                          <small>{visibleProviders.length} / {providerList.length}</small>
                        </div>
                        <div className="fw-model-provider-grid">
                          {visibleProviders.map(item => {
                            const active = item.id === providerId
                            return (
                              <button
                                key={item.id}
                                type="button"
                                className={`fw-settings-provider${active ? ' is-active' : ''}${item.enabled === false ? ' is-disabled' : ''}`}
                                onClick={() => chooseProvider(item.id)}
                                disabled={saving || Boolean(editing)}
                              >
                                <span className="fw-settings-provider-mark">
                                  {providerMark(item.name)}
                                </span>
                                <span className="fw-settings-provider-text">
                                  <b>{item.name}</b>
                                  <small>
                                    {item.models.filter(model => model.enabled !== false).length} 个模型
                                    {!item.hasApiKey ? ' · 未配置 key' : ''}
                                    {item.enabled === false ? ' · 已停用' : ''}
                                  </small>
                                </span>
                              </button>
                            )
                          })}
                          {visibleProviders.length === 0 && (
                            <div className="fw-panel-empty">没有匹配的服务商。</div>
                          )}
                        </div>
                      </>
                    )}

                    {provider && draft ? (
                      <>
                        <div className="fw-settings-provider-head">
                          <h3>{provider.name}</h3>
                          <span className="fw-settings-provider-format">
                            {formatLabel(draft.format)}
                          </span>
                          <span className="fw-model-head-spacer" />
                          <label className="fw-settings-enabled">
                            <input
                              type="checkbox"
                              checked={provider.enabled}
                              onChange={event => void setProviderEnabled(event.target.checked)}
                              disabled={saving || deleting}
                            />
                            启用
                          </label>
                          <button
                            type="button"
                            className="fw-settings-provider-delete"
                            onClick={() => void deleteProvider()}
                            disabled={saving || deleting}
                          >
                            {deleting ? '删除中…' : '删除服务商'}
                          </button>
                        </div>

                    <div className="fw-settings-fields">
                      <label className="fw-field">
                        <span>端点格式</span>
                        {provider.endpointFamilies.length > 1 ? (
                          <select
                            value={draft.format}
                            onChange={event => changeFormat(event.target.value)}
                            disabled={saving}
                          >
                            {provider.endpointFamilies.map(family => (
                              <option key={family} value={family}>
                                {formatLabel(family)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input value={formatLabel(draft.format)} readOnly disabled />
                        )}
                      </label>

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
                    </div>

                    <section className="fw-settings-keys">
                      <div className="fw-settings-keys-head">
                        <span>API keys</span>
                        <small>
                          {provider.apiKeys.length} 个 · 启用 {enabledKeyCount}
                        </small>
                        <span className="fw-model-head-spacer" />
                        {provider.apiKeyEnv && (
                          <small className="fw-settings-keys-env">
                            环境变量 {provider.apiKeyEnv}
                          </small>
                        )}
                      </div>

                      {provider.apiKeys.length === 0 ? (
                        <div className="fw-settings-keys-empty">
                          还没有添加 key。
                          {provider.hasApiKey ? ' 已有旧配置或环境变量里的 key，会与列表里的密钥一起轮换。' : ''}
                        </div>
                      ) : (
                        <div className="fw-settings-key-list">
                          {provider.apiKeys.map(entry => (
                            <div className="fw-settings-key" key={entry.id}>
                              <span className="fw-settings-key-preview">{entry.preview}</span>
                              <label className="fw-settings-key-enabled">
                                <input
                                  type="checkbox"
                                  checked={entry.isEnabled}
                                  onChange={event =>
                                    void setApiKeyEnabled(entry.id, event.target.checked)}
                                  disabled={keySaving}
                                />
                                启用
                              </label>
                              <button
                                type="button"
                                className="fw-settings-key-remove"
                                onClick={() => void removeApiKey(entry.id)}
                                disabled={keySaving}
                              >
                                删除
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="fw-settings-key-add">
                        <input
                          type="password"
                          value={draft.apiKey}
                          onChange={event => updateDraft({ apiKey: event.target.value })}
                          placeholder={keyPlaceholder}
                          autoComplete="off"
                          spellCheck={false}
                          disabled={saving || keySaving}
                          onKeyDown={event => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void addApiKey()
                            }
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => void addApiKey()}
                          disabled={!draft.apiKey.trim() || saving || keySaving}
                        >
                          {keySaving ? '添加中…' : '添加 key'}
                        </button>
                      </div>
                    </section>

                    <section className="fw-settings-models">
                      <div className="fw-settings-models-head">
                        <span>模型</span>
                        <small>
                          {enabledModelCount === provider.models.length
                            ? `${provider.models.length} 个`
                            : `${enabledModelCount} / ${provider.models.length} 个`}
                        </small>
                        <span className="fw-model-head-spacer" />
                        {provider.models.some(model => model.enabled === false) && (
                          <button
                            type="button"
                            className="fw-settings-probe"
                            onClick={() => setShowDisabledModels(value => !value)}
                          >
                            {showDisabledModels ? '隐藏已停用' : '显示已停用'}
                          </button>
                        )}
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
                      {provider.models.length > 0 && visibleModels.length === 0 && (
                        <div className="fw-settings-models-empty">
                          没有启用的模型；点「显示已停用」查看。
                        </div>
                      )}

                      <div className="fw-settings-model-list">
                        {visibleModels.map(model => (
                          <div
                            className={`fw-settings-model${model.enabled === false ? ' is-disabled' : ''}`}
                            key={model.id}
                          >
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
                            <label className="fw-settings-model-enabled">
                              <input
                                type="checkbox"
                                checked={model.enabled !== false}
                                onChange={event => void setModelEnabled(model.id, event.target.checked)}
                                disabled={saving}
                              />
                              启用
                            </label>
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
