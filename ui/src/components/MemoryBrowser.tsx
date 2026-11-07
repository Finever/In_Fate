import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiError } from '../api'
import { oneLine } from '../lib/format'
import type {
  MemoryDocument,
  MemoryEntry,
  MemoryFileSummary,
  MemoryQuote,
  MemorySearchHit,
  MemoryValidationIssue,
} from '../types'
import { Icon } from './Icon'
import { MemoryIndexView } from './MemoryIndexView'
import { MemoryLibraryPanel } from './MemoryLibraryPanel'
import { MemoryPolicyPanel } from './MemoryPolicyPanel'
import { MemoryLogView } from './MemoryLogView'

const PAGE_SIZE = 20
const SEARCH_LIMIT = 50
const TRUST_TAGS = ['确信', '可信', '有疑'] as const
const QUOTE_TAGS = ['禁令', '需求', '想法', '疑问', '认可', '否定', '表达交流'] as const

function plainPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
}

function nowStamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}`
}

function nextEntryId(doc: MemoryDocument): string {
  const prefix = doc.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${prefix}-(\\d+)$`)
  let max = 0
  for (const entry of doc.entries) {
    const match = pattern.exec(entry.id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `${doc.filename}-${String(max + 1).padStart(4, '0')}`
}

interface EntryEditorProps {
  entry: MemoryEntry
  index: number
  total: number
  onChange: (patch: Partial<MemoryEntry>) => void
  onMove: (delta: number) => void
  onRemove: () => void
  onOpenLog?: (addr: string) => void
}

function EntryEditor({
  entry,
  index,
  total,
  onChange,
  onMove,
  onRemove,
  onOpenLog,
}: EntryEditorProps) {
  const quotes = entry.quotes ?? []

  function setQuotes(next: MemoryQuote[]): void {
    onChange({ quotes: next })
  }

  function setQuote(quoteIndex: number, patch: Partial<MemoryQuote>): void {
    setQuotes(quotes.map((quote, i) => i === quoteIndex ? { ...quote, ...patch } : quote))
  }

  function toggleQuoteTag(quoteIndex: number, tag: string): void {
    const quote = quotes[quoteIndex]!
    const current = quote.tag ?? []
    const next = current.includes(tag)
      ? current.filter(item => item !== tag)
      : [...current, tag]
    setQuote(quoteIndex, { tag: next })
  }

  return (
    <article className="fw-mem-entry-edit">
      <div className="fw-mem-entry-edit-head">
        <span className="fw-mem-entry-id">{entry.id}</span>
        <select
          value={entry.tag}
          onChange={event => onChange({ tag: event.target.value as MemoryEntry['tag'] })}
          aria-label={`${entry.id} 可信度`}
        >
          {TRUST_TAGS.map(tag => <option key={tag} value={tag}>{tag}</option>)}
        </select>
        <label className="fw-mem-mini">
          <span>at</span>
          <input
            value={entry.at ?? ''}
            onChange={event => onChange({ at: event.target.value || null })}
            placeholder="—"
          />
        </label>
        <label className="fw-mem-mini">
          <span>rec-time</span>
          <input
            value={entry['rec-time'] ?? ''}
            onChange={event => onChange({ 'rec-time': event.target.value })}
            placeholder="—"
          />
        </label>
        <span className="fw-mem-rev">rev {entry['rev-time'] ?? '—'}</span>
        <span className="fw-mem-grow" />
        <button
          type="button"
          className="fw-mem-icon"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          title="上移"
        >
          ↑
        </button>
        <button
          type="button"
          className="fw-mem-icon"
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          title="下移"
        >
          ↓
        </button>
        <button
          type="button"
          className="fw-mem-icon is-danger"
          onClick={onRemove}
          title="删除这条"
        >
          ×
        </button>
      </div>

      <textarea
        className="fw-mem-content-input"
        value={entry.content}
        spellCheck={false}
        placeholder="条目内容（Markdown）"
        onChange={event => onChange({ content: event.target.value })}
      />

      <div className="fw-mem-quote-box">
        <div className="fw-mem-quote-box-head">
          原话 · {quotes.length}
          <span>引号里必须是能回翻到的原文</span>
        </div>
        {quotes.map((quote, quoteIndex) => (
          <div className="fw-mem-quote-edit" key={quoteIndex}>
            <textarea
              value={quote.say}
              spellCheck={false}
              placeholder="他说的原话，逐字"
              onChange={event => setQuote(quoteIndex, { say: event.target.value })}
            />
            <div className="fw-mem-quote-row">
              <div className="fw-mem-qtags">
                {QUOTE_TAGS.map(tag => {
                  const on = (quote.tag ?? []).includes(tag)
                  return (
                    <button
                      key={tag}
                      type="button"
                      className={`fw-mem-qtag${on ? ' is-on' : ''}`}
                      onClick={() => toggleQuoteTag(quoteIndex, tag)}
                    >
                      {tag}
                    </button>
                  )
                })}
              </div>
              <input
                value={quote.at ?? ''}
                onChange={event => setQuote(quoteIndex, { at: event.target.value || null })}
                placeholder="发生时间"
              />
              <input
                className={`fw-mem-addr${quote['log-addr'] ? '' : ' is-missing'}`}
                value={quote['log-addr'] ?? ''}
                onChange={event => setQuote(quoteIndex, { 'log-addr': event.target.value })}
                placeholder="log-addr：年-月-日-会话id-n"
              />
              <button
                type="button"
                className="fw-mem-icon"
                onClick={() => onOpenLog?.(quote['log-addr'] ?? '')}
                disabled={!quote['log-addr']}
                title="在日志里打开"
              >
                ↗
              </button>
              <button
                type="button"
                className="fw-mem-icon is-danger"
                onClick={() => setQuotes(quotes.filter((_, i) => i !== quoteIndex))}
                title="删除原话"
              >
                ×
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="fw-mem-add"
          onClick={() => setQuotes([
            ...quotes,
            { say: '', at: null, tag: [], 'log-addr': '' },
          ])}
        >
          ＋ 原话
        </button>
      </div>
    </article>
  )
}

export function MemoryBrowser({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const [files, setFiles] = useState<MemoryFileSummary[]>([])
  const [indexLoading, setIndexLoading] = useState(true)
  const [view, setView] = useState<'entries' | 'structure' | 'policy' | 'index' | 'log'>('entries')
  const [structureDirty, setStructureDirty] = useState(false)
  const [logTarget, setLogTarget] = useState<{ addr: string; key: number }>()
  const [selected, setSelected] = useState<string>()
  const [draft, setDraft] = useState<MemoryDocument>()
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'doc' | 'save'>()
  const [error, setError] = useState<string>()
  const [issues, setIssues] = useState<MemoryValidationIssue[]>([])
  const [notice, setNotice] = useState<string>()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemorySearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchMode, setSearchMode] = useState(false)
  const [focusId, setFocusId] = useState<string>()
  const [visible, setVisible] = useState(PAGE_SIZE)

  const domains = useMemo(() => {
    const map = new Map<string, MemoryFileSummary[]>()
    for (const file of files) {
      const list = map.get(file.domain) ?? []
      list.push(file)
      map.set(file.domain, list)
    }
    return [...map.entries()].map(([domain, list]) => ({ domain, files: list }))
  }, [files])

  const loadIndex = useCallback(async (): Promise<void> => {
    setIndexLoading(true)
    try {
      setFiles(await api.memoryIndex())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setIndexLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadIndex()
  }, [loadIndex])

  useEffect(() => {
    onDirtyChange?.(dirty || structureDirty)
  }, [dirty, structureDirty, onDirtyChange])

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  useEffect(() => {
    if (!draft || !focusId) return
    const node = window.document.getElementById(`mem-entry-${focusId}`)
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [draft, focusId])

  async function loadFile(target: string, focus?: string): Promise<void> {
    setBusy('doc')
    setError(undefined)
    setIssues([])
    setNotice(undefined)
    setSearchMode(false)
    setFocusId(focus)
    try {
      const next = await api.memoryRead(target)
      setSelected(target)
      setDraft(structuredClone(next))
      setDirty(false)
      const index = focus ? next.entries.findIndex(entry => entry.id === focus) : -1
      setVisible(index >= 0 ? Math.max(PAGE_SIZE, index + 1) : PAGE_SIZE)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function selectFile(target: string, focus?: string): Promise<void> {
    if (target === selected && !focus) return
    if (dirty && !window.confirm('当前文件有未保存的改动，切换会丢失。继续？')) return
    await loadFile(target, focus)
  }

  async function reload(): Promise<void> {
    if (!selected) return
    if (dirty && !window.confirm('放弃当前未保存的改动？')) return
    await loadFile(selected)
  }

  async function runSearch(): Promise<void> {
    const needle = query.trim()
    if (!needle) {
      setError('先输入关键词再搜索。')
      return
    }
    setSearching(true)
    setError(undefined)
    setFocusId(undefined)
    try {
      setHits(await api.memorySearch(needle, SEARCH_LIMIT))
      setSearchMode(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSearching(false)
    }
  }

  function mutate(next: MemoryDocument): void {
    setDraft(next)
    setDirty(true)
    setNotice(undefined)
  }

  function updateEntry(index: number, patch: Partial<MemoryEntry>): void {
    if (!draft) return
    mutate({
      ...draft,
      entries: draft.entries.map((entry, i) => i === index ? { ...entry, ...patch } : entry),
    })
  }

  function addEntry(): void {
    if (!draft) return
    const entry: MemoryEntry = {
      id: nextEntryId(draft),
      'rec-time': nowStamp(),
      'rev-time': null,
      at: null,
      tag: '可信',
      content: '',
      quotes: [],
    }
    mutate({ ...draft, entries: [...draft.entries, entry] })
    setVisible(value => Math.max(value, draft.entries.length + 1))
  }

  function removeEntry(index: number): void {
    if (!draft) return
    const entry = draft.entries[index]
    if (!entry || !window.confirm(`删掉 ${entry.id}？保存后才会从文件里消失。`)) return
    mutate({ ...draft, entries: draft.entries.filter((_, i) => i !== index) })
  }

  function moveEntry(index: number, delta: number): void {
    if (!draft) return
    const next = [...draft.entries]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    const [entry] = next.splice(index, 1)
    next.splice(target, 0, entry!)
    mutate({ ...draft, entries: next })
  }

  async function save(): Promise<void> {
    if (!draft || !selected) return
    setBusy('save')
    setError(undefined)
    setIssues([])
    setNotice(undefined)
    try {
      const result = await api.saveMemoryDocument(selected, draft)
      setDraft(structuredClone(result.document))
      setDirty(false)
      setIssues(result.warnings)
      setNotice(result.warnings.length
        ? `已保存 · ${result.warnings.length} 条提醒`
        : '已保存')
      try {
        setFiles(await api.memoryIndex())
      } catch {
        // 索引刷新失败不影响本次保存结果。
      }
    } catch (reason) {
      if (reason instanceof ApiError) setIssues(reason.issues ?? [])
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  function openLog(addr: string): void {
    if (!addr) return
    setLogTarget(current => ({ addr, key: (current?.key ?? 0) + 1 }))
    setView('log')
  }

  function switchView(next: typeof view): void {
    if (view === 'structure' && next !== 'structure' && structureDirty) {
      if (!window.confirm('库结构里有未保存的改动，切换会丢失。继续？')) return
    }
    setView(next)
  }

  const entries = draft ? draft.entries.slice(0, visible) : []
  const remaining = draft ? draft.entries.length - entries.length : 0

  return (
    <div className="fw-mem">
      <div className="fw-mem-tabs">
        {([
          ['entries', '条目'],
          ['structure', '结构'],
          ['policy', '策略'],
          ['index', '索引'],
          ['log', '日志'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={view === id ? 'is-active' : ''}
            onClick={() => switchView(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'entries' && (
        <>
          <form
            className="fw-mem-search"
            onSubmit={event => {
              event.preventDefault()
              void runSearch()
            }}
          >
            <input
              autoFocus
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索所有域里的条目 / 原话"
              aria-label="搜索全局记忆"
            />
            <button type="submit" disabled={searching || !query.trim()}>
              {searching ? '搜索中…' : '搜索'}
            </button>
            {searchMode && (
              <button
                type="button"
                className="fw-mem-clear"
                onClick={() => {
                  setSearchMode(false)
                  setHits([])
                }}
              >
                清除
              </button>
            )}
          </form>

          {error && <div className="fw-dialog-error fw-mem-error">{error}</div>}
          {issues.length > 0 && (
            <div className="fw-mem-issues">
              {issues.slice(0, 8).map((issue, index) => (
                <div key={`${issue.path}-${index}`} className={`is-${issue.level}`}>
                  <code>{issue.path}</code>
                  {issue.message}
                </div>
              ))}
              {issues.length > 8 && <div>还有 {issues.length - 8} 条…</div>}
            </div>
          )}
        </>
      )}

      {view === 'entries' ? (
      <div className="fw-mem-layout">
        <aside className="fw-mem-tree" aria-label="记忆文件">
          <div className="fw-mem-tree-head">
            <span>记忆库</span>
            <small>{files.length} 个文件</small>
          </div>
          {indexLoading && (
            <div className="fw-panel-loading fw-mem-tree-loading">
              <span className="fw-spinner" /> 载入…
            </div>
          )}
          {!indexLoading && files.length === 0 && (
            <div className="fw-panel-empty">detail 里还没有文件。</div>
          )}
          {domains.map(group => (
            <section className="fw-mem-domain" key={group.domain}>
              <div className="fw-mem-domain-name">{group.domain}</div>
              {group.files.map(file => (
                <button
                  key={file.target}
                  type="button"
                  className={`fw-mem-file${selected === file.target ? ' is-active' : ''}`}
                  title={file.introduction || file.target}
                  onClick={() => void selectFile(file.target)}
                >
                  <span className="fw-mem-file-name">{file.filename}</span>
                  <span className="fw-mem-file-count">{file.entries}</span>
                </button>
              ))}
            </section>
          ))}
        </aside>

        <div className="fw-mem-main">
          {searchMode ? (
            <div className="fw-mem-results">
              <div className="fw-mem-result-head">
                <span>找到 {hits.length} 条</span>
                <small>detail 记忆库 · 全局共享 · 最多 {SEARCH_LIMIT} 条</small>
              </div>
              {hits.length === 0 && (
                <div className="fw-mem-empty">
                  <span>没有匹配的记忆。</span>
                  <small>换个关键词试试；空查询不会搜索。</small>
                </div>
              )}
              {hits.map(hit => (
                <button
                  key={`${hit.target}#${hit.id}`}
                  type="button"
                  className="fw-mem-hit"
                  onClick={() => void selectFile(hit.target, hit.id)}
                >
                  <span className="fw-mem-hit-head">
                    <b>{hit.filename}</b>
                    <em className="fw-tag" data-tag={hit.tag}>{hit.tag}</em>
                  </span>
                  <span className="fw-mem-hit-target">{hit.target}</span>
                  <span className="fw-mem-hit-preview">
                    {oneLine(plainPreview(hit.preview), 200)}
                  </span>
                </button>
              ))}
            </div>
          ) : draft ? (
            <div className="fw-mem-editor">
              <div className="fw-mem-editor-head">
                <div className="fw-mem-title">
                  <h3>{draft.filename}</h3>
                  <small>{selected}</small>
                </div>
                <div className="fw-mem-editor-actions">
                  {dirty && <span className="fw-mem-dirty">未保存</span>}
                  {notice && <span className="fw-mem-notice">{notice}</span>}
                  <button
                    type="button"
                    className="fw-dialog-cancel fw-mem-btn"
                    onClick={() => void reload()}
                    disabled={!dirty || Boolean(busy)}
                  >
                    还原
                  </button>
                  <button
                    type="button"
                    className="fw-dialog-submit fw-mem-btn"
                    onClick={() => void save()}
                    disabled={!dirty || Boolean(busy)}
                  >
                    {busy === 'save' ? '保存中…' : '保存'}
                  </button>
                </div>
              </div>

              {busy === 'doc' && (
                <div className="fw-panel-loading"><span className="fw-spinner" /> 载入文件…</div>
              )}

              <div className="fw-mem-meta-fields">
                <label>
                  <span>project</span>
                  <input
                    value={draft.project}
                    onChange={event => mutate({ ...draft, project: event.target.value })}
                  />
                </label>
                <label className="fw-mem-intro-field">
                  <span>introduction</span>
                  <textarea
                    value={draft.introduction}
                    spellCheck={false}
                    onChange={event => mutate({ ...draft, introduction: event.target.value })}
                  />
                </label>
              </div>

              {entries.map((entry, index) => (
                <div key={entry.id} id={`mem-entry-${entry.id}`}>
                  <EntryEditor
                    entry={entry}
                    index={index}
                    total={draft.entries.length}
                    onChange={patch => updateEntry(index, patch)}
                    onMove={delta => moveEntry(index, delta)}
                    onRemove={() => removeEntry(index)}
                    onOpenLog={openLog}
                  />
                </div>
              ))}

              {remaining > 0 && (
                <button
                  type="button"
                  className="fw-mem-more"
                  onClick={() => setVisible(value => value + PAGE_SIZE)}
                >
                  加载更多 · 还剩 {remaining} 条
                </button>
              )}

              <button type="button" className="fw-mem-add fw-mem-add-entry" onClick={addEntry}>
                ＋ 新增条目
              </button>
            </div>
          ) : (
            <div className="fw-mem-empty">
              <Icon name="layers" size={22} />
              <b>全局记忆</b>
              <span>左侧选一个文件；搜索会跨所有域。</span>
              <small>
                按现有记忆系统编辑：条目、三档戳、原话与 log-addr。
                保存前会按同一套规则校验，不通过不落盘。
              </small>
            </div>
          )}
        </div>
      </div>
      ) : view === 'structure' ? (
        <MemoryLibraryPanel onDirtyChange={setStructureDirty} />
      ) : view === 'policy' ? (
        <MemoryPolicyPanel />
      ) : view === 'index' ? (
        <MemoryIndexView
          onOpenFile={target => {
            setView('entries')
            void selectFile(target)
          }}
        />
      ) : (
        <MemoryLogView openTarget={logTarget} />
      )}
    </div>
  )
}
