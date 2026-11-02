import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ModelConfig, ModelProviderInput } from '../types'

function parseModels(text: string): ModelProviderInput['models'] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [id = '', name = '', context = '', output = ''] = line
        .split('|')
        .map(part => part.trim())
      const contextWindow = context ? Number(context) : undefined
      const maxOutputTokens = output ? Number(output) : undefined
      return {
        id,
        ...(name ? { name } : {}),
        ...(Number.isFinite(contextWindow) ? { contextWindow } : {}),
        ...(Number.isFinite(maxOutputTokens) ? { maxOutputTokens } : {}),
      }
    })
}

export function AddProviderDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (config: ModelConfig, providerId: string) => void
}) {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiKeyEnv, setApiKeyEnv] = useState('')
  const [modelsText, setModelsText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const models = parseModels(modelsText)
  const valid = Boolean(
    id.trim()
    && name.trim()
    && baseUrl.trim()
    && models.length > 0
    && models.every(model => model.id),
  )

  async function submit(): Promise<void> {
    if (!valid || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const next = await api.addModelProvider({
        id: id.trim(),
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(apiKeyEnv.trim() ? { apiKeyEnv: apiKeyEnv.trim() } : {}),
        models,
      })
      onCreated(next, id.trim())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fw-modal-backdrop"
      onMouseDown={() => {
        if (!busy) onClose()
      }}
    >
      <div
        className="fw-agent-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="添加模型服务商"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="fw-dialog-head">
          <h2>添加模型服务商</h2>
          <button
            type="button"
            className="fw-icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        <p className="fw-provider-add-hint">
          内置服务商已经自动列出；这里用于添加别的 OpenAI 兼容来源。
        </p>

        <label className="fw-field">
          <span>id</span>
          <input
            autoFocus
            value={id}
            onChange={event => setId(event.target.value)}
            placeholder="例如 my-gateway"
            spellCheck={false}
            disabled={busy}
          />
          <small>小写字母开头，只能用小写字母、数字、下划线和连字符；创建后不改。</small>
        </label>

        <label className="fw-field">
          <span>名称</span>
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="显示在设置里的名字"
            disabled={busy}
          />
        </label>

        <label className="fw-field">
          <span>Base URL</span>
          <input
            value={baseUrl}
            onChange={event => setBaseUrl(event.target.value)}
            placeholder="https://…/v1"
            spellCheck={false}
            disabled={busy}
          />
        </label>

        <label className="fw-field">
          <span>描述</span>
          <input
            value={description}
            onChange={event => setDescription(event.target.value)}
            placeholder="可空"
            disabled={busy}
          />
        </label>

        <label className="fw-field">
          <span>模型</span>
          <textarea
            value={modelsText}
            onChange={event => setModelsText(event.target.value)}
            placeholder={'一行一个模型 id，例如：\nmy-model\nmy-model-pro|显示名|128000|8192'}
            spellCheck={false}
            disabled={busy}
          />
          <small>格式：`id` 或 `id|名称|上下文|最大输出`；后三项可空。</small>
        </label>

        <label className="fw-field">
          <span>API key（可空）</span>
          <input
            type="password"
            value={apiKey}
            onChange={event => setApiKey(event.target.value)}
            placeholder="留空则用环境变量或稍后再填"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
        </label>

        <label className="fw-field">
          <span>API key 环境变量（可空）</span>
          <input
            value={apiKeyEnv}
            onChange={event => setApiKeyEnv(event.target.value)}
            placeholder="例如 MY_PROVIDER_API_KEY"
            spellCheck={false}
            disabled={busy}
          />
        </label>

        {error && <div className="fw-dialog-error">{error}</div>}

        <footer className="fw-dialog-actions">
          <button type="button" className="fw-dialog-cancel" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="fw-dialog-submit"
            onClick={() => void submit()}
            disabled={busy || !valid}
          >
            {busy ? '添加中…' : '添加'}
          </button>
        </footer>
      </div>
    </div>
  )
}
