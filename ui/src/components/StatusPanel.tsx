import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { relativeTime } from '../lib/format'
import type {
  AgentSummary,
  ModelConfig,
  ModelRef,
  SessionInfo,
  ToolView,
} from '../types'

function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  return a?.provider === b?.provider && a?.model === b?.model
}

function modelKey(choice: ModelRef): string {
  return `${choice.provider}\u0000${choice.model}`
}

function modelSummary(config: ModelConfig, choice: ModelRef | undefined): string {
  if (!choice) return '还没有选择模型'
  const provider = config.providers.find(item => item.id === choice.provider)
  const model = provider?.models.find(item => item.id === choice.model)
  if (!model) return '模型不在当前目录里'
  const pricing = model.pricing
  const currency = pricing?.input?.currency
    ?? pricing?.output?.currency
    ?? pricing?.cacheRead?.currency
    ?? pricing?.offPeak?.input?.currency
    ?? 'CNY'
  const price = pricing
    ? `${currency} · 入 ${pricing.input?.perMillionTokens ?? 0} / 出 ${pricing.output?.perMillionTokens ?? 0} / 缓 ${pricing.cacheRead?.perMillionTokens ?? 0}`
    : '未配置单价'
  return `上下文 ${model.contextWindow?.toLocaleString('en-US') ?? '未配置'} · 最大输出 ${model.maxOutputTokens?.toLocaleString('en-US') ?? '未配置'} · ${price}`
}

