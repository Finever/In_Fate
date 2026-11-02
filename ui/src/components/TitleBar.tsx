import { Icon } from './Icon'

export function TitleBar({ onSettings }: { onSettings?: () => void }) {
  const controls = typeof window === 'undefined' ? undefined : window.ifWindow

  return (
    <header className="fw-titlebar">
      <div className="fw-titlebar-brand">
        <img src="/icon.png" alt="" />
        <b>In_Fate</b>
      </div>
      <div className="fw-titlebar-actions">
        <button
          type="button"
          className="fw-titlebar-settings"
          onClick={onSettings}
          aria-label="设置"
          title="设置"
        >
          <Icon name="settings" size={15} />
        </button>
        {controls && (
          <div className="fw-titlebar-controls">
            <button type="button" onClick={() => controls.minimize()} aria-label="最小化" title="最小化">
              <Icon name="minimize" size={13} />
            </button>
            <button type="button" onClick={() => controls.toggleFullscreen()} aria-label="全屏" title="全屏">
              <Icon name="fullscreen" size={13} />
            </button>
            <button
              type="button"
              className="is-close"
              onClick={() => controls.close()}
              aria-label="关闭"
              title="关闭"
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
