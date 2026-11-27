const VERSION_TAIL = /\/v\d+(?:alpha|beta)?\d*$/i

export function apiUrl(baseUrl: string, path: string, version = 'v1'): string {
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return VERSION_TAIL.test(base) ? `${base}${suffix}` : `${base}/${version}${suffix}`
}
