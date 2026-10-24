const platform = typeof navigator === 'undefined'
  ? ''
  : `${navigator.platform} ${navigator.userAgent}`

export const isMac = /Mac|iPhone|iPad|iPod/i.test(platform)
export const modLabel = isMac ? '⌘' : 'Ctrl'
