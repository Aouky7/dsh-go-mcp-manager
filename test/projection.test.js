import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../lib/runtime.js';

function fixture(t, options = {}) {
  const servers = [{ id: 'alpha', enabled: true }, { id: 'beta', enabled: false }];
  const ctx = { tools: { guard: () => () => {} }, on: () => () => {} };
  const runtime = createRuntime(ctx, { getState: () => ({ servers }), ...options });
  t.after(() => runtime.dispose());
  const slot = runtime.slot('alpha');
  slot.view = {
    status: 'connected', error: null, refreshing: false,
    lastCheck: { at: 123, durationMs: 20, ok: true },
    serverInfo: { name: 'Example', version: '1.2.3' },
    tools: [
      { name: 'read', description: 'Read a document', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'search', description: 'Search documents', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    ],
    resources: [{ name: 'Manual', uri: 'docs://manual', description: 'A manual', mimeType: 'text/plain', contents: 'not projected' }],
    prompts: [{ name: 'Review', description: 'Review a document', arguments: [{ name: 'document', description: 'not projected' }] }],
    metadataUnavailable: { resources: false, prompts: true },
  };
  slot.retries = 2;
  slot.nextRetryAt = 456;
  slot.stats = { calls: 3, failures: 1, active: 0 };
  slot.history = [{ tool: 'read', at: 120, durationMs: 5, ok: true }];
  return { runtime, slot, servers };
}

test('summary and tools projections include counts without reading catalog schemas', t => {
  const { runtime, slot } = fixture(t);
  const largeSchema = { type: 'object', description: 'large-schema-marker'.repeat(20000) };
  Object.defineProperty(slot.view.tools[0], 'inputSchema', { get() { throw Error('summary accessed full schema'); } });
  slot.view.tools[1].inputSchema = largeSchema;
  Object.defineProperty(slot.view.prompts[0], 'arguments', { get() { throw Error('summary accessed prompt arguments'); } });
  Object.defineProperty(slot.view.resources[0], 'contents', { get() { throw Error('summary accessed resource contents'); } });
  for (const detail of ['summary', 'tools']) {
    const result = runtime.project({ detail }).alpha;
    assert.equal(result.status, 'connected');
    assert.equal(result.error, null);
    assert.equal(result.refreshing, false);
    assert.deepEqual(result.lastCheck, { at: 123, durationMs: 20, ok: true });
    assert.deepEqual(result.serverInfo, { name: 'Example', version: '1.2.3' });
    assert.equal(result.retries, 2);
    assert.equal(result.nextRetryAt, 456);
    assert.deepEqual(result.counts, { tools: 2, enabledTools: 2, resources: 1, prompts: 1 });
    if (detail === 'tools') assert.deepEqual(result.tools, [{ name: 'read', description: 'Read a document' }, { name: 'search', description: 'Search documents' }]);
    else assert.deepEqual(result.tools, []);
    assert.equal('resources' in result, false);
    assert.equal('prompts' in result, false);
    assert.doesNotMatch(JSON.stringify(result), /inputSchema|large-schema-marker|not projected/);
  }
});

test('selected tool detail reads only its schema and redacts an independent copy', t => {
  const { runtime, slot } = fixture(t);
  Object.defineProperty(slot.view.tools[0], 'inputSchema', { get() { throw Error('accessed unrelated tool schema'); } });
  const result = runtime.project({ serverId: 'alpha', detail: 'tool', toolName: 'search' });
  assert.deepEqual(Object.keys(result), ['alpha']);
  assert.deepEqual(result.alpha.tools, [slot.view.tools[1]]);
  result.alpha.tools[0].inputSchema.properties.query.type = 'number';
  assert.equal(slot.view.tools[1].inputSchema.properties.query.type, 'string');
  assert.deepEqual(runtime.project({ serverId: 'alpha', detail: 'tool', toolName: 'missing' }).alpha.tools, []);
});

test('overview includes bounded records and counts without catalog definitions', t => {
  const { runtime, slot } = fixture(t);
  Object.defineProperty(slot.view.tools[0], 'inputSchema', { get() { throw Error('overview accessed tool schema'); } });
  Object.defineProperty(slot.view.prompts[0], 'arguments', { get() { throw Error('overview accessed prompt arguments'); } });
  slot.history = Array.from({ length: 25 }, (_, at) => ({ tool: 'read', at, durationMs: 1, ok: true }));
  const result = runtime.project({ serverId: 'alpha', detail: 'overview' }).alpha;
  assert.deepEqual(result.stats, slot.stats);
  assert.equal(result.history.length, 20);
  assert.deepEqual(result.metadataUnavailable, { resources: false, prompts: true });
  assert.deepEqual(result.counts, { tools: 2, enabledTools: 2, resources: 1, prompts: 1 });
  assert.equal('resources' in result, false);
  assert.equal('prompts' in result, false);
  assert.ok(result.tools.every(tool => !('inputSchema' in tool)));
});

test('catalog includes only minimal metadata for an explicitly selected server', t => {
  const { runtime, slot } = fixture(t);
  Object.defineProperty(slot.view.prompts[0], 'arguments', { get() { throw Error('catalog accessed prompt arguments'); } });
  const result = runtime.project({ serverId: 'alpha', detail: 'catalog' }).alpha;
  assert.deepEqual(result.resources, [{ name: 'Manual', uri: 'docs://manual', description: 'A manual', mimeType: 'text/plain' }]);
  assert.deepEqual(result.prompts, [{ name: 'Review', description: 'Review a document' }]);
  assert.deepEqual(result.metadataUnavailable, { resources: false, prompts: true });
  assert.doesNotMatch(JSON.stringify(result), /inputSchema|arguments|not projected/);
  assert.equal('resources' in runtime.project({ detail: 'catalog' }).alpha, false);
});

test('server filtering avoids reading other catalogs and supplies disconnected defaults', t => {
  const { runtime, slot } = fixture(t);
  const beta = runtime.project({ serverId: 'beta' });
  assert.deepEqual(Object.keys(beta), ['beta']);
  assert.deepEqual(beta.beta, {
    status: 'disabled', error: null, refreshing: false, lastCheck: null, serverInfo: null,
    retries: 0, nextRetryAt: null, counts: { tools: 0, enabledTools: 0, resources: 0, prompts: 0 }, tools: [],
  });
  Object.defineProperty(slot.view, 'tools', { get() { throw Error('read unselected catalog'); } });
  assert.deepEqual(Object.keys(runtime.project({ serverId: 'beta' })), ['beta']);
  assert.deepEqual(runtime.project({ serverId: 'missing' }), {});
});

test('summaries cap minimal tools at 500 while counts report the catalog size', t => {
  const { runtime, slot } = fixture(t);
  slot.view.tools = Array.from({ length: 502 }, (_, index) => ({ name: `tool${index}`, description: 'Example', inputSchema: { type: 'object' } }));
  const result = runtime.project({ serverId: 'alpha', detail: 'tools' }).alpha;
  assert.equal(result.tools.length, 500);
  assert.equal(result.counts.tools, 502);
  assert.equal(result.tools.at(-1).name, 'tool499');
  assert.ok(result.tools.every(tool => Object.keys(tool).join(',') === 'name,description'));
});

test('every projection mode passes through existing credential redaction', t => {
  const { runtime, slot } = fixture(t);
  const secret = 'projection-test-credential';
  runtime.rememberSecret(secret);
  slot.view.error = { code: 'example', message: `failure ${secret}` };
  slot.view.serverInfo.name = `Example ${secret}`;
  slot.view.tools[0].description = `Read ${secret}`;
  slot.view.tools[0].inputSchema.description = `Schema ${secret}`;
  slot.view.resources[0].uri = `docs://${secret}`;
  slot.view.prompts[0].description = `Review ${secret}`;
  slot.history[0].message = `Result ${secret}`;
  for (const detail of ['summary', 'tools', 'tool', 'overview', 'catalog']) {
    const result = runtime.project({ serverId: 'alpha', detail, toolName: 'read' });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    assert.match(JSON.stringify(result), /已隐藏/);
  }
});

test('snapshot retains full legacy catalogs independently of project options', t => {
  const { runtime, slot } = fixture(t);
  runtime.project({ serverId: 'alpha', detail: 'summary' });
  const result = runtime.snapshot();
  assert.deepEqual(Object.keys(result), ['alpha', 'beta']);
  assert.deepEqual(result.alpha.tools, slot.view.tools);
  assert.deepEqual(result.alpha.prompts, slot.view.prompts);
  assert.deepEqual(result.alpha.resources, slot.view.resources);
  assert.equal(result.alpha.resourcesCallable, false);
  assert.equal(result.alpha.promptsCallable, false);
  assert.deepEqual(result.alpha.stats, slot.stats);
  assert.deepEqual(result.alpha.history, slot.history);
});

test('onInvalidate receives no arguments and bypasses snapshot and legacy listener', t => {
  let invalidations = 0, legacyCalls = 0;
  const { runtime } = fixture(t, {
    onInvalidate(...args) { assert.equal(args.length, 0); invalidations++; },
    onChange() { legacyCalls++; },
  });
  runtime.snapshot = () => { throw Error('invalidation computed full snapshot'); };
  runtime.changed();
  assert.equal(invalidations, 1);
  assert.equal(legacyCalls, 0);
  runtime.closed = true;
  runtime.changed();
  assert.equal(invalidations, 1);
  runtime.closed = false;
});

test('legacy onChange receives snapshot and observer failures do not alter lifecycle', t => {
  const received = [];
  const { runtime } = fixture(t, { onChange: snapshot => received.push(snapshot) });
  const snapshot = runtime.snapshot();
  runtime.changed();
  assert.deepEqual(received, [snapshot]);
  runtime.options.onInvalidate = () => { throw Error('observer failure'); };
  assert.doesNotThrow(() => runtime.changed());
  assert.equal(received.length, 1);
});
