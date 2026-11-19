import { shortId } from '../lib/format'
import type { UiApproval } from '../types'
import { Button, EmptyState } from './Ui'

export function ApprovalsPanel({
  approvals,
  busy,
  onRespond,
}: {
  approvals: UiApproval[]
  busy: boolean
  onRespond: (id: string, approved: boolean) => void
}) {
  if (approvals.length === 0) {
    return (
      <EmptyState
        icon="approvals"
        title="没有待审批"
        body="危险工具请求会出现在这里，不依赖消息卡是否展开。"
      />
    )
  }

  return (
    <div className="approval-list">
      {approvals.map(item => (
        <article key={item.approvalId} className="approval-card">
          <header>
            <span className="approval-tool">{item.toolName}</span>
            <span className="approval-session" title={item.sessionId}>{shortId(item.sessionId, 18)}</span>
          </header>
          {item.reason && <div className="approval-risk">{item.reason}</div>}
          <pre className="code-block">{JSON.stringify(item.input, null, 2)}</pre>
          <div className="approval-actions">
            <Button
              size="sm"
              variant="primary"
              icon="check"
              disabled={busy}
              onClick={() => onRespond(item.approvalId, true)}
            >
              允许
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon="close"
              disabled={busy}
              onClick={() => onRespond(item.approvalId, false)}
            >
              拒绝
            </Button>
          </div>
        </article>
      ))}
    </div>
  )
}
