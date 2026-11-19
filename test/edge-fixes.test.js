import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createController} from '../lib/controller.js'
import {render,draftServer,buildView} from '../lib/ui.js'
import {createRuntime} from '../lib/runtime.js'
import {checkView} from './helpers/native-check.js'

function controllerFixture(){
 const state={version:1,revision:2,servers:[{...draftServer(),id:'sample',name:'Saved',url:'https://example.test/mcp',timeoutMs:120000,headers:[{name:'x-api-key',credentialRef:'EXISTING'}],tools:{read:{enabled:false}}}]}
 const store={snapshot:()=>structuredClone(state),update:async(rev,mutate)=>{if(rev!==state.revision)throw Error('配置已更新');await mutate(state);state.revision++}}
 const runtime={snapshot:()=>({sample:{status:'connected',tools:[{name:'read',description:'Read a file',inputSchema:{type:'object'}}]}}),reconcile:async()=>{},refresh:async()=>{},connect:async()=>{}}
 return {state,store,c:createController(store,runtime),scope:{sessionId:'review'}}
}
const nodes=node=>[node,...(node.children??[]).flatMap(nodes)]

test('transport selection and cancelling retain unsaved fields without writing configuration',async()=>{
 const {c,scope,state}=controllerFixture(),before=structuredClone(state)
 try{
  await c.actions.editServer(scope,{value:{serverId:'sample'}})
  await c.actions.editDraft(scope,{value:{args:{field:'name'},value:'Unsaved name'}})
  await c.actions.editDraft(scope,{value:{args:{field:'url'},value:'https://draft.test/mcp'}})
  await c.actions.changeTransport(scope,{value:{serverId:'sample'}})
  let result=await c.actions.chooseTransport(scope,{value:{transport:'stdio'}})
  assert.equal(result.patch.form.name,'Unsaved name')
  await c.actions.editDraft(scope,{value:{args:{field:'command'},value:'node'}})
  await c.actions.editDraft(scope,{value:{args:{field:'argsLines'},value:'server.mjs\n--quiet'}})
  await c.actions.changeTransport(scope,{value:{serverId:'sample'}})
  result=await c.actions.resumeConnection(scope,{})
  assert.equal(result.patch.form.command,'node');assert.equal(result.patch.form.argsLines,'server.mjs\n--quiet')
  await c.actions.changeTransport(scope,{value:{serverId:'sample'}})
  result=await c.actions.chooseTransport(scope,{value:{transport:'sse'}})
  assert.equal(result.patch.form.url,'https://draft.test/mcp');assert.equal(result.patch.form.name,'Unsaved name')
  assert.deepEqual(state,before)
  result=await c.actions.saveServer(scope,{value:{serverId:'sample',form:{name:'Unsaved name',url:'https://draft.test/mcp'}}})
  assert.equal(result.toast,'已保存基础设置')
  assert.equal(state.servers[0].transport,'sse');assert.equal(state.servers[0].name,'Unsaved name')
  assert.equal(state.servers[0].timeoutMs,120000);assert.equal(state.servers[0].headers[0].credentialRef,'EXISTING')
  assert.equal(state.servers[0].tools.read.enabled,false)
 }finally{c.dispose()}
})

test('new-server wizard accepts full native form payload and retains drafts on transport return',async()=>{
 const {c,scope,state}=controllerFixture();state.servers=[]
 try{
  await c.actions.addServer(scope,{})
  await c.actions.chooseTransport(scope,{value:{transport:'streamable-http'}})
  await c.actions.changeTransport(scope,{value:{values:{form:{name:'New server',url:'https://new.test/mcp'}}}})
  const result=await c.actions.resumeConnection(scope,{})
  assert.equal(result.patch.form.name,'New server');assert.equal(result.patch.form.url,'https://new.test/mcp')
  assert.equal(state.servers.length,0)
  await c.actions.saveServer(scope,{value:{form:{name:'New server',url:'https://new.test/mcp'}}})
  assert.equal(state.servers.length,1)
 }finally{c.dispose()}
})

test('native change handlers update draft state without redrawing the input',async()=>{
 const {c,scope}=controllerFixture()
 try{
  const result=await c.actions.editServer(scope,{value:{serverId:'sample'}})
  const fields=result.patch.content.flatMap(nodes).filter(n=>n.type==='textField')
  assert.ok(fields.every(n=>n.onChange?.id==='editDraft'))
  assert.deepEqual(await c.actions.editDraft(scope,{value:{args:{field:'name'},value:'Typed'}}),{})
  await c.actions.viewServer(scope,{value:{serverId:'sample'}})
  assert.deepEqual(await c.actions.searchDraft(scope,{value:{value:'read'}}),{})
  const filtered=await c.actions.filterTools(scope,{value:{serverId:'sample',value:'disabled'}})
  assert.equal(filtered.patch.form.query,'read');assert.equal(filtered.patch.filters.mode,'disabled')
  assert.match(JSON.stringify(filtered.patch.content),/read/)
 }finally{c.dispose()}
})

