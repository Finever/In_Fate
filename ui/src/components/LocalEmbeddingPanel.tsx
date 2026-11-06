import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { EmbeddingInstallJob, EmbeddingModelStatus } from '../types'

function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${value} B`
}

function percent(value: number): string {
  return `${Math.max(0, Math.min(100, Math.round(value * 100)))}%`
}

export function LocalEmbeddingPanel() {
  const [models, setModels] = useState<EmbeddingModelStatus[]>([])
  const [jobs, setJobs] = useState<Record<string, EmbeddingInstallJob>>({})
  const [mirror, setMirror] = useState(true)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const mounted = useRef(true)

  async function reload(): Promise<void> {
    const next = await api.embeddingModels()
    if (mounted.current) setModels(next)
  }

  useEffect(() => {
    mounted.current = true
    void reload()
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false))
    return () => {
      mounted.current = false
    }
  }, [])

  async function install(modelId: string): Promise<void> {
    if (busy) return
    setBusy(modelId)
    setError(undefined)
    try {
      let job = await api.startEmbeddingInstall(modelId, mirror)
      setJobs(current => ({ ...current, [modelId]: job }))
      while (job.status === 'running') {
        await new Promise(resolve => setTimeout(resolve, 700))
        job = await api.embeddingInstallJob(job.id)
        if (!mounted.current) return
        setJobs(current => ({ ...current, [modelId]: job }))
      }
      if (job.status === 'error') {
        setError(job.error ?? '下载失败')
      } else {
        await reload()
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }

  async function activate(modelId: string): Promise<void> {
    if (busy) return
    setBusy(modelId)
    setError(undefined)
    try {
      await api.activateEmbeddingModel(modelId)
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }

  async function remove(modelId: string): Promise<void> {
    if (busy) return
    if (!window.confirm('删除这个本地模型？已下载的权重会从磁盘移除。')) return
    setBusy(modelId)
    setError(undefined)
    try {
      const next = await api.removeEmbeddingModel(modelId)
      if (mounted.current) setModels(next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }

  return (
    <div className="fw-local-models">
      <div className="fw-local-models-head">
        <div>
          <h3>本地模型</h3>
          <small>权重不随项目内置，按需下载到 data/models/embeddings。</small>
        </div>
        <label className="fw-local-mirror">
          <input
            type="checkbox"
            checked={mirror}
            onChange={event => setMirror(event.target.checked)}
          />
          使用 hf-mirror 镜像
        </label>
      </div>

      {error && <div className="fw-dialog-error">{error}</div>}
      {loading && <div className="fw-panel-loading"><span className="fw-spinner" /> 读取本地模型…</div>}

      {!loading && (
        <div className="fw-local-model-list">
          {models.map(model => {
            const job = jobs[model.preset.id]
            const running = job?.status === 'running'
            return (
              <article
                className={`fw-local-model${model.active ? ' is-active' : ''}`}
                key={model.preset.id}
              >
                <div className="fw-local-model-head">
                  <div>
                    <b>{model.preset.name}</b>
                    <small>{model.preset.id}</small>
                  </div>
                  <span className={`fw-local-model-badge${model.active ? ' is-active' : ''}`}>
                    {model.active ? '使用中' : model.installed ? '已安装' : '未安装'}
                  </span>
                </div>
                <p>{model.preset.description}</p>
                <div className="fw-local-model-meta">
                  <span>{model.preset.quantization}</span>
                  <span>{model.preset.dimensions} 维</span>
                  <span>{model.preset.contextSize.toLocaleString()} ctx</span>
                  <span>{formatBytes(model.totalBytes)}</span>
                  <span>{model.preset.license}</span>
                </div>

                {job && (running || job.status === 'error') && (
                  <div className="fw-local-progress">
                    <div className="fw-local-progress-bar">
                      <span style={{ width: percent(job.ratio) }} />
                    </div>
                    <small>
                      {running
                        ? `${percent(job.ratio)} · ${formatBytes(job.received)} / ${formatBytes(job.total || model.totalBytes)}`
                        : job.error ?? '下载失败'}
                    </small>
                  </div>
                )}

                <div className="fw-local-model-actions">
                  {!model.installed ? (
                    <button
                      type="button"
                      className="fw-dialog-submit"
                      onClick={() => void install(model.preset.id)}
                      disabled={Boolean(busy)}
                    >
                      {running ? '下载中…' : busy === model.preset.id ? '准备中…' : '下载安装'}
                    </button>
                  ) : (
                    <>
                      {!model.active && (
                        <button
                          type="button"
                          className="fw-dialog-submit"
                          onClick={() => void activate(model.preset.id)}
                          disabled={Boolean(busy)}
                        >
                          启用
                        </button>
                      )}
                      <button
                        type="button"
                        className="fw-settings-key-remove"
                        onClick={() => void remove(model.preset.id)}
                        disabled={Boolean(busy)}
                      >
                        删除
                      </button>
                    </>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}

      <p className="fw-local-model-note">
        下载会校验文件大小和 sha256；中断后再次点击会从断点继续。模型只在启用并首次检索时加载。
      </p>
    </div>
  )
}
