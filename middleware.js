/**
 * 全局中间件（项目根）—— zip 上传部署形态下 edge-functions/ 子目录函数不注册，
 * 只有根层单文件函数（health.js）生效。本文件是唯一能拦截所有路径的根层入口：
 * API 路径直接短路交给 handleRequest，其余放行给静态资源 / 已注册函数。
 *
 * ⚠ 打包说明：项目根的 middleware.js 不能跨目录 import edge-functions/_shared/proxy.js
 *   （build 7 实测导致全站 HTTP 545）。因此 scripts/pack.mjs 在打包时会把下面
 *   标记行的 import 替换为 proxy.js 的完整实现（剥离 export 后内联）。
 *   repo 里保留 import 是为了本地可跑测试；zip 内是自包含版本。
 *
 * 背景（2026-10-08 五次线上排查）：
 *   - functions/ 目录名不被扫描 → 必须 edge-functions/
 *   - zip 上传形态：子目录函数（catch-all / [param] 链 / 普通名显式文件）全部不注册
 *   - 仅 edge-functions/ 根层普通名文件生效（health.js 实证）；middleware 全局生效（build 7 的 545 实证）
 *   - 根文件跨目录 import 也失败（build 7 的 545）→ 必须 pack 时内联
 * 线上判别：GET /version.txt 看 build；GET /ping 应 pong；GET /api/zen/v1/models 应 200。
 */

// —— 内联自包含实现(源: edge-functions/_shared/proxy.js, 修改后需同步) ——
/**
 * OpenCode Zen 反向代理 · 共享核心实现
 *
 * 本文件是唯一的实现来源，路由层（functions/api、functions/v1、functions/anthropic）
 * 只做 re-export，避免历史上的三份拷贝互相漂移。
 *
 * 路由约定（假设部署域名为 https://<xxx>.edgeone.app）：
 *   /v1/*                -> https://opencode.ai/zen/v1/*     （OpenAI SDK：base_url 填 <域名>/v1）
 *   /zen/*               -> https://opencode.ai/zen/*        （原样透传）
 *   /anthropic/v1/*      -> https://opencode.ai/zen/v1/*     （Anthropic SDK：base_url 填 <域名>/anthropic）
 *   /api/*               -> 剥掉 /api 前缀后按上面规则处理   （推荐入口，见 usage()）
 *
 * 环境变量（Pages 控制台 → 项目设置 → 环境变量）：
 *   ACCESS_TOKEN      【配了服务端 Key 时必填】网关口令。客户端必须带 Authorization: Bearer <ACCESS_TOKEN>。
 *                     不配且配了 OPENCODE_API_KEY 会直接 503（fail-closed），防止 Key 被白嫖。
 *   OPENCODE_API_KEY  可选。填了就用这把 Key 请求上游（客户端无需带自己的 Key）。
 *   ZEN_API_KEY       OPENCODE_API_KEY 的别名。
 *
 *   ALLOW_OPEN_ACCESS  显式设为 1 才允许「有服务端 Key 但无网关口令」的裸奔模式（默认关闭）。
 *   ALLOW_QUERY_TOKEN  显式设为 1 才允许 ?token=xxx 传令牌（默认关闭，避免令牌进日志/Referer）。
 *   ALLOWED_ORIGINS    逗号分隔的 Origin 白名单；未配置时为 *。
 *
 *   PUBLIC_MODELS      显式 true/1/on -> /models 始终匿名放行；显式关闭词 -> 始终要求口令。
 *   FREE_MODELS_ONLY   默认 true，/models 只返回免费模型。
 *   FREE_MODEL_EXTRA   逗号分隔，额外视为「免费」的模型 ID。
 *
 *   ZEN_SPOOF_CLIENT   默认 true，开启官方客户端身份伪装。
 *   ZEN_SPOOF_ALL      默认 true，付费模型也伪装（上游只对免费档做校验，伪装无害）。
 *   ZEN_FORCE_TOOLS    默认 true，免费档补齐上游要求的 bash / read 工具。
 *   FREE_TIER_ANONYMOUS 默认 true，免费档优先匿名请求，失败再回退到 Key。
 *
 *   DEBUG              设为 1 时才输出 x-zen-* 诊断头（默认关闭，避免泄露付费模式/伪装状态）。
 */

const UPSTREAM = 'https://opencode.ai/zen'

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
}

const EXPOSED_HEADERS = ['x-request-id']

// 控制台环境变量不允许留空，填下面这些值即视为「未配置」
const PLACEHOLDERS = new Set([
  'anonymous', 'none', 'null', 'nil', 'off', 'false', '0',
  '-', '--', 'skip', 'client', 'disabled', 'empty', 'transparent',
])

function readEnv(context, key) {
  let raw
  try {
    if (context && context.env && context.env[key] !== undefined) raw = String(context.env[key])
  } catch (e) {}
  if (raw === undefined) {
    try {
      if (typeof process !== 'undefined' && process.env && process.env[key]) raw = String(process.env[key])
    } catch (e) {}
  }
  if (raw === undefined) return undefined
  const v = raw.trim()
  if (v === '' || PLACEHOLDERS.has(v.toLowerCase())) return undefined
  return v
}

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...(extraHeaders || {}) },
  })
}

