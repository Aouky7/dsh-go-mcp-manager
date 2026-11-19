import test from 'node:test'
import assert from 'node:assert/strict'
import {createController} from '../lib/controller.js'
import {render,buildView,draftServer} from '../lib/ui.js'
import {checkView} from './helpers/native-check.js'

const server={...draftServer(),id:'alpha',name:'Search tools',url:'https://mcp.example.test',enabled:true,requireApproval:true,tools:{}}
const tools=[
 {name:'read_file',description:'Read a file from the workspace',inputSchema:{type:'object',properties:{path:{type:'string'}}}},
 {name:'search_files',description:'Search across workspace files',inputSchema:{type:'object',properties:{query:{type:'string'}}}},
 {name:'write_file',description:'Write a file to the workspace',inputSchema:{type:'object',properties:{path:{type:'string'},text:{type:'string'}}}},
]
const runtimes={alpha:{status:'connected',tools,counts:{tools:3,enabledTools:3,resources:1,prompts:1},stats:{calls:8,failures:1,active:0},history:[{tool:'read_file',at:1000,durationMs:20,ok:true}],resources:[{name:'Manual',uri:'docs://manual'}],prompts:[{name:'Review',description:'Review a file'}],lastCheck:{at:1000,durationMs:20,ok:true}}}
const walk=node=>[node,...(node.children??[]).flatMap(walk)]
const nodes=data=>data.content.flatMap(walk)
const validate=(state,rt,screen)=>{
 const data=render(state,rt,screen),result=checkView(buildView(),{budget:'panel',data})
 assert.equal(result.ok,true,`${screen.page}: ${JSON.stringify(result)}`)
 assert.equal(result.placeholders,0,`${screen.page}: ${JSON.stringify(result)}`)
 assert.equal(result.empty,0,`${screen.page}: ${JSON.stringify(result)}`)
 assert.equal(result.truncated,0,`${screen.page}: ${JSON.stringify(result)}`)
 for(const node of nodes(data))if(['stack','row','form','list'].includes(node.type))assert.ok((node.children??node.items).length,JSON.stringify(node))
 assert.deepEqual(result.issues.filter(issue=>!(issue.kind==='note'&&/对比度至少/.test(issue.message))),[])
 return data
}
const waitUpdate=()=>new Promise(resolve=>setTimeout(resolve,75))
function controllerFixture(){
 const state={revision:2,servers:[structuredClone(server)]}
 const store={snapshot:()=>structuredClone(state),update:async(rev,change)=>{assert.equal(rev,state.revision);await change(state);state.revision++}}
 const requested=[]
 const runtime={project:options=>{requested.push(options);return runtimes},snapshot:()=>runtimes,refresh:async()=>{},connect:async()=>{},reconcile:async()=>{}}
 return {state,store,runtime,requested,c:createController(store,runtime),scope:{sessionId:'session'}}
}

test('all populated screens have no generic no-data blocks or empty layout nodes',()=>{
 const state={revision:4,servers:[server]}
 const screens=[{page:'list'},{page:'transport'},{page:'edit',serverId:'alpha'},{page:'edit',draft:server},{page:'edit',draft:{...server,transport:'stdio',command:'node'}},{page:'policy',serverId:'alpha'},{page:'settings',serverId:'alpha'},{page:'credentials',serverId:'alpha'},
  {page:'pair',serverId:'alpha',kind:'headers',index:-1},{page:'deletePair',serverId:'alpha',kind:'headers',index:0},
  {page:'overview',serverId:'alpha'},{page:'server',serverId:'alpha'},{page:'server',serverId:'alpha',query:'read',filter:'enabled'},
  {page:'records',serverId:'alpha'},{page:'catalog',serverId:'alpha'},{page:'tool',serverId:'alpha',toolName:'read_file'},{page:'schema',serverId:'alpha',toolName:'read_file'},{page:'delete',serverId:'alpha'},{page:'missing',serverId:'unknown'}]
 for(const screen of screens)validate(state,runtimes,screen)
})

test('empty data is explained once per page, never by empty section stacks',()=>{
 const home=validate({revision:0,servers:[]},{},{page:'list'})
 assert.equal(nodes(home).filter(n=>n.type==='emptyState').length,1)
 assert.equal(nodes(home).filter(n=>n.type==='stack').length,0)
 const state={revision:0,servers:[server]}
 for(const page of ['server','records','catalog','credentials']){
  const data=validate(state,{alpha:{status:'connected',tools:[]}},{page,serverId:'alpha'})
  assert.equal(nodes(data).filter(n=>n.type==='emptyState').length,1,page)
 }
})