test('filter switching preserves an unsubmitted query including clearing it',async()=>{
 const {c,scope}=controllerFixture()
 try{
  await c.actions.viewServer(scope,{value:{serverId:'sample'}})
  let result=await c.actions.filterTools(scope,{value:{value:'enabled',form:{query:'unsubmitted'}}})
  assert.equal(result.patch.form.query,'unsubmitted')
  await c.actions.searchDraft(scope,{value:{value:''}})
  result=await c.actions.filterTools(scope,{value:{value:'all'}})
  assert.equal(result.patch.form.query,'')
 }finally{c.dispose()}
})

test('removed-server fallback has a working return action',async()=>{
 const {c,scope,state}=controllerFixture()
 try{
  await c.actions.viewServer(scope,{value:{serverId:'sample'}})
  state.servers=[];state.revision++
  const data=c.data(scope),checks=checkView(buildView(),{data})
  assert.equal(checks.empty,0);assert.equal(checks.placeholders,0)
  const targets=data.content.flatMap(nodes).flatMap(node=>(node.items??[]).map(item=>item.action?.id).filter(Boolean))
  assert.deepEqual(targets,['back'])
  const result=await c.actions[targets[0]](scope,{})
  assert.equal(c.screens.get(scope.sessionId).page,'list')
  assert.match(JSON.stringify(result.patch.content),/连接你的第一个/)
 }finally{c.dispose()}
})

test('parallel tool HTTP errors retain per-call categories without exposing response bodies',async t=>{
 const http=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405);res.end();return}
  let body='';for await(const chunk of req)body+=chunk
  const message=JSON.parse(body)
  if(message.id===undefined){res.writeHead(202);res.end();return}
  if(message.method==='tools/call'){
   const status=message.params.arguments.status
   if(status!==200){res.writeHead(status,{'content-type':'text/plain'});res.end('private-upstream-body');return}
  }
  let result={}
  if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
  if(message.method==='tools/list')result={tools:[{name:'request',description:'Request',inputSchema:{type:'object',properties:{status:{type:'number'}},required:['status']}}]}
  if(message.method==='tools/call')result={content:[{type:'text',text:'success'}]}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))
 })
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve))
 t.after(()=>{http.closeAllConnections();return new Promise(resolve=>http.close(resolve))})
 const state={servers:[{...draftServer(),id:'fixture',url:`http://127.0.0.1:${http.address().port}/mcp`,timeoutMs:2000}]}
 const registered=new Map(),ctx={get:()=>undefined,on:()=>()=>{},tools:{guard:()=>()=>{},register:def=>{registered.set(def.name,def);return()=>registered.delete(def.name)}}}
 const runtime=createRuntime(ctx,{getState:()=>state,resolveSecret:async()=>undefined})
 t.after(()=>runtime.dispose())
 await runtime.reconcile();assert.equal(runtime.snapshot().fixture.status,'connected')
 const definition=registered.get('mcp__fixture__request')
 const result=await Promise.allSettled([401,403,429,200].map(status=>definition.execute({status},{signal:new AbortController().signal,name:definition.name})))
 assert.deepEqual(result.slice(0,3).map(r=>r.reason.code),['auth-rejected','access-denied','rate-limited'])
 assert.equal(result[3].status,'fulfilled')
 assert.doesNotMatch(JSON.stringify(runtime.snapshot()),/private-upstream-body/)
 assert.equal(runtime.snapshot().fixture.stats.failures,3)
 assert.equal(runtime.snapshot().fixture.status,'connected')
})

test('SDK request timeout has a fixed public category',async t=>{
 const definitions=new Map(),ctx={get:()=>undefined,on:()=>()=>{},tools:{guard:()=>()=>{},register:def=>{definitions.set(def.name,def);return()=>definitions.delete(def.name)}}}
 const runtime=createRuntime(ctx,{getState:()=>({servers:[{...draftServer(),id:'timeout',url:'https://example.test/mcp'}]}),resolveSecret:async()=>undefined,createClient:()=>({
  async connect(transport){this.transport=transport},async close(){this.onclose?.()},getServerCapabilities:()=>({tools:{}}),
  async listTools(){return {tools:[{name:'request',inputSchema:{type:'object'}}]}},
  async callTool(){throw Object.assign(new Error('private-peer-timeout'),{code:'REQUEST_TIMEOUT'})}
 })})
 t.after(()=>runtime.dispose());await runtime.reconcile()
 const definition=definitions.get('mcp__timeout__request')
 await assert.rejects(definition.execute({},{signal:new AbortController().signal}),error=>error.code==='timeout'&&!error.message.includes('private'))
 assert.equal(runtime.snapshot().timeout.history[0].code,'timeout')
})
