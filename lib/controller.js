import {randomUUID} from 'node:crypto'
import {normalizeServer,formPayload,record,bool,integer,pairs} from './store.js'
import {render,connectionView,composeView,draftServer,buildView} from './ui.js'
import {referenced} from './credentials.js'

export function createController(store,runtime,options={}){
 const screens=new Map(),listeners=new Map(),projections=new Map(),toolPositions=new Map(),listPositions=new Map(),vault=options.vault
 let notifyTimer=null,disposed=false
 const key=scope=>scope.sessionId??'settings'
 const screenOf=scope=>screens.get(key(scope))??{page:'list'}
 const toolKey=(scope,id)=>`${key(scope)}:${id}`
 const find=id=>{const s=store.snapshot().servers.find(x=>x.id===id);if(!s)throw Error('服务器不存在，请返回列表');return s}
 const projectOptions=screen=>{
  if(!screen.serverId)return {detail:'summary'}
  if(['tool','schema'].includes(screen.page))return {serverId:screen.serverId,detail:'tool',toolName:screen.toolName}
  if(screen.page==='catalog')return {serverId:screen.serverId,detail:'catalog'}
  if(screen.page==='records')return {serverId:screen.serverId,detail:'overview'}
  if(['server','overview'].includes(screen.page))return {serverId:screen.serverId,detail:'tools'}
  return {serverId:screen.serverId,detail:'summary'}
 }
 const runtimeView=screen=>runtime.project?runtime.project(projectOptions(screen)):runtime.snapshot()
 const data=scope=>{const view=render(store.snapshot(),runtimeView(screenOf(scope)),screenOf(scope));projections.set(key(scope),view);return view}
 const args=event=>{const raw=event?.value??{},v=record(raw)?raw:{value:raw};return {...(record(v.args)?v.args:{}),...v}}
 const revision=(v,scope)=>{const n=v.revision??screenOf(scope).revision;if(!Number.isSafeInteger(n)||n!==store.snapshot().revision)throw Error('配置已更新，请重新打开后重试');return n}
 // Keep composition helpers local; the native client only binds these fields.
 const wire=view=>({content:view.content,navigation:view.navigation,form:view.form?{...view.form,pairValue:''}:null,filters:view.filters??null})
 const updateView=view=>{const patch=wire(view);return Buffer.byteLength(JSON.stringify(patch))<=16384?{patch}:{refresh:true}}
 const navigate=(scope,next)=>{
  const prior=screenOf(scope)
  if(prior.page==='server')toolPositions.set(toolKey(scope,prior.serverId),{query:prior.query??'',draftQuery:prior.draftQuery??prior.query??'',filter:prior.filter??'all',pageIndex:prior.pageIndex??0})
  if(prior.page==='list')listPositions.set(key(scope),prior.pageIndex??0)
  screens.set(key(scope),next)
  const view=data(scope)
  return updateView(view)
 }
 const openTools=(scope,id)=>navigate(scope,{page:'server',serverId:find(id).id,...(toolPositions.get(toolKey(scope,id))??{}),revision:store.snapshot().revision})
 const settings=(scope,id)=>navigate(scope,{page:'settings',serverId:find(id).id,revision:store.snapshot().revision})
 const credentials=(scope,id)=>navigate(scope,{page:'credentials',serverId:find(id).id,revision:store.snapshot().revision})
 const basic=(scope,id)=>navigate(scope,{page:'edit',serverId:find(id).id,revision:store.snapshot().revision})
 const notify=()=>{if(disposed||notifyTimer||!listeners.size)return;notifyTimer=setTimeout(flush,48);notifyTimer.unref?.()}
 const flush=()=>{
  if(notifyTimer)clearTimeout(notifyTimer);notifyTimer=null
  if(disposed)return
  const state=store.snapshot()
  for(const [k,subscribers]of listeners){
   const screen=screens.get(k)??{page:'list'},previous=projections.get(k)
   // Editors keep both their content and revision until the user saves or leaves.
   if(['edit','policy','pair','tool','schema','transport','delete','deletePair'].includes(screen.page))continue
   screen.revision=state.revision
   screens.set(k,screen)
   let view=render(state,runtimeView(screen),screen)
   if(['server','overview'].includes(screen.page)&&previous)view=composeView({...view,controls:previous.controls,form:previous.form,filters:previous.filters})
   if(JSON.stringify(view)===JSON.stringify(previous))continue
   projections.set(k,view)
   for(const emit of subscribers)emit(wire(view))
  }
 }
 const reconcile=()=>{Promise.resolve(runtime.reconcile()).then(notify,notify);notify()}
 const dropUnused=async refs=>{for(const ref of new Set(refs.filter(Boolean)))if(!referenced(store.snapshot(),ref))await vault?.drop(ref)}
 const guarded=fn=>async(scope,event={})=>{try{return await fn(scope,event)}catch(error){return {toast:error instanceof SyntaxError?'填写格式不正确，请检查':String(error.message).length<=40?error.message:'操作未完成，请重新打开后重试'}}}
 const checkServer=(scope,id,force=false)=>{
  const s=find(id);if(!s.enabled)return {toast:'请先启用此服务器'}
  Promise.resolve(force?runtime.connect(id):runtime.refresh(id)).then(notify,notify)
  const screen=screenOf(scope),before=projections.get(key(scope))
  if(before&&['settings','server','overview'].includes(screen.page)){
   const view=composeView({...before,connection:connectionView(s,runtimeView(screen)[id])})
   projections.set(key(scope),view)
   return {toast:force?'正在重新连接':'正在测试连接并刷新工具',...updateView(view)}
  }
  return {toast:'正在重新连接'}
 }
 const connectionFields=['name','url','command','cwd','argsLines']
 const connectionDraft=(screen,input={})=>{
  const saved=screen.serverId?find(screen.serverId):draftServer(),base={...saved,...screen.draft}
  const draft={name:base.name,transport:base.transport,url:base.url,command:base.command,cwd:base.cwd,argsLines:base.argsLines??(base.args??[]).join('\n')}
  for(const field of connectionFields)if(typeof input[field]==='string')draft[field]=input[field]
  return draft
 }
 const actions={
  editDraft:(scope,event)=>{
   const screen=screenOf(scope),v=args(event)
   if(screen.page!=='edit'||!connectionFields.includes(v.field))throw Error('请重新打开连接编辑页')
   const value=v.value??formPayload(v)[v.field]
   if(typeof value!=='string'||value.length>2000)throw Error('字段格式或长度不正确')
   screens.set(key(scope),{...screen,draft:connectionDraft(screen,{[v.field]:value})})
   return {}
  },
  searchDraft:(scope,event)=>{
   const screen=screenOf(scope),v=args(event),query=v.value??formPayload(v).query
   if(screen.page!=='server'||typeof query!=='string'||query.length>120)return {}
   screens.set(key(scope),{...screen,draftQuery:query})
   return {}
  },
  resumeConnection:scope=>{const screen=screenOf(scope);if(screen.page!=='transport'||!screen.returnToEditor)throw Error('请重新打开连接编辑页');return navigate(scope,{...screen,page:'edit'})},
  back:scope=>navigate(scope,{page:'list',pageIndex:listPositions.get(key(scope))??0}),
  refresh:()=>{reconcile();return {toast:'正在刷新连接状态'}},
  addServer:scope=>navigate(scope,{page:'transport',draft:draftServer(),revision:store.snapshot().revision}),
  changeTransport:(scope,event)=>{const current=screenOf(scope),v=args(event);if(current.page!=='edit')throw Error('请先打开连接设置');if(v.serverId&&v.serverId!==current.serverId)throw Error('编辑目标已变化');return navigate(scope,{...current,page:'transport',returnToEditor:true,draft:connectionDraft(current,formPayload(v))})},
  chooseTransport:(scope,event)=>{const current=screenOf(scope),transport=args(event).transport;if(current.page!=='transport'||!['streamable-http','sse','stdio'].includes(transport))throw Error('请先选择连接方式');return navigate(scope,{...current,page:'edit',draft:{...connectionDraft(current),transport}})},
  editServer:(scope,event)=>basic(scope,args(event).serverId),
  editPolicy:(scope,event)=>navigate(scope,{page:'policy',serverId:find(args(event).serverId).id,revision:store.snapshot().revision}),
  viewSettings:(scope,event)=>settings(scope,args(event).serverId),
  viewCredentials:(scope,event)=>credentials(scope,args(event).serverId),
  viewOverview:(scope,event)=>openTools(scope,args(event).serverId),
  viewServer:(scope,event)=>openTools(scope,args(event).serverId),
  viewRecords:(scope,event)=>navigate(scope,{...screenOf(scope),page:'records',serverId:find(args(event).serverId).id,pageIndex:0}),
  pageRecords:(scope,event)=>{const v=args(event);return navigate(scope,{...screenOf(scope),page:'records',serverId:find(v.serverId).id,pageIndex:integer(v.pageIndex,0,1000,0)})},
  viewCatalog:(scope,event)=>navigate(scope,{page:'catalog',serverId:find(args(event).serverId).id}),
  pageServers:(scope,event)=>navigate(scope,{page:'list',pageIndex:integer(args(event).pageIndex,0,1000,0)}),
  selectSection:(scope,event)=>{
   const current=screenOf(scope),v=args(event),s=find(current.serverId)
   if(v.serverId&&v.serverId!==s.id)throw Error('页面已变化，请重新打开')
   const section=v.value??v.section??formPayload(v).section
   if(section==='settings')return settings(scope,s.id)
   if(section==='tools'||section==='overview')return openTools(scope,s.id)
   if(section==='activity')return navigate(scope,{page:'records',serverId:s.id,pageIndex:0})
   throw Error('请选择工具、活动或设置')
  },
  searchTools:(scope,event)=>{
   const screen=screenOf(scope),v=args(event),input=formPayload(v)
   if(!['server','overview'].includes(screen.page)||v.serverId&&v.serverId!==screen.serverId)throw Error('请重新打开工具列表')
   const query=typeof input.query==='string'?input.query.trim().slice(0,120):''
   const filter=['all','enabled','disabled'].includes(input.filter)?input.filter:screen.filter??'all'
   return navigate(scope,{...screen,page:'server',query,draftQuery:query,filter,pageIndex:0})
  },
  filterTools:(scope,event)=>{
   const screen=screenOf(scope),v=args(event),filter=v.value??v.filter
   if(screen.page!=='server'||v.serverId&&v.serverId!==screen.serverId||!['all','enabled','disabled'].includes(filter))throw Error('请选择工具筛选范围')
   const input=formPayload(v),draftQuery=typeof input.query==='string'?input.query:screen.draftQuery??screen.query??''
    return navigate(scope,{...screen,query:draftQuery.trim().slice(0,120),draftQuery,pageIndex:0,filter})
  },
  clearSearch:(scope,event)=>navigate(scope,{page:'server',serverId:find(args(event).serverId).id,query:'',filter:'all',pageIndex:0}),
  viewTool:(scope,event)=>{const v=args(event);find(v.serverId);return navigate(scope,{page:'tool',serverId:v.serverId,toolName:v.toolName,revision:store.snapshot().revision})},
  viewSchema:(scope,event)=>{const v=args(event);find(v.serverId);return navigate(scope,{page:'schema',serverId:v.serverId,toolName:v.toolName})},
  pageTools:(scope,event)=>{const v=args(event);find(v.serverId);return navigate(scope,{...screenOf(scope),page:'server',serverId:v.serverId,pageIndex:integer(v.pageIndex,0,1000,0)})},
  requestDelete:(scope,event)=>navigate(scope,{page:'delete',serverId:find(args(event).serverId).id,revision:store.snapshot().revision}),
  deleteServer:async(scope,event)=>{
   const screen=screenOf(scope),v=args(event)
   if(screen.page!=='delete')throw Error('请先选择要移除的服务器')
   if(v.serverId!==screen.serverId||v.revision!==screen.revision)throw Error('确认目标已变化，请重新确认')
   if(v.confirmed!==true)return settings(scope,screen.serverId)
   const old=find(screen.serverId)
   await store.update(revision(v,scope),next=>{next.servers=next.servers.filter(s=>s.id!==old.id)})
   reconcile();await dropUnused([...old.headers,...old.env].map(x=>x.credentialRef))
   return {...navigate(scope,{page:'list'}),toast:'服务器已移除'}
  },
  saveServer:async(scope,event)=>{
   const screen=screenOf(scope),v=args(event)
   if(!['edit','policy'].includes(screen.page))throw Error('请先打开连接或策略编辑页')
   if(Buffer.byteLength(JSON.stringify(event.value??{}))>4096)throw Error('表单太长，请缩短地址或参数')
   const input=formPayload(v),rev=revision(v,scope)
   if(v.serverId!==undefined&&v.serverId!==(screen.serverId??''))throw Error('编辑目标已变化，请重新打开')
   const old=screen.serverId?find(screen.serverId):undefined
   const allowed=screen.page==='policy'?['timeoutMs','requireApproval']:['name','transport','url','command','cwd','argsLines']
   const fields=Object.fromEntries(Object.entries(input).filter(([k])=>allowed.includes(k)))
   const id=old?.id||'mcp_'+randomUUID().replaceAll('-','').slice(0,16)
   const draft=screen.page==='edit'?connectionDraft(screen):{}
   const merged={...(old??draftServer()),...draft,...fields,id,headers:old?.headers??[],env:old?.env??[]}
   merged.args=typeof merged.argsLines==='string'?merged.argsLines.split('\n').filter(x=>x.length):old?.args??[]
   delete merged.argsLines
   const server=normalizeServer(merged,old)
   await store.update(rev,next=>{if(old)next.servers[next.servers.findIndex(s=>s.id===id)]=server;else{if(next.servers.length>=32)throw Error('最多可添加 32 个服务器');next.servers.push(server)}})
   reconcile();return {...settings(scope,id),toast:'已保存基础设置'}
  },
  toggleServer:async(scope,event)=>{const v=args(event),s=find(v.serverId);await store.update(revision(v,scope),next=>{const server=next.servers.find(x=>x.id===s.id);server.enabled=!server.enabled});reconcile();return settings(scope,s.id)},
  saveTool:async(scope,event)=>{
   const v=args(event),screen=screenOf(scope),input=formPayload(v)
   if(screen.page!=='tool'||v.serverId&&v.serverId!==screen.serverId||v.toolName&&v.toolName!==screen.toolName)throw Error('工具目标已变化，请重新打开')
   const s=find(screen.serverId)
   if(!runtimeView(screen)[s.id]?.tools?.some(t=>t.name===screen.toolName))throw Error('工具列表已更新，请刷新')
   await store.update(revision(v,scope),next=>{next.servers.find(x=>x.id===s.id).tools[screen.toolName]={enabled:bool(input.enabled,true),requireApproval:bool(input.requireApproval,true)}})
   reconcile();return {...openTools(scope,s.id),toast:'工具设置已保存'}
  },
  connect:(scope,event)=>checkServer(scope,args(event).serverId,true),
  testConnection:(scope,event)=>checkServer(scope,args(event).serverId),
  addPair:(scope,event)=>{const v=args(event),s=find(v.serverId),kind=v.kind==='env'?'env':'headers';if(s[kind].length>=16)throw Error('最多可添加 16 项');return navigate(scope,{page:'pair',serverId:s.id,kind,index:-1,revision:store.snapshot().revision})},
  editPair:(scope,event)=>{const v=args(event),s=find(v.serverId),kind=v.kind==='env'?'env':'headers',index=integer(v.index,0,15,0);if(!s[kind][index])throw Error('配置项已删除，请重新打开');return navigate(scope,{page:'pair',serverId:s.id,kind,index,revision:store.snapshot().revision})},
  savePair:async(scope,event)=>{
   const screen=screenOf(scope),v=args(event),input=formPayload(v)
   if(screen.page!=='pair')throw Error('请重新打开请求头编辑页')
   const rev=revision(v,scope),s=find(screen.serverId),kind=screen.kind,index=screen.index
   if(v.serverId!==undefined&&v.serverId!==s.id||v.kind!==undefined&&v.kind!==kind||v.index!==undefined&&v.index!==index)throw Error('编辑目标已变化，请重新打开')
   const old=s[kind][index],name=typeof input.pairName==='string'?input.pairName.trim():''
   const value=input.pairValue??''
   if(typeof value!=='string'||value.length>2000||/[\r\n\0]/.test(value))throw Error('值不能超过 2000 字符或包含换行')
   if(value!==value.trim())throw Error('值前后有空白，请去除后再保存')
   const clear=bool(input.clearValue,false)
   if(clear&&value)throw Error('清空值和填写新值不能同时选择')
   if(!old&&!value)throw Error('请填写值；无需鉴权则不必添加请求头')
   const candidate=clear?{name,value:''}:value?{name,credentialRef:'MCP_PENDING'}:{...old,name}
   const list=s[kind].slice();if(index===-1)list.push(candidate);else list[index]=candidate
   pairs(list,kind)
   let created
   try{await store.update(rev,async next=>{if(value){if(!vault)throw Error('当前主机不支持保存凭据');created=await vault.put(value);candidate.credentialRef=created}const server=next.servers.find(x=>x.id===s.id);if(index===-1)server[kind].push(candidate);else server[kind][index]=candidate})}
   catch(error){if(created)await vault.drop(created);throw error}
   reconcile();await dropUnused([old?.credentialRef])
   return {...credentials(scope,s.id),toast:'已保存并更新连接'}
  },
  requestDeletePair:(scope,event)=>{const v=args(event),s=find(v.serverId),kind=v.kind==='env'?'env':'headers',index=integer(v.index,0,15,0);if(!s[kind][index])throw Error('配置项已删除');return navigate(scope,{page:'deletePair',serverId:s.id,kind,index,revision:store.snapshot().revision})},
  deletePair:async(scope,event)=>{
   const screen=screenOf(scope),v=args(event)
   if(screen.page!=='deletePair')throw Error('请先选择要删除的请求头')
   if(v.serverId!==screen.serverId||v.kind!==screen.kind||v.index!==screen.index||v.revision!==screen.revision)throw Error('确认目标已变化，请重新确认')
   if(v.confirmed!==true)return credentials(scope,screen.serverId)
   const old=find(screen.serverId)[screen.kind][screen.index]
   await store.update(revision(v,scope),next=>{next.servers.find(s=>s.id===screen.serverId)[screen.kind].splice(screen.index,1)})
   reconcile();await dropUnused([old?.credentialRef]);return {...credentials(scope,screen.serverId),toast:'已删除并更新连接'}
  }
 }
 return {notify,data,screens,actions:Object.fromEntries(Object.entries(actions).map(([id,fn])=>[id,guarded(fn)])),panel:{view:buildView,data:(scope,emit)=>{const k=key(scope),set=listeners.get(k)??new Set();set.add(emit);listeners.set(k,set);emit(wire(data(scope)));return ()=>{set.delete(emit);if(!set.size){listeners.delete(k);projections.delete(k)}}}},dispose:()=>{disposed=true;if(notifyTimer)clearTimeout(notifyTimer);listeners.clear();screens.clear();projections.clear();toolPositions.clear();listPositions.clear()}}
}
