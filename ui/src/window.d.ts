export {}

declare global {
  interface Window {
    ifWindow?: {
      minimize: () => void
      toggleFullscreen: () => void
      close: () => void
    }
  }
}
