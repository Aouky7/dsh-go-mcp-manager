import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createRuntime} from '../lib/runtime.js'

test('real Streamable HTTP handshake, tool discovery, invocation and credential header',async t=>{
 const requests=[]
 const http=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405);res.end();return}
  let body='';for await(const c of req)body+=c
  const msg=JSON.parse(body);requests.push({method:msg.method,token:req.headers['x-api-key']})
  if(msg.id===undefined){res.writeHead(202);res.end();return}
  let result
  if(msg.method==='initialize')result={protocolVersion:msg.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
  else if(msg.method==='tools/list')result={tools:[{name:'echo',description:'Test echo',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}
  else if(msg.method==='tools/call')result={content:[{type:'text',text:msg.params.arguments.text}]}
  else result={}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result}))
 })
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve))
 t.after(()=>{http.closeAllConnections();return new Promise(resolve=>http.close(resolve))})
 const state={servers:[{id:'fixture',transport:'streamable-http',url:`http://127.0.0.1:${http.address().port}/mcp`,enabled:true,requireApproval:true,headers:[{name:'x-api-key',credentialRef:'FIXTURE_KEY'}],timeoutMs:5000,tools:{}}]}
 const registered=new Map()
 const ctx={get:()=>undefined,on:()=>()=>{},tools:{guard:()=>()=>{},register:(def,options)=>{registered.set(def.name,{def,options});return()=>registered.delete(def.name)}}}
 const runtime=createRuntime(ctx,{getState:()=>state,resolveSecret:async()=>'test-only-key'})
 t.after(()=>runtime.dispose())
 await runtime.reconcile()
 assert.equal(runtime.snapshot().fixture.status,'connected',JSON.stringify(runtime.snapshot()))
 const entry=registered.get('mcp__fixture__echo')
 const result=await entry.def.execute({text:'hello MCP'},{name:entry.def.name,signal:new AbortController().signal})
 assert.equal(result.content[0].text,'hello MCP')
 assert.ok(requests.some(r=>r.method==='tools/call'))
 assert.ok(requests.every(r=>r.token==='test-only-key'))
  const handshakes=requests.filter(r=>r.method==='initialize').length
  const calls=requests.filter(r=>r.method==='tools/call').length
  await runtime.refresh('fixture')
  assert.equal(runtime.snapshot().fixture.lastCheck.ok,true)
  assert.equal(requests.filter(r=>r.method==='initialize').length,handshakes)
  assert.equal(requests.filter(r=>r.method==='tools/call').length,calls)
  assert.ok(requests.filter(r=>r.method==='tools/list').length>=2)
 state.servers[0].enabled=false
 await runtime.reconcile()
 assert.equal(registered.size,0)
})