test('home uses compact server rows without statistics cards, and paginates',()=>{
 const servers=Array.from({length:20},(_,i)=>({...server,id:`server${i}`,name:`Server ${i}`}))
 const state={revision:0,servers},rt=Object.fromEntries(servers.map(s=>[s.id,{status:'connected',counts:{tools:30},tools:[]}]))
 const first=validate(state,rt,{page:'list'}),last=validate(state,rt,{page:'list',pageIndex:2})
 assert.equal(nodes(first).filter(n=>n.type==='metric').length,0)
 assert.equal(nodes(first).filter(n=>n.type==='form').length,0)
 assert.equal(nodes(first).find(n=>n.type==='list').items.length,8)
 assert.match(JSON.stringify(first.content),/下一页/)
 assert.match(JSON.stringify(last.content),/上一页/)
 assert.equal(nodes(last).find(n=>n.type==='list').items.length,4)
})

test('settings is a summary menu; editors contain only the relevant fields',()=>{
 const state={revision:4,servers:[server]},view=validate(state,runtimes,{page:'settings',serverId:'alpha'})
 assert.equal(nodes(view).filter(n=>n.type==='form').length,0)
 assert.equal(nodes(view).filter(n=>n.type==='textField').length,0)
 for(const label of ['名称与地址','请求头','调用策略','重新连接','移除服务器'])assert.match(JSON.stringify(view.content),new RegExp(label))
 const http=validate(state,runtimes,{page:'edit',serverId:'alpha'}),stdio=validate(state,runtimes,{page:'edit',draft:{...server,transport:'stdio',command:'node'}})
 assert.deepEqual(nodes(http).filter(n=>n.type==='textField').map(n=>n.label),['名称','MCP 地址'])
 assert.deepEqual(nodes(stdio).filter(n=>n.type==='textField').map(n=>n.label),['名称','程序','启动参数','工作目录'])
})

test('tool search filters by name/description and enabled state',()=>{
 const state={revision:0,servers:[{...server,tools:{write_file:{enabled:false}}}]}
 const result=validate(state,runtimes,{page:'server',serverId:'alpha',query:'workspace',filter:'enabled'})
 const json=JSON.stringify(result.children)
 assert.match(json,/read_file/);assert.match(json,/search_files/);assert.doesNotMatch(json,/write_file/)
 const noMatch=validate(state,runtimes,{page:'server',serverId:'alpha',query:'absent'})
 assert.match(JSON.stringify(noMatch.content),/没有匹配工具/)
})

test('tool-first navigation retains filters through schema, tabs and tool saves',async()=>{
 const {c,scope}=controllerFixture()
 try{
  let result=await c.actions.viewOverview(scope,{value:{serverId:'alpha'}})
  assert.match(JSON.stringify(result.patch.content),/搜索工具/)
  result=await c.actions.searchTools(scope,{value:{serverId:'alpha',values:{form:{query:'read',filter:'enabled'}}}})
  assert.doesNotMatch(JSON.stringify(result.patch.content),/write_file/)
  await c.actions.viewTool(scope,{value:{serverId:'alpha',toolName:'read_file'}})
  await c.actions.viewSchema(scope,{value:{serverId:'alpha',toolName:'read_file'}})
  await c.actions.viewTool(scope,{value:{serverId:'alpha',toolName:'read_file'}})
  result=await c.actions.saveTool(scope,{value:{form:{enabled:true,requireApproval:true}}})
  assert.equal(result.patch.form.query,'read');assert.equal(result.patch.filters.mode,'enabled')
  result=await c.actions.selectSection(scope,{value:'activity'})
  assert.match(JSON.stringify(result.patch.content),/8 次调用/)
  result=await c.actions.selectSection(scope,{value:{serverId:'alpha',value:'settings'}})
  assert.match(JSON.stringify(result.patch.content),/名称与地址/)
  assert.equal(nodes(result.patch).filter(n=>n.type==='form').length,0)
  result=await c.actions.selectSection(scope,{value:'tools'})
  assert.equal(result.patch.form.query,'read');assert.equal(result.patch.filters.mode,'enabled')
 }finally{c.dispose()}
})

