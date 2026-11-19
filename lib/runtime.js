import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client, StreamableHTTPClientTransport, SSEClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client';
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess';

const MESSAGES = Object.freeze({
  'connection-failed': '连接失败，请检查服务器地址与凭据。',
  'discovery-failed': '无法刷新服务器工具列表。',
  'tool-failed': 'MCP 工具调用失败。',
  'tool-disabled': 'MCP 工具已禁用或连接配置已改变。',
  'credential-missing': '请求头凭据不可用。请打开基础设置，点击该请求头重新填写并保存。',
  'auth-rejected': '服务器拒绝鉴权（401）。请检查请求头名称和值；x-api-key 通常直接填 Key。',
  'access-denied': '服务器拒绝访问（403）。请检查 Key 权限或服务商的网络访问限制。',
  'rate-limited': '请求过于频繁或额度不足（429）。请稍后重新连接或检查服务商额度。',
  'invalid-transport': '服务器连接配置无效。',
  'unsafe-request': '已阻止跨来源请求或重定向。',
  'registration-failed': '工具名称冲突，无法注册。',
  'schema-secret': '服务器工具定义包含连接凭据，已拒绝加载，请联系服务器维护者。',
  'timeout': '操作超时。',
  'cancelled': '操作已取消。',
  'close-failed': '无法确认旧连接已关闭；请重启引擎后重试。',
  'retry-exhausted': '连接多次失败，请手动重连。',
});
const faults = new WeakSet();
function fault(code) {
  const error = Object.assign(new Error(MESSAGES[code]), { code });
  faults.add(error);
  return error;
}
function errorCode(error, fallback) {
  return error && faults.has(error) ? error.code : fallback;
}
const clone = value => structuredClone(value);
const timeoutFor = server => Number.isFinite(server.timeoutMs)
  ? Math.max(100, Math.min(300000, server.timeoutMs)) : 60000;
const sleepTimer = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; };

