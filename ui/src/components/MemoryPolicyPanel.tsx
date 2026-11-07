import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ResolvedMemoryPolicy } from '../types'

export function MemoryPolicyPanel() {
  const [policy, setPolicy] = useState<ResolvedMemoryPolicy>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  useEffect(() => {
    void api.memoryPolicy().then(setPolicy).catch(reason => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [])

  function patch(next: Partial<ResolvedMemoryPolicy>): void {
    setPolicy(current => current ? { ...current, ...next } : current)
    setNotice(undefined)
  }

  function patchJev(next: Partial<ResolvedMemoryPolicy['jev']>): void {
    setPolicy(current => current
      ? { ...current, jev: { ...current.jev, ...next } }
      : current)
    setNotice(undefined)
  }

  async function save(): Promise<void> {
    if (!policy) return
    setSaving(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const next = await api.setMemoryPolicy('default', undefined, {
        mode: policy.mode,
        scope: policy.scope,
        write: policy.write,
        jev: policy.jev,
        rag: policy.rag,
        maxEntries: policy.maxEntries,
        maxBytes: policy.maxBytes,
      })
      setPolicy(next)
      setNotice('已保存')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  if (!policy) {
    return (
      <div className="fw-mem-empty">
        {error ? <span className="fw-dialog-error">{error}</span> : <span>载入策略…</span>}
      </div>
    )
  }

  return (
    <div className="fw-mem-policy">
      <div className="fw-mem-library-head">
        <div>
          <h3>记忆策略</h3>
          <small>默认策略；agent / session 可另行覆盖</small>
        </div>
        <div className="fw-mem-library-actions">
          {notice && <span className="fw-mem-notice">{notice}</span>}
          <button
            type="button"
            className="fw-dialog-submit fw-mem-btn"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? '保存中…' : '保存默认策略'}
          </button>
        </div>
      </div>
      {error && <div className="fw-dialog-error fw-mem-error">{error}</div>}

      <div className="fw-mem-policy-grid">
        <label>
          <span>模式</span>
          <select
            value={policy.mode}
            onChange={event => {
              const mode = event.target.value as ResolvedMemoryPolicy['mode']
              if (mode === 'jev-push' && policy.jev.enabled === 'off') {
                patchJev({ enabled: 'once' })
              }
              patch({ mode })
            }}
          >
            <option value="rag-tool">RAG 工具检索</option>
            <option value="jev-push">Jev 推送</option>
            <option value="off">关闭</option>
          </select>
        </label>
        <label>
          <span>Jev 触发</span>
          <select value={policy.jev.enabled} onChange={event => patchJev({ enabled: event.target.value as ResolvedMemoryPolicy['jev']['enabled'] })}>
            <option value="off">关闭</option>
            <option value="once">会话/压缩段一次</option>
            <option value="always">每轮</option>
          </select>
        </label>
        <label>
          <span>Jev 后端</span>
          <select value={policy.jev.backend} onChange={event => patchJev({ backend: event.target.value as ResolvedMemoryPolicy['jev']['backend'] })}>
            <option value="local">本地</option>
            <option value="api">外部 API</option>
          </select>
        </label>
        <label>
          <span>选择范围</span>
          <select value={policy.jev.scope} onChange={event => patchJev({ scope: event.target.value as ResolvedMemoryPolicy['jev']['scope'] })}>
            <option value="agent">agent 全域</option>
            <option value="all">全库</option>
            <option value="domain">指定域</option>
            <option value="target">指定文件</option>
            <option value="session">当前会话</option>
          </select>
        </label>
        <label>
          <span>scopeValue</span>
          <input
            value={policy.jev.scopeValue ?? ''}
            onChange={event => patchJev({ scopeValue: event.target.value || undefined })}
            placeholder="domain / target"
          />
        </label>
        <label>
          <span>写入审批</span>
          <select value={policy.write.approval} onChange={event => patch({ write: { approval: event.target.value as 'required' | 'off' } })}>
            <option value="required">需要审批 / 提议</option>
            <option value="off">有 propose 权限即可直写</option>
          </select>
        </label>
        <label>
          <span>最多条目</span>
          <input type="number" min={1} max={100} value={policy.maxEntries} onChange={event => patch({ maxEntries: Number(event.target.value) })} />
        </label>
        <label>
          <span>最大字节</span>
          <input type="number" min={512} step={512} value={policy.maxBytes} onChange={event => patch({ maxBytes: Number(event.target.value) })} />
        </label>
        <label className="fw-mem-policy-check">
          <input
            type="checkbox"
            checked={policy.jev.reanalyzeOnCompaction}
            onChange={event => patchJev({ reanalyzeOnCompaction: event.target.checked })}
          />
          <span>压缩后重新分析推送</span>
        </label>
      </div>

      {policy.jev.backend === 'api' && policy.jev.enabled !== 'off' && (
        <div className="fw-mem-policy-warning">
          外部 API 后端尚未接入，当前仍使用本地启发式选择；接上 API 后，选中的记忆会离开本机，私域和身份文件仍不会进入选择器。
        </div>
      )}
      <div className="fw-mem-library-note">
        Jev 推送只使用共享 detail，不包含 `_` 私域；摘要由“结构 → 重建摘要”生成。
      </div>
    </div>
  )
}