export function StatusPanel({
  agentId,
  agent,
  sessions,
  onSelectSession,
  onOpenSettings,
  onChanged,
}: {
  agentId: string
  agent: AgentSummary | undefined
  sessions: SessionInfo[]
  onSelectSession: (sessionId: string) => void
  onOpenSettings: () => void
  onChanged: () => void
}) {
  const [config, setConfig] = useState<ModelConfig>()
  const [summary, setSummary] = useState<AgentSummary | undefined>(agent)
  const [tools, setTools] = useState<ToolView[]>([])
  const [modelProvider, setModelProvider] = useState('')
  const [modelId, setModelId] = useState('')
  const [subagentModels, setSubagentModels] = useState<ModelRef[]>([])
  const [subagentPresets, setSubagentPresets] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState<string>()

  useEffect(() => {
    if (!agent) return
    setSummary(agent)
    if (agent.model) {
      setModelProvider(agent.model.provider)
      setModelId(agent.model.model)
      setSubagentModels(agent.subagentModels.length
        ? [...agent.subagentModels]
        : [agent.model])
    }
    setSubagentPresets(agent.subagentPresets
      ?? agent.availablePresets.map(item => item.id))
  }, [
    agent?.id,
    agent?.model?.provider,
    agent?.model?.model,
    agent?.modelConfigured,
  ])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(undefined)
    setNotice(undefined)
    setTools([])
    setSubagentModels([])
    setSubagentPresets([])
    if (!agentId) {
      setLoading(false)
      return
    }
    void Promise.all([
      api.modelConfig(),
      api.tools(agentId),
    ])
      .then(([nextConfig, nextTools]) => {
        if (cancelled) return
        setConfig(nextConfig)
        setTools(nextTools)
        const nextSummary = agent
        const current = nextSummary?.model
        const firstProvider = nextConfig.providers[0]
        setModelProvider(current?.provider ?? firstProvider?.id ?? '')
        setModelId(
          current?.model
            ?? firstProvider?.models[0]?.id
            ?? '',
        )
        setSubagentModels(
          nextSummary?.subagentModels?.length
            ? [...nextSummary.subagentModels]
            : current ? [current] : [],
        )
        setSubagentPresets(
          nextSummary?.subagentPresets
            ?? nextSummary?.availablePresets.map(item => item.id)
            ?? [],
        )
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
  }, [agentId])

  const modelOptions = useMemo(() => config?.providers
    .filter(provider => provider.enabled !== false)
    .flatMap(provider => provider.models
      .filter(model => model.enabled !== false)
      .map(model => ({
        provider: provider.id,
        model: model.id,
        label: `${provider.name} / ${model.name ?? model.id}`,
      }))) ?? [], [config])

  const selectedModel = modelProvider && modelId
    ? { provider: modelProvider, model: modelId }
    : undefined
  const allTools = tools.map(tool => tool.name)
  const agentAllow = summary?.tools.allow !== undefined
    ? new Set(summary.tools.allow)
    : new Set(allTools)

  async function saveModel(): Promise<void> {
    if (!modelProvider || !modelId) return
    setBusy('model')
    setError(undefined)
    setNotice(undefined)
    try {
      const choice = { provider: modelProvider, model: modelId }
      const nextSubagents = subagentModels.some(item => sameModel(item, choice))
        ? subagentModels
        : [choice, ...subagentModels]
      const next = await api.updateAgentSettings(agentId, {
        model: choice,
        subagentModels: nextSubagents,
        ...(summary ? { subagentPresets } : {}),
      })
      setSummary(next)
      setSubagentModels(next.subagentModels)
      setNotice('当前模型已保存，下一轮生效')
      onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function saveSubagents(): Promise<void> {
    if (!summary) return
    setBusy('subagents')
    setError(undefined)
    setNotice(undefined)
    try {
      const next = await api.updateAgentSettings(agentId, {
        subagentModels,
        subagentPresets,
      })
      setSummary(next)
      setSubagentModels(next.subagentModels)
      setNotice('子 agent 设置已保存')
      onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function toggleGlobalTool(tool: ToolView): Promise<void> {
    setBusy(`tool:${tool.name}`)
    setError(undefined)
    try {
      await api.updateTool(tool.name, { enabled: !tool.enabled })
      setTools(await api.tools(agentId))
      onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function setGlobalApproval(tool: ToolView, value: 'auto' | 'required'): Promise<void> {
    setBusy(`tool:${tool.name}`)
    setError(undefined)
    try {
      await api.updateTool(tool.name, { approval: value })
      setTools(await api.tools(agentId))
      onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function toggleAgentTool(tool: ToolView): Promise<void> {
    if (!summary) return
    const next = new Set(agentAllow)
    if (next.has(tool.name)) next.delete(tool.name)
    else next.add(tool.name)
    setBusy(`agent-tool:${tool.name}`)
    setError(undefined)
    try {
      const updated = await api.updateAgentSettings(agentId, {
        tools: {
          allow: [...next],
          ...(summary.tools.approval ? { approval: summary.tools.approval } : {}),
        },
      })
      setSummary(updated)
      setTools(await api.tools(agentId))
      onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function setAgentApproval(
    tool: ToolView,
    value: '' | 'auto' | 'required',
  ): Promise<void> {
    if (!summary) return
    const approval = { ...(summary.tools.approval ?? {}) }
    if (value === '') delete approval[tool.name]
    else approval[tool.name] = value
    setBusy(`agent-tool:${tool.name}`)
    setError(undefined)
    try {
      const updated = await api.updateAgentSettings(agentId, {
        tools: {
          ...(summary.tools.allow !== undefined ? { allow: summary.tools.allow } : {}),
          approval,
        },
      })
      setSummary(updated)
      setTools(await api.tools(agentId))
      onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  if (loading) {
    return <div className="fw-panel-loading"><span className="fw-spinner" /> 载入状态…</div>
  }

  return (
    <div className="fw-status-panel">
      <div className="fw-status-agent-head">
        <div>
          <h3>{summary?.name ?? agentId}</h3>
          <p>{agentId}</p>
        </div>
        <span className={`fw-status-model-state${summary?.modelConfigured ? ' is-ok' : ''}`}>
          {summary?.modelConfigured ? '模型已配置' : '模型未配置'}
        </span>
      </div>

      {error && <div className="fw-dialog-error fw-status-error">{error}</div>}
      {notice && <div className="fw-settings-notice">{notice}</div>}

      <section className="fw-status-section">
        <div className="fw-status-section-head">
          <span>当前模型</span>
          <button type="button" className="fw-status-link" onClick={onOpenSettings}>
            管理模型目录…
          </button>
        </div>
        {!config && <div className="fw-status-empty">模型目录没有加载。</div>}
        {config && (
          <>
            <div className="fw-status-model-row">
              <select
                value={modelProvider}
                onChange={event => {
                  const provider = config.providers.find(item => item.id === event.target.value)
                  setModelProvider(event.target.value)
                  setModelId(provider?.models[0]?.id ?? '')
                }}
                aria-label="模型服务商"
              >
                {config.providers.map(provider => (
                  <option key={provider.id} value={provider.id}>{provider.name}</option>
                ))}
              </select>
              <select
                value={modelId}
                onChange={event => setModelId(event.target.value)}
                aria-label="模型"
              >
                {config.providers.find(item => item.id === modelProvider)?.models.map(model => (
                  <option key={model.id} value={model.id}>{model.name ?? model.id}</option>
                ))}
              </select>
              <button
                type="button"
                className="fw-status-save"
                onClick={() => void saveModel()}
                disabled={busy === 'model' || !modelProvider || !modelId}
              >
                {busy === 'model' ? '保存中…' : '保存'}
              </button>
            </div>
            <div className="fw-status-model-summary">
              {modelSummary(config, selectedModel)}
            </div>
            {!summary?.modelConfigured && (
              <div className="fw-status-warning">
                这个 agent 还没有模型，保存后才能发消息。
              </div>
            )}
          </>
        )}
      </section>

      <section className="fw-status-section">
        <div className="fw-status-section-head">
          <span>子 agent</span>
          <button
            type="button"
            className="fw-status-save"
            onClick={() => void saveSubagents()}
            disabled={busy === 'subagents' || !summary}
          >
            {busy === 'subagents' ? '保存中…' : '保存'}
          </button>
        </div>
        <div className="fw-status-subhead">可用预设</div>
        <div className="fw-status-checks">
          {(summary?.availablePresets ?? []).map(preset => {
            const checked = subagentPresets.includes(preset.id)
            return (
              <label key={preset.id} className="fw-status-check" title={preset.description}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => setSubagentPresets(current =>
                    checked
                      ? current.filter(id => id !== preset.id)
                      : [...current, preset.id])}
                />
                <span>{preset.id}</span>
              </label>
            )
          })}
          {(summary?.availablePresets?.length ?? 0) === 0 && (
            <span className="fw-status-empty">没有可用预设。</span>
          )}
        </div>

        <div className="fw-status-subhead">可用模型</div>
        <div className="fw-status-checks">
          {modelOptions.map(option => {
            const choice = { provider: option.provider, model: option.model }
            const isMain = sameModel(choice, summary?.model)
            const checked = isMain || subagentModels.some(item => sameModel(item, choice))
            return (
              <label key={`${option.provider}/${option.model}`} className="fw-status-check">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isMain}
                  onChange={() => setSubagentModels(current =>
                    checked
                      ? current.filter(item => !sameModel(item, choice))
                      : [...current, choice])}
                />
                <span>{option.label}</span>
                {isMain && <em>当前模型自动可用</em>}
              </label>
            )
          })}
        </div>
      </section>

      <section className="fw-status-section">
        <div className="fw-status-section-head">
          <span>会话</span>
          <small>{sessions.length} 个</small>
        </div>
        <div className="fw-status-sessions">
          {sessions.length === 0 && <div className="fw-status-empty">还没有会话。</div>}
          {sessions.map(session => (
            <button
              key={session.id}
              type="button"
              className="fw-status-session"
              onClick={() => onSelectSession(session.id)}
            >
              <span>{session.title || session.id}</span>
              <small>{session.state ?? session.lifecycle} · {relativeTime(session.lastActivity ?? session.updatedAt)}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="fw-status-section">
        <div className="fw-status-section-head">
          <span>工具与权限</span>
          <small>全局启停 + 这个 agent 的白名单</small>
        </div>
        <div className="fw-status-tools-head">
          <span>工具</span>
          <span>全局</span>
          <span>审批</span>
          <span>本 agent</span>
        </div>
        {tools.length === 0 && <div className="fw-status-empty">没有工具。</div>}
        {tools.map(tool => (
          <div className="fw-status-tool" key={tool.name}>
            <div className="fw-status-tool-name">
              <b title={tool.name}>{tool.name}</b>
              <small>
                {tool.source}
                {tool.dangerous ? ' · 危险' : ''}
                {tool.readOnly ? ' · 只读' : ''}
              </small>
            </div>
            <label className="fw-status-switch" title="全局启用">
              <input
                type="checkbox"
                checked={tool.enabled}
                onChange={() => void toggleGlobalTool(tool)}
                disabled={busy === `tool:${tool.name}`}
              />
            </label>
            <select
              value={tool.approval}
              onChange={event => void setGlobalApproval(
                tool,
                event.target.value as 'auto' | 'required',
              )}
              disabled={busy === `tool:${tool.name}`}
              aria-label={`${tool.name} 全局审批`}
            >
              <option value="auto">自动</option>
              <option value="required">审批</option>
            </select>
            <div className="fw-status-tool-agent">
              <label className="fw-status-check">
                <input
                  type="checkbox"
                  checked={agentAllow.has(tool.name)}
                  onChange={() => void toggleAgentTool(tool)}
                  disabled={busy === `agent-tool:${tool.name}`}
                />
                允许
              </label>
              <select
                value={tool.agentApproval ?? ''}
                onChange={event => void setAgentApproval(
                  tool,
                  event.target.value as '' | 'auto' | 'required',
                )}
                disabled={busy === `agent-tool:${tool.name}`}
                aria-label={`${tool.name} 本 agent 审批`}
              >
                <option value="">默认</option>
                <option value="auto">自动</option>
                <option value="required">审批</option>
              </select>
            </div>
          </div>
        ))}
        <div className="fw-status-mcp">
          <span>MCP 服务器</span>
          <small>下一阶段接入；这一轮先做工具启停与审批。</small>
        </div>
      </section>
    </div>
  )
}
