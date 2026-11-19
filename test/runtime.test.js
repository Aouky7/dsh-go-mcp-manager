import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, createCredentialFetch, publicToolName } from '../lib/runtime.js';

const schema = { type: 'object', properties: {}, additionalProperties: false };
const tool = (name = 'read') => ({ name, description: 'Example tool', inputSchema: schema });
function server(overrides = {}) {
  return { id: 'example', name: 'Example', transport: 'streamable-http', url: 'https://mcp.example/mcp',
    enabled: true, requireApproval: true, timeoutMs: 1000, headers: [], env: [], tools: {}, ...overrides };
}
function fixture(servers = [server()], behavior = {}) {
  const state = { servers };
  const registered = new Map();
  const guards = new Set();
  let pre;
  const clients = [];
  let calls = 0;
  const ctx = {
    tools: {
      register(definition, options) {
        if (registered.has(definition.name)) throw Error('duplicate');
        behavior.register?.(definition);
        registered.set(definition.name, { definition, options });
        return () => registered.delete(definition.name);
      },
      guard(fn) { guards.add(fn); return () => guards.delete(fn); },
    },
    on(event, fn) { assert.equal(event, 'tools/pre-execute'); pre = fn; return () => { pre = undefined; }; },
    get() { return undefined; },
  };
  const runtime = createRuntime(ctx, {
    getState: () => state,
    resolveSecret: async ref => ref === 'TOKEN' ? 'super-private-123' : undefined,
    createClient(identity, options) {
      const client = {
        options, identity, closed: false,
        getServerCapabilities: () => ({ tools: {}, resources: {}, prompts: {} }),
        async connect(transport) {
          this.transport = transport;
          await behavior.connect?.(this);
        },
        async close() { this.closed = true; this.onclose?.(); },
        async listTools() { return behavior.listTools ? behavior.listTools(this) : { tools: [tool()] }; },
        async listResources() { return { resources: [{ name: 'Manual', uri: 'demo://manual' }] }; },
        async listPrompts() { return { prompts: [{ name: 'review', arguments: [] }] }; },
        async callTool(params, options) {
          calls++;
          if (behavior.callTool) return behavior.callTool(params, options);
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      };
      clients.push(client);
      return client;
    },
  });
  return { runtime, state, registered, clients, guards, get calls() { return calls; },
    pre: (...args) => pre(...args) };
}
const execution = name => ({ name, callId: 'call', signal: new AbortController().signal });
const allow = async () => ({ kind: 'allow' });

test('discovers namespaced tools and metadata; disposes all registrations', async () => {
  const f = fixture();
  await f.runtime.reconcile();
  const snapshot = f.runtime.snapshot().example;
  assert.equal(snapshot.status, 'connected');
  assert.equal(snapshot.tools[0].name, 'read');
  assert.equal(snapshot.resources[0].uri, 'demo://manual');
  assert.equal(snapshot.prompts[0].name, 'review');
  assert.equal(snapshot.resourcesCallable, false);
  assert.equal(snapshot.promptsCallable, false);
  const entry = f.registered.get('mcp__example__read');
  assert.equal(entry.options.when(), true);
  assert.deepEqual(await entry.definition.execute({}, execution(entry.definition.name)), { content: [{ type: 'text', text: 'ok' }] });
  await f.runtime.dispose();
  assert.equal(f.registered.size, 0);
  assert.equal(f.clients[0].closed, true);
  assert.equal(f.guards.size, 0);
});

test('per-tool approval preserves downstream decisions and inherits server default', async () => {
  const f = fixture();
  await f.runtime.reconcile();
  const exec = execution('mcp__example__read');
  assert.equal((await f.pre(exec, allow)).kind, 'ask');
  f.state.servers[0].tools.read = { requireApproval: false };
  assert.equal((await f.pre(exec, allow)).kind, 'allow');
  const denied = { kind: 'deny', reason: 'other policy' };
  assert.equal(await f.pre(exec, async () => denied), denied);
  const asked = { kind: 'ask', reason: 'other approval' };
  assert.equal(await f.pre(exec, async () => asked), asked);
  assert.equal((await f.pre(execution('unrelated'), allow)).kind, 'allow');
  await f.runtime.dispose();
});

test('live disabling rejects admitted definitions before body and guard dispatch', async () => {
  const f = fixture();
  await f.runtime.reconcile();
  const entry = f.registered.get('mcp__example__read');
  const exec = execution(entry.definition.name);
  f.state.servers[0].tools.read = { enabled: false };
  assert.equal(entry.options.when(), false);
  assert.equal((await f.pre(exec, allow)).kind, 'deny');
  assert.equal(typeof [...f.guards][0](exec), 'string');
  await assert.rejects(entry.definition.execute({}, exec), /禁用/);
  assert.equal(f.calls, 0);
  await f.runtime.dispose();
});

test('config rotation revokes captured old definitions even before reconcile', async () => {
  const f = fixture();
  await f.runtime.reconcile();
  const old = f.registered.get('mcp__example__read').definition;
  f.state.servers[0].url = 'https://different.example/mcp';
  await assert.rejects(old.execute({}, execution(old.name)), /禁用/);
  await f.runtime.reconcile();
  assert.equal(f.clients.length, 2);
  assert.equal(f.clients[0].closed, true);
  assert.equal(f.runtime.snapshot().example.status, 'connected');
  await f.runtime.dispose();
});

test('tool list change replaces generation; failed discovery retains existing tools', async () => {
  let names = ['read'];
  const f = fixture(undefined, { listTools: async () => {
    if (names === null) throw Error('super-private-123');
    return { tools: names.map(tool) };
  } });
  await f.runtime.reconcile();
  const generation = f.runtime.slots.get('example').generation;
  names = ['write'];
  f.clients[0].options.listChanged.tools.onChanged();
  await generation.sync;
  assert.equal(f.registered.has('mcp__example__read'), false);
  assert.equal(f.registered.has('mcp__example__write'), true);
  names = null;
  f.clients[0].options.listChanged.tools.onChanged();
  await generation.sync;
  assert.equal(f.registered.has('mcp__example__write'), true);
  assert.equal(f.runtime.snapshot().example.error.code, 'discovery-failed');
  assert.doesNotMatch(JSON.stringify(f.runtime.snapshot()), /super-private/);
  await f.runtime.dispose();
});

test('tool failure text is generic, including MCP isError results', async () => {
  const f = fixture(undefined, { callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'password=super-private-123' }] }) });
  await f.runtime.reconcile();
  const def = f.registered.get('mcp__example__read').definition;
  await assert.rejects(def.execute({}, execution(def.name)), error => error.message === 'MCP 工具调用失败。');
  await f.runtime.dispose();
});