/** 常量时间字符串比较，避免令牌被逐字节爆破 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function requestId() {
  const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
  let s = ''
  for (let i = 0; i < 16; i++) s += ALPHABET[Math.floor(Math.random() * 36)]
  return s
}

/** 构造 CORS 头；配置了 Origin 白名单时按白名单回显 */
function corsFor(context, request) {
  const allow = readEnv(context, 'ALLOWED_ORIGINS')
  if (!allow) return CORS_HEADERS
  const origin = request.headers.get('origin') || ''
  const list = allow.split(',').map((x) => x.trim()).filter(Boolean)
  if (origin && list.indexOf(origin) !== -1) {
    return { ...CORS_HEADERS, 'access-control-allow-origin': origin, vary: 'Origin' }
  }
  return { ...CORS_HEADERS, 'access-control-allow-origin': 'null' }
}

/* ------------------------------------------------------------------
 * 路径映射
 * ------------------------------------------------------------------ */

/** 剥掉前缀后交给统一的 /v1 规则 */
function mapStripped(rest, query) {
  if (rest === '' || rest === '/') return UPSTREAM + '/v1' + query
  if (rest === '/v1' || rest.startsWith('/v1/')) return UPSTREAM + rest + query
  // 兜底：裸路径按 /v1 处理，例如 /chat/completions
  return UPSTREAM + '/v1' + rest + query
}

/** 把客户端路径映射到上游路径 */
function mapPath(pathname, search) {
  const query = search || ''
  // 伪装路径（推荐对外只暴露这一个）：/api/zen/v1/... -> /v1/...
  if (pathname === '/api/zen' || pathname.startsWith('/api/zen/')) {
    return mapStripped(pathname.slice('/api/zen'.length), query)
  }
  // /api/anthropic/v1/messages -> /v1/messages
  if (pathname === '/api/anthropic' || pathname.startsWith('/api/anthropic/')) {
    return mapStripped(pathname.slice('/api/anthropic'.length), query)
  }
  if (pathname === '/zen' || pathname.startsWith('/zen/')) {
    return mapStripped(pathname.slice('/zen'.length), query)
  }
  if (pathname === '/anthropic' || pathname.startsWith('/anthropic/')) {
    return mapStripped(pathname.slice('/anthropic'.length), query)
  }
  // 修复：原先漏掉 /api/v1/*，导致 /api/v1/models 被拼成 /zen/v1/api/v1/models
  // 现在 /api/* 统一剥前缀后走同一套规则。
  if (pathname === '/api') {
    return mapStripped('', query)
  }
  if (pathname.startsWith('/api/')) {
    return mapStripped(pathname.slice('/api'.length), query)
  }
  return mapStripped(pathname, query)
}

/** 依据「上游路径」判断客户端在用哪套协议，决定折叠成什么 schema */
function detectEndpoint(upstreamUrl) {
  let p
  try {
    p = new URL(upstreamUrl).pathname
  } catch (e) {
    return 'chat'
  }
  if (/\/messages\/?$/.test(p)) return 'anthropic'
  if (/\/responses\/?$/.test(p)) return 'responses'
  return 'chat'
}

/* ------------------------------------------------------------------
 * 上游鉴权
 * ------------------------------------------------------------------ */

// 客户端用来携带「真实上游 Key」的请求头，优先级从高到低
const UPSTREAM_KEY_HEADERS = ['x-zen-key', 'x-upstream-key', 'x-target-key', 'x-api-key']

/**
 * 决定最终发给上游的 Authorization，优先级：
 *   1. 服务端固定 Key（OPENCODE_API_KEY / ZEN_API_KEY）
 *   2. 客户端通过 x-zen-key 等头带来的真实 Key
 *   3. 客户端 Authorization 不是网关口令时，原样透传
 *   4. 都没有 -> 匿名（只能调 -free / big-pickle 等免费模型）
 */
function resolveUpstreamAuth(request, serverKey, accessToken, queryToken) {
  if (serverKey) return { auth: 'Bearer ' + serverKey, from: 'server key' }

  for (const h of UPSTREAM_KEY_HEADERS) {
    const v = (request.headers.get(h) || (h === 'x-zen-key' ? queryToken : '') || '').trim()
    if (!v) continue
    if (accessToken && safeEqual(v, accessToken)) continue // 是网关口令，不是真 Key
    return { auth: 'Bearer ' + v, from: h }
  }

  const incoming = (request.headers.get('authorization') || '').trim()
  if (incoming) {
    // 带的就是网关口令本身，不能拿它去请求上游
    if (accessToken && safeEqual(incoming, 'Bearer ' + accessToken)) {
      return { auth: '', from: 'anonymous (gateway token only)' }
    }
    return { auth: incoming, from: 'client authorization' }
  }
  return { auth: '', from: 'anonymous' }
}

