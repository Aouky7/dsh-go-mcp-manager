import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,stat,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {StateStore,normalizeServer,formPayload} from '../lib/store.js'
import {createController} from '../lib/controller.js'
import {render,buildView,draftServer} from '../lib/ui.js'
import {checkView} from './helpers/native-check.js'

const server=()=>normalizeServer({...draftServer(),id:'sample',name:'测试服务',url:'https://example.com/mcp'})
async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'mcp-manager-test-'))
 t.after(async()=>{assert.ok(dir.startsWith(join(tmpdir(),'mcp-manager-test-')));await rm(dir,{recursive:true,force:true})})
 const store=new StateStore(join(dir,'servers.json'));await store.load()
 const rt={snapshot:()=>Object.fromEntries(store.snapshot().servers.map(s=>[s.id,{status:'connected',tools:[{name:'echo',description:'Echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}])),reconcile(){},connect(){}}
 return {store,rt,controller:createController(store,rt),dir}
}
test('state starts empty, persists, and rejects concurrent lost updates',async t=>{
 const {store,dir}=await fixture(t)
 assert.deepEqual(store.snapshot().servers,[])
 const results=await Promise.allSettled([store.update(0,s=>s.servers.push(server())),store.update(0,s=>s.servers.push(server()))])
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1)
 const loaded=new StateStore(join(dir,'servers.json'));await loaded.load()
 assert.equal(loaded.snapshot().servers[0].id,'sample')
 assert.equal((await stat(store.path)).mode&0o777,0o600)
})
test('URL credentials, inline header secrets, malformed pairs and duplicate IDs reject',()=>{
 assert.throws(()=>normalizeServer({...server(),url:'https://user:pw@example.com'}))
 assert.throws(()=>normalizeServer({...server(),url:'https://example.com?apiKey=secret'}))
 assert.throws(()=>normalizeServer({...server(),headers:[{name:'Authorization',value:'Bearer secret'}]}))
 assert.throws(()=>normalizeServer({...server(),headers:[{name:'x','value':'a'},{name:'X','value':'b'}]}))
 assert.throws(()=>normalizeServer({...server(),env:[{name:'NODE_OPTIONS',value:'--require evil'}]}))
 for(const credentialRef of ['API-KEY','API.KEY'])assert.throws(()=>normalizeServer({...server(),headers:[{name:'Authorization',credentialRef}]}),/凭据引用名不合法/)
 const s=normalizeServer({...server(),headers:[{name:'Authorization',credentialRef:'MCP_KEY',prefix:'Bearer '}]})
 assert.equal(s.headers[0].prefix,'Bearer ')
})
test('form supports nested and dotted values from native clients',()=>{
 assert.equal(formPayload({values:{'data.form.name':'Alpha'}}).name,'Alpha')
 assert.equal(formPayload({values:{form:{name:'Alpha'}}}).name,'Alpha')
 assert.equal(formPayload({form:{name:'Alpha'}}).name,'Alpha')
})
test('panel creates, edits, disables tools, and requires explicit deletion confirmation',async t=>{
 const {store,controller:c}=await fixture(t),scope={sessionId:'test'}
 await c.actions.addServer(scope,{value:{}})
  await c.actions.chooseTransport(scope,{value:{transport:'streamable-http'}})
 let r=await c.actions.saveServer(scope,{value:{args:{revision:0,serverId:''},values:{form:{...server(),argsText:'[]',headersText:'[]',envText:'[]'}}}})
 assert.equal(r.toast,'已保存基础设置')
 assert.equal(store.snapshot().servers.length,1)
 const id=store.snapshot().servers[0].id
 await c.actions.viewTool(scope,{value:{serverId:id,toolName:'echo'}})
 r=await c.actions.saveTool(scope,{value:{args:{revision:1,serverId:id,toolName:'echo'},values:{form:{enabled:false,requireApproval:true}}}})
 assert.equal(r.toast,'工具设置已保存')
 assert.equal(store.snapshot().servers[0].tools.echo.enabled,false)
 await c.actions.requestDelete(scope,{value:{serverId:id}})
 await c.actions.deleteServer(scope,{value:{serverId:id,revision:2,confirmed:false}})
 assert.equal(store.snapshot().servers.length,1)
 await c.actions.requestDelete(scope,{value:{serverId:id}})
 await c.actions.deleteServer(scope,{value:{serverId:id,revision:2,confirmed:true}})
 assert.equal(store.snapshot().servers.length,0)
})
test('stale form cannot overwrite newer state',async t=>{
 const {store,controller:c}=await fixture(t),scope={sessionId:'test'}
 await store.update(0,s=>s.servers.push(server()))
 await c.actions.editServer(scope,{value:{serverId:'sample'}})
 await store.update(1,s=>s.servers[0].name='Changed')
 const r=await c.actions.saveServer(scope,{value:{values:{form:{...server(),name:'Old'}}}})
 assert.match(r.toast,/配置已更新/)
 assert.equal(store.snapshot().servers[0].name,'Changed')
})
test('all native pages parse within limits and contain no broken components',()=>{
 const s=server(),state={revision:0,servers:[s]},runtimes={sample:{status:'connected',tools:Array.from({length:20},(_,i)=>({name:'tool'+i,description:'Example',inputSchema:{type:'object'}})),resources:[{name:'Manual',uri:'test://manual'}],prompts:[{name:'Review'}]}}
 for(const screen of [{page:'list'},{page:'edit',serverId:'sample'},{page:'edit',draft:server()},{page:'pair',serverId:'sample',kind:'headers',index:-1},{page:'deletePair',serverId:'sample',kind:'headers',index:0},{page:'server',serverId:'sample'},{page:'overview',serverId:'sample'},{page:'records',serverId:'sample'},{page:'catalog',serverId:'sample'},{page:'tool',serverId:'sample',toolName:'tool0'},{page:'schema',serverId:'sample',toolName:'tool0'},{page:'delete',serverId:'sample'}]) {
  const data=render(state,runtimes,screen)
  const check=checkView(buildView(),{budget:'panel',data})
  assert.equal(check.ok,true,JSON.stringify(check))
  assert.equal(check.placeholders,0,JSON.stringify(check))
   assert.equal(check.empty,0,JSON.stringify(check))
  assert.deepEqual(check.issues.filter(x=>!(/对比度至少/.test(x.message)&&x.kind==='note')),[],JSON.stringify(check))
 }
 const empty=checkView(buildView(),{data:render({revision:0,servers:[]},{},{page:'list'})})
 assert.equal(empty.ok,true)
})
