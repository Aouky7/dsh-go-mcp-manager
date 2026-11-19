import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { StateStore } from './store.js'
import { createRuntime } from './runtime.js'
import { createController } from './controller.js'
import { createVault } from './credentials.js'

export const name='local-mcp-manager'
export const Config=z.object({
  autoConnect:z.boolean().default(true).description('允许 MCP 连接（总开关）。服务器、请求头和工具请在本插件原生面板管理。'),
  credentials:z.array(z.object({
    ref:z.string().required(),
    value:z.string().role('secret')
  })).default([]).hidden()
})

export async function apply(ctx,config={}) {
  const root=process.env.DSH_HOME||join(homedir(),'.dsh')
  const store=new StateStore(join(root,'dsh-go','plugin-data',name,'servers.json'))
  await store.load()
  let active,controller,closed=false,credentialContext=ctx
  const runtime={snapshot:()=>active?.snapshot()??{},project:options=>active?.project(options)??{},reconcile:()=>active?.reconcile(),connect:id=>active?.connect(id),refresh:id=>active?.refresh(id)}
  const resolveSecret=async(ref,source=credentialContext)=>{
    const entry=(config.credentials??[]).find(x=>x.ref===ref)
    if(typeof entry?.value==='string'&&entry.value)return entry.value
    const service=source.get('credentials')
    return service?(await service.resolve(credentialRef(ref)))?.value:undefined
  }
  controller=createController(store,runtime,{vault:createVault(()=>credentialContext.get('credentials'))})
  // A credentials provider may initialize after tools. Do not attempt authenticated
  // MCP connections until both services exist; otherwise one early miss is marked
  // blocked and will not be retried by the ordinary list refresh.
  ctx.inject(['tools','credentials'],child=>{
    if(closed)return
    if(typeof child.tools.guard!=='function') {
      ctx.logger?.warn?.('MCP connections disabled: host tool guard API unavailable')
      return
    }
    credentialContext=child
    const instance=createRuntime(child,{
      getState:()=>{const state=store.snapshot();if(config.autoConnect===false)state.servers=state.servers.map(s=>({...s,enabled:false}));return state},
      resolveSecret:ref=>resolveSecret(ref,child),onInvalidate:()=>controller.notify()
    })
    active=instance
    instance.reconcile().catch(()=>child.logger?.warn?.('MCP startup reconciliation failed'))
    child.on('dispose',async()=>{
      if(active===instance)active=undefined
      if(credentialContext===child)credentialContext=ctx
      await instance.dispose()
    })
  })
  ctx.inject(['dshGo'],child=>{
    child.dshGo.panel('mcp-manager',{...controller.panel,actions:controller.actions})
  })
  ctx.on('dispose',async()=>{
    if(closed)return
    closed=true;controller.dispose()
    const instance=active;active=undefined
    await instance?.dispose()
  })
}
