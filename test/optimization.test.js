import test from 'node:test'
import assert from 'node:assert/strict'
import {createRuntime} from '../lib/runtime.js'
import {createController} from '../lib/controller.js'
import {render,buildView,draftServer} from '../lib/ui.js'
import {checkView} from './helpers/native-check.js'

const tool=(name='echo',description='Echo')=>({name,description,inputSchema:{type:'object',properties:{}}})
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
function fixture(t,behavior={}){
 const state={version:1,revision:0,servers:[{...draftServer(),id:'sample',name:'Sample',url:'https://example.test/mcp',timeoutMs:1000}]}
 const registered=new Map(),clients=[]
 const ctx={get:()=>undefined,on:()=>()=>{},tools:{guard:()=>()=>{},register:(definition,options)=>{
  if(registered.has(definition.name))throw Error('duplicate')
  behavior.register?.(definition)
  registered.set(definition.name,{definition,options});return()=>registered.delete(definition.name)
 }}}
 const runtime=createRuntime(ctx,{getState:()=>state,resolveSecret:async()=> 'test-secret-credential',createClient:()=>{
  const client={getServerCapabilities:()=>({tools:{},resources:{}}),getServerVersion:()=>({name:'fixture',version:'1.0'}),
   async connect(transport){this.transport=transport;await behavior.connect?.()},async close(){this.onclose?.()},
   async listTools(){return behavior.listTools?behavior.listTools():{tools:[tool()]}},
   async listResources(){return behavior.listResources?behavior.listResources():{resources:[]}},
   async callTool(params,options){return behavior.callTool?behavior.callTool(params,options):{content:[{type:'text',text:'response body not logged'}]}}
  };clients.push(client);return client
 }})
 t.after(()=>runtime.dispose())
 return {runtime,state,registered,clients}
}
const exec=()=>({name:'mcp__sample__echo',signal:new AbortController().signal})

test('in-place refresh coalesces clicks and leaves running tool calls intact',async t=>{
 const entered=deferred(),finish=deferred(),listing=deferred();let slowList=false
 const f=fixture(t,{listTools:async()=>{if(slowList)await listing.promise;return {tools:[tool()]}},callTool:async()=>{entered.resolve();await finish.promise;return {content:[{type:'text',text:'done'}]}}})
 await f.runtime.reconcile()
 const definition=f.registered.get('mcp__sample__echo').definition
 const call=definition.execute({},exec());await entered.promise
 slowList=true
 const first=f.runtime.refresh('sample'),second=f.runtime.refresh('sample')
 assert.equal(f.runtime.snapshot().sample.refreshing,true)
 listing.resolve();await Promise.all([first,second])
 assert.equal(f.clients.length,1)
 assert.equal(f.registered.get('mcp__sample__echo').definition,definition)
 assert.equal(f.runtime.snapshot().sample.stats.active,1)
 finish.resolve();assert.equal((await call).content[0].text,'done')
 assert.equal(f.runtime.snapshot().sample.stats.active,0)
 assert.equal(f.runtime.snapshot().sample.lastCheck.ok,true)
})

test('failed tool registration preserves working catalog and callable definitions',async t=>{
 let extra=false
 const f=fixture(t,{listTools:async()=>({tools:extra?[tool(),tool('new')]:[tool()]}),register:definition=>{if(definition.name.endsWith('__new'))throw Error('conflict')}})
 await f.runtime.reconcile();const original=f.registered.get('mcp__sample__echo').definition
 extra=true;await f.runtime.refresh('sample')
 assert.equal(f.runtime.snapshot().sample.error.code,'registration-failed')
 assert.equal(f.runtime.snapshot().sample.tools.length,1)
 assert.equal(f.registered.get('mcp__sample__echo').definition,original)
 assert.equal((await original.execute({},exec())).content[0].type,'text')
})

test('a changed definition rolls back if replacement registration fails',async t=>{
 let changed=false,failOnce=true
 const f=fixture(t,{listTools:async()=>({tools:[tool('echo',changed?'Changed':'Original')]}),register:definition=>{if(definition.description==='Changed'&&failOnce){failOnce=false;throw Error('failure')}}})
 await f.runtime.reconcile();const original=f.registered.get('mcp__sample__echo').definition
 changed=true;await f.runtime.refresh('sample')
 assert.equal(f.runtime.snapshot().sample.error.code,'registration-failed')
 assert.equal(f.registered.get('mcp__sample__echo').definition,original)
 assert.equal(f.runtime.snapshot().sample.tools[0].description,'Original')
})

test('editing a failed connection resets exhausted retries without manual toggle',async t=>{
 let failing=true
 const f=fixture(t,{connect:async()=>{if(failing)throw Error('offline')}})
 await f.runtime.reconcile()
 const slot=f.runtime.slots.get('sample');f.runtime.clearTimer(slot);slot.retries=10;f.runtime.retry(slot)
 assert.equal(slot.exhausted,true)
 failing=false;f.state.servers[0].url='https://corrected.example/mcp';await f.runtime.reconcile()
 assert.equal(f.runtime.snapshot().sample.status,'connected')
 assert.equal(slot.retries,0)
})