/** 读原始值（不做占位过滤），用来判断「填了关闭词」的情况 */
function rawEnv(context, key) {
  try {
    if (context && context.env && context.env[key] !== undefined) return String(context.env[key]).trim()
  } catch (e) {}
  try {
    if (typeof process !== 'undefined' && process.env && process.env[key]) return String(process.env[key]).trim()
  } catch (e) {}
  return undefined
}

/** 布尔开关：没填走 def；填了 anonymous/false/off/0/no 都算关闭 */
function envFlag(context, key, def) {
  const v = rawEnv(context, key)
  if (v === undefined || v === '') return def
  return !/^(0|false|off|no|anonymous|none|null|-)$/i.test(v)
}

/** 判断模型 ID 是否属于免费档 */
function isFreeModel(id, extraList) {
  const s = String(id || '').toLowerCase().trim()
  if (!s) return false
  if (extraList && extraList.indexOf(String(id).trim()) !== -1) return true
  if (s === 'big-pickle') return true
  if (/(^|[-_])free([-_]|$)/.test(s)) return true
  return false
}

function extraModels(context) {
  return (readEnv(context, 'FREE_MODEL_EXTRA') || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

/** 过滤 /models 响应，只保留免费模型；解析失败返回 null（原样透传） */
function filterFreeModels(rawText, extraAllow) {
  let j
  try {
    j = JSON.parse(rawText)
  } catch (e) {
    return null
  }
  const arr = Array.isArray(j) ? j : Array.isArray(j && j.data) ? j.data : null
  if (!arr) return null
  const kept = arr.filter((m) => {
    const id = typeof m === 'string' ? m : m && m.id
    if (!id) return false
    return isFreeModel(id, extraAllow)
  })
  if (Array.isArray(j)) return { json: kept, total: arr.length, kept: kept.length }
  j.data = kept
  return { json: j, total: arr.length, kept: kept.length }
}

/* ------------------------------------------------------------------
 * 访问控制（fail-closed）
 * ------------------------------------------------------------------ */

/**
 * 返回 null 表示放行，否则返回要返回给客户端的 Response。
 * 规则：
 *   1. 配了 ACCESS_TOKEN -> 必须携带正确口令（/models 可由 PUBLIC_MODELS 单独放行）
 *   2. 没配口令但配了服务端 Key -> 503 fail-closed，除非显式 ALLOW_OPEN_ACCESS=1
 *   3. 两者都没配 -> 匿名放行（此时没有服务端 Key 可被滥用）
 */
function evaluateAccess(opts) {
  const { serverKey, accessToken, incomingAuth, isModelsRead, publicModels, allowOpen } = opts

  if (isModelsRead && publicModels) return null

  if (accessToken) {
    if (!safeEqual(incomingAuth, 'Bearer ' + accessToken)) {
      return json(
        {
          error: {
            message: 'Unauthorized: 请带 Authorization: Bearer <ACCESS_TOKEN>',
            type: 'auth_error',
            mode: serverKey ? 'server-key' : 'passthrough',
          },
        },
        401
      )
    }
    return null
  }

  if (serverKey && !allowOpen) {
    // fail-closed：配置了付费 Key 却没设网关口令，等于把 Key 敞开给全网
    return json(
      {
        error: {
          message:
            'Gateway misconfigured: 已配置 OPENCODE_API_KEY 但未配置 ACCESS_TOKEN。' +
            '请在环境变量中设置 ACCESS_TOKEN（客户端用它做 Authorization: Bearer <ACCESS_TOKEN>）。',
          type: 'config_error',
          hint: '确实想开放匿名访问请显式设置 ALLOW_OPEN_ACCESS=1（不建议）。',
        },
      },
      503
    )
  }

  if (serverKey) return null
  return incomingAuth ? null : null
}

/* ------------------------------------------------------------------
 * 官方客户端身份伪装
 * ------------------------------------------------------------------ */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

let _idCtr = 0
function rand62(n) {
  let s = ''
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(Math.random() * 62)]
  return s
}

/** 复刻 opencode CLI 的 ID：前缀 + 12 位十六进制(时间戳) + 14 位 base62 */
function zenId(prefix, desc) {
  const ts = Date.now()
  let v = BigInt(ts) * 0x1000n + BigInt((_idCtr = (_idCtr + 1) & 0xfff))
  if (desc) v = ~v
  let hex = ''
  for (let i = 0; i < 6; i++) {
    hex += ((v >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  }
  return prefix + '_' + hex + rand62(14)
}

const ZEN_REQUEST_ID = zenId('msg', false)
const ZEN_PROJECT_ID = 'global'
let ZEN_SESSION_ID = zenId('ses', true)
let ZEN_SESSION_AT = Date.now()

function zenSessionId() {
  if (Date.now() - ZEN_SESSION_AT > 30 * 60 * 1000) {
    ZEN_SESSION_ID = zenId('ses', true)
    ZEN_SESSION_AT = Date.now()
  }
  return ZEN_SESSION_ID
}

const ZEN_UA_VERSION = '1.18.31'
const ZEN_UA = `opencode/${ZEN_UA_VERSION} ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14`

/**
 * 免费档请求体必须声明这两个工具，否则上游 403。
 * 注意：OpenAI 与 Anthropic 两种协议的 tools 结构完全不同，
 * 之前这里只注入 OpenAI 形状，发 /v1/messages 会让上游直接 400。
 */
const ZEN_TOOLS_OPENAI = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command and return its output',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The command to execute' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path to the file' } },
        required: ['path'],
      },
    },
  },
]

