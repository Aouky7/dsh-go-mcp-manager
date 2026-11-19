import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const BAD = new Set(['__proto__', 'constructor', 'prototype'])
export function record(x) { return x !== null && typeof x === 'object' && !Array.isArray(x) }
export function text(x, max = 2000) { if (typeof x !== 'string' || x.length > max || x.includes('\0')) throw Error('字段格式或长度不正确'); return x.trim() }
export function bool(x, fallback) { if (x === undefined) return fallback; if (typeof x !== 'boolean') throw Error('开关值不正确'); return x }
export function integer(x, min, max, fallback) { const n = x === undefined ? fallback : Number(x); if (!Number.isSafeInteger(n) || n < min || n > max) throw Error(`数字须在 ${min} 到 ${max} 之间`); return n }
function parseList(value, fallback = []) { if (value === undefined || value === '') return fallback; const out = typeof value === 'string' ? JSON.parse(value) : value; if (!Array.isArray(out)) throw Error('请填写 JSON 数组'); return out }
export function pairs(input, type) {
  const list = parseList(input)
  if (list.length > 16) throw Error('请求头或环境变量最多 16 项')
  const seen = new Set()
  return list.map(p => {
    if (!record(p)) throw Error('请求头或环境变量格式不正确')
    const name = text(p.name, 128)
    const pattern = type === 'headers' ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/
    if (!pattern.test(name) || BAD.has(name) || seen.has(name.toLowerCase())) throw Error('名称不合法或重复')
    if (type === 'headers' && /^(host|connection|content-length|transfer-encoding|cookie|set-cookie)$/i.test(name)) throw Error('此请求头由连接器管理')
    if (type === 'env' && /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DSH_.*)$/i.test(name)) throw Error('此环境变量不可配置')
    seen.add(name.toLowerCase())
    const credentialRef = p.credentialRef ? text(p.credentialRef, 128) : ''
    if (credentialRef && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(credentialRef)) throw Error('凭据引用名不合法')
    const value = p.value === undefined ? '' : text(p.value, 1024)
    const prefix = p.prefix === undefined ? '' : String(p.prefix)
    if (prefix.length > 80 || /[\r\n\0]/.test(prefix + value)) throw Error('请求头值不合法')
    if (credentialRef && value) throw Error('凭据引用和值只能填写一种')
    if (!credentialRef && /authorization|api[-_]?key|token|secret|password/i.test(name) && value) throw Error('请在请求头编辑页直接填写密钥值')
    return credentialRef ? {name, credentialRef, ...(prefix ? {prefix} : {})} : {name, value}
  })
}
export function normalizeServer(input, previous) {
  if (!record(input)) throw Error('服务器配置无效')
  const id = text(input.id ?? previous?.id ?? '', 32)
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(id) || BAD.has(id)) throw Error('ID 须以字母开头，仅含字母数字、下划线或短横线')
  if (previous && id !== previous.id) throw Error('编辑时不能更改 ID，请新建服务器')
  const name = text(input.name || id, 80)
  const transport = input.transport ?? 'streamable-http'
  if (!['streamable-http','sse','stdio'].includes(transport)) throw Error('不支持的传输方式')
  let url = '', command = '', args = [], cwd = ''
  if (transport === 'stdio') {
    command = text(input.command ?? '', 300)
    if (!command || /[\r\n]/.test(command)) throw Error('请填写单个程序名或绝对路径')
    args = parseList(input.argsText ?? input.args)
    if (args.length > 64 || args.some(x => typeof x !== 'string' || x.length > 2000 || x.includes('\0'))) throw Error('程序参数格式不正确')
    cwd = text(input.cwd ?? '', 1000)
    if (cwd && !cwd.startsWith('/')) throw Error('工作目录须为绝对路径')
  } else {
    url = text(input.url ?? '', 2000)
    let parsed; try { parsed = new URL(url) } catch { throw Error('请输入完整的服务器 URL') }
    if (!['https:','http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw Error('仅支持不带账户信息及片段的 HTTP/HTTPS 地址')
    for (const key of parsed.searchParams.keys()) if (/key|token|secret|password|authorization/i.test(key)) throw Error('URL 中不要填写密钥，请在自定义请求头中填写')
  }
  const headers = pairs(input.headersText ?? input.headers, 'headers')
  const env = pairs(input.envText ?? input.env, 'env')
  return { id,name,transport,url,command,args,cwd,headers,env,
    enabled: bool(input.enabled, previous?.enabled ?? false),
    requireApproval: bool(input.requireApproval, previous?.requireApproval ?? true),
    timeoutMs: integer(input.timeoutMs,1000,180000,60000),
    tools: structuredClone(previous?.tools ?? {}) }
}
export function normalizeState(input) {
  if (!record(input) || input.version !== 1 || !Array.isArray(input.servers) || input.servers.length > 32) throw Error('MCP 配置文件格式不正确')
  const ids = new Set()
  const servers = input.servers.map(s => {
    const server = normalizeServer(s)
    if (ids.has(server.id)) throw Error('服务器 ID 重复'); ids.add(server.id)
    if (s.tools !== undefined && !record(s.tools)) throw Error('工具设置不正确')
    for (const [name,policy] of Object.entries(s.tools ?? {})) {
      if (!name || name.length > 256 || BAD.has(name) || !record(policy)) throw Error('工具设置不正确')
      server.tools[name] = {enabled:bool(policy.enabled,true),requireApproval:bool(policy.requireApproval,server.requireApproval)}
    }
    return server
  })
  return {version:1,revision:integer(input.revision,0,Number.MAX_SAFE_INTEGER,0),servers}
}
export class StateStore {
  constructor(path) { this.path=path; this.value={version:1,revision:0,servers:[]}; this.queue=Promise.resolve() }
  async load() {
    try { this.value=normalizeState(JSON.parse(await readFile(this.path,'utf8'))) }
    catch(e) { if(e.code!=='ENOENT') throw Error('无法读取 MCP 配置，请检查配置文件；原文件未改动') }
    return this.snapshot()
  }
  snapshot() { return structuredClone(this.value) }
  async update(revision, mutate) {
    const run = this.queue.then(async()=>{
      if (revision !== this.value.revision) throw Error('配置已更新，请刷新后重试')
      const next = this.snapshot(); await mutate(next); next.revision++
      const checked = normalizeState(next)
      await mkdir(dirname(this.path),{recursive:true,mode:0o700})
      const tmp=this.path+'.'+randomUUID()+'.tmp'
      await writeFile(tmp,JSON.stringify(checked,null,2)+'\n',{mode:0o600,flag:'wx'})
      await rename(tmp,this.path); await chmod(this.path,0o600)
      this.value=checked
      return this.snapshot()
    })
    this.queue=run.catch(()=>{}); return run
  }
}

// Native clients may send bound form values by path or as a nested object.
export function formPayload(value) {
  if (!record(value)) throw Error('没有收到表单内容')
  const out={}
  const roots=[value, value.values, value.fields, value.data, value.form, value.values?.form, value.values?.data?.form, value.data?.form]
  for (const root of roots) if(record(root)) for(const [k,v] of Object.entries(root)) {
    const key=k.replace(/^data\.form\./,'').replace(/^form\./,'')
    if(BAD.has(key)) throw Error('表单字段不正确')
    if(!record(v)) out[key]=v
  }
  return out
}
