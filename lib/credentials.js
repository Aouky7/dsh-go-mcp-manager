import { randomUUID } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
const OWNED=/^MCP_MANAGER_[A-F0-9]{32}$/
export function createVault(getService) {
 return {
  async put(value) {
   if(typeof value!=='string'||!value||value.length>2000||/[\r\n\0]/.test(value))throw Error('请求头值无效：不能为空或包含换行')
   const service=getService()
   if(typeof service?.set!=='function')throw Error('当前主机不支持保存凭据')
   const ref='MCP_MANAGER_'+randomUUID().replaceAll('-','').toUpperCase()
   try {await service.set(credentialRef(ref),value)}catch{throw Error('凭据保存失败，请重试；原值未修改')}
   return ref
  },
  async drop(ref) {
   if(!OWNED.test(ref??''))return
   const service=getService()
   if(typeof service?.unset!=='function')return
   try {await service.unset(credentialRef(ref))}catch{/* Retain unreferenced secret rather than misreport committed edits. */}
  }
 }
}
export function referenced(state,ref) {return state.servers.some(s=>[...s.headers,...s.env].some(row=>row.credentialRef===ref))}