const ZEN_TOOLS_ANTHROPIC = [
  {
    name: 'bash',
    description: 'Execute a shell command and return its output',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command to execute' } },
      required: ['command'],
    },
  },
  {
    name: 'read',
    description: 'Read the contents of a file',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to the file' } },
      required: ['path'],
    },
  },
]

/** 按协议取工具名 */
function toolName(t) {
  if (!t) return ''
  if (typeof t.name === 'string' && t.name) return t.name
  if (t.function && typeof t.function.name === 'string') return t.function.name
  return ''
}

/* ------------------------------------------------------------------
 * SSE 解析与折叠
 * ------------------------------------------------------------------ */

/** 把原始 SSE 文本切成一个个 data 负载（支持多行 data 与 CRLF） */
function* sseEvents(text) {
  const blocks = String(text).replace(/\r\n/g, '\n').split(/\n\n+/)
  for (const block of blocks) {
    const lines = block.split('\n')
    const parts = []
    for (const line of lines) {
      const s = line.trim()
      if (s.startsWith('data:')) parts.push(s.slice(5).trim())
    }
    if (!parts.length) continue
    const payload = parts.join('\n')
    if (!payload || payload === '[DONE]') continue
    try {
      yield JSON.parse(payload)
    } catch (e) {
      /* 跳过非法行 */
    }
  }
}

/** 折叠 OpenAI chat.completions 流：保留 content 与 tool_calls */
function foldChat(text, modelId) {
  let content = ''
  let role = 'assistant'
  let finish = 'stop'
  let id = 'chatcmpl-' + Date.now()
  let usage = null
  const tools = new Map()

  for (const ev of sseEvents(text)) {
    if (ev.id) id = ev.id
    if (ev.usage) usage = ev.usage
    const c = ev.choices && ev.choices[0]
    if (!c) continue
    const d = c.delta || {}
    if (typeof d.content === 'string') content += d.content
    if (typeof d.role === 'string' && d.role) role = d.role
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = tc && tc.index != null ? tc.index : 0
        let cur = tools.get(idx)
        if (!cur) {
          cur = { id: 'call_' + idx, type: 'function', function: { name: '', arguments: '' } }
          tools.set(idx, cur)
        }
        if (tc.id) cur.id = tc.id
        if (tc.type) cur.type = tc.type
        const f = tc.function
        if (f) {
          // name 通常只在首个 chunk 完整下发；arguments 是增量片段
          if (typeof f.name === 'string' && f.name && !cur.function.name) cur.function.name = f.name
          if (typeof f.arguments === 'string') cur.function.arguments += f.arguments
        }
      }
    }
    if (c.finish_reason) finish = c.finish_reason
  }

  const list = Array.from(tools.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((v) => v.function.name || v.function.arguments)

  // 上游声明要调工具却没给任何工具调用时，降级为 stop，避免客户端拿到自相矛盾的响应
  if (finish === 'tool_calls' && !list.length) finish = 'stop'
  if (finish === 'tool_calls' && !list.length && !content) finish = 'stop'

  const message = { role, content: list.length ? (content || null) : content }
  if (list.length) message.tool_calls = list

  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId || 'unknown',
    choices: [{ index: 0, message, logprobs: null, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  }
}

/** 折叠 Anthropic messages 流：还原 content blocks 与 tool_use */
function foldAnthropic(text, modelId) {
  let id = 'msg_' + Date.now()
  let model = modelId || 'unknown'
  let stopReason = 'end_turn'
  let inTokens = null
  let outTokens = null
  const blocks = new Map()
  let partial = ''

  const flush = () => {
    if (blocks.has(partial.idx)) {
      const b = blocks.get(partial.idx)
      if (b.type === 'tool_use') {
        try {
          b.input = partial.json ? JSON.parse(partial.json) : {}
        } catch (e) {
          b.input = { _raw: partial.json }
        }
        if (partial.name && !b.name) b.name = partial.name
        if (partial.id && !b.id) b.id = partial.id
        delete b._partial
      }
    }
    partial = ''
  }

  for (const ev of sseEvents(text)) {
    if (ev.type === 'message_start' && ev.message) {
      if (ev.message.id) id = ev.message.id
      if (ev.message.model) model = ev.message.model
      const u = ev.message.usage || {}
      if (u.input_tokens != null) inTokens = u.input_tokens
      if (u.output_tokens != null) outTokens = u.output_tokens
      continue
    }
    if (ev.type === 'content_block_start' && ev.content_block) {
      const cb = ev.content_block
      const idx = ev.index != null ? ev.index : blocks.size
      blocks.set(idx, cb.type === 'tool_use'
        ? { type: 'tool_use', id: cb.id, name: cb.name, input: cb.input || {} }
        : { type: 'text', text: cb.text || '' })
      continue
    }
    if (ev.type === 'content_block_delta' && ev.delta) {
      const idx = ev.index != null ? ev.index : 0
      const b = blocks.get(idx) || { type: 'text', text: '' }
      blocks.set(idx, b)
      const d = ev.delta
      if (typeof d.text === 'string') {
        b.type = b.type === 'tool_use' ? b.type : 'text'
        b.text = (b.text || '') + d.text
      } else if (typeof d.partial_json === 'string') {
        partial = { idx, json: (partial.idx === idx ? partial.json : '') + d.partial_json, name: b.name, id: b.id }
      } else if (typeof d.thinking === 'string') {
        b.type = 'thinking'
        b.thinking = (b.thinking || '') + d.thinking
      }
      continue
    }
    if (ev.type === 'content_block_stop') {
      if (partial && partial.idx === ev.index) flush()
      continue
    }
    if (ev.type === 'message_delta') {
      if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason
      const u = (ev.delta && ev.delta.usage) || ev.usage
      if (u) {
        if (u.input_tokens != null) inTokens = u.input_tokens
        if (u.output_tokens != null) outTokens = u.output_tokens
      }
      continue
    }
  }
  if (partial) flush()

  const content = Array.from(blocks.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter(Boolean)

  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inTokens ?? 0, output_tokens: outTokens ?? 0 },
  }
}

