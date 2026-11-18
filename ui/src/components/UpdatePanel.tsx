import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { UpdateCheckResult, UpdateStatus } from '../types'

function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${value} B`
}

function layoutLabel(layout: UpdateStatus['layout']): string {
  if (layout === 'installed') return '安装版'
  if (layout === 'portable') return '便携版'
  return '开发环境'
}

function progressText(status: UpdateStatus): string {
  const job = status.job
  const total = job.total
  const downloaded = formatBytes(job.downloaded)
  if (total && total > 0) {
    return `${Math.min(100, Math.round((job.downloaded / total) * 100))}% · ${downloaded} / ${formatBytes(total)}`
  }
  return downloaded
}

export function UpdatePanel() {
  const [status, setStatus] = useState<UpdateStatus>()
  const [check, setCheck] = useState<UpdateCheckResult>()
  const [manifestUrl, setManifestUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const fileRef = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)

  async function reload(): Promise<void> {
    const next = await api.updateStatus()
    if (!mounted.current) return
    setStatus(next)
    setManifestUrl(current => current || next.manifestUrl || '')
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

  const jobState = status?.job.state
  useEffect(() => {
    if (jobState !== 'checking' && jobState !== 'downloading' && jobState !== 'staging') return
    let cancelled = false
    const timer = window.setInterval(() => {
      void api.updateJob()
        .then(job => {
          if (cancelled) return
          setStatus(current => current ? { ...current, job } : current)
          if (job.state === 'ready' || job.state === 'error') {
            if (job.state === 'error' && job.error) setError(job.error)
            void reload().catch(() => undefined)
          }
        })
        .catch(() => undefined)
    }, 800)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [jobState])

  async function saveSource(): Promise<void> {
    setBusy('source')
    setError(undefined)
    setNotice(undefined)
    try {
      const next = await api.saveUpdateConfig(manifestUrl.trim())
      if (mounted.current) {
        setStatus(next)
        setNotice('更新源已保存。')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }

  async function checkNow(): Promise<void> {
    setBusy('check')
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await api.checkUpdate()
      if (!mounted.current) return
      setCheck(result)
      if (!result.available) setNotice(`已经是最新版本 V${result.currentVersion}。`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }

  async function download(): Promise<void> {
    setBusy('download')
    setError(undefined)
    setNotice(undefined)
    try {
      const job = await api.startUpdateDownload()
      if (!mounted.current) return
      setStatus(current => current ? { ...current, job } : current)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }

  async function apply(): Promise<void> {
    if (!window.confirm('应用更新后，程序层会在下次启动前切换；需要完全退出并重新启动 IF。继续？')) return
    setBusy('apply')
    setError(undefined)
    setNotice(undefined)
    try {
      const pending = await api.applyUpdate()
      if (!mounted.current) return
      setNotice(`已排队：下次启动时切换到 V${pending.version}。请完全退出后重新打开。`)
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }

  async function rollback(): Promise<void> {
    if (!window.confirm('回滚会在下次启动前把上一版本切回来。继续？')) return
    setBusy('rollback')
    setError(undefined)
    setNotice(undefined)
    try {
      const pending = await api.rollbackUpdate()
      if (!mounted.current) return
      setNotice(`已排队：下次启动时回滚到 V${pending.version}。请完全退出后重新打开。`)
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }

  async function upload(file: File): Promise<void> {
    setBusy('upload')
    setError(undefined)
    setNotice(undefined)
    try {
      const staged = await api.uploadUpdatePackage(file)
      if (!mounted.current) return
      setNotice(`本地更新包 V${staged.version} 已校验并暂存。点「应用更新」后重启生效。`)
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (mounted.current) {
        setBusy(undefined)
        if (fileRef.current) fileRef.current.value = ''
      }
    }
  }

  const locked = status?.layout === 'dev'
  const job = status?.job
  const running = job?.state === 'checking' || job?.state === 'downloading' || job?.state === 'staging'

  return (
    <div className="fw-update-panel">
      <div className="fw-local-models-head">
        <div>
          <h3>关于与更新</h3>
          <small>程序层和可变数据分开；更新不会动 data/ 与配置。</small>
        </div>
        <span className={`fw-local-model-badge${locked ? '' : ' is-active'}`}>
          {status ? layoutLabel(status.layout) : '读取中'}
        </span>
      </div>

      {error && <div className="fw-dialog-error">{error}</div>}
      {notice && <div className="fw-settings-hint">{notice}</div>}
      {loading && <div className="fw-panel-loading"><span className="fw-spinner" /> 读取版本信息…</div>}

      {!loading && status && (
        <>
          <div className="fw-local-model-meta">
            <span>当前版本 V{status.currentVersion}</span>
            {status.previousVersion && <span>上一版本 V{status.previousVersion}</span>}
            {job?.version && <span>待应用 V{job.version}</span>}
          </div>

          <div className="fw-update-paths">
            <p><span>程序</span>{status.programRoot}</p>
            <p><span>数据</span>{status.dataRoot}</p>
          </div>

          {locked && (
            <p className="fw-settings-hint">
              开发环境没有 In_First/In_Fate 布局，不能应用自动更新。用发布包或安装版测试更新流程。
            </p>
          )}

          {status.pending && (
            <div className="fw-update-result">
              <b>
                {status.pending.action === 'rollback' ? '待回滚' : '待应用'} V{status.pending.version}
              </b>
              <small>完全退出并用 start 脚本重新启动后生效。</small>
            </div>
          )}

          <div className="fw-update-source">
            <label>
              更新源
              <input
                value={manifestUrl}
                placeholder="https://…/latest.json，或本地路径"
                onChange={event => setManifestUrl(event.target.value)}
                disabled={Boolean(busy)}
              />
            </label>
            <button
              type="button"
              className="fw-dialog-submit"
              onClick={() => void saveSource()}
              disabled={Boolean(busy)}
            >
              保存
            </button>
          </div>

          <div className="fw-local-model-actions">
            <button
              type="button"
              className="fw-dialog-submit"
              onClick={() => void checkNow()}
              disabled={Boolean(busy) || running || !manifestUrl.trim()}
            >
              {busy === 'check' ? '检查中…' : '检查更新'}
            </button>
            {check?.available && (
              <button
                type="button"
                className="fw-dialog-submit"
                onClick={() => void download()}
                disabled={Boolean(busy) || running || locked}
              >
                {job?.state === 'downloading' || job?.state === 'staging' ? '下载中…' : `下载 V${check.manifest.version}`}
              </button>
            )}
            {job?.state === 'ready' && !status.pending && (
              <button
                type="button"
                className="fw-dialog-submit"
                onClick={() => void apply()}
                disabled={Boolean(busy) || locked}
              >
                应用更新
              </button>
            )}
            {status.previousVersion && !status.pending && (
              <button
                type="button"
                className="fw-settings-key-remove"
                onClick={() => void rollback()}
                disabled={Boolean(busy) || locked}
              >
                回滚到 V{status.previousVersion}
              </button>
            )}
          </div>

          {running && job && (
            <div className="fw-local-progress">
              <div className="fw-local-progress-bar">
                <span style={{ width: job.total ? `${Math.min(100, Math.round((job.downloaded / job.total) * 100))}%` : '15%' }} />
              </div>
              <small>
                {job.state === 'checking' && '读取更新清单…'}
                {job.state === 'downloading' && `下载中 · ${progressText(status)}`}
                {job.state === 'staging' && '校验并解压…'}
              </small>
            </div>
          )}

          {check && (
            <div className="fw-update-result">
              <b>
                {check.available
                  ? `可更新：V${check.currentVersion} → V${check.manifest.version}`
                  : `已是最新：V${check.currentVersion}`}
              </b>
              {check.manifest.notes && <p>{check.manifest.notes}</p>}
              <small>{check.manifest.publishedAt ?? ''}</small>
            </div>
          )}

          <div className="fw-update-local">
            <p>没有更新源时，也可以直接选发布包 zip：</p>
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              style={{ display: 'none' }}
              onChange={event => {
                const file = event.target.files?.[0]
                if (file) void upload(file)
              }}
            />
            <button
              type="button"
              className="fw-settings-add-provider"
              onClick={() => fileRef.current?.click()}
              disabled={Boolean(busy) || locked}
            >
              {busy === 'upload' ? '上传中…' : '选择本地更新包'}
            </button>
          </div>

          <p className="fw-local-model-note">
            更新包会校验版本与包结构，下载时再校验 sha256。应用只是写入 pending，真正切换发生在下一次启动之前。
          </p>
        </>
      )}
    </div>
  )
}
