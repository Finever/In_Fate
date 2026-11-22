/**
 * 开发/发布辅助：本机 CONNECT 隧道。
 *
 * 症状：GitHub 直连时好时坏——DNS 轮询里混着连不通的 IP，git 的 libcurl
 * 只试解析到的第一个地址，碰上坏的就 21 秒超时（"Could not connect"）。
 *
 * 这个脚本在 127.0.0.1 起一个最小 CONNECT 代理：对每个目标主机，把 DNS
 * 结果和一份已知可用的兜底 IP 池合起来，逐地址重试（两轮）；只做 TCP
 * 转发，不解密、不改内容。
 *
 * 用法：
 *   node tools/gh-tunnel.cjs 17777
 *   git -c http.proxy=http://127.0.0.1:17777 push github main
 *   git -c http.proxy=http://127.0.0.1:17777 push github V0.0.1.x
 *   curl --proxy http://127.0.0.1:17777 https://api.github.com/...
 *   curl --proxy http://127.0.0.1:17777 -X POST --data-binary @file \
 *     https://uploads.github.com/repos/.../releases/<id>/assets?name=<file>
 *
 * 用完 Ctrl-C。不要把它当常驻服务。
 */
const net = require('node:net')
const dns = require('node:dns')

const PORT = Number(process.argv[2] || 17777)
const ATTEMPT_TIMEOUT_MS = 6_000
const ROUNDS = 2

// 2026-11-23 实测：github.com 常被解析到连不通的 IP；这几个更稳。
const FALLBACKS = {
  'github.com': ['140.82.112.4', '140.82.113.4', '20.205.243.166', '140.82.121.4'],
}

function resolveAll(host) {
  return new Promise(resolve => {
    dns.lookup(host, { all: true }, (error, addrs) => {
      resolve(error ? [] : addrs.map(a => a.address))
    })
  })
}

function tryOnce(host, ip, port) {
  return new Promise(resolve => {
    const upstream = net.connect({ host: ip, port })
    upstream.setTimeout(ATTEMPT_TIMEOUT_MS, () => { upstream.destroy(); resolve(undefined) })
    upstream.once('error', () => resolve(undefined))
    upstream.once('connect', () => { upstream.setTimeout(0); resolve(upstream) })
  })
}

async function connectUpstream(host, port) {
  for (let round = 0; round < ROUNDS; round += 1) {
    const dnsAddrs = await resolveAll(host)
    const fallbacks = FALLBACKS[host] ?? []
    const candidates = [...new Set([...dnsAddrs, ...fallbacks])]
    for (const ip of candidates) {
      const upstream = await tryOnce(host, ip, port)
      if (upstream) return { upstream, ip }
    }
  }
  return undefined
}

const server = net.createServer(client => {
  let buffered = Buffer.alloc(0)
  let handled = false
  const onData = chunk => {
    if (handled) return
    buffered = Buffer.concat([buffered, chunk])
    const headerEnd = buffered.indexOf('\r\n\r\n')
    if (headerEnd === -1) {
      if (buffered.length > 64 * 1024) client.destroy()
      return
    }
    handled = true
    client.off('data', onData)
    const head = buffered.slice(0, headerEnd).toString('latin1')
    const rest = buffered.slice(headerEnd + 4)
    const match = /^CONNECT ([^:\s]+):(\d+)/i.exec(head)
    if (!match) {
      client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n')
      return
    }
    const host = match[1]
    const port = Number(match[2])
    void connectUpstream(host, port).then(result => {
      if (!result) {
        console.log(`[tunnel] ${host}:${port} -> all candidates failed`)
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        return
      }
      const { upstream, ip } = result
      console.log(`[tunnel] ${host}:${port} -> ${ip}`)
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (rest.length) upstream.write(rest)
      client.pipe(upstream)
      upstream.pipe(client)
    })
  }
  client.on('data', onData)
  client.once('error', () => {})
})

server.on('error', error => {
  console.error('[tunnel] server error:', error.message)
  process.exit(1)
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[tunnel] listening on 127.0.0.1:${PORT}`)
})