/** 折叠 Responses API 流 */
function foldResponses(text, modelId) {
  let id = 'resp_' + Date.now()
  let model = modelId || 'unknown'
  let output = ''
  let usage = null
  const calls = []

  for (const ev of sseEvents(text)) {
    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
      output += ev.delta
      continue
    }
    if (ev.type === 'response.output_item.added' && ev.item) {
      if (ev.item.id) id = ev.item.id
      if (ev.item.type === 'function_call') {
        calls.push({ id: ev.item.id, call_id: ev.item.call_id, name: ev.item.name, args: '' })
      }
      continue
    }
    if (ev.type === 'response.function_call_arguments.delta' && typeof ev.delta === 'string') {
      if (calls.length) calls[calls.length - 1].args += ev.delta
      continue
    }
    if (ev.type === 'response.completed' && ev.response) {
      const r = ev.response
      if (r.id) id = r.id
      if (r.model) model = r.model
      if (r.usage) usage = r.usage
      if (!output && typeof r.output_text === 'string') output = r.output_text
      if (!calls.length && Array.isArray(r.output)) {
        for (const o of r.output) {
          if (o && o.type === 'function_call') {
            calls.push({ id: o.id, call_id: o.call_id, name: o.name, args: o.arguments || '' })
          }
        }
      }
      continue
    }
    if (ev.type === 'response.created' && ev.response) {
      if (ev.response.id) id = ev.response.id
      if (ev.response.model) model = ev.response.model
    }
  }

  const out = []
  if (output) {
    out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: output, annotations: [] }] })
  }
  for (const c of calls) {
    out.push({
      type: 'function_call',
      id: c.id,
      call_id: c.call_id || c.id,
      name: c.name || '',
      arguments: c.args || '',
      status: 'completed',
    })
  }

  const resp = {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output: out,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
  }
  if (usage) {
    resp.usage = {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ?? (usage.input_tokens || 0) + (usage.output_tokens || 0),
    }
  }
  return resp
}

/** 按协议分派折叠 */
function foldSse(text, modelId, endpoint) {
  if (endpoint === 'anthropic') return foldAnthropic(text, modelId)
  if (endpoint === 'responses') return foldResponses(text, modelId)
  return foldChat(text, modelId)
}

/* ------------------------------------------------------------------
 * 请求头
 * ------------------------------------------------------------------ */

function buildHeaders(request, upstreamAuth, spoof, anonymous, cors) {
  const headers = new Headers()
  request.headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (HOP_BY_HOP.includes(k)) return
    if (UPSTREAM_KEY_HEADERS.includes(k)) return // 内部头不外泄
    headers.set(key, value)
  })
  try {
    headers.set('host', 'opencode.ai')
  } catch (e) {
    // 少数运行时禁止改写 host，忽略即可（URL 已决定 Host）
  }
  if (upstreamAuth) {
    headers.set('authorization', upstreamAuth)
  } else {
    headers.delete('authorization')
  }
  if (spoof) {
    headers.set('user-agent', ZEN_UA)
    headers.set('x-opencode-client', 'cli')
    headers.set('x-opencode-project', ZEN_PROJECT_ID)
    headers.set('x-opencode-request', ZEN_REQUEST_ID)
    headers.set('x-opencode-session', zenSessionId())
    headers.set('origin', 'https://opencode.ai')
    headers.set('referer', 'https://opencode.ai/')
  } else {
    headers.set('x-opencode-client', 'edgeone-proxy')
  }
  if (anonymous) headers.delete('authorization')
  // 关键：要求上游返回明文，杜绝 gzip/br 二次解码问题
  headers.set('accept-encoding', 'identity')
  // 复用客户端的 CORS 头，避免 CORS_* 未定义时 SyntaxError
  for (const [k, v] of Object.entries(cors || CORS_HEADERS)) headers.set(k, v)
  return headers
}

