import { useEffect, useState } from 'react'
import { api } from '../api'
import type {
  ModelConfig,
  ModelConfigProvider,
  ModelPricing,
  PriceRate,
  PricingWindow,
} from '../types'
import { Icon } from './Icon'
import { PricingWindowsEditor } from './PricingWindowsEditor'

type ModelView = ModelConfigProvider['models'][number]

function rateText(rate: PriceRate | undefined): string {
  return rate ? String(rate.perMillionTokens) : ''
}

function currencyOf(pricing: ModelPricing | undefined): string {
  return pricing?.input?.currency
    ?? pricing?.output?.currency
    ?? pricing?.cacheRead?.currency
    ?? pricing?.offPeak?.input?.currency
    ?? 'CNY'
}

function windowCopy(windows: readonly PricingWindow[] | undefined): PricingWindow[] {
  return (windows ?? []).map(window => ({
    ...(window.days ? { days: [...window.days] } : {}),
    start: window.start,
    end: window.end,
  }))
}

export function ModelEditorDialog({
  provider,
  model,
  timeZone,
  onClose,
  onSaved,
}: {
  provider: ModelConfigProvider
  model: ModelView
  timeZone: string
  onClose: () => void
  onSaved: (config: ModelConfig) => void
}) {
  const pricing = model.pricing
  const [contextWindow, setContextWindow] = useState(
    model.contextWindow !== undefined ? String(model.contextWindow) : '',
  )
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    model.maxOutputTokens !== undefined ? String(model.maxOutputTokens) : '',
  )
  const [currency, setCurrency] = useState(currencyOf(pricing))
  const [input, setInput] = useState(rateText(pricing?.input))
  const [output, setOutput] = useState(rateText(pricing?.output))
  const [cacheRead, setCacheRead] = useState(rateText(pricing?.cacheRead))
  const [offPeak, setOffPeak] = useState(Boolean(pricing?.offPeak))
  const [offInput, setOffInput] = useState(rateText(pricing?.offPeak?.input))
  const [offOutput, setOffOutput] = useState(rateText(pricing?.offPeak?.output))
  const [offCacheRead, setOffCacheRead] = useState(rateText(pricing?.offPeak?.cacheRead))
  const [windows, setWindows] = useState<PricingWindow[]>(
    windowCopy(pricing?.offPeak?.windows),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  function numberOrNull(value: string, label: string): number | null {
    if (!value.trim()) return null
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) {
      throw new Error(`${label}必须是正数`)
    }
    return Math.round(number)
  }

  function rate(value: string, label: string): PriceRate | undefined {
    if (!value.trim()) return undefined
    const number = Number(value)
    if (!Number.isFinite(number) || number < 0) {
      throw new Error(`${label}必须是非负数`)
    }
    return {
      currency: currency.trim() || 'CNY',
      perMillionTokens: number,
    }
  }

  async function save(): Promise<void> {
    if (saving) return
    setSaving(true)
    setError(undefined)
    try {
      const parsedContext = numberOrNull(contextWindow, '上下文窗口')
      const parsedOutput = numberOrNull(maxOutputTokens, '最大输出')
      const standard = {
        input: rate(input, '输入单价'),
        output: rate(output, '输出单价'),
        cacheRead: rate(cacheRead, '缓存命中单价'),
      }
      const hasStandard = Object.values(standard).some(Boolean)
      const offRates = {
        input: rate(offInput, '低谷输入单价'),
        output: rate(offOutput, '低谷输出单价'),
        cacheRead: rate(offCacheRead, '低谷缓存单价'),
      }
      const hasOffRates = Object.values(offRates).some(Boolean)
      if (offPeak && windows.length === 0) {
        throw new Error('启用低谷价时至少需要一个低谷时段')
      }
      if (offPeak && !hasStandard && !hasOffRates) {
        throw new Error('启用低谷价时至少填一个价格')
      }
      const nextPricing: ModelPricing | null = !hasStandard && !offPeak
        ? null
        : {
          ...standard,
          ...(offPeak
            ? {
              offPeak: {
                ...offRates,
                windows: windows.map(window => ({
                  ...(window.days ? { days: window.days } : {}),
                  start: window.start,
                  end: window.end,
                })),
              },
            }
            : {}),
        }
      const config = await api.saveModelCard({
        provider: provider.id,
        model: model.id,
        contextWindow: parsedContext,
        maxOutputTokens: parsedOutput,
        pricing: nextPricing,
      })
      onSaved(config)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fw-modal-backdrop" onMouseDown={() => { if (!saving) onClose() }}>
      <div
        className="fw-model-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="编辑模型"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="fw-dialog-head">
          <div>
            <h2>编辑模型</h2>
            <p className="fw-usage-model">{provider.name} / {model.name ?? model.id}</p>
          </div>
          <button
            type="button"
            className="fw-icon-btn"
            onClick={onClose}
            disabled={saving}
            aria-label="关闭模型编辑"
            title="关闭模型编辑"
          >
            <Icon name="close" size={15} />
          </button>
        </header>

        <div className="fw-model-body">
          <section className="fw-model-section">
            <div className="fw-settings-models-head">
              <span>基础</span>
              <small>token 数只影响上下文与输出展示</small>
            </div>
            <div className="fw-model-grid">
              <label className="fw-field">
                <span>上下文窗口</span>
                <input
                  type="number"
                  min="1"
                  value={contextWindow}
                  onChange={event => setContextWindow(event.target.value)}
                  placeholder="例如 128000"
                  disabled={saving}
                />
              </label>
              <label className="fw-field">
                <span>最大输出</span>
                <input
                  type="number"
                  min="1"
                  value={maxOutputTokens}
                  onChange={event => setMaxOutputTokens(event.target.value)}
                  placeholder="例如 8192"
                  disabled={saving}
                />
              </label>
            </div>
          </section>

          <section className="fw-model-section">
            <div className="fw-settings-models-head">
              <span>价格</span>
              <small>每百万 token；留空按 0 计</small>
            </div>
            <label className="fw-field fw-model-currency">
              <span>币种</span>
              <input
                value={currency}
                onChange={event => setCurrency(event.target.value)}
                placeholder="CNY"
                spellCheck={false}
                disabled={saving}
              />
            </label>
            <div className="fw-model-price-title">高峰价</div>
            <div className="fw-model-grid fw-model-grid-3">
              <label className="fw-field">
                <span>输入</span>
                <input
                  type="number"
                  min="0"
                  step="0.000001"
                  value={input}
                  onChange={event => setInput(event.target.value)}
                  placeholder="0"
                  disabled={saving}
                />
              </label>
              <label className="fw-field">
                <span>输出</span>
                <input
                  type="number"
                  min="0"
                  step="0.000001"
                  value={output}
                  onChange={event => setOutput(event.target.value)}
                  placeholder="0"
                  disabled={saving}
                />
              </label>
              <label className="fw-field">
                <span>缓存命中</span>
                <input
                  type="number"
                  min="0"
                  step="0.000001"
                  value={cacheRead}
                  onChange={event => setCacheRead(event.target.value)}
                  placeholder="0"
                  disabled={saving}
                />
              </label>
            </div>

            <label className="fw-model-toggle">
              <input
                type="checkbox"
                checked={offPeak}
                onChange={event => setOffPeak(event.target.checked)}
                disabled={saving}
              />
              启用低谷价
            </label>

            {offPeak && (
              <div className="fw-model-offpeak">
                <div className="fw-model-grid fw-model-grid-3">
                  <label className="fw-field">
                    <span>低谷输入</span>
                    <input
                      type="number"
                      min="0"
                      step="0.000001"
                      value={offInput}
                      onChange={event => setOffInput(event.target.value)}
                      placeholder="继承高峰"
                      disabled={saving}
                    />
                  </label>
                  <label className="fw-field">
                    <span>低谷输出</span>
                    <input
                      type="number"
                      min="0"
                      step="0.000001"
                      value={offOutput}
                      onChange={event => setOffOutput(event.target.value)}
                      placeholder="继承高峰"
                      disabled={saving}
                    />
                  </label>
                  <label className="fw-field">
                    <span>低谷缓存</span>
                    <input
                      type="number"
                      min="0"
                      step="0.000001"
                      value={offCacheRead}
                      onChange={event => setOffCacheRead(event.target.value)}
                      placeholder="继承高峰"
                      disabled={saving}
                    />
                  </label>
                </div>
                <PricingWindowsEditor
                  windows={windows}
                  timeZone={timeZone}
                  onChange={setWindows}
                />
              </div>
            )}
          </section>

          {error && <div className="fw-dialog-error">{error}</div>}
        </div>

        <footer className="fw-model-footer">
          <button
            type="button"
            className="fw-dialog-cancel"
            onClick={onClose}
            disabled={saving}
          >
            取消
          </button>
          <button
            type="button"
            className="fw-dialog-submit"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  )
}
