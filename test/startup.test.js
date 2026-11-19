import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {apply} from '../lib/index.js'

test('automatic MCP startup waits for the credentials service', async t => {
  const previousHome = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'local-mcp-startup-'))
  process.env.DSH_HOME = home
  const dataDir = join(home, 'dsh-go', 'plugin-data', 'local-mcp-manager')
  await mkdir(dataDir, { recursive: true })

  const requests = []
  let resolveToolsListed
  const toolsListed = new Promise(resolve => { resolveToolsListed = resolve })
  const http = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    let body = ''
    for await (const chunk of req) body += chunk
    const message = JSON.parse(body)
    requests.push({ method: message.method, token: req.headers['x-api-key'] })
    if (message.id === undefined) { res.writeHead(202); res.end(); return }
    let result = {}
    if (message.method === 'initialize') result = {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'startup-fixture', version: '1' },
    }
    else if (message.method === 'tools/list') result = { tools: [{
      name: 'read', description: 'fixture', inputSchema: { type: 'object', properties: {} },
    }] }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), () => {
      if (message.method === 'tools/list') resolveToolsListed()
    })
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  const port = http.address().port
  await writeFile(join(dataDir, 'servers.json'), JSON.stringify({
    version: 1, revision: 0, servers: [{
      id: 'fixture', name: 'Fixture', transport: 'streamable-http',
      url: `http://127.0.0.1:${port}/mcp`, command: '', args: [], cwd: '',
      headers: [{ name: 'x-api-key', credentialRef: 'STARTUP_KEY' }], env: [],
      enabled: true, requireApproval: true, timeoutMs: 5000, tools: {},
    }],
  }))

  const services = new Map()
  const pending = []
  const childDisposers = []
  let guardCalls = 0
  let rootDispose
  const childFor = () => ({
    tools: services.get('tools'),
    get: name => services.get(name),
    logger: { warn() {} },
    on(event, callback) {
      if (event === 'dispose') childDisposers.push(callback)
      return () => {}
    },
  })
  const activateReady = () => {
    for (const item of pending) {
      if (item.ran || !item.deps.every(name => services.has(name))) continue
      item.ran = true
      item.callback(childFor())
    }
  }
  const ctx = {
    logger: { warn() {} },
    get: name => services.get(name),
    inject(deps, callback) { pending.push({ deps, callback, ran: false }); activateReady() },
    on(event, callback) {
      if (event === 'dispose') rootDispose = callback
      return () => {}
    },
  }
  const tools = {
    guard() { guardCalls++; return () => {} },
    register() { return () => {} },
  }

  try {
    await apply(ctx, {})
    services.set('tools', tools)
    activateReady()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(guardCalls, 0, 'runtime must not start with tools alone')
    assert.equal(requests.length, 0, 'no authenticated request before credentials are ready')
    assert.ok(pending.some(item => item.deps.includes('tools') && item.deps.includes('credentials')))

    services.set('credentials', {
      async resolve(ref) { return ref === 'STARTUP_KEY' ? { value: 'fixture-secret' } : undefined },
      async set() {}, async unset() {},
    })
    activateReady()
    let timer
    try {
      await Promise.race([
        toolsListed,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('startup MCP did not connect')), 7000) }),
      ])
    } finally { clearTimeout(timer) }
    assert.ok(guardCalls > 0)
    assert.ok(requests.some(request => request.method === 'initialize' && request.token === 'fixture-secret'))
    assert.ok(requests.some(request => request.method === 'tools/list' && request.token === 'fixture-secret'))
  } finally {
    await rootDispose?.()
    await Promise.all(childDisposers.map(dispose => dispose()))
    http.closeAllConnections()
    await new Promise(resolve => http.close(resolve))
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