test('missing credentials do not retry on unrelated config updates',async t=>{
 const f=fixture(t)
 f.state.servers[0].headers=[{name:'x-key',credentialRef:'TOKEN'}]
 f.runtime.options.resolveSecret=async()=>undefined
 await f.runtime.reconcile();assert.equal(f.runtime.snapshot().sample.error.code,'credential-missing')
 await f.runtime.reconcile();assert.equal(f.clients.length,1)
 f.state.servers[0].headers=[];await f.runtime.reconcile()
 assert.equal(f.runtime.snapshot().sample.status,'connected')
})

test('notification during metadata refresh schedules another catalog read',async t=>{
 const blocked=deferred(),entered=deferred();let names=['echo'],pause=false,reads=0
 const f=fixture(t,{listTools:async()=>{reads++;return {tools:names.map(n=>tool(n))}},listResources:async()=>{if(pause){pause=false;entered.resolve();await blocked.promise}return {resources:[]}}})
 await f.runtime.reconcile();const generation=f.runtime.slots.get('sample').generation
 pause=true;const refresh=f.runtime.refreshGeneration(generation)
 await entered.promise;names=['updated'];f.runtime.refreshGeneration(generation,true);blocked.resolve();await refresh
 assert.equal(reads,3)
 assert.equal(f.runtime.snapshot().sample.tools[0].name,'updated')
 assert.equal(f.clients.length,1)
})

test('recent calls are bounded, classified and omit parameters and bodies',async t=>{
 let failing=false
 const f=fixture(t,{callTool:async()=>{if(failing)throw Error('secret-upstream-body');return {content:[{type:'text',text:'secret-result-body'}]}}})
 await f.runtime.reconcile();const definition=f.registered.get('mcp__sample__echo').definition
 for(let i=0;i<22;i++)await definition.execute({query:'secret-query'},exec())
 failing=true;await assert.rejects(definition.execute({query:'secret-query'},exec()),/调用失败/)
 const view=f.runtime.snapshot().sample
 assert.equal(view.stats.calls,23);assert.equal(view.stats.failures,1);assert.equal(view.history.length,20)
 assert.equal(view.history[0].code,'tool-failed')
 assert.doesNotMatch(JSON.stringify(view),/secret-query|secret-result-body|secret-upstream-body/)
 const check=checkView(buildView(),{data:render(f.state,f.runtime.snapshot(),{page:'server',serverId:'sample'})})
 assert.equal(check.ok,true);assert.equal(check.placeholders,0,JSON.stringify(check))
})

test('reflected credential in tool schemas never reaches registered model tools',async t=>{
 const f=fixture(t,{listTools:async()=>({tools:[{...tool(),inputSchema:{type:'object',description:'test-secret-credential'}}]})})
 f.state.servers[0].headers=[{name:'x-key',credentialRef:'TOKEN'}]
 await f.runtime.reconcile()
 assert.equal(f.registered.size,0)
 assert.equal(f.runtime.snapshot().sample.error.code,'schema-secret')
 assert.doesNotMatch(JSON.stringify(f.runtime.snapshot()),/test-secret-credential/)
 assert.doesNotMatch(f.runtime.safe('x'.repeat(15999)+'test-secret-credential'),/test-secret/)
})

test('connection status pushes preserve edit forms and their revision',async()=>{
 const state={version:1,revision:1,servers:[{...draftServer(),id:'sample',name:'Saved',url:'https://example.test/mcp'}]}
 let status='connecting',checks=0,reconciles=0
 const runtime={snapshot:()=>({sample:{status,tools:[],resources:[],prompts:[]}}),refresh:async()=>{checks++;status='connected'},connect:async()=>{},reconcile:async()=>{reconciles++}}
 const store={snapshot:()=>structuredClone(state)}
 const c=createController(store,runtime),scope={sessionId:'test'},emitted=[]
 try{
  await c.actions.editServer(scope,{value:{serverId:'sample'}})
  const stop=c.panel.data(scope,data=>emitted.push(data));const before=emitted.at(-1)
  await c.actions.testConnection(scope,{value:{serverId:'sample'}})
  await new Promise(resolve=>setTimeout(resolve,70))
  state.revision=2;state.servers[0].name='Changed elsewhere';c.notify()
  const after=emitted.at(-1)
  assert.equal(checks,1);assert.deepEqual(after.content,before.content)
  assert.deepEqual(after.form,before.form);assert.deepEqual(after.children,before.children)
  await c.actions.refresh(scope,{value:{}});assert.equal(reconciles,1)
  stop()
 }finally{c.dispose()}
})
