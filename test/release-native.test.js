import test from 'node:test'
import assert from 'node:assert/strict'
import {createController} from '../lib/controller.js'
import {buildView, draftServer} from '../lib/ui.js'
import {checkView, checkEffects} from './helpers/native-check.js'

function fixture(t, description = 'Fixture') {
  const state = {version: 1, revision: 0, servers: ['alpha', 'beta'].map(id => ({
    ...draftServer(), id, name: id, url: 'https://example.test/mcp',
    headers: [{name: 'X-One', value: ''}, {name: 'X-Two', value: ''}],
  }))}
  const tools = Array.from({length: 10}, (_, i) => ({name: `read_${i}`, description: 'Read', inputSchema: {type: 'object', description}}))
  const store = {
    snapshot: () => structuredClone(state),
    async update(revision, mutate) {
      assert.equal(revision, state.revision)
      const next = structuredClone(state)
      await mutate(next)
      next.revision++
      Object.assign(state, next)
    },
  }
  const runtime = {snapshot: () => Object.fromEntries(state.servers.map(s => [s.id, {status: 'connected', tools}])), reconcile() {}}
  const c = createController(store, runtime)
  t.after(() => c.dispose())
  return {c, state, store, scope: {sessionId: 'test'}}
}
const value = args => ({value: args})
const nodes = node => [node, ...(node.children ?? []).flatMap(nodes)]
const button = (data, id, confirmed) => data.content.flatMap(nodes)
  .flatMap(n => n.items ?? []).find(item => item.action?.id === id && item.action.args.confirmed === confirmed)

test('large Unicode schemas navigate through an accepted refresh and bounded data feed', async t => {
  const {c, scope} = fixture(t, '汉'.repeat(6500))
  const result = await c.actions.viewSchema(scope, value({serverId: 'alpha', toolName: 'read_0'}))
  assert.deepEqual(result, {refresh: true})
  const effects = checkEffects(result, {source: 'mcp-manager', panels: new Set(['mcp-manager'])})
  assert.equal(effects.violation, false, JSON.stringify(effects))
  assert.equal(effects.effects[0].type, 'refresh')
  let data
  const stop = c.panel.data(scope, next => { data = next })
  t.after(stop)
  assert.ok(Buffer.byteLength(JSON.stringify(data)) <= 32768)
  assert.equal('children' in data, false, 'wire payload must not duplicate composed nodes')
  const schema = data.content.flatMap(nodes).find(n => n.type === 'codeBlock')
  assert.match(schema.code, /汉{6500}/)
  assert.equal(checkView(buildView(), {budget: 'panel', data}).ok, true)
})

test('ordinary navigation returns a bridge-accepted compact patch', async t => {
  const {c, scope} = fixture(t)
  const result = await c.actions.viewServer(scope, value({serverId: 'alpha'}))
  assert.ok(result.patch.content)
  assert.equal('children' in result.patch, false)
  const checked = checkEffects(result, {source: 'mcp-manager', panels: new Set(['mcp-manager'])})
  assert.equal(checked.violation, false, JSON.stringify(checked))
})

test('unsubmitted search text survives pagination, reopening tools, and data resubscription', async t => {
  const {c, scope} = fixture(t)
  await c.actions.viewServer(scope, value({serverId: 'alpha'}))
  await c.actions.searchDraft(scope, value({value: 'not submitted'}))
  let result = await c.actions.pageTools(scope, value({serverId: 'alpha', pageIndex: 1}))
  assert.equal(result.patch.form.query, 'not submitted')
  assert.match(JSON.stringify(result.patch.content), /read_8/)
  await c.actions.viewTool(scope, value({serverId: 'alpha', toolName: 'read_8'}))
  result = await c.actions.viewServer(scope, value({serverId: 'alpha'}))
  assert.equal(result.patch.form.query, 'not submitted')
  let data
  const stop = c.panel.data(scope, next => { data = next })
  t.after(stop)
  assert.equal(data.form.query, 'not submitted')
})

test('read-only settings refresh advances revision while editors preserve theirs', async t => {
  const {c, store, state} = fixture(t)
  const viewer = {sessionId: 'viewer'}, editor = {sessionId: 'editor'}
  await c.actions.viewSettings(viewer, value({serverId: 'alpha'}))
  await c.actions.editServer(editor, value({serverId: 'alpha'}))
  let data
  const stop = c.panel.data(viewer, next => { data = next })
  t.after(stop)
  await store.update(0, next => { next.servers[0].name = 'Renamed' })
  c.notify()
  await new Promise(resolve => setTimeout(resolve, 80))
  const toggle = data.content.flatMap(nodes).flatMap(n => n.items ?? []).find(item => item.action?.id === 'toggleServer')
  assert.equal(toggle.action.args.revision, 1)
  assert.equal(c.screens.get('editor').revision, 0)
  const result = await c.actions.toggleServer(viewer, value(toggle.action.args))
  assert.equal(result.toast, undefined)
  assert.equal(state.servers[0].enabled, false)
})

test('stale server deletion confirmations cannot delete a different target', async t => {
  const {c, scope, state} = fixture(t)
  const original = await c.actions.requestDelete(scope, value({serverId: 'alpha'}))
  const stale = button(original.patch, 'deleteServer', true)
  assert.ok(stale)
  const latest = await c.actions.requestDelete(scope, value({serverId: 'beta'}))
  const rejected = await c.actions.deleteServer(scope, value(stale.action.args))
  assert.match(rejected.toast, /确认目标已变化/)
  assert.equal(state.servers.length, 2)
  await c.actions.deleteServer(scope, value(button(latest.patch, 'deleteServer', true).action.args))
  assert.deepEqual(state.servers.map(s => s.id), ['alpha'])
})

test('stale credential deletion confirmations cannot delete a different entry', async t => {
  const {c, scope, state} = fixture(t)
  const original = await c.actions.requestDeletePair(scope, value({serverId: 'alpha', kind: 'headers', index: 0}))
  const stale = button(original.patch, 'deletePair', true)
  const latest = await c.actions.requestDeletePair(scope, value({serverId: 'alpha', kind: 'headers', index: 1}))
  const rejected = await c.actions.deletePair(scope, value(stale.action.args))
  assert.match(rejected.toast, /确认目标已变化/)
  assert.equal(state.servers[0].headers.length, 2)
  await c.actions.deletePair(scope, value(button(latest.patch, 'deletePair', true).action.args))
  assert.deepEqual(state.servers[0].headers.map(row => row.name), ['X-One'])
})
