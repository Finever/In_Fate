import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { MemoryIndexList } from '../types'

export function MemoryIndexView({
  onOpenFile,
}: {
  onOpenFile: (target: string) => void
}) {
  const [index, setIndex] = useState<MemoryIndexList>()
  const [loading, setLoading] = useState(true)
  const [reindexing, setReindexing] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      setIndex(await api.memoryIndexList())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function reindex(): Promise<void> {
    setReindexing(true)
    setError(undefined)
    setNotice(undefined)
    try {
      setIndex(await api.reindexMemory())
      setNotice('索引已重算')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setReindexing(false)
    }
  }

  return (
    <div className="fw-mem-index">
      <div className="fw-mem-index-head">
        <div>
          <h3>索引 indexlist</h3>
          <small>
            {index
              ? `生成于 ${index.generated} · ${index.items.length} 条`
              : '自动生成的派生物'}
          </small>
        </div>
        {notice && <span className="fw-mem-notice">{notice}</span>}
        <button
          type="button"
          className="fw-dialog-submit fw-mem-btn"
          onClick={() => void reindex()}
          disabled={reindexing || loading}
        >
          {reindexing ? '重算中…' : '重算索引'}
        </button>
      </div>

      <p className="fw-mem-index-note">
        不能手改；改了下次重算会被覆盖。点 detail 行跳到源文件。
      </p>

      {error && <div className="fw-dialog-error fw-mem-error">{error}</div>}

      {loading && (
        <div className="fw-panel-loading"><span className="fw-spinner" /> 载入索引…</div>
      )}

      {!loading && index && (
        <div className="fw-mem-index-table">
          <div className="fw-mem-index-row is-head">
            <span>路径</span>
            <span>是什么</span>
            <span>条数</span>
            <span>更新</span>
          </div>
          {index.items.map(item => {
            const detail = item.path.startsWith('detail/')
            const target = detail
              ? `detail:${item.path.slice('detail/'.length).replace(/\.json$/, '')}`
              : undefined
            const cells = (
              <>
                <span className="fw-mem-index-path">{item.path}</span>
                <span className="fw-mem-index-what">{item.what}</span>
                <span className="fw-mem-index-n">{item.n ?? ''}</span>
                <span className="fw-mem-index-updated">{item.updated ?? ''}</span>
              </>
            )
            return detail && target ? (
              <button
                key={item.path}
                type="button"
                className="fw-mem-index-row is-link"
                onClick={() => onOpenFile(target)}
                title="打开这个记忆文件"
              >
                {cells}
              </button>
            ) : (
              <div key={item.path} className="fw-mem-index-row">{cells}</div>
            )
          })}
          {index.items.length === 0 && (
            <div className="fw-panel-empty">索引是空的。</div>
          )}
        </div>
      )}
    </div>
  )
}
