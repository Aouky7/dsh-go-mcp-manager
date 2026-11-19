import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {StateStore,normalizeServer} from '../lib/store.js'
import {createController} from '../lib/controller.js'
import {createVault} from '../lib/credentials.js'
import {render,buildView,draftServer} from '../lib/ui.js'
import {createCredentialFetch} from '../lib/runtime.js'
import {checkView} from './helpers/native-check.js'
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'mcp-native-headers-'))
 t.after(async()=>{assert.ok(dir.startsWith(join(tmpdir(),'mcp-native-headers-')));await rm(dir,{recursive:true,force:true})})
 const store=new StateStore(join(dir,'servers.json'));await store.load()
 await store.update(0,s=>s.servers.push(normalizeServer({...draftServer(),id:'sample',name:'Sample',url:'https://example.com/mcp'})))
 const secrets=new Map(),vault=createVault(()=>({set:async(ref,v)=>secrets.set(ref,v),unset:async ref=>secrets.delete(ref)}))
 let changes=0
 const runtime={snapshot:()=>({}),reconcile:()=>{changes++},connect(){}}
 const c=createController(store,runtime,{vault}),scope={sessionId:'test'},value=v=>({value:v})
 return {store,secrets,c,scope,value,get changes(){return changes}}
}
test('direct header input stores secret separately, never projects it, and supplies authenticated request',async t=>{
 const f=await fixture(t),{c,scope,store,secrets,value}=f
 await c.actions.addPair(scope,value({serverId:'sample',kind:'headers'}))
 const result=await c.actions.savePair(scope,value({values:{form:{pairName:'x-api-key',pairValue:'test-secret-only'}}}))
 assert.equal(result.toast,'已保存并更新连接')
 const s=store.snapshot().servers[0],ref=s.headers[0].credentialRef
 assert.equal(secrets.get(ref),'test-secret-only')
 assert.doesNotMatch(await readFile(store.path,'utf8'),/test-secret-only/)
 assert.doesNotMatch(JSON.stringify(result),/test-secret-only/)
 assert.equal(result.patch.form,null)
  assert.equal(c.screens.get(scope.sessionId).page,'credentials')
 assert.equal(f.changes,1)
 let sent
 const fetch=createCredentialFetch({server:s,resolveSecret:async r=>secrets.get(r),assertCurrent(){},fetchImpl:async(_,init)=>{sent=init.headers.get('x-api-key');return new Response('{}')}})
 await fetch(s.url)
 assert.equal(sent,'test-secret-only')
 await c.actions.editPair(scope,value({serverId:'sample',kind:'headers',index:0}))
 assert.equal(c.data(scope).form.pairValue,'')
 assert.doesNotMatch(JSON.stringify(c.data(scope)),/test-secret-only/)
})
test('blank edit preserves old value; replacement removes only manager-owned prior secret',async t=>{
 const {c,scope,store,secrets,value}=await fixture(t)
 await c.actions.addPair(scope,value({serverId:'sample',kind:'headers'}))
 await c.actions.savePair(scope,value({form:{pairName:'x-api-key',pairValue:'old-secret'}}))
 const oldRef=store.snapshot().servers[0].headers[0].credentialRef
 await c.actions.editPair(scope,value({serverId:'sample',kind:'headers',index:0}))
 await c.actions.savePair(scope,value({form:{pairName:'x-api-key',pairValue:''}}))
 assert.equal(store.snapshot().servers[0].headers[0].credentialRef,oldRef)
 assert.equal(secrets.get(oldRef),'old-secret')
 await c.actions.editPair(scope,value({serverId:'sample',kind:'headers',index:0}))
 await c.actions.savePair(scope,value({form:{pairName:'x-api-key',pairValue:'new-secret'}}))
 const ref=store.snapshot().servers[0].headers[0].credentialRef
 assert.notEqual(ref,oldRef);assert.equal(secrets.has(oldRef),false);assert.equal(secrets.get(ref),'new-secret')
})
test('header deletion is confirmed and restores a keyless request',async t=>{
 const {c,scope,store,secrets,value}=await fixture(t)
 await c.actions.addPair(scope,value({serverId:'sample',kind:'headers'}))
 await c.actions.savePair(scope,value({form:{pairName:'x-api-key',pairValue:'test-only'}}))
 await c.actions.requestDeletePair(scope,value({serverId:'sample',kind:'headers',index:0}))
 await c.actions.deletePair(scope,value({serverId:'sample',kind:'headers',index:0,revision:store.snapshot().revision,confirmed:false}))
 assert.equal(store.snapshot().servers[0].headers.length,1)
 await c.actions.requestDeletePair(scope,value({serverId:'sample',kind:'headers',index:0}))
 await c.actions.deletePair(scope,value({serverId:'sample',kind:'headers',index:0,revision:store.snapshot().revision,confirmed:true}))
 assert.equal(store.snapshot().servers[0].headers.length,0);assert.equal(secrets.size,0)
})
test('basic setting edits preserve previous headers, approvals and server identity',async t=>{
 const {c,scope,store,value}=await fixture(t)
 await store.update(1,s=>{s.servers[0].headers=[{name:'x-api-key',credentialRef:'LEGACY_KEY'}];s.servers[0].tools.read={enabled:false,requireApproval:true}})
 await c.actions.editServer(scope,value({serverId:'sample'}))
 await c.actions.saveServer(scope,value({form:{name:'Renamed',transport:'streamable-http',url:'https://other.example/mcp',enabled:true}}))
 const s=store.snapshot().servers[0]
 assert.equal(s.id,'sample');assert.equal(s.name,'Renamed');assert.equal(s.headers[0].credentialRef,'LEGACY_KEY');assert.equal(s.tools.read.enabled,false)
})
test('stale or duplicate header edits cannot mutate credentials',async t=>{
 const {c,scope,store,secrets,value}=await fixture(t)
 await c.actions.addPair(scope,value({serverId:'sample',kind:'headers'}))
 await store.update(1,s=>s.servers[0].name='Changed')
 const r=await c.actions.savePair(scope,value({form:{pairName:'x-api-key',pairValue:'not-saved'}}))
 assert.match(r.toast,/配置已更新/);assert.equal(secrets.size,0)
 await c.actions.addPair(scope,value({serverId:'sample',kind:'headers'}))
 await c.actions.savePair(scope,value({form:{pairName:'x-api-key',pairValue:'first'}}))
 await c.actions.addPair(scope,value({serverId:'sample',kind:'headers'}))
 const duplicate=await c.actions.savePair(scope,value({form:{pairName:'X-API-KEY',pairValue:'second'}}))
 assert.match(duplicate.toast,/重复/);assert.equal(secrets.size,1)
})
test('native pages contain no template, JSON input or legacy credential configuration instructions',()=>{
 const s=normalizeServer({...draftServer(),id:'sample',name:'Sample',url:'https://example.com',headers:[{name:'x-api-key',credentialRef:'EXISTING'}]}),state={revision:1,servers:[s]}
 for(const screen of [{page:'list'},{page:'edit',serverId:'sample'},{page:'pair',serverId:'sample',kind:'headers',index:0},{page:'deletePair',serverId:'sample',kind:'headers',index:0},{page:'server',serverId:'sample'},{page:'overview',serverId:'sample'},{page:'records',serverId:'sample'},{page:'catalog',serverId:'sample'},{page:'tool',serverId:'sample',toolName:'read'},{page:'schema',serverId:'sample',toolName:'read'}]){
  const data=render(state,{},screen),json=JSON.stringify(data)
  assert.doesNotMatch(json,/Exa 模板|在网页版|JSON 数组|credentialRef|EXISTING/)
  const check=checkView(buildView(),{data})
  assert.equal(check.ok,true,JSON.stringify(check));assert.equal(check.placeholders,0,JSON.stringify(check))
  assert.deepEqual(check.issues.filter(x=>!(/对比度至少/.test(x.message)&&x.kind==='note')),[])
 }
})
test('HTTP auth errors are distinguished without leaking peer response bodies',async()=>{
 for(const [status,code]of [[401,'auth-rejected'],[403,'access-denied'],[429,'rate-limited']]){
  let reported
  const fetch=createCredentialFetch({server:{url:'https://example.com/mcp',headers:[]},resolveSecret:async()=>undefined,assertCurrent(){},onFault:c=>{reported=c},fetchImpl:async()=>new Response('secret-from-server',{status})})
  await assert.rejects(fetch('https://example.com/mcp'),e=>e.code===code&&!e.message.includes('secret-from-server'))
  assert.equal(reported,code)
 }
})