test('transport choice creates no server until final valid submission',async()=>{
 const {c,scope,state}=controllerFixture();state.servers=[]
 try{
  let result=await c.actions.addServer(scope,{})
  assert.equal(state.servers.length,0);assert.equal(nodes(result.patch).filter(n=>n.type==='textField').length,0)
  result=await c.actions.chooseTransport(scope,{value:{transport:'stdio'}})
  assert.equal(state.servers.length,0)
  assert.deepEqual(nodes(result.patch).filter(n=>n.type==='textField').map(n=>n.label),['名称','程序','启动参数','工作目录'])
  result=await c.actions.saveServer(scope,{value:{form:{name:'Local',command:'node',argsLines:'server.mjs'}}})
  assert.equal(result.toast,'已保存基础设置');assert.equal(state.servers.length,1)
  assert.equal(state.servers[0].transport,'stdio');assert.deepEqual(state.servers[0].args,['server.mjs'])
 }finally{c.dispose()}
})

test('policy and connection forms merge into existing config without resetting other fields',async()=>{
 const {c,scope,state}=controllerFixture()
 state.servers[0]={...state.servers[0],timeoutMs:120000,requireApproval:false,headers:[{name:'x-key',credentialRef:'LEGACY'}],tools:{read_file:{enabled:false}}}
 try{
  await c.actions.editServer(scope,{value:{serverId:'alpha'}})
  let result=await c.actions.saveServer(scope,{value:{form:{name:'Renamed',url:'https://other.test/mcp'}}})
  assert.equal(result.toast,'已保存基础设置')
  assert.equal(state.servers[0].timeoutMs,120000);assert.equal(state.servers[0].requireApproval,false)
  assert.equal(state.servers[0].headers[0].credentialRef,'LEGACY');assert.equal(state.servers[0].tools.read_file.enabled,false)
  await c.actions.editPolicy(scope,{value:{serverId:'alpha'}})
  result=await c.actions.saveServer(scope,{value:{form:{timeoutMs:30000,requireApproval:true,url:'https://unrelated.test'}}})
  assert.equal(state.servers[0].url,'https://other.test/mcp');assert.equal(state.servers[0].timeoutMs,30000)
 }finally{c.dispose()}
})

test('batched updates suppress unchanged content and preserve editors/search drafts',async()=>{
 const {c,scope,runtime}=controllerFixture();let source=structuredClone(runtimes),projects=0
 runtime.project=()=>{projects++;return source}
 const emitted=[]
 try{
  await c.actions.viewOverview(scope,{value:{serverId:'alpha'}})
  const stop=c.panel.data(scope,value=>emitted.push(value)),initial=emitted.length
  c.notify();c.notify();c.notify();await waitUpdate();assert.equal(emitted.length,initial)
  const before=emitted.at(-1)
  source.alpha.status='error';source.alpha.error={message:'network down'}
  c.notify();await waitUpdate();assert.equal(emitted.length,initial+1)
  assert.match(JSON.stringify(emitted.at(-1).content),/network down/)
  assert.deepEqual(emitted.at(-1).controls,before.controls);stop()
  for(const action of ['editServer','editPolicy']){
   await c.actions[action](scope,{value:{serverId:'alpha'}})
   const unsubscribe=c.panel.data(scope,value=>emitted.push(value)),edit=emitted.at(-1),n=emitted.length
   source.alpha.status='connected';c.notify();await waitUpdate()
   assert.equal(emitted.length,n);assert.deepEqual(emitted.at(-1).form,edit.form);unsubscribe()
  }
  assert.ok(projects>0)
 }finally{c.dispose()}
})

test('every action rendered in every screen has a registered handler',()=>{
 const {c}=controllerFixture(),state={revision:4,servers:[server]}
 try{for(const screen of [{page:'list'},{page:'transport'},{page:'server',serverId:'alpha'},{page:'settings',serverId:'alpha'},{page:'edit',serverId:'alpha'},{page:'policy',serverId:'alpha'},{page:'credentials',serverId:'alpha'},{page:'records',serverId:'alpha'},{page:'tool',serverId:'alpha',toolName:'read_file'}]){
  const view=render(state,runtimes,screen)
  for(const node of nodes(view)){
   const candidates=[node.onChange,node.submit,...(node.items??[]).map(item=>item.action)]
   if(node.type==='emptyState'&&node.action)candidates.push(node.action.action)
   for(const item of candidates.filter(Boolean)){const id=typeof item==='string'?item:item.id;assert.equal(typeof c.actions[id],'function',`${screen.page}: ${id}`)}
  }
 }}finally{c.dispose()}
})