function usage(host) {
  const text = [
    'OpenCode Zen proxy is running.',
    '',
    `伪装路径（推荐）: ${host}/api/zen/v1/chat/completions`,
    `Responses API:    ${host}/api/zen/v1/responses`,
    `模型列表:         ${host}/api/zen/v1/models`,
    `Anthropic 兼容:   ${host}/api/anthropic/v1/messages`,
    '',
    `兼容路径:         ${host}/api/v1/*  ${host}/v1/*  ${host}/zen/v1/*  ${host}/anthropic/v1/*`,
    '',
    '用法：OpenAI SDK 的 base_url 填 <域名>/api/zen/v1，api_key 填你的 Zen Key（或服务端已配置的 ACCESS_TOKEN）。',
    '',
    '提示：服务端配置了 OPENCODE_API_KEY 时，必须同时配置 ACCESS_TOKEN，否则网关返回 503（fail-closed）。',
    '诊断头：设置环境变量 DEBUG=1 后会返回 x-zen-* 诊断头。',
  ].join('\n')
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS_HEADERS },
  })
}

/** 健康检查：只报告配置状态，不做任何转发 */
function healthResponse(context) {
  const serverKey = !!(readEnv(context, 'OPENCODE_API_KEY') || readEnv(context, 'ZEN_API_KEY'))
  const accessToken = !!readEnv(context, 'ACCESS_TOKEN')
  const allowOpen = envFlag(context, 'ALLOW_OPEN_ACCESS', false)
  const state = accessToken ? 'ok' : serverKey && !allowOpen ? 'misconfigured' : 'ok'
  return json(
    {
      status: state,
      serverKey: serverKey ? 'configured' : 'absent',
      accessToken: accessToken ? 'configured' : 'absent',
      note: !accessToken && serverKey
        ? '已配置服务端 Key 但未配置 ACCESS_TOKEN，请求会被 503 拒绝。'
        : undefined,
      debug: envFlag(context, 'DEBUG', false),
    },
    state === 'ok' ? 200 : 503
  )
}

/* ------------------------------------------------------------------
 * 主处理流程
 * ------------------------------------------------------------------ */

