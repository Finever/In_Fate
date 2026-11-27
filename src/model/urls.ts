/**
 * 端点地址拼接：baseUrl 末尾已有版本段（/v1、/v4、/v1beta…）就不再插。
 *
 * 这样既容得下只给域名的写法，也容得下已经带版本的自建地址。
 *
 * @module if/model/urls
 */

const VERSION_TAIL = /\/v\d+(?:alpha|beta)?\d*$/i

export function apiUrl(baseUrl: string, path: string, version = 'v1'): string {
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return VERSION_TAIL.test(base) ? `${base}${suffix}` : `${base}/${version}${suffix}`
}
