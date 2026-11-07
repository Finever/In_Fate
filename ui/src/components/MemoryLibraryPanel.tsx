import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, ApiError } from '../api'
import type {
  MemoryCommitStatus,
  MemoryLibraryFile,
  MemoryLibraryNode,
  MemoryTrashEntry,
} from '../types'

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function stem(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/i, '')
}

function defaultDetailText(path: string): string {
  const parts = path.split('/')
  const namespace = parts.slice(1, -1)
  return `${JSON.stringify({
    project: namespace[0] ?? '',
    filename: stem(path),
    introduction: '',
    entries: [],
  }, null, 2)}\n`
}

export function MemoryLibraryPanel({
  onDirtyChange,
}: {
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [nodes, setNodes] = useState<MemoryLibraryNode[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string>()
  const [file, setFile] = useState<MemoryLibraryFile>()
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'load' | 'save' | 'op'>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [trash, setTrash] = useState<MemoryTrashEntry[]>()
  const [showTrash, setShowTrash] = useState(false)
  const [commitStatus, setCommitStatus] = useState<MemoryCommitStatus>()

  const tree = useMemo(() => {
    const children = new Map<string, MemoryLibraryNode[]>()
    for (const node of nodes) {
      const parent = parentPath(node.path)
      const list = children.get(parent) ?? []
      list.push(node)
      children.set(parent, list)
    }
    for (const list of children.values()) {
      list.sort((a, b) =>
        (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1)
        || a.name.localeCompare(b.name, 'zh'))
    }
    return children
  }, [nodes])

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setNodes(await api.memoryLibraryTree())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshCommit = useCallback(async (): Promise<void> => {
    try {
      setCommitStatus(await api.memoryCommitStatus())
    } catch {
      // 没有 git 或未配置记忆时，提交状态不是核心功能。
    }
  }, [])

  useEffect(() => {
    void refresh()
    void refreshCommit()
  }, [refresh, refreshCommit])

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  useEffect(() => {
    if (!showTrash) return
    void api.memoryLibraryTrash().then(setTrash).catch(reason => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [showTrash])

  async function openFile(path: string): Promise<void> {
    if (dirty && !window.confirm('当前文件有未保存的改动，切换会丢失。继续？')) return
    setBusy('load')
    setError(undefined)
    setNotice(undefined)
    try {
      const next = await api.memoryLibraryRead(path)
      setSelected(path)
      setFile(next)
      setText(next.text)
      setDirty(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function save(): Promise<void> {
    if (!file || file.readOnly) return
    setBusy('save')
    setError(undefined)
    setNotice(undefined)
    try {
      const next = await api.writeMemoryLibrary(file.path, text)
      setFile(next)
      setText(next.text)
      setDirty(false)
      setNotice('已保存')
      await refresh()
      await refreshCommit()
    } catch (reason) {
      if (reason instanceof ApiError && reason.issues?.length) {
        setError(reason.issues.map(issue => `${issue.path}: ${issue.message}`).join('；'))
      } else {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      setBusy(undefined)
    }
  }

  async function createFolder(): Promise<void> {
    const path = window.prompt('新目录路径（例如 detail/新域）')
    if (!path?.trim()) return
    setBusy('op')
    setError(undefined)
    try {
      await api.mkdirMemoryLibrary(path.trim())
      await refresh()
      await refreshCommit()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function createFile(): Promise<void> {
    const path = window.prompt('新文件路径（例如 detail/新域/新文件.json）')
    if (!path?.trim()) return
    const target = path.trim()
    const content = target.startsWith('detail/') && target.endsWith('.json')
      ? defaultDetailText(target)
      : target.endsWith('.json')
        ? '{}\n'
        : ''
    setBusy('op')
    setError(undefined)
    try {
      await api.writeMemoryLibrary(target, content)
      await refresh()
      await refreshCommit()
      await openFile(target)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function moveSelected(): Promise<void> {
    if (!selected) return
    if (dirty && !window.confirm('当前文件有未保存的改动，移动/重命名会丢失。继续？')) return
    const target = window.prompt('新路径', selected)
    if (!target?.trim() || target.trim() === selected) return
    setBusy('op')
    setError(undefined)
    try {
      const moved = nodes.find(node => node.path === selected)
      await api.moveMemoryLibrary(selected, target.trim())
      const next = target.trim()
      await refresh()
      await refreshCommit()
      if (moved?.kind === 'file' && !moved.readOnly) {
        await openFile(next)
      } else {
        setSelected(next)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function removeSelected(): Promise<void> {
    if (!selected) return
    if (dirty && !window.confirm('当前文件有未保存的改动，删除会丢失。继续？')) return
    if (!window.confirm(`把 ${selected} 移到回收站？`)) return
    setBusy('op')
    setError(undefined)
    try {
      await api.removeMemoryLibrary(selected)
      setSelected(undefined)
      setFile(undefined)
      setText('')
      setDirty(false)
      await refresh()
      await refreshCommit()
      if (showTrash) setTrash(await api.memoryLibraryTrash())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function restore(id: string): Promise<void> {
    setBusy('op')
    setError(undefined)
    try {
      await api.restoreMemoryLibrary(id)
      setTrash(await api.memoryLibraryTrash())
      await refresh()
      await refreshCommit()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function commitNow(): Promise<void> {
    setBusy('op')
    setError(undefined)
    setNotice(undefined)
    try {
      setCommitStatus(await api.commitMemory())
      setNotice('已提交')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function rebuildSummaries(): Promise<void> {
    setBusy('op')
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await api.rebuildMemorySummaries()
      setNotice(`已重建 ${result.count} 份摘要`)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  function renderNodes(parent: string, depth: number): ReactNode {
    return (tree.get(parent) ?? []).map(node => {
      const isDir = node.kind === 'directory'
      const open = !collapsed.has(node.path)
      const active = selected === node.path
      return (
        <div key={node.path}>
          <button
            type="button"
            className={`fw-mem-file${active ? ' is-active' : ''}`}
            style={{ paddingLeft: `${10 + depth * 14}px` }}
            title={node.invalid ?? node.path}
            onClick={() => {
              if (isDir) {
                setCollapsed(current => {
                  const next = new Set(current)
                  if (next.has(node.path)) next.delete(node.path)
                  else next.add(node.path)
                  return next
                })
              } else {
                void openFile(node.path)
              }
            }}
          >
            <span className="fw-mem-file-name">
              {isDir ? (open ? '▾ ' : '▸ ') : ''}{node.name}
            </span>
            {node.private && <span className="fw-mem-file-count">私</span>}
            {node.invalid && <span className="fw-mem-dirty">坏</span>}
            {node.readOnly && <span className="fw-mem-file-count">只读</span>}
            {typeof node.entries === 'number' && (
              <span className="fw-mem-file-count">{node.entries}</span>
            )}
          </button>
          {isDir && open && renderNodes(node.path, depth + 1)}
        </div>
      )
    })
  }

  return (
    <div className="fw-mem-library">
      <div className="fw-mem-library-head">
        <div>
          <h3>库结构</h3>
          <small>
            detail / summaries / proposals / agents；摘要由主 agent 模型生成，共享记忆会发给该模型，log 只读
            {commitStatus?.dirty.length
              ? ` · ${commitStatus.dirty.length} 项待提交`
              : commitStatus?.gitRoot
                ? ' · 已提交'
                : ' · 不在 git 库'}
          </small>
        </div>
        <div className="fw-mem-library-actions">
          <button type="button" className="fw-mem-btn" onClick={() => void refresh()} disabled={Boolean(busy)}>
            刷新
          </button>
          <button
            type="button"
            className="fw-mem-btn"
            onClick={() => void commitNow()}
            disabled={Boolean(busy) || !commitStatus?.dirty.length}
          >
            提交
          </button>
          <button
            type="button"
            className="fw-mem-btn"
            onClick={() => void rebuildSummaries()}
            disabled={Boolean(busy)}
          >
            重建摘要
          </button>
          <button type="button" className="fw-mem-btn" onClick={() => void createFolder()} disabled={Boolean(busy)}>
            新建目录
          </button>
          <button type="button" className="fw-mem-btn" onClick={() => void createFile()} disabled={Boolean(busy)}>
            新建文件
          </button>
          <button type="button" className="fw-mem-btn" onClick={() => void moveSelected()} disabled={!selected || Boolean(busy)}>
            移动/重命名
          </button>
          <button type="button" className="fw-mem-btn is-danger" onClick={() => void removeSelected()} disabled={!selected || Boolean(busy)}>
            移到回收站
          </button>
          <button type="button" className={`fw-mem-btn${showTrash ? ' is-active' : ''}`} onClick={() => setShowTrash(value => !value)}>
            回收站
          </button>
        </div>
      </div>

      {error && <div className="fw-dialog-error fw-mem-error">{error}</div>}
      {notice && <div className="fw-mem-notice">{notice}</div>}

      <div className="fw-mem-layout">
        <aside className="fw-mem-tree" aria-label="记忆库结构">
          <div className="fw-mem-tree-head">
            <span>记忆库</span>
            <small>{nodes.length} 个节点</small>
          </div>
          {loading && (
            <div className="fw-panel-loading fw-mem-tree-loading">
              <span className="fw-spinner" /> 载入…
            </div>
          )}
          {!loading && nodes.length === 0 && <div className="fw-panel-empty">记忆库是空的。</div>}
          {!loading && renderNodes('', 0)}
        </aside>

        <div className="fw-mem-main">
          {showTrash ? (
            <div className="fw-mem-editor">
              <div className="fw-mem-editor-head">
                <div className="fw-mem-title">
                  <h3>回收站</h3>
                  <small>{trash?.length ?? 0} 项</small>
                </div>
              </div>
              {trash?.length === 0 && <div className="fw-mem-empty">回收站是空的。</div>}
              {(trash ?? []).map(entry => (
                <div className="fw-mem-trash-row" key={entry.id}>
                  <span>
                    <b>{entry.name}</b>
                    <small>{entry.original}</small>
                  </span>
                  <button type="button" className="fw-mem-btn" onClick={() => void restore(entry.id)} disabled={Boolean(busy)}>
                    恢复
                  </button>
                </div>
              ))}
            </div>
          ) : file ? (
            <div className="fw-mem-editor">
              <div className="fw-mem-editor-head">
                <div className="fw-mem-title">
                  <h3>{file.path}</h3>
                  <small>{file.area} · {file.readOnly ? '只读' : '可编辑'}</small>
                </div>
                <div className="fw-mem-editor-actions">
                  {dirty && <span className="fw-mem-dirty">未保存</span>}
                  <button
                    type="button"
                    className="fw-dialog-submit fw-mem-btn"
                    onClick={() => void save()}
                    disabled={file.readOnly || !dirty || Boolean(busy)}
                  >
                    {busy === 'save' ? '保存中…' : '保存'}
                  </button>
                </div>
              </div>
              {file.invalid && <div className="fw-mem-issues"><div className="is-error">{file.invalid}</div></div>}
              <textarea
                className="fw-mem-content-input fw-mem-library-text"
                value={text}
                spellCheck={false}
                readOnly={file.readOnly}
                onChange={event => {
                  setText(event.target.value)
                  setDirty(true)
                  setNotice(undefined)
                }}
              />
              <div className="fw-mem-library-note">
                {file.area === 'detail'
                  ? 'detail 保存前会按记忆格式校验；坏文件可以在这里修好再保存。'
                  : '文本/JSON 原样保存；JSON 会先做语法检查。'}
              </div>
            </div>
          ) : (
            <div className="fw-mem-empty">
              <b>选一个文件</b>
              <span>左侧可以新建目录/文件、移动、重命名和删除。</span>
              <small>log 不在这棵树里，只能在日志页查看。</small>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