/** Mirrors the public naming contract; the upstream helper is private. */
export function publicToolName(serverId, rawName) {
  const joined = `mcp__${serverId}__${rawName}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
  if (joined === normalized && normalized.length <= 64) return normalized;
  const hash = createHash('sha256').update(`${serverId}\0${rawName}`).digest('hex').slice(0, 12);
  return `${normalized.slice(0, 51)}_${hash}`;
}

function connectionKey(server) {
  // Hash keeps literal config values out of diagnostics and generation labels.
  return createHash('sha256').update(JSON.stringify([
    server.transport, server.url, server.command, server.args ?? [], server.cwd,
    server.headers ?? [], server.env ?? [], server.timeoutMs,
  ])).digest('hex');
}

async function bounded(work, signal, timeoutMs) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(fault('timeout')), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(deadline.signal.aborted ? fault('timeout') : fault('cancelled'));
    if (combined.aborted) abort();
    else combined.addEventListener('abort', abort, { once: true });
  });
  try {
    combined.throwIfAborted();
    return await Promise.race([Promise.resolve().then(() => work(combined)), stopped]);
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', abort);
  }
}

/** HTTP and legacy SSE both use this fetch, including their receive stream.
 * Credentials are resolved afresh for each request. Redirects are never followed.
 */
export function createCredentialFetch({ server, resolveSecret, signal, assertCurrent,
  rememberSecret = () => {}, onFault = () => {}, fetchImpl = globalThis.fetch }) {
  const base = new URL(server.url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw fault('invalid-transport');
  return async (input, init = {}) => {
    assertCurrent();
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== base.origin || url.username || url.password) throw fault('unsafe-request');
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    for (const row of server.headers ?? []) {
      if (/^(host|content-length|connection|transfer-encoding|proxy-authorization)$/i.test(row.name)) throw fault('invalid-transport');
      let value = row.value ?? '';
      if (row.credentialRef) {
        value = await resolveSecret(row.credentialRef);
        if (typeof value !== 'string' || value.length === 0) throw fault('credential-missing');
        rememberSecret(value);
      }
      headers.set(row.name, `${row.prefix ?? ''}${value}`);
    }
    assertCurrent();
    const requestSignal = input instanceof Request ? input.signal : undefined;
    const signals = [signal, init.signal, requestSignal].filter(Boolean);
    const response = await fetchImpl(input, { ...init, headers, redirect: 'error',
      signal: signals.length ? AbortSignal.any(signals) : undefined });
    const code = ({401:'auth-rejected',403:'access-denied',429:'rate-limited'})[response.status];
    if (code) { onFault(code); await response.body?.cancel().catch(()=>{}); throw fault(code); }
    return response;
  };
}

/** Host-only MCP registry. This class never exposes a raw client or credential.
 * getState(): {servers: Server[]} | Server[]
 * resolveSecret(ref): Promise<string | undefined>
 * onInvalidate(): void (preferred); onChange(snapshot): void (legacy fallback).
 * createClient(identity, SDK options): Client (test seam).
 * Resource and prompt entries are metadata only, not callable registrations.
 */
export class ManagerRuntime {
  constructor(ctx, options) {
    this.ctx = ctx;
    this.options = options;
    this.slots = new Map();
    this.owned = new Map();
    this.secrets = new Set();
    this.callFaults = new AsyncLocalStorage();
    this.closed = false;
    this.disposers = [];
    this.disposers.push(ctx.tools.guard(exec => {
      const item = this.owned.get(exec.name);
      return item && !this.allowed(item.generation, item.rawName) ? MESSAGES['tool-disabled'] : undefined;
    }));
    this.disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
      const downstream = await next();
      if (downstream.kind !== 'allow') return downstream;
      const item = this.owned.get(exec.name);
      if (!item) return downstream;
      if (!this.allowed(item.generation, item.rawName)) return { kind: 'deny', reason: MESSAGES['tool-disabled'] };
      const server = this.server(item.generation.slot.id);
      const policy = server?.tools?.[item.rawName];
      if (policy?.requireApproval ?? server?.requireApproval ?? true) return {
        kind: 'ask', reason: 'This MCP tool requires approval for this call.',
        displayReason: { en: 'Approve this MCP tool call', zh: '批准本次 MCP 工具调用' },
      };
      return downstream;
    }, { prepend: true }));
  }

  servers() {
    const state = this.options.getState();
    return Array.isArray(state) ? state : state.servers ?? [];
  }
  server(id) { return this.servers().find(server => server.id === id); }
  live(generation) {
    const server = this.server(generation.slot.id);
    return !this.closed && !generation.controller.signal.aborted && generation.slot.generation === generation
      && server?.enabled === true && connectionKey(server) === generation.key;
  }
  allowed(generation, rawName) {
    return this.live(generation) && this.server(generation.slot.id)?.tools?.[rawName]?.enabled !== false;
  }
  assertCurrent(generation, rawName) {
    if (!(rawName === undefined ? this.live(generation) : this.allowed(generation, rawName))) throw fault('tool-disabled');
  }
  rememberSecret(value) {
    if (typeof value === 'string' && value.length) this.secrets.add(value);
  }
  safe(value, depth = 0) {
    if (depth > 24) return null;
    if (typeof value === 'string') {
      let text = value;
      for (const secret of this.secrets) if (text.includes(secret)) text = text.split(secret).join('[已隐藏]');
      return text.replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, '$1 [已隐藏]').slice(0, 16000);
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 500).map(item => this.safe(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 500)
      .filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key))
      .map(([key, item]) => [this.safe(key), this.safe(item, depth + 1)]));
    return null;
  }
  snapshot() {
    const rows = this.servers().map(server => {
      const slot = this.slots.get(server.id);
      const view = slot?.view ?? { status: server.enabled ? 'disconnected' : 'disabled', error: null,
        tools: [], resources: [], prompts: [] };
      return [server.id, this.safe({ ...view, resourcesCallable: false, promptsCallable: false,
        retries: slot?.retries ?? 0, nextRetryAt: slot?.nextRetryAt ?? null,
        history: slot?.history ?? [], stats: slot?.stats ?? { calls: 0, failures: 0, active: 0 },
      })];
    });
    return Object.fromEntries(rows);
  }
  /** Lightweight native UI projection; catalog schemas stay on their owning slot.
   * @param {{ serverId?: string, detail?: 'summary'|'tools'|'tool'|'overview'|'catalog', toolName?: string }} options
   */
  project(options = {}) {
    const { serverId, detail = 'summary', toolName } = options;
    const servers = this.servers();
    const selected = serverId === undefined ? servers : servers.filter(server => server.id === serverId);
    return Object.fromEntries(selected.map(server => {
      const slot = this.slots.get(server.id);
      const view = slot?.view;
      const tools = view?.tools ?? [];
      // Build the allowlisted fields before redaction. In particular, summary
      // projections never access inputSchema, resource entries or prompt args.
      const row = {
        status: view?.status ?? (server.enabled ? 'disconnected' : 'disabled'),
        error: view?.error ?? null,
        refreshing: view?.refreshing === true,
        lastCheck: view?.lastCheck ?? null,
        serverInfo: view?.serverInfo ?? null,
        retries: slot?.retries ?? 0,
        nextRetryAt: slot?.nextRetryAt ?? null,
        counts: { tools: tools.length, enabledTools: tools.reduce((total, tool) => total + (server.tools?.[tool.name]?.enabled === false ? 0 : 1), 0), resources: view?.resources?.length ?? 0, prompts: view?.prompts?.length ?? 0 },
        tools: detail === 'tool'
          ? tools.filter(tool => tool.name === toolName).slice(0, 1).map(tool => ({
            name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema,
          }))
          : detail === 'tools' ? tools.slice(0, 500).map(tool => ({ name: tool.name, description: tool.description ?? '' })) : [],
      };
      if (detail === 'overview') {
        row.stats = slot?.stats ?? { calls: 0, failures: 0, active: 0 };
        row.history = (slot?.history ?? []).slice(0, 20);
        row.metadataUnavailable = view?.metadataUnavailable ?? { resources: false, prompts: false };
      }
      // Catalog metadata is requested for one server; directory argument and
      // content schemas are deliberately excluded even on this detail page.
      if (detail === 'catalog' && serverId !== undefined) {
        row.resources = (view?.resources ?? []).slice(0, 500).map(resource => ({
          name: resource.name, uri: resource.uri, description: resource.description ?? '', mimeType: resource.mimeType ?? '',
        }));
        row.prompts = (view?.prompts ?? []).slice(0, 500).map(prompt => ({ name: prompt.name, description: prompt.description ?? '' }));
        row.metadataUnavailable = view?.metadataUnavailable ?? { resources: false, prompts: false };
      }
      return [server.id, this.safe(row)];
    }));
  }
  changed() {
    if (this.closed) return;
    try {
      if (typeof this.options.onInvalidate === 'function') this.options.onInvalidate();
      else this.options.onChange?.(this.snapshot());
    } catch { /* UI observers cannot alter lifecycle. */ }
  }
  slot(id) {
    let slot = this.slots.get(id);
    if (!slot) {
      slot = { id, generation: null, chain: Promise.resolve(), retries: 0, timer: null, nextRetryAt: null,
        halted: false, exhausted: false, history: [], stats: { calls: 0, failures: 0, active: 0 },
        view: { status: 'disconnected', error: null, tools: [], resources: [], prompts: [] } };
      this.slots.set(id, slot);
    }
    return slot;
  }
  enqueue(slot, operation) {
    const result = slot.chain.then(operation);
    slot.chain = result.catch(() => {});
    return result;
  }
  clearTimer(slot) { if (slot.timer) clearTimeout(slot.timer); slot.timer = null; slot.nextRetryAt = null; }
  recordCall(slot, rawName, started, code) {
    slot.stats.active = Math.max(0, slot.stats.active - 1);
    if (code) slot.stats.failures++;
    slot.history.unshift({ tool: rawName, at: Date.now(), durationMs: Date.now() - started,
      ok: !code, ...(code ? { code, message: MESSAGES[code] } : {}) });
    slot.history.length = Math.min(20, slot.history.length);
    this.changed();
  }
  revoke(generation) {
    if (!generation) return;
    generation.controller.abort();
    for (const [name, registration] of generation.registrations) {
      registration.dispose();
      if (this.owned.get(name)?.generation === generation) this.owned.delete(name);
    }
    generation.registrations.clear();
  }
  async retire(slot) {
    const generation = slot.generation;
    if (!generation) return;
    this.revoke(generation);
    slot.generation = null;
    try {
      await bounded(async () => {
        if (generation.client?.transport) await generation.client.close();
        else if (generation.transport) await generation.transport.close();
        else if (generation.client) await generation.client.close();
        // Stdio close must have reached process 'close', not merely sent SIGTERM.
        if (generation.started && generation.server.transport === 'stdio' && !generation.closeObserved) {
          await generation.closePromise;
        }
      }, undefined, 5500);
    } catch {
      slot.halted = true;
      slot.view.status = 'error';
      slot.view.error = { code: 'close-failed', message: MESSAGES['close-failed'] };
    }
  }
  async reconcile() {
    if (this.closed) return this.snapshot();
    const active = new Set(this.servers().map(server => server.id));
    const operations = [];
    for (const server of this.servers()) {
      const slot = this.slot(server.id);
      const key = connectionKey(server);
      if (!server.enabled || slot.lastKey !== key) {
        this.clearTimer(slot);
        slot.exhausted = false;
        slot.blocked = false;
        slot.retries = 0;
        this.revoke(slot.generation);
      }
      slot.lastKey = key;
      operations.push(this.enqueue(slot, () => this.ensure(slot)));
    }
    for (const [id, slot] of this.slots) if (!active.has(id)) {
      this.clearTimer(slot);
      this.revoke(slot.generation);
      operations.push(this.enqueue(slot, async () => {
        if (this.server(id)) return;
        await this.retire(slot);
        if (!this.server(id)) this.slots.delete(id);
      }));
    }
    await Promise.all(operations);
    this.changed();
    return this.snapshot();
  }
  async connect(id) {
    if (this.closed) return this.snapshot()[id];
    const slot = this.slot(id);
    if (slot.connectTask) return slot.connectTask;
    this.clearTimer(slot);
    this.revoke(slot.generation);
    const task = this.enqueue(slot, async () => {
      slot.retries = 0;
      slot.exhausted = false;
      slot.blocked = false;
      slot.lastKey = this.server(id) ? connectionKey(this.server(id)) : undefined;
      await this.retire(slot);
      await this.ensure(slot);
      return this.snapshot()[id];
    });
    slot.connectTask = task;
    try { return await task; }
    finally { if (slot.connectTask === task) slot.connectTask = null; }
  }
  async refresh(id) {
    const server = this.server(id);
    if (this.closed || !server?.enabled) return this.snapshot()[id];
    const slot = this.slot(id);
    if (slot.refreshTask) return slot.refreshTask;
    const task = (async () => {
      // A healthy connection keeps its transport and in-flight tool calls.
      // A disconnected server gets the same explicit retry as reconnect.
      if (!slot.generation || !this.live(slot.generation)) await this.connect(id);
      else if (slot.generation.connecting) await slot.chain;
      else await this.refreshGeneration(slot.generation);
      return this.snapshot()[id];
    })();
    slot.refreshTask = task;
    try { return await task; }
    finally { if (slot.refreshTask === task) slot.refreshTask = null; }
  }
  refreshGeneration(generation, invalidated = false) {
    if (generation.refreshTask) {
      if (invalidated) generation.refreshAgain = true;
      return generation.refreshTask;
    }
    const slot = generation.slot;
    const started = Date.now();
    slot.view.refreshing = true;
    this.changed();
    const task = generation.sync.then(async () => {
      try {
        do {
          generation.refreshAgain = false;
          await this.discover(generation);
          this.assertCurrent(generation);
        } while (generation.refreshAgain);
        slot.view.lastCheck = { at: Date.now(), durationMs: Date.now() - started, ok: true };
      } catch (error) {
        if (!this.live(generation)) return;
        const code = errorCode(error, generation.lastFetchFault ?? 'discovery-failed');
        slot.view.error = { code, message: MESSAGES[code] };
        slot.view.lastCheck = { at: Date.now(), durationMs: Date.now() - started, ok: false };
      } finally {
        if (slot.generation === generation) slot.view.refreshing = false;
        this.changed();
      }
    });
    generation.refreshTask = task;
    generation.sync = task;
    void task.then(() => { if (generation.refreshTask === task) generation.refreshTask = null; });
    return task;
  }
  async ensure(slot) {
    const server = this.server(slot.id);
    if (this.closed || !server?.enabled) {
      await this.retire(slot);
      if (!slot.halted) slot.view = { status: 'disabled', error: null, tools: [], resources: [], prompts: [] };
      this.changed();
      return;
    }
    if (slot.halted || slot.exhausted || slot.blocked) return;
    if (slot.generation && this.live(slot.generation)) return;
    await this.retire(slot);
    if (slot.halted || this.closed || !this.server(slot.id)?.enabled) return;
    if (slot.timer) return;
    await this.start(slot, clone(this.server(slot.id)));
  }
  async transport(generation) {
    const server = generation.server;
    const rememberSecret = value => this.rememberSecret(value);
    for (const row of [...server.headers ?? [], ...server.env ?? []]) if (row.value) rememberSecret(row.value);
    if (server.transport === 'stdio') {
      const env = scrubbedParentEnv();
      for (const row of server.env ?? []) {
        let value = row.value ?? '';
        if (row.credentialRef) {
          value = await this.options.resolveSecret(row.credentialRef);
          if (typeof value !== 'string' || !value) throw fault('credential-missing');
          rememberSecret(value);
        }
        env[row.name] = value;
      }
      this.assertCurrent(generation);
      return new StdioClientTransport({ command: server.command, args: server.args ?? [],
        cwd: server.cwd || undefined, env, stderr: 'ignore' });
    }
    for (const row of server.headers ?? []) if (row.credentialRef) {
      const value = await this.options.resolveSecret(row.credentialRef);
      if (typeof value !== 'string' || !value) throw fault('credential-missing');
      rememberSecret(value);
    }
    const fetch = createCredentialFetch({ server, resolveSecret: this.options.resolveSecret,
      signal: generation.controller.signal, assertCurrent: () => this.assertCurrent(generation), rememberSecret,
      onFault: code => {
        const call = this.callFaults.getStore();
        if (call) call.code = code;
        else generation.lastFetchFault = code;
      }, fetchImpl: this.options.fetchImpl });
    if (server.transport === 'streamable-http') return new StreamableHTTPClientTransport(new URL(server.url), { fetch });
    if (server.transport === 'sse') return new SSEClientTransport(new URL(server.url), { fetch });
    throw fault('invalid-transport');
  }
  async start(slot, server) {
    let resolveClosed;
    const generation = { slot, server, key: connectionKey(server), controller: new AbortController(),
      registrations: new Map(), client: null, transport: null, started: false, connecting: true,
      closeObserved: false, closePromise: new Promise(resolve => { resolveClosed = resolve; }),
      sync: Promise.resolve() };
    slot.generation = generation;
    const started = Date.now();
    slot.view = { status: 'connecting', error: null, tools: [], resources: [], prompts: [], refreshing: false };
    this.changed();
    try {
      const refresh = () => {
        if (!generation.connecting && this.live(generation)) void this.refreshGeneration(generation, true);
      };
      const listChanged = Object.fromEntries(['tools', 'resources', 'prompts'].map(kind => [kind,
        { autoRefresh: false, debounceMs: 100, onChanged: refresh }]));
      const factory = this.options.createClient ?? ((identity, options) => new Client(identity, options));
      generation.client = factory({ name: 'dsh-go-mcp-manager', version: '1.0.0' },
        { capabilities: {}, versionNegotiation: { mode: 'auto' }, listChanged });
      generation.client.onclose = () => {
        generation.closeObserved = true;
        resolveClosed();
        if (!generation.connecting && this.live(generation)) this.down(generation);
      };
      // Never pass arbitrary peer exceptions to a Host logger or UI.
      generation.client.onerror = () => {};
      generation.transport = await bounded(() => this.transport(generation), generation.controller.signal, timeoutFor(server));
      this.assertCurrent(generation);
      generation.started = true;
      await bounded(signal => generation.client.connect(generation.transport, { signal, timeout: timeoutFor(server) }),
        generation.controller.signal, timeoutFor(server));
      if (generation.closeObserved) throw fault('connection-failed');
      await this.discover(generation);
      this.assertCurrent(generation);
      generation.connecting = false;
      generation.connectedAt = Date.now();
      slot.view.status = 'connected';
      slot.view.connectedAt = generation.connectedAt;
      slot.view.lastCheck = { at: Date.now(), durationMs: Date.now() - started, ok: true };
      const info = generation.client.getServerVersion?.();
      slot.view.serverInfo = info ? { name: String(info.name ?? '').slice(0, 120), version: String(info.version ?? '').slice(0, 80) } : null;
      this.changed();
    } catch (error) {
      generation.connecting = false;
      if (slot.generation !== generation) return;
      const cancelled = !this.live(generation);
      await this.retire(slot);
      if (slot.halted || this.closed) return;
      slot.view.status = cancelled ? 'disconnected' : 'error';
      const code = errorCode(error, generation.lastFetchFault ?? 'connection-failed');
      slot.view.error = cancelled ? null : { code, message: MESSAGES[code] };
      slot.view.tools = []; slot.view.resources = []; slot.view.prompts = [];
      slot.view.lastCheck = { at: Date.now(), durationMs: Date.now() - started, ok: false };
      slot.blocked = !cancelled && ['credential-missing','auth-rejected','access-denied','rate-limited','invalid-transport','unsafe-request','registration-failed','schema-secret'].includes(code);
      if (!cancelled && !slot.blocked) this.retry(slot);
      this.changed();
    }
  }
  down(generation) {
    const slot = generation.slot;
    if (Date.now() - generation.connectedAt >= 30000) slot.retries = 0;
    this.revoke(generation);
    slot.view.status = 'disconnected';
    slot.view.error = { code: 'connection-failed', message: MESSAGES['connection-failed'] };
    this.enqueue(slot, async () => { await this.retire(slot); if (!slot.halted) this.retry(slot); });
    this.changed();
  }
  retry(slot) {
    if (this.closed || !this.server(slot.id)?.enabled || slot.timer || slot.halted) return;
    if (++slot.retries > 10) {
      slot.exhausted = true;
      slot.view.status = 'error';
      slot.view.error = { code: 'retry-exhausted', message: MESSAGES['retry-exhausted'] };
      return;
    }
    slot.view.status = 'reconnecting';
    const delay = Math.min(30000, 500 * 2 ** (slot.retries - 1));
    slot.nextRetryAt = Date.now() + delay;
    slot.timer = sleepTimer(() => {
      slot.timer = null;
      slot.nextRetryAt = null;
      this.enqueue(slot, () => this.ensure(slot));
    }, delay);
  }
  async discover(generation) {
    this.assertCurrent(generation);
    const client = generation.client;
    const capabilities = client.getServerCapabilities() ?? {};
    const server = generation.server;
    generation.lastFetchFault = null;
    const request = fn => bounded(signal => fn({ signal, timeout: timeoutFor(server), cacheMode: 'refresh' }),
      generation.controller.signal, timeoutFor(server));
    if (!capabilities.tools && !capabilities.resources && !capabilities.prompts) await request(options => client.ping(options));
    const response = capabilities.tools ? await request(options => client.listTools(undefined, options)) : { tools: [] };
    if (response.tools.length > 500) throw fault('discovery-failed');
    const resources = capabilities.resources && client.listResources
      ? await request(options => client.listResources(undefined, options)).catch(() => ({ resources: [], unavailable: true }))
      : { resources: [] };
    const prompts = capabilities.prompts && client.listPrompts
      ? await request(options => client.listPrompts(undefined, options)).catch(() => ({ prompts: [], unavailable: true }))
      : { prompts: [] };
    this.assertCurrent(generation);
    const definitions = new Map();
    for (const tool of response.tools) {
      if (typeof tool.name !== 'string' || !tool.name || tool.name.length > 1024) throw fault('discovery-failed');
      const name = publicToolName(server.id, tool.name);
      if (definitions.has(name)) throw fault('discovery-failed');
      // Reflected connection credentials must never become model-visible schema.
      const serialized = JSON.stringify([tool.name, tool.inputSchema, tool.outputSchema]);
      for (const secret of this.secrets) if (serialized.includes(JSON.stringify(secret).slice(1, -1))) throw fault('schema-secret');
      const definition = createMcpToolDefinition(this.ctx, { name, rawName: tool.name,
        description: this.safe(tool.description ?? ''), inputSchema: clone(tool.inputSchema), outputSchema: tool.outputSchema,
        taskRequired: tool.execution?.taskSupport === 'required',
        call: async (args, execution) => {
          this.assertCurrent(generation, tool.name);
          const signal = AbortSignal.any([execution.signal, generation.controller.signal]);
          const result = await bounded(async boundedSignal => {
            this.assertCurrent(generation, tool.name);
            return client.callTool({ name: tool.name, arguments: args },
              { signal: boundedSignal, timeout: timeoutFor(this.server(server.id)), toolDefinition: tool });
          }, signal, timeoutFor(this.server(server.id)));
          if (result?.isError === true) throw fault('tool-failed');
          return result;
        },
      });
      // Track one attempt, including schema/protocol failures, without arguments
      // or result bodies. Arbitrary tools are never replayed automatically.
      const execute = definition.execute;
      definition.execute = async (args, execution) => {
        this.assertCurrent(generation, tool.name);
        const slot = generation.slot, started = Date.now();
        slot.stats.calls++; slot.stats.active++;
        this.changed();
        let code;
        const callFault = {};
        try { return await this.callFaults.run(callFault, () => execute(args, execution)); }
        catch (error) {
          const signal = execution.signal;
          const fallback = signal.aborted || generation.controller.signal.aborted ? 'cancelled'
            : error?.code === 'REQUEST_TIMEOUT' || error?.name === 'TimeoutError' ? 'timeout'
              : callFault.code ?? 'tool-failed';
          code = errorCode(error, fallback);
          throw fault(code);
        }
        finally { this.recordCall(slot, tool.name, started, code); }
      };
      definitions.set(name, { definition, rawName: tool.name, signature: JSON.stringify(tool) });
    }
    // Install new names before replacing existing ones. Failed replacement rolls
    // back the prior definitions, keeping its last successfully read catalog.
    const prior = new Map(generation.registrations);
    const installed = new Set(), removed = new Set();
    const register = (name, item) => {
      const dispose = this.ctx.tools.register(item.definition, { when: () => this.allowed(generation, item.rawName) });
      generation.registrations.set(name, { ...item, dispose });
      this.owned.set(name, { generation, rawName: item.rawName });
    };
    const remove = (name, item) => {
      item.dispose(); generation.registrations.delete(name);
      if (this.owned.get(name)?.generation === generation) this.owned.delete(name);
    };
    try {
      for (const [name, item] of definitions) if (!prior.has(name)) { register(name, item); installed.add(name); }
      for (const [name, item] of definitions) {
        const old = prior.get(name);
        if (!old || old.signature === item.signature) continue;
        remove(name, old); removed.add(name);
        register(name, item); installed.add(name);
      }
    } catch {
      for (const name of installed) remove(name, generation.registrations.get(name));
      for (const name of removed) {
        try { register(name, prior.get(name)); }
        catch { /* If the Host cannot restore a row, do not advertise it. */ }
      }
      generation.slot.view.tools = generation.slot.view.tools.filter(tool => generation.registrations.has(publicToolName(server.id, tool.name)));
      throw fault('registration-failed');
    }
    for (const [name, item] of prior) if (!definitions.has(name)) remove(name, item);
    generation.slot.view.tools = response.tools.map(tool => ({ name: tool.name,
      description: tool.description ?? '', inputSchema: tool.inputSchema }));
    generation.slot.view.resources = (resources.resources ?? []).slice(0, 500).map(resource => ({
      name: resource.name, uri: resource.uri, description: resource.description ?? '', mimeType: resource.mimeType ?? '',
    }));
    generation.slot.view.prompts = (prompts.prompts ?? []).slice(0, 500).map(prompt => ({
      name: prompt.name, description: prompt.description ?? '', arguments: prompt.arguments ?? [],
    }));
    generation.slot.view.metadataUnavailable = { resources: !!resources.unavailable, prompts: !!prompts.unavailable };
    generation.slot.view.error = null;
    this.changed();
  }
  async dispose() {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const slot of this.slots.values()) { this.clearTimer(slot); this.revoke(slot.generation); }
    for (const dispose of this.disposers) dispose?.();
    this.closing = Promise.all([...this.slots.values()].map(slot => this.enqueue(slot, () => this.retire(slot))))
      .then(() => { this.secrets.clear(); });
    return this.closing;
  }
}

export function createRuntime(ctx, options) { return new ManagerRuntime(ctx, options); }
