import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { LogSearchResult, LogTree, LogViewPage } from '../types'

const PAGE_LIMIT = 200

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function MemoryLogView({
  openTarget,
}: {
  openTarget?: { addr: string; key: number }
}) {
  const [tree, setTree] = useState<LogTree>()
  const [treeLoading, setTreeLoading] = useState(true)
  const [treeError, setTreeError] = useState<string>()
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<{ day: string; sid: string }>()
  const [page, setPage] = useState<LogViewPage>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<LogSearchResult>()
  const [searching, setSearching] = useState(false)
  const lastOpenKey = useRef(0)

  useEffect(() => {
    let cancelled = false
    setTreeLoading(true)
    setTreeError(undefined)
    void api.memoryLogTree()
      .then(next => {
        if (cancelled) return
        setTree(next)
        if (next.days[0]) setOpenDays(current => current.size ? current : new Set([next.days[0]!.day]))
      })
      .catch(reason => {
        if (!cancelled) setTreeError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setTreeLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function openFile(day: string, sid: string, jumpN?: number): Promise<void> {
    setSelected({ day, sid })
    setLoading(true)
    setError(undefined)
    setSearch(undefined)
    setQuery('')
    setOpenDays(current => new Set(current).add(day))
    try {
      setPage(await api.memoryLogPage(day, sid, {
        offset: 0,
        limit: PAGE_LIMIT,
        ...(jumpN !== undefined ? { jumpN } : {}),
      }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!openTarget || openTarget.key === lastOpenKey.current) return
    lastOpenKey.current = openTarget.key
    const match = /^(\d{4}-\d{2}-\d{2})-(.+)-(\d+)$/.exec(openTarget.addr.trim())
    if (!match) {
      setError('地址形状不对，应像：2026-10-16-会话id-12')
      return
    }
    void openFile(match[1]!, match[2]!, Number(match[3]))
    // openFile 只依赖状态 setter 和 API；这里按 key 触发一次就够。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTarget])

  useEffect(() => {
    if (!page || page.focus === null) return
    const node = window.document.getElementById(`log-row-${page.focus}`)
    node?.scrollIntoView({ block: 'center' })
  }, [page])

  async function loadMore(): Promise<void> {
    if (!page || !selected || loading) return
    setLoading(true)
    setError(undefined)
    try {
      const next = await api.memoryLogPage(selected.day, selected.sid, {
        offset: page.offset + page.rows.length,
        limit: PAGE_LIMIT,
      })
      setPage(current => current
        ? { ...next, offset: current.offset, rows: [...current.rows, ...next.rows] }
        : next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  async function runSearch(): Promise<void> {
    const needle = query.trim()
    if (!needle) {
      setError('先输入关键词再搜日志。')
      return
    }
    setSearching(true)
    setError(undefined)
    try {
      setSearch(await api.memoryLogSearch(needle, 200))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSearching(false)
    }
  }

  function toggleDay(day: string): void {
    setOpenDays(current => {
      const next = new Set(current)
      if (next.has(day)) next.delete(day)
      else next.add(day)
      return next
    })
  }

  const dayCount = tree?.days.length ?? 0
  const fileCount = tree?.days.reduce((sum, day) => sum + day.files.length, 0) ?? 0

  return (
    <div className="fw-mem-log">
      <aside className="fw-mem-log-tree" aria-label="日志文件">
        <div className="fw-mem-tree-head">
          <span>日志</span>
          <small>{dayCount} 天 / {fileCount} 个会话</small>
        </div>
        {treeLoading && (
          <div className="fw-panel-loading fw-mem-tree-loading">
            <span className="fw-spinner" /> 载入…
          </div>
        )}
        {treeError && <div className="fw-panel-error fw-mem-log-tree-error">{treeError}</div>}
        {tree?.days.map(day => {
          const open = openDays.has(day.day)
          return (
            <section key={day.day}>
              <button
                type="button"
                className="fw-mem-log-day"
                onClick={() => toggleDay(day.day)}
                aria-expanded={open}
              >
                <span>{open ? '▾' : '▸'} {day.day}</span>
                <small>{day.files.length}</small>
              </button>
              {open && day.files.map(file => (
                <button
                  key={`${day.day}-${file.sid}`}
                  type="button"
                  className={`fw-mem-log-file${selected?.day === day.day && selected.sid === file.sid ? ' is-active' : ''}`}
                  title={file.sid}
                  onClick={() => void openFile(day.day, file.sid)}
                >
                  <span>{file.sid.slice(0, 8)}</span>
                  <small>{formatSize(file.size)}</small>
                </button>
              ))}
            </section>
          )
        })}
        {!treeLoading && !treeError && dayCount === 0 && (
          <div className="fw-panel-empty">没有日志。</div>
        )}
      </aside>

      <div className="fw-mem-log-main">
        <div className="fw-mem-log-head">
          <div className="fw-mem-log-title">
            <h3>
              {search
                ? `搜索「${query.trim()}」`
                : selected
                  ? `${selected.day} · ${selected.sid.slice(0, 8)}`
                  : '日志'}
            </h3>
            <small>
              {search
                ? `${search.hits.length} / 共 ${search.total} 条`
                : page
                  ? `${page.total} 行 · 只读`
                  : selected ? '只读' : '左边选一个会话，或全库搜日志'}
            </small>
          </div>
          <form
            className="fw-mem-log-search"
            onSubmit={event => {
              event.preventDefault()
              void runSearch()
            }}
          >
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="全库搜日志…"
              aria-label="搜索日志"
            />
            <button type="submit" disabled={searching || !query.trim()}>
              {searching ? '搜索中…' : '搜索'}
            </button>
            {search && (
              <button
                type="button"
                onClick={() => {
                  setSearch(undefined)
                  setQuery('')
                }}
              >
                返回会话
              </button>
            )}
          </form>
        </div>

        {error && <div className="fw-dialog-error fw-mem-error">{error}</div>}

        {search ? (
          <div className="fw-mem-log-scroll">
            {search.hits.length === 0 && (
              <div className="fw-mem-empty"><span>没有命中。</span></div>
            )}
            {search.hits.map(hit => (
              <button
                key={`${hit.addr}-${hit.ts}`}
                type="button"
                className="fw-mem-log-hit"
                onClick={() => void openFile(hit.day, hit.sid, hit.n)}
              >
                <span className="fw-mem-log-hit-meta">
                  {hit.addr}　{hit.ts}　{hit.who}
                </span>
                <span className="fw-mem-log-hit-text">
                  {hit.text}{hit.trunc ? ' …' : ''}
                </span>
              </button>
            ))}
            {search.total > search.hits.length && (
              <div className="fw-mem-log-note">
                只显示前 {search.hits.length} 条，共 {search.total} 条。把词再收窄些。
              </div>
            )}
          </div>
        ) : page ? (
          <div className="fw-mem-log-scroll">
            {page.rows.length === 0 && (
              <div className="fw-mem-empty"><span>这个会话没有可显示的行。</span></div>
            )}
            {page.rows.map((row, index) => {
              const absolute = page.offset + index
              return (
                <div
                  key={`${absolute}-${row.n ?? ''}`}
                  id={`log-row-${absolute}`}
                  className={`fw-mem-log-row${row.kind === 'tool' ? ' is-tool' : ''}${page.focus === absolute ? ' is-focus' : ''}`}
                  title="双击复制这一行"
                  onDoubleClick={() => {
                    void navigator.clipboard.writeText(row.body).catch(() => undefined)
                  }}
                >
                  <span className="fw-mem-log-meta">
                    [{row.n ?? '–'}] {row.who || '·'} {row.ts}
                  </span>
                  <span className="fw-mem-log-body">{row.body}</span>
                </div>
              )
            })}
            {page.offset + page.rows.length < page.total && (
              <button
                type="button"
                className="fw-mem-more"
                onClick={() => void loadMore()}
                disabled={loading}
              >
                {loading
                  ? '载入中…'
                  : `加载更多（还有 ${page.total - page.offset - page.rows.length} 行）`}
              </button>
            )}
          </div>
        ) : (
          <div className="fw-mem-empty">
            <span>左边选一个会话，或全库搜日志。</span>
            <small>日志只读；双击一行复制正文。</small>
          </div>
        )}
      </div>
    </div>
  )
}