test('dispose aborts in-flight calls without replay', async () => {
  let entered;
  const began = new Promise(resolve => { entered = resolve; });
  const f = fixture(undefined, { callTool: async (_params, { signal }) => new Promise((resolve, reject) => {
    entered();
    signal.addEventListener('abort', () => reject(new Error('upstream secret')), { once: true });
  }) });
  await f.runtime.reconcile();
  const def = f.registered.get('mcp__example__read').definition;
  const call = def.execute({}, execution(def.name));
  const rejected = assert.rejects(call, /取消/);
  await began;
  await f.runtime.dispose();
  await rejected;
  assert.equal(f.calls, 1);
});

test('missing credential and upstream connection errors never enter snapshots', async () => {
  const f = fixture(undefined, { connect: async () => { throw Error('https://user:password@example.test super-private-123'); } });
  await f.runtime.reconcile();
  assert.equal(f.runtime.snapshot().example.status, 'reconnecting');
  assert.doesNotMatch(JSON.stringify(f.runtime.snapshot()), /password|super-private/);
  assert.equal(f.registered.size, 0);
  await f.runtime.dispose();
});

test('custom fetch refreshes secrets, forbids other origins and disables redirect following', async () => {
  let token = 'one-secret';
  const sent = [];
  const fetch = createCredentialFetch({ server: server({ headers: [{ name: 'Authorization', credentialRef: 'TOKEN', prefix: 'Bearer ' }] }),
    resolveSecret: async () => token, assertCurrent() {}, fetchImpl: async (input, init) => { sent.push({ input, init }); return new Response('{}'); } });
  await fetch('https://mcp.example/mcp', { method: 'POST' });
  token = 'two-secret';
  await fetch('https://mcp.example/events', { headers: { Accept: 'text/event-stream' }, redirect: 'follow' });
  assert.equal(sent[0].init.headers.get('Authorization'), 'Bearer one-secret');
  assert.equal(sent[1].init.headers.get('Authorization'), 'Bearer two-secret');
  assert.equal(sent[1].init.headers.get('Accept'), 'text/event-stream');
  assert.equal(sent[1].init.redirect, 'error');
  await assert.rejects(fetch('https://evil.example/mcp'), /跨来源/);
  await assert.rejects(fetch('https://user:password@mcp.example/mcp'), /跨来源/);
  assert.equal(sent.length, 2);
});

