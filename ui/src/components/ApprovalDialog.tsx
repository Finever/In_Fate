import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { sessionDisplayTitle } from '../lib/sessions'
import type { MemoryProposal, SessionInfo, UiApproval } from '../types'
import { Icon } from './Icon'

type ApprovalItem =
  | { kind: 'tool'; id: string; approval: UiApproval }
  | { kind: 'memory'; id: string; proposal: MemoryProposal }

const CODE_LIMIT = 4_000

function previewJson(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  return text.length > CODE_LIMIT ? `${text.slice(0, CODE_LIMIT)}\n…（已截断）` : text
}

function proposalBody(proposal: MemoryProposal): string {
  if (proposal.kind === 'detail') {
    return proposal.entry?.content ?? ''
  }
  if (!proposal.identity) return ''
  return `## ${proposal.identity.section}\n${proposal.identity.content}`
}

function proposalTitle(proposal: MemoryProposal): string {
  if (proposal.kind === 'detail') return proposal.target
  return `身份 · ${proposal.identity?.file ?? '未知文件'}`
}

export function ApprovalDialog({
  approvals,
  proposals,
  sessions,
  error,
  onRefresh,
}: {
  approvals: UiApproval[]
  proposals: MemoryProposal[]
  sessions: SessionInfo[]
  error: string | undefined
  onRefresh: () => Promise<void> | void
}) {
  const items = useMemo<ApprovalItem[]>(() => [
    ...approvals.map(item => ({
      kind: 'tool' as const,
      id: item.approvalId,
      approval: item,
    })),
    ...proposals.map(item => ({
      kind: 'memory' as const,
      id: item.proposalId,
      proposal: item,
    })),
  ], [approvals, proposals])
  const signature = items.map(item => item.id).join('|')
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState('')
  const [busy, setBusy] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [confirming, setConfirming] = useState<string>()

  useEffect(() => {
    if (items.length === 0) {
      setOpen(false)
      setDismissed('')
      return
    }
    if (signature !== dismissed) setOpen(true)
  }, [dismissed, items.length, signature])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        setDismissed(signature)
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, open, signature])

  useEffect(() => {
    setConfirming(undefined)
    setActionError(undefined)
  }, [signature])

  const current = items[0]
  if (!current) return null

  const title = current.kind === 'tool'
    ? '工具审批'
    : '记忆提议'
  const sourceId = current.kind === 'tool'
    ? current.approval.sessionId
    : current.proposal.sourceSession
  const source = sessions.find(session => session.id === sourceId)
  const sourceTitle = source ? sessionDisplayTitle(source) : sourceId

  function dismiss(): void {
    setDismissed(signature)
    setOpen(false)
  }

  async function respondTool(approved: boolean): Promise<void> {
    if (current.kind !== 'tool' || busy) return
    setBusy(current.id)
    setActionError(undefined)
    try {
      await api.respondApproval(current.id, approved)
      await Promise.resolve(onRefresh())
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function respondProposal(accept: boolean): Promise<void> {
    if (current.kind !== 'memory' || busy) return
    if (accept && confirming !== current.id) {
      setConfirming(current.id)
      return
    }
    setBusy(current.id)
    setActionError(undefined)
    try {
      if (accept) await api.acceptProposal(current.id)
      else await api.rejectProposal(current.id)
      setConfirming(undefined)
      await Promise.resolve(onRefresh())
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="fw-approval-pill"
        onClick={() => setOpen(true)}
        title="打开待审批"
      >
        <Icon name="approvals" size={15} />
        <span>{items.length}</span>
        待审批
      </button>
    )
  }

  return (
    <div className="fw-modal-backdrop" role="presentation">
      <section
        className="fw-approval-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fw-approval-title"
      >
        <header className="fw-dialog-head">
          <h2 id="fw-approval-title">待审批</h2>
          <span className="fw-approval-queue">
            {items.length > 1 ? `1 / ${items.length}` : '1 项'}
          </span>
          <button
            type="button"
            className="fw-approval-close"
            onClick={dismiss}
            aria-label="稍后处理"
            title="稍后处理"
          >
            ×
          </button>
        </header>

        <div className="fw-approval-body">
          <div className="fw-approval-kind-row">
            <span className={`fw-approval-kind${current.kind === 'memory' ? ' is-memory' : ''}`}>
              {title}
            </span>
            {current.kind === 'tool' && (
              <b className="fw-approval-tool">{current.approval.toolName}</b>
            )}
            {current.kind === 'memory' && (
              <b className="fw-approval-tool">{proposalTitle(current.proposal)}</b>
            )}
          </div>

          <div className="fw-approval-source">
            <span>来源会话</span>
            <b title={sourceId}>{sourceTitle}</b>
            {current.kind === 'memory' && current.proposal.reason && (
              <small>{current.proposal.reason}</small>
            )}
          </div>

          {current.kind === 'tool' ? (
            <>
              <div className="fw-approval-label">调用参数</div>
              <pre className="fw-approval-code">{previewJson(current.approval.input)}</pre>
              <p className="fw-approval-hint">
                工具审批有时限，未处理会被自动拒绝。批准只对本次调用生效。
              </p>
            </>
          ) : (
            <>
              <div className="fw-approval-label">
                {current.proposal.kind === 'detail' ? '将要写入的条目' : '将要修改的身份文件'}
              </div>
              <pre className="fw-approval-code fw-approval-proposal">
                {proposalBody(current.proposal)}
              </pre>
              {current.proposal.kind === 'identity' && current.proposal.identity && (
                <p className="fw-approval-hint">
                  模式：{current.proposal.identity.mode === 'append' ? '追加' : '替换段落'}
                  。接受后会先备份原文件。
                </p>
              )}
              {current.proposal.kind === 'detail' && current.proposal.entry && (
                <p className="fw-approval-hint">
                  标签：{current.proposal.entry.tag}
                  {current.proposal.entry.at ? ` · ${current.proposal.entry.at}` : ''}
                </p>
              )}
              {confirming === current.id && (
                <div className="fw-approval-confirm">
                  确认接受这条记忆提议？写入后可以再改，但不会自动撤销。
                </div>
              )}
            </>
          )}

          {(actionError ?? error) && (
            <div className="fw-dialog-error">{actionError ?? error}</div>
          )}
        </div>

        <footer className="fw-dialog-actions fw-approval-actions">
          {current.kind === 'tool' ? (
            <>
              <button
                type="button"
                className="fw-dialog-cancel"
                disabled={busy === current.id}
                onClick={() => void respondTool(false)}
              >
                拒绝
              </button>
              <button
                type="button"
                className="fw-dialog-submit"
                disabled={busy === current.id}
                onClick={() => void respondTool(true)}
              >
                {busy === current.id ? '处理中…' : '允许'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="fw-dialog-cancel"
                disabled={busy === current.id}
                onClick={() => void respondProposal(false)}
              >
                拒绝
              </button>
              <button
                type="button"
                className="fw-dialog-submit"
                disabled={busy === current.id}
                onClick={() => void respondProposal(true)}
              >
                {busy === current.id
                  ? '处理中…'
                  : confirming === current.id ? '确认接受' : '接受'}
              </button>
            </>
          )}
          <button
            type="button"
            className="fw-dialog-cancel"
            disabled={busy === current.id}
            onClick={dismiss}
          >
            稍后
          </button>
        </footer>
      </section>
    </div>
  )
}
