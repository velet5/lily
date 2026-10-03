// Serves the harness (index.html, harness.js) and what build.sh left in
// packages/studio/dist/site/ (engine.worker.js, engine/), with brotli when the
// browser accepts it and chapter 08 §5.1's Cache-Control, without COOP/COEP
// (B9). A phone's results are POSTed to /result and appended to a file.
//
//   node serve.mjs [--port 8471] [--cert cert.pem --key key.pem] [--results spike-results.jsonl]
//
// Cache Storage needs a secure context: https (a certificate the phone
// trusts, e.g. mkcert's), or http://localhost (Android: adb reverse tcp:8471 tcp:8471).
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants } from 'node:zlib'

const here = path.dirname(fileURLToPath(import.meta.url))
const site = path.resolve(here, '../../../dist/site')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const port = Number(arg('port', 8471))
const results = path.resolve(arg('results', 'spike-results.jsonl'))
const cert = arg('cert')
const key = arg('key')

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' }
const compressed = new Map()

function file(url) {
  const name = decodeURIComponent(url.pathname)
  if (name === '/' || name === '/index.html') return path.join(here, 'index.html')
  if (name === '/harness.js') return path.join(here, 'harness.js')
  const full = path.join(site, path.normalize(name))
  return full.startsWith(site) && (name === '/engine.worker.js' || name.startsWith('/engine/')) ? full : undefined
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'POST' && url.pathname === '/result') {
    let body = ''
    for await (const chunk of req) body += chunk
    appendFileSync(results, JSON.stringify({ at: new Date().toISOString(), ...JSON.parse(body) }) + '\n')
    console.log(`result from ${JSON.parse(body).label ?? req.headers['user-agent']}`)
    return res.writeHead(204).end()
  }
  const full = file(url)
  if (!full || !existsSync(full)) return res.writeHead(404).end()
  // Names under engine/ carry their hash: never stale. Everything else is checked on each load.
  const immutable = url.pathname.startsWith('/engine/') && !url.pathname.endsWith('manifest.json')
  const headers = {
    'content-type': TYPES[path.extname(full)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  }
  let body = readFileSync(full)
  if (/\bbr\b/.test(req.headers['accept-encoding'] ?? '')) {
    // A rebuild may keep a file's length (manifest.json does): the key is the modification time too.
    const cacheKey = `${full}:${statSync(full).mtimeMs}:${body.length}`
    if (!compressed.has(cacheKey)) compressed.set(cacheKey, brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }))
    body = compressed.get(cacheKey)
    headers['content-encoding'] = 'br'
  }
  headers['content-length'] = body.length
  res.writeHead(200, headers).end(body)
}

const server = cert && key ? https.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, handle) : http.createServer(handle)
server.listen(port, '0.0.0.0', () => {
  const scheme = cert ? 'https' : 'http'
  const addresses = Object.values(networkInterfaces()).flat().filter((a) => a.family === 'IPv4').map((a) => a.address)
  for (const a of ['localhost', ...addresses]) console.log(`${scheme}://${a}:${port}/`)
  console.log(`results: ${results}`)
})
