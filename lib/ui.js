const text=(value,size='body',extra={})=>({type:'text',text:value,style:{size,...extra}})
const hint=value=>({...text(value,'caption'),tone:'muted'})
const heading=value=>text(value,'title',{weight:'bold',maxLines:2})
const label=value=>text(value,'caption',{weight:'semibold'})
const action=(name,id,args={},icon)=>({label:name,action:{id,args},...(icon?{icon}:{})})
const actions=(...items)=>({type:'actions',items})
const field=(name,key,value,extra={})=>({type:'textField',label:name,bind:`data.form.${key}`,value,maxLength:2000,...extra})
const toggle=(name,key,value)=>({type:'toggle',label:name,bind:`data.form.${key}`,value})
const list=items=>({type:'list',items})
const row=(title,subtitle,id,args={},icon='settings',trailing)=>({title,...(subtitle?{subtitle}:{}),...(trailing?{trailing}:{}),icon,action:{id,args}})
const statusText={connected:'已连接',connecting:'连接中',disconnected:'未连接',disabled:'已停用',error:'连接失败',reconnecting:'重连中'}
const transportText={'streamable-http':'HTTP','sse':'SSE','stdio':'本地 stdio'}
const tone=rt=>rt.status==='connected'?(rt.error?'warn':'good'):rt.status==='disabled'?'muted':rt.error?'warn':'info'
const duration=value=>value<1000?`${Math.max(0,value)} ms`:`${(value/1000).toFixed(1)} s`
const clock=value=>new Date(value).toLocaleTimeString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'})
const count=(rt,key)=>rt.counts?.[key]??rt[key]?.length??0
const enabled=(s,rt)=>rt.counts?.enabledTools??(rt.tools??[]).filter(t=>s.tools?.[t.name]?.enabled!==false).length
const policy=(s,t)=>s.tools?.[t.name]?.enabled===false?'已停用':(s.tools?.[t.name]?.requireApproval??s.requireApproval)?'需审批':'已启用'
const endpoint=s=>{if(s.transport==='stdio')return s.command||'本地程序';try{return new URL(s.url).host}catch{return '尚未配置'}}
const group=(name,items)=>[label(name),list(items)]
function pages(index,total,id,args={}){
 if(total<=1)return []
 return [hint(`${index+1} / ${total} 页`),actions(...(index?[action('上一页',id,{...args,pageIndex:index-1},'reply')]:[]),...(index+1<total?[action('下一页',id,{...args,pageIndex:index+1},'more')]:[]))]
}
// Only actual content reaches the renderer. Empty sections are implementation
// state, never empty stacks (which the App renders as a "no data" placeholder).
export function composeView(data){
 return {...data,content:[...(data.header?.children??[]),...(data.connection?.children??[]),...(data.controls?.children??[]),...(data.children??[])]}
}
export const buildView=()=>({v:2,type:'stack',accent:'app',title:'MCP 管理器',style:{gap:'S'},children:{$:'data.content'}})
export function draftServer(){return {id:'',name:'',transport:'streamable-http',url:'',command:'',args:[],cwd:'',headers:[],env:[],timeoutMs:60000,enabled:true,requireApproval:true,tools:{}}}
export function connectionView(s,rt={}){
 if(!s)return {children:[]}
 const children=[{type:'row',style:{gap:'S'},children:[{type:'badge',text:statusText[rt.status]??(s.enabled?'未连接':'已停用'),tone:tone(rt)},hint(rt.refreshing?'正在检查连接':`${enabled(s,rt)} / ${count(rt,'tools')} 工具启用`)]}]
 if(rt.error)children.push({type:'callout',tone:'warn',text:rt.error.message??'连接失败，请检查设置。'})
 if(rt.nextRetryAt)children.push(hint(`第 ${rt.retries} 次重连 · ${clock(rt.nextRetryAt)}（北京时间）`))
 return {children}
}
const editorHeader=(name,subtitle,id,args={})=>({children:[actions(action('返回',id,args,'reply')),heading(name),...(subtitle?[hint(subtitle)]:[])]})
function detailHeader(s,section){return {children:[
 actions(action('所有服务器','back',{},'reply')),
 heading(s.name),hint(`${transportText[s.transport]} · ${endpoint(s)}`),
 {type:'segmented',label:'服务页面',bind:'data.navigation.section',value:section,options:[{label:'工具',value:'tools'},{label:'活动',value:'activity'},{label:'设置',value:'settings'}],onChange:{id:'selectSection',args:{serverId:s.id}}}
]}}
export function render(state,runtimes,screen={page:'list'}){
 const s=state.servers.find(x=>x.id===screen.serverId),rt=runtimes[s?.id]??{},revision=screen.revision??state.revision,page=screen.page??'list'
 const section=['settings','edit','policy','credentials'].includes(page)?'settings':page==='records'?'activity':'tools'
 const data={header:{children:[]},connection:{children:[]},controls:{children:[]},children:[],navigation:{section},form:null}
 const c=data.children,done=()=>composeView(data)
 if(page==='list'){
  const connected=state.servers.filter(x=>runtimes[x.id]?.status==='connected').length
  data.header.children=[heading('服务器'),hint(`${state.servers.length} 个服务 · ${connected} 个已连接 · ${state.servers.reduce((n,x)=>n+count(runtimes[x.id]??{},'tools'),0)} 个工具`),actions(action('添加服务器','addServer',{},'add'),action('刷新','refresh',{},'refresh'))]
  if(!state.servers.length)c.push({type:'emptyState',title:'连接你的第一个 MCP 服务',message:'添加服务器地址或本地启动程序，连接后自动发现工具。',icon:'server',action:{label:'添加服务器',action:{id:'addServer'},icon:'add'}})
  else{
   const total=Math.ceil(state.servers.length/8),index=Math.max(0,Math.min(screen.pageIndex??0,total-1))
   const selected=state.servers.slice(index*8,index*8+8)
   const attention=selected.filter(x=>x.enabled&&runtimes[x.id]?.error),normal=selected.filter(x=>!attention.includes(x))
   const items=servers=>servers.map(server=>{const live=runtimes[server.id]??{};return {...row(server.name,`${endpoint(server)} · ${count(live,'tools')} 个工具`,'viewOverview',{serverId:server.id},server.transport==='stdio'?'terminal':'server',statusText[live.status]??(server.enabled?'未连接':'已停用')),tone:tone(live)}})
   if(attention.length)c.push(...group('需要处理',items(attention)))
   if(normal.length)c.push(...(attention.length?[label('其他服务')]:[]),list(items(normal)))
   c.push(...pages(index,total,'pageServers'))
  }
  return done()
 }
 if(page==='transport'){
  data.header=editorHeader(s?'更改连接方式':'添加服务器','选择服务提供方支持的 MCP 连接方式。',screen.returnToEditor?'resumeConnection':'back')
  c.push(list([
   row('HTTP','远程 MCP 地址，推荐优先选择。','chooseTransport',{transport:'streamable-http'},'globe'),
   row('SSE','提供方明确要求 SSE 时使用。','chooseTransport',{transport:'sse'},'web'),
   row('本地 stdio','通过程序和参数启动本机服务。','chooseTransport',{transport:'stdio'},'terminal')
  ]),hint('普通 REST API 地址无法直接作为 MCP 服务添加。'))
  return done()
 }
 if(!s&&!(page==='edit'&&screen.draft)){
  data.header=editorHeader('服务不可用','','back')
  c.push({type:'emptyState',title:'服务器已移除',message:'返回列表选择其他服务。'})
  return done()
 }
 if(s)data.header=detailHeader(s,section)
 if(['server','overview'].includes(page)){
  data.connection=connectionView(s,rt)
  const tools=rt.tools??[],query=screen.query??'',filter=screen.filter??'all'
  data.form={query:screen.draftQuery??query};data.filters={mode:filter}
  data.controls.children=[{type:'form',submit:{id:'searchTools',args:{serverId:s.id}},submitLabel:'搜索',children:[field('搜索工具','query',screen.draftQuery??query,{maxLength:120,placeholder:'名称或描述',onChange:{id:'searchDraft'}})]},
   {type:'chips',label:'工具范围',bind:'data.filters.mode',value:filter,options:[{label:'全部',value:'all'},{label:'已启用',value:'enabled'},{label:'已停用',value:'disabled'}],onChange:{id:'filterTools',args:{serverId:s.id}}}]
  c.push(actions(action(rt.refreshing?'检查中':'测试连接','testConnection',{serverId:s.id},'check'),...(query||filter!=='all'?[action('清除筛选','clearSearch',{serverId:s.id},'clear')]:[])))
  const found=tools.filter(t=>(!query||`${t.name} ${t.description??''}`.toLowerCase().includes(query.toLowerCase()))&&(filter==='all'||(s.tools?.[t.name]?.enabled!==false)===(filter==='enabled')))
  const total=Math.max(1,Math.ceil(found.length/8)),index=Math.max(0,Math.min(screen.pageIndex??0,total-1))
  c.push(hint(query?`“${query}” · ${found.length} 项`:`${found.length} 个工具`))
  if(found.length)c.push(list(found.slice(index*8,index*8+8).map(t=>({...row(t.name.slice(0,90),(t.description||'暂无描述').replace(/\s+/g,' ').slice(0,90),'viewTool',{serverId:s.id,toolName:t.name},'tool',policy(s,t)),tone:s.tools?.[t.name]?.enabled===false?'muted':'info'}))))
  else c.push({type:'emptyState',title:tools.length?'没有匹配工具':rt.status==='connected'?'服务未提供工具':'工具尚未就绪',message:tools.length?'换个关键词，或清除筛选。':rt.status==='connected'?'可在设置中查看资源与提示词目录。':'测试连接后会自动发现工具。',icon:'search'})
  c.push(...pages(index,total,'pageTools',{serverId:s.id}))
  return done()
 }
 if(page==='settings'){
  data.connection=connectionView(s,rt)
  const kind=s.transport==='stdio'?'env':'headers',name=kind==='env'?'环境变量':'请求头'
  c.push(...group('连接',[
   row('名称与地址',`${transportText[s.transport]} · ${endpoint(s)}`,'editServer',{serverId:s.id},'link'),
   row(name,`${s[kind]?.length??0} 项已配置`,'viewCredentials',{serverId:s.id},'list'),
   row('调用策略',`${s.timeoutMs/1000} 秒超时 · ${s.requireApproval?'默认需审批':'遵守宿主权限策略'}`,'editPolicy',{serverId:s.id},'settings')
  ]),...group('服务',[
   row('资源与提示词',`${count(rt,'resources')} 个资源 · ${count(rt,'prompts')} 个提示词`,'viewCatalog',{serverId:s.id},'folder'),
   row('重新连接','会中止旧连接上正在执行的调用。','connect',{serverId:s.id},'refresh'),
   row(s.enabled?'停用服务器':'启用服务器',s.enabled?'停用后工具从 AI 的可用列表移除。':'恢复连接并发现工具。','toggleServer',{serverId:s.id,revision},s.enabled?'pause':'play')
  ]),{type:'divider',size:'S'},list([{...row('移除服务器','需要再次确认。','requestDelete',{serverId:s.id},'delete'),tone:'warn'}]))
  return done()
 }
 if(page==='edit'){
  const d=screen.draft??s??draftServer(),f={name:d.name,transport:d.transport,url:d.url,command:d.command,argsLines:d.argsLines??(d.args??[]).join('\n'),cwd:d.cwd}
  const connectionField=(name,key,value,extra={})=>field(name,key,value,{...extra,onChange:{id:'editDraft',args:{field:key}}})
  data.form=f
  data.header=editorHeader(s?'编辑连接':'连接信息',transportText[d.transport],s?'viewSettings':'back',s?{serverId:s.id}:{})
  c.push({type:'form',submit:{id:'saveServer',args:{revision,serverId:s?.id??'',transport:d.transport}},submitLabel:s?'保存连接':'添加并连接',children:[connectionField('名称','name',f.name,{maxLength:80,required:true}),...(d.transport==='stdio'?[
   connectionField('程序','command',f.command,{required:true,placeholder:'程序名或绝对路径'}),connectionField('启动参数','argsLines',f.argsLines,{multiline:true,maxLines:4,placeholder:'每行一个参数，不加引号'}),connectionField('工作目录','cwd',f.cwd,{placeholder:'可留空'})
  ]:[connectionField('MCP 地址','url',f.url,{required:true,maxLines:3,multiline:true,placeholder:'https://example.com/mcp'})])]},actions(action('更改连接方式','changeTransport',{serverId:s?.id??''},'edit')))
  if(d.transport==='stdio')c.push(hint('保存并启用后，将在当前主机执行此程序。'))
  if(!s)c.push(hint('添加后可在设置中配置请求头或环境变量。'))
  return done()
 }
 if(page==='policy'){
  data.header=editorHeader('调用策略',s.name,'viewSettings',{serverId:s.id})
  data.form={timeoutMs:s.timeoutMs,requireApproval:s.requireApproval}
  c.push({type:'form',submit:{id:'saveServer',args:{revision,serverId:s.id}},submitLabel:'保存策略',children:[{type:'number',label:'调用超时（毫秒）',bind:'data.form.timeoutMs',value:s.timeoutMs,min:1000,max:180000,step:1000},toggle('新工具默认需要审批','requireApproval',s.requireApproval)]},hint('单个工具可以覆盖默认审批设置。宿主的权限策略仍然有效。'))
  return done()
 }
 if(page==='credentials'){
  const kind=s.transport==='stdio'?'env':'headers',name=kind==='env'?'环境变量':'请求头',items=s[kind]??[]
  data.header=editorHeader(name,s.name,'viewSettings',{serverId:s.id})
  c.push(actions(action(`添加${name}`,'addPair',{serverId:s.id,kind},'add')))
  if(items.length)c.push(list(items.map((item,index)=>row(item.name,'值已保存，点击修改。','editPair',{serverId:s.id,kind,index},'edit','••••'))))
  else c.push({type:'emptyState',title:`尚未配置${name}`,message:kind==='headers'?'不需要鉴权的服务可以留空。':'按本地服务要求添加环境变量。',icon:'list'})
  return done()
 }
 if(page==='pair'){
  const kind=screen.kind==='env'?'env':'headers',item=s[kind]?.[screen.index],name=kind==='env'?'环境变量':'请求头'
  data.header=editorHeader(`${item?'修改':'添加'}${name}`,s.name,'viewCredentials',{serverId:s.id})
  data.form={pairName:item?.name??'',pairValue:'',clearValue:false}
  c.push({type:'form',submit:{id:'savePair',args:{serverId:s.id,revision,index:screen.index??-1,kind}},submitLabel:'保存',children:[field('名称','pairName',data.form.pairName,{maxLength:128,required:true,placeholder:kind==='headers'?'例如 Authorization':'例如 SERVICE_API_KEY'}),field('值','pairValue','',{maxLength:2000,placeholder:item?'留空保留原值':'填入完整值'}),...(item?[toggle('改为空字符串','clearValue',false)]:[])]},hint(`输入时文字可见，保存后不回显。${item?'留空保留原值。':''}`))
  if(kind==='headers')c.push(hint('x-api-key 通常直接填 Key；Authorization 按提供方要求填写完整值。'))
  if(item)c.push(actions(action(`删除此${name}`,'requestDeletePair',{serverId:s.id,index:screen.index,kind,revision},'delete')))
  return done()
 }
 if(page==='deletePair'||page==='delete'){
  data.header=editorHeader(page==='delete'?'移除服务器':'删除配置项',s.name,page==='delete'?'viewSettings':'viewCredentials',{serverId:s.id})
  const target={serverId:s.id,revision,...(page==='deletePair'?{kind:screen.kind,index:screen.index}:{})},id=page==='delete'?'deleteServer':'deletePair'
  c.push({type:'callout',tone:'warn',text:page==='delete'?`确认移除“${s.name}”？服务器会断开，不再提供工具。`:`确认删除“${s[screen.kind]?.[screen.index]?.name??'此配置项'}”？`},actions(action('确认删除',id,{...target,confirmed:true},'delete'),action('取消',id,{...target,confirmed:false},'reply')))
  return done()
 }
 if(page==='tool'){
  const tool=(rt.tools??[]).find(t=>t.name===screen.toolName)
  data.header=editorHeader(String(screen.toolName).slice(0,90),s.name,'viewServer',{serverId:s.id})
  if(!tool){c.push({type:'emptyState',title:'工具列表已变化',message:'返回工具页刷新后再试。'});return done()}
  data.form={enabled:s.tools?.[tool.name]?.enabled!==false,requireApproval:s.tools?.[tool.name]?.requireApproval??s.requireApproval}
  c.push(text((tool.description||'此工具暂无描述。').slice(0,1800)),{type:'divider',size:'S'},{type:'form',submit:{id:'saveTool',args:{serverId:s.id,toolName:tool.name,revision}},submitLabel:'保存设置',children:[toggle('启用工具','enabled',data.form.enabled),toggle('每次调用需要审批','requireApproval',data.form.requireApproval)]},list([row('参数定义','查看 JSON Schema。','viewSchema',{serverId:s.id,toolName:tool.name},'code')]))
  return done()
 }
 if(page==='schema'){
  data.header=editorHeader('参数定义',String(screen.toolName).slice(0,90),'viewTool',{serverId:s.id,toolName:screen.toolName})
  const code=JSON.stringify((rt.tools??[]).find(t=>t.name===screen.toolName)?.inputSchema??{},null,2)
  c.push({type:'codeBlock',language:'json',code:code.slice(0,7000)},...(code.length>7000?[hint('仅展示前 7000 个字符。')]:[]))
  return done()
 }
 if(page==='catalog'){
  data.header=editorHeader('资源与提示词',s.name,'viewSettings',{serverId:s.id})
  const sections=[['resources','资源'],['prompts','提示词']].filter(([key])=>count(rt,key)>0)
  if(!sections.length)c.push({type:'emptyState',title:'服务未提供目录',message:'服务器当前没有资源或提示词模板。',icon:'folder'})
  for(const [key,name]of sections)c.push(label(`${name} · ${count(rt,key)}`),list((rt[key]??[]).slice(0,12).map(x=>({title:String(x.name||'未命名').slice(0,100),subtitle:String(x.description||x.uri||'').slice(0,120),icon:key==='resources'?'document':'chat'}))),...(count(rt,key)>12?[hint('展示前 12 项。')]:[]))
  c.push(hint('目录仅供查看。'))
  return done()
 }
 if(page==='records'){
  const stats=rt.stats??{calls:0,failures:0,active:0},history=rt.history??[],total=Math.max(1,Math.ceil(history.length/8)),index=Math.max(0,Math.min(screen.pageIndex??0,total-1))
  c.push(text(`${stats.calls} 次调用 · ${stats.failures} 次失败 · ${stats.active} 项执行中`))
  if(rt.lastCheck)c.push(hint(`最近连接检查 ${rt.lastCheck.ok?'通过':'失败'} · ${duration(rt.lastCheck.durationMs)}`))
  if(history.length)c.push(list(history.slice(index*8,index*8+8).map(item=>({title:String(item.tool).slice(0,90),subtitle:`${clock(item.at)} · ${duration(item.durationMs)}${item.code?' · '+item.code:''}`,trailing:item.ok?'成功':'失败',tone:item.ok?'good':'warn',icon:item.ok?'check':'warning'}))),...pages(index,total,'pageRecords',{serverId:s.id}))
  else c.push({type:'emptyState',title:'还没有调用记录',message:'AI 使用此服务的工具后，会在这里显示耗时与结果。',icon:'history'})
  c.push(hint('保留本次运行最近 20 条记录，不保存参数、正文或凭据。'))
  return done()
 }
 c.push({type:'emptyState',title:'页面已变化',message:'返回服务器列表重新打开。'},actions(action('返回列表','back',{},'reply')))
 return done()
}
