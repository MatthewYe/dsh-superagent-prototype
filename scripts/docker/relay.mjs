#!/usr/bin/env node
// Loopback relay for the DSH Superagent container (ticket #2).
//
// DSH binds 127.0.0.1:3082 inside the container. Compose cannot publish from a
// loopback bind, and the product's management guard only accepts the loopback
// authority it was started with, so this relay listens on 0.0.0.0:13082 and
// forwards to DSH with the Host header restored to 127.0.0.1:3082.
//
// It forwards plain HTTP, streaming responses (SSE) and WebSocket upgrades. When
// a browser uses an alternate published port, its same-origin Origin header names
// that published authority; it is rewritten only when it exactly matches the Host
// header the browser sent, so a cross-origin request is still rejected by the
// product guard.
import http from 'node:http'
import net from 'node:net'

const LISTEN_HOST = process.env.SUPERAGENT_RELAY_HOST ?? '0.0.0.0'
const LISTEN_PORT = Number(process.env.SUPERAGENT_RELAY_PORT ?? 13082)
const TARGET_HOST = process.env.SUPERAGENT_TARGET_HOST ?? '127.0.0.1'
const TARGET_PORT = Number(process.env.SUPERAGENT_TARGET_PORT ?? 3082)
const TARGET_AUTHORITY = `${TARGET_HOST}:${TARGET_PORT}`

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Headers to DSH: rewrite the authority and a same-origin Origin, drop hop-by-hop. */
function upstreamHeaders(source) {
  const headers = {}
  for (const [name, value] of Object.entries(source)) {
    if (name === 'host' || HOP_BY_HOP.has(name)) continue
    headers[name] = value
  }
  headers.host = TARGET_AUTHORITY
  const origin = source.origin
  if (typeof origin === 'string' && origin === `http://${source.host}`) {
    headers.origin = `http://${TARGET_AUTHORITY}`
  }
  return headers
}

/** Response headers from DSH: the framework frames the body, so drop its framing. */
function downstreamHeaders(source) {
  const headers = {}
  for (const [name, value] of Object.entries(source)) {
    if (HOP_BY_HOP.has(name)) continue
    headers[name] = value
  }
  return headers
}

function fail(response, error) {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(`superagent relay: ${error.message}\n`)
}

const server = http.createServer((request, response) => {
  const upstream = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: request.method,
      path: request.url,
      headers: upstreamHeaders(request.headers),
    },
    answer => {
      response.writeHead(answer.statusCode ?? 502, downstreamHeaders(answer.headers))
      answer.pipe(response)
    },
  )
  upstream.on('error', error => fail(response, error))
  request.pipe(upstream)
})

server.on('upgrade', (request, socket, head) => {
  const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
    // Connection and Upgrade are hop-by-hop for ordinary requests but carry the
    // upgrade itself here, so restore them after upstreamHeaders drops them.
    const headers = { ...upstreamHeaders(request.headers), connection: 'Upgrade', upgrade: request.headers.upgrade ?? 'websocket' }
    const lines = [`${request.method} ${request.url} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
      lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.error(`superagent relay: ${LISTEN_HOST}:${LISTEN_PORT} -> ${TARGET_AUTHORITY}`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