test('custom fetch refuses missing secrets before any request', async () => {
  let sent = false;
  const fetch = createCredentialFetch({ server: server({ headers: [{ name: 'X-Key', credentialRef: 'MISSING' }] }),
    resolveSecret: async () => undefined, assertCurrent() {}, fetchImpl: async () => { sent = true; } });
  await assert.rejects(fetch('https://mcp.example/mcp'), /凭据/);
  assert.equal(sent, false);
});

test('stdio scrubs inherited secrets and suppresses stderr; SSE transport is available', async () => {
  const previous = process.env.MCP_TEST_SECRET;
  process.env.MCP_TEST_SECRET = 'never-inherit';
  const f = fixture([server({ transport: 'stdio', command: 'not-executed-in-test',
    env: [{ name: 'EXPLICIT_TOKEN', credentialRef: 'TOKEN' }] })]);
  try {
    await f.runtime.reconcile();
    const params = f.clients[0].transport._serverParams;
    assert.equal(params.env.MCP_TEST_SECRET, undefined);
    assert.equal(params.env.EXPLICIT_TOKEN, 'super-private-123');
    assert.equal(params.stderr, 'ignore');
    assert.doesNotMatch(JSON.stringify(f.runtime.snapshot()), /super-private|never-inherit/);
    await f.runtime.dispose();
    const sse = fixture([server({ transport: 'sse' })]);
    await sse.runtime.reconcile();
    assert.equal(sse.clients[0].transport.constructor.name, 'SSEClientTransport');
    await sse.runtime.dispose();
  } finally {
    if (previous === undefined) delete process.env.MCP_TEST_SECRET;
    else process.env.MCP_TEST_SECRET = previous;
    await f.runtime.dispose();
  }
});

test('identical raw names on distinct servers remain independent', async () => {
  const f = fixture([server(), server({ id: 'other' })]);
  await f.runtime.reconcile();
  assert.equal(f.registered.size, 2);
  f.state.servers[0].enabled = false;
  await f.runtime.reconcile();
  assert.equal(f.registered.has('mcp__example__read'), false);
  assert.equal(f.registered.has('mcp__other__read'), true);
  assert.equal(f.runtime.snapshot().example.status, 'disabled');
  await f.runtime.dispose();
});

test('normalization and truncation preserve a deterministic unique identity', () => {
  assert.equal(publicToolName('server', 'read'), 'mcp__server__read');
  assert.notEqual(publicToolName('server', 'a b'), publicToolName('server', 'a_b'));
  const name = publicToolName('server', 'x'.repeat(100));
  assert.equal(name.length, 64);
  assert.match(name, /^[A-Za-z0-9_-]+$/);
  assert.equal(publicToolName('server', 'x'.repeat(100)), name);
});