async function handleRequest(context) {
  const request = context.request
  const url = new URL(request.url)
  const host = url.protocol + '//' + url.host
  const rid = request.headers.get('x-request-id') || requestId()
  const cors = corsFor(context, request)
  const debug = envFlag(context, 'DEBUG', false)

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors, ...EXPOSED_HEADERS.reduce((a, k) => ({ ...a, [k]: rid }), {}) } })
  }

  // 根路径 / 交给静态首页（index.html）
  if (url.pathname === '/health') return healthResponse(context)
  if (url.pathname === '/api' || url.pathname === '/api/') return usage(host)

  // 前缀白名单：动态参数链（[a]/[b]/...）会接住所有未命中静态资源的多段路径，
  // 必须把非 API 路径拦下来返回 404，否则任意路径都会被代理到上游。
  // 静态资源（/、/test.html 等）由平台按「静态优先」规则处理，到不了这里。
  const API_PREFIXES = ['/api/', '/v1/', '/zen/', '/anthropic/']
  const isApiPath =
    API_PREFIXES.some((p) => url.pathname.startsWith(p)) ||
    url.pathname === '/api' ||
    url.pathname === '/v1' ||
    url.pathname === '/zen' ||
    url.pathname === '/anthropic'
  if (!isApiPath) {
    return json(
      {
        error: {
          message: 'Not Found: ' + url.pathname,
          type: 'not_found',
          hint: '可用前缀：/api/zen/v1/*、/api/anthropic/v1/*、/api/v1/*、/v1/*、/zen/*、/anthropic/*；部署与排障说明见 README。',
        },
      },
      404,
      { 'x-request-id': rid }
    )
  }

  const accessToken = readEnv(context, 'ACCESS_TOKEN')
  const serverKey = readEnv(context, 'OPENCODE_API_KEY') || readEnv(context, 'ZEN_API_KEY')
  const allowOpen = envFlag(context, 'ALLOW_OPEN_ACCESS', false)
  const allowQueryToken = envFlag(context, 'ALLOW_QUERY_TOKEN', false)
  const queryToken = allowQueryToken ? (url.searchParams.get('token') || '').trim() : ''
  const incomingAuth =
    (request.headers.get('authorization') || '').trim() || (queryToken ? 'Bearer ' + queryToken : '')

  const isModelsRead =
    (request.method === 'GET' || request.method === 'HEAD') && /\/models(\/|$)/.test(url.pathname)

  const publicRaw = rawEnv(context, 'PUBLIC_MODELS')
  let publicModels
  if (publicRaw !== undefined && publicRaw !== '') {
    publicModels = !/^(0|false|off|no|anonymous|none|null|-)$/i.test(publicRaw)
  } else {
    publicModels = !serverKey
  }

  const denied = evaluateAccess({
    serverKey,
    accessToken,
    incomingAuth,
    isModelsRead,
    publicModels,
    allowOpen,
  })
  if (denied) {
    if (debug) denied.headers.set('x-request-id', rid)
    return denied
  }

  const resolved = resolveUpstreamAuth(request, serverKey, accessToken, queryToken)
  const upstreamAuth = resolved.auth

  const target = mapPath(url.pathname, url.search)
  const endpoint = detectEndpoint(target)
  const hasBody = !['GET', 'HEAD'].includes(request.method)

  // 请求体普遍很小（就是一段 JSON），统一读成缓冲再发，
  // 避免 request.body 这种 ReadableStream 在部分运行时抛 duplex 相关错误
  let bodyBuf = undefined
  if (hasBody) {
    try {
      bodyBuf = await request.arrayBuffer()
    } catch (e) {
      bodyBuf = undefined
    }
    if (bodyBuf && bodyBuf.byteLength === 0) bodyBuf = undefined
  }

  let payload = null
  if (bodyBuf) {
    try {
      payload = JSON.parse(new TextDecoder().decode(bodyBuf))
    } catch (e) {
      payload = null
    }
  }

  const modelId = payload && (payload.model || payload.target || '')
  const extraList = extraModels(context)
  const isFree = isFreeModel(modelId, extraList)
  const spoofAll = envFlag(context, 'ZEN_SPOOF_ALL', true)
  const spoof = envFlag(context, 'ZEN_SPOOF_CLIENT', true) && (isFree || spoofAll)

  let foldToJson = false
  let toolState = 'n/a'
  let forcedStream = false
  if (spoof && payload) {
    if (isFree) {
      if (payload.stream !== true) {
        payload.stream = true
        foldToJson = true
        forcedStream = true
      }
      const wanted = endpoint === 'anthropic' ? ZEN_TOOLS_ANTHROPIC : ZEN_TOOLS_OPENAI
      const forceTools = envFlag(context, 'ZEN_FORCE_TOOLS', true)
      const existing = Array.isArray(payload.tools)
        ? payload.tools
        : Array.isArray(payload.functions)
        ? payload.functions
        : null
      if (!existing || existing.length === 0) {
        payload.tools = wanted
        toolState = 'injected(' + endpoint + ')'
      } else {
        const names = new Set(existing.map(toolName).filter(Boolean))
        const missing = wanted.filter((t) => names.indexOf(toolName(t)) === -1)
        if (missing.length) {
          if (forceTools) {
            payload.tools = existing.concat(missing)
            toolState = 'merged(+' + missing.map(toolName).join(',') + ')'
            if (Array.isArray(payload.functions)) delete payload.functions
          } else {
            toolState = 'had-tools(kept)'
          }
        } else {
          toolState = 'had-tools(ok)'
        }
      }
    } else {
      toolState = 'skipped(paid)'
    }
    bodyBuf = new TextEncoder().encode(JSON.stringify(payload))
  }

  // 重试顺序：免费档优先匿名（额度在匿名层），付费模型优先带 Key。
  // 修复：原先写成 (isFree || spoofAll)，而 spoofAll 默认为 true，
  // 导致付费模型也先匿名打一次必然 401 的请求，延迟与调用量翻倍。
  const preferAnonymous = envFlag(context, 'FREE_TIER_ANONYMOUS', true) && isFree
  const modes = []
  if (upstreamAuth) {
    modes.push(preferAnonymous, !preferAnonymous)
  } else {
    modes.push(true)
  }

  // bodyBuf 是 ArrayBuffer 而非 ReadableStream，正常无需 duplex；
  // 少数运行时仍会抛错时补一次重试。
  const send = async (anon, extra) =>
    fetch(target, {
      method: request.method,
      headers: buildHeaders(request, upstreamAuth, spoof, anon, cors),
      body: bodyBuf,
      redirect: 'follow',
      ...(extra || {}),
    })

  let upstream = null
  let usedAnon = null
  const tried = []
  for (const anon of modes) {
    let res = null
    try {
      res = await send(anon)
    } catch (e) {
      try {
        res = await send(anon, { duplex: 'half' })
      } catch (e2) {
        res = null
      }
    }
    if (!res) {
      tried.push((anon ? 'anon' : 'key') + ':network-error')
      continue
    }
    tried.push((anon ? 'anon' : 'key') + ':' + res.status)
    if (res.status === 401 || res.status === 403) {
      // 修复：原先用 if (!upstream) upstream = res 保留了第一次（匿名）的失败响应，
      // 两次都失败时客户端拿到的是匿名那条错误，误导排查。
      // 现在始终保留最后一次尝试的响应，即最贴近真实鉴权上下文的那次。
      upstream = res
      continue
    }
    upstream = res
    usedAnon = anon
    break
  }

  if (!upstream) {
    return json(
      {
        error: {
          message: 'Upstream unreachable',
          type: 'upstream_error',
          hint: '边缘节点无法访问 opencode.ai，检查加速区域是否为「全球（不含中国大陆）」',
          tried,
          requestId: rid,
        },
      },
      502,
      { 'x-request-id': rid }
    )
  }

  const headers = new Headers()
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (HOP_BY_HOP.includes(k)) return
    if (k === 'content-encoding' || k === 'content-length') return
    headers.set(key, value)
  })
  for (const [k, v] of Object.entries(cors)) headers.set(k, v)
  headers.set('x-request-id', rid)
  headers.delete('content-encoding')
  headers.delete('content-length')

  // 诊断头只在 DEBUG=1 时输出，默认不泄露付费模式 / 伪装状态 / 重试轨迹
  if (debug) {
    headers.set('x-upstream', 'opencode-zen')
    headers.set('access-control-expose-headers', EXPOSED_HEADERS.concat([
      'x-upstream', 'x-zen-auth-source', 'x-zen-spoof', 'x-zen-model',
      'x-zen-attempts', 'x-zen-tools', 'x-zen-free', 'x-zen-stream',
      'x-zen-endpoint', 'x-zen-folded', 'x-zen-model-filter',
    ]).join(', '))
    headers.set(
      'x-zen-auth-source',
      spoof
        ? usedAnon === null
          ? 'spoofed (fallback)'
          : usedAnon
          ? 'free-tier anonymous (spoofed)'
          : 'spoofed + key'
        : resolved.from
    )
    headers.set('x-zen-spoof', spoof ? 'on' : 'off')
    headers.set('x-zen-model', String(modelId || ''))
    headers.set('x-zen-attempts', tried.join(' -> '))
    headers.set('x-zen-tools', toolState)
    headers.set('x-zen-free', isFree ? 'yes' : 'no')
    headers.set('x-zen-stream', forcedStream ? 'forced' : 'as-requested')
    headers.set('x-zen-endpoint', endpoint)
  }

  // 模型列表：默认只保留免费模型
  if (isModelsRead && upstream.ok && envFlag(context, 'FREE_MODELS_ONLY', true)) {
    let bodyText = ''
    let r = null
    try {
      bodyText = await upstream.text()
      r = filterFreeModels(bodyText, extraList)
    } catch (e) {
      r = null
    }

    headers.delete('etag')
    headers.set('cache-control', 'no-store')

    if (r) {
      headers.set('content-type', 'application/json; charset=utf-8')
      if (debug) headers.set('x-zen-model-filter', `free-only ${r.kept}/${r.total}`)
      return new Response(JSON.stringify(r.json), { status: 200, headers })
    }
    if (debug) headers.set('x-zen-model-filter', 'passthrough (unparsable)')
    return new Response(bodyText, { status: upstream.status, headers })
  }

  // 强制了流式但客户端要非流式 -> 按协议折叠回完整 JSON
  if (foldToJson && upstream.ok && (upstream.headers.get('content-type') || '').includes('event-stream')) {
    const raw = await upstream.text()
    const folded = foldSse(raw, modelId, endpoint)
    headers.set('content-type', 'application/json; charset=utf-8')
    headers.delete('etag')
    if (debug) headers.set('x-zen-folded', 'sse->' + endpoint)
    return new Response(JSON.stringify(folded), { status: 200, headers })
  }

  // upstream.body 直接透传，SSE 流式不会被缓冲
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers })
}

const API_PREFIXES = ['/api/', '/v1/', '/zen/', '/anthropic/']
const API_EXACT = ['/api', '/v1', '/zen', '/anthropic', '/health']

function isApiPath(pathname) {
  return (
    API_PREFIXES.some((p) => pathname.startsWith(p)) || API_EXACT.indexOf(pathname) !== -1
  )
}

export async function onRequest(context) {
  const request = context.request
  let pathname = '/'
  try {
    pathname = new URL(request.url).pathname
  } catch (e) {}

  if (isApiPath(pathname)) {
    // 短路：API 请求不进入静态资源流程
    return handleRequest(context)
  }

  // 非 API：放行给静态资源 / 已注册的根层函数（/ping、/health 由根层函数处理）
  if (typeof context.next === 'function') {
    return context.next()
  }
  // 运行时不提供 next（异常形态）：兜底返回 404
  return new Response(
    JSON.stringify({ error: { message: 'Not Found: ' + pathname, type: 'not_found' } }),
    { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' } }
  )
}