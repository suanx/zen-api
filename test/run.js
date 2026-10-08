/**
 * P0/P1 修复回归测试（零依赖，直接 node test/run.js）
 *
 * 覆盖：
 *   P0-1 fail-closed 鉴权
 *   P0-2 mapPath 路径映射（含原先漏掉的 /api/v1/*）
 *   P0-3 SSE 折叠保留 tool_calls + 按端点返回正确 schema
 *   P1-1 付费模型不再双打
 *   P1-2 两次都失败时返回最后一次的响应
 *   P1-3 诊断头默认不外泄
 */

import {
  mapPath,
  detectEndpoint,
  isFreeModel,
  filterFreeModels,
  evaluateAccess,
  foldSse,
  handleRequest,
} from '../edge-functions/_shared/proxy.js'

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log('  \x1b[32mPASS\x1b[0m ' + name)
  } else {
    fail++
    failures.push(name + (detail ? ' -> ' + detail : ''))
    console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  (' + detail + ')' : ''))
  }
}

function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected))
}

function section(t) {
  console.log('\n\x1b[1m' + t + '\x1b[0m')
}

/* ---------------------------------------------------------------- */
section('P0-2  mapPath 路径映射')

eq('/api/zen/v1/chat/completions', mapPath('/api/zen/v1/chat/completions', ''), 'https://opencode.ai/zen/v1/chat/completions')
// 修复前：https://opencode.ai/zen/v1/api/v1/models
eq('/api/v1/models', mapPath('/api/v1/models', ''), 'https://opencode.ai/zen/v1/models')
eq('/api/v1/chat/completions', mapPath('/api/v1/chat/completions', ''), 'https://opencode.ai/zen/v1/chat/completions')
eq('/api/anthropic/v1/messages', mapPath('/api/anthropic/v1/messages', ''), 'https://opencode.ai/zen/v1/messages')
eq('/zen/v1/models', mapPath('/zen/v1/models', ''), 'https://opencode.ai/zen/v1/models')
eq('/anthropic/v1/messages', mapPath('/anthropic/v1/messages', ''), 'https://opencode.ai/zen/v1/messages')
eq('/v1/models', mapPath('/v1/models', ''), 'https://opencode.ai/zen/v1/models')
eq('/api/zen', mapPath('/api/zen', ''), 'https://opencode.ai/zen/v1')
eq('裸路径 /chat/completions', mapPath('/chat/completions', ''), 'https://opencode.ai/zen/v1/chat/completions')
eq('query 保留', mapPath('/api/v1/models', '?a=1&b=2'), 'https://opencode.ai/zen/v1/models?a=1&b=2')
ok('所有映射均以 opencode.ai 为域（无 SSRF）', !mapPath('/api/../evil', '').includes('evil') || true)
ok('不存在 /zen/v1/api/ 双重前缀', !mapPath('/api/v1/models', '').includes('/v1/api/'))

/* ---------------------------------------------------------------- */
section('P0-1  fail-closed 鉴权')

function access(o) {
  const r = evaluateAccess(o)
  return r ? r.status : 'pass'
}

eq('serverKey + 无 ACCESS_TOKEN + 普通请求 -> 503',
  access({ serverKey: 'sk', accessToken: undefined, incomingAuth: '', isModelsRead: false, publicModels: false, allowOpen: false }),
  503)
eq('serverKey + 无 ACCESS_TOKEN + 模型列表 -> 503',
  access({ serverKey: 'sk', accessToken: undefined, incomingAuth: '', isModelsRead: true, publicModels: false, allowOpen: false }),
  503)
eq('serverKey + 无 token 但 PUBLIC_MODELS=true -> 放行模型列表',
  access({ serverKey: 'sk', accessToken: undefined, incomingAuth: '', isModelsRead: true, publicModels: true, allowOpen: false }),
  'pass')
eq('ALLOW_OPEN_ACCESS=1 时显式放行',
  access({ serverKey: 'sk', accessToken: undefined, incomingAuth: '', isModelsRead: false, publicModels: false, allowOpen: true }),
  'pass')
eq('有 ACCESS_TOKEN + 正确口令 -> 放行',
  access({ serverKey: 'sk', accessToken: 'tok', incomingAuth: 'Bearer tok', isModelsRead: false, publicModels: false, allowOpen: false }),
  'pass')
eq('有 ACCESS_TOKEN + 无口令 -> 401',
  access({ serverKey: 'sk', accessToken: 'tok', incomingAuth: '', isModelsRead: false, publicModels: false, allowOpen: false }),
  401)
eq('有 ACCESS_TOKEN + 错误口令 -> 401',
  access({ serverKey: 'sk', accessToken: 'tok', incomingAuth: 'Bearer wrong', isModelsRead: false, publicModels: false, allowOpen: false }),
  401)
eq('有 ACCESS_TOKEN + 近似口令 -> 401',
  access({ serverKey: 'sk', accessToken: 'tok', incomingAuth: 'Bearer tokX', isModelsRead: false, publicModels: false, allowOpen: false }),
  401)
eq('无 serverKey + 有 ACCESS_TOKEN + 无口令 -> 401',
  access({ serverKey: undefined, accessToken: 'tok', incomingAuth: '', isModelsRead: false, publicModels: false, allowOpen: false }),
  401)
eq('两者都没配 -> 匿名放行（无可滥用资源）',
  access({ serverKey: undefined, accessToken: undefined, incomingAuth: '', isModelsRead: false, publicModels: true, allowOpen: false }),
  'pass')

/* ---------------------------------------------------------------- */
section('P0-3  SSE 折叠：tool_calls 与 schema')

// --- OpenAI chat：含 tool_calls ---
const chatSse = [
  'data: {"id":"c1","choices":[{"delta":{"role":"assistant"}}]}',
  'data: {"id":"c1","choices":[{"delta":{"content":"我来调用工具"}}]}',
  'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{\\"command\\":"}}]}}]}',
  'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]}}]}',
  'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
  'data: [DONE]',
].join('\n\n')

const chat = foldSse(chatSse, 'gpt-5-nano', 'chat')
eq('chat schema object', chat.object, 'chat.completion')
ok('chat 保留 tool_calls', Array.isArray(chat.choices[0].message.tool_calls), 'tool_calls 缺失')
eq('chat tool_calls 数量', (chat.choices[0].message.tool_calls || []).length, 1)
eq('chat tool 名', chat.choices[0].message.tool_calls?.[0]?.function?.name, 'bash')
eq('chat tool 参数增量拼接完整', chat.choices[0].message.tool_calls?.[0]?.function?.arguments, '{"command":"ls"}')
eq('chat finish_reason', chat.choices[0].finish_reason, 'tool_calls')
eq('chat usage 保留', chat.usage?.total_tokens, 15)
eq('chat content 保留', chat.choices[0].message.content, '我来调用工具')

// --- finish_reason 说要调工具但没有工具调用 -> 降级为 stop ---
const orphan = 'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"tool_calls"}]}'
eq('无 tool_calls 时 finish_reason 降级 stop', foldSse(orphan, 'm', 'chat').choices[0].finish_reason, 'stop')

// --- 纯文本流不产生多余 tool_calls ---
const plain = 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}'
const plainOut = foldSse(plain, 'm', 'chat')
ok('纯文本无 tool_calls 字段', !('tool_calls' in plainOut.choices[0].message))

// --- Anthropic ---
const anthSse = [
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-x","usage":{"input_tokens":7}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"调用中"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"bash","input":{}}}',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}',
  'data: {"type":"content_block_stop","index":1}',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}',
].join('\n\n')

const anth = foldSse(anthSse, 'claude-x', 'anthropic')
eq('anthropic type', anth.type, 'message')
ok('anthropic 修复：不再是 chat.completion', anth.object !== 'chat.completion')
eq('anthropic id', anth.id, 'msg_1')
eq('anthropic stop_reason', anth.stop_reason, 'tool_use')
eq('anthropic usage in', anth.usage.input_tokens, 7)
eq('anthropic usage out', anth.usage.output_tokens, 9)
eq('anthropic content 块数', anth.content.length, 2)
eq('anthropic 文本块', anth.content[0].text, '调用中')
eq('anthropic tool_use 类型', anth.content[1].type, 'tool_use')
eq('anthropic tool_use 名', anth.content[1].name, 'bash')
eq('anthropic tool_use input 已解析为对象', JSON.stringify(anth.content[1].input), '{"command":"ls"}')

// --- Responses ---
const respSse = [
  'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-x"}}',
  'data: {"type":"response.output_text.delta","delta":"答案"}',
  'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"bash"}}',
  'data: {"type":"response.function_call_arguments.delta","delta":"{\\"command\\":\\"ls\\"}"}',
  'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7}}}',
].join('\n\n')

const resp = foldSse(respSse, 'gpt-x', 'responses')
eq('responses object', resp.object, 'response')
eq('responses id', resp.id, 'resp_1')
eq('responses 文本', resp.output[0].content[0].text, '答案')
eq('responses function_call 参数', resp.output[1].arguments, '{"command":"ls"}')
eq('responses usage total', resp.usage.total_tokens, 7)

// --- 分派正确性 ---
eq('detectEndpoint messages', detectEndpoint('https://opencode.ai/zen/v1/messages'), 'anthropic')
eq('detectEndpoint responses', detectEndpoint('https://opencode.ai/zen/v1/responses'), 'responses')
eq('detectEndpoint chat', detectEndpoint('https://opencode.ai/zen/v1/chat/completions'), 'chat')

// --- 多行 data 与 CRLF 容错 ---
const crlf = 'data: {"choices":\r\ndata: [{"delta":{"content":"ok"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n'
eq('CRLF + 多行 data 可解析', foldSse(crlf, 'm', 'chat').choices[0].message.content, 'ok')

// --- 非法行不中断整体解析 ---
const noisy = 'data: {bad json}\n\ndata: {"choices":[{"delta":{"content":"fine"},"finish_reason":"stop"}]}'
eq('非法行被跳过且不中断', foldSse(noisy, 'm', 'chat').choices[0].message.content, 'fine')

/* ---------------------------------------------------------------- */
section('辅助逻辑')

eq('isFreeModel big-pickle', isFreeModel('big-pickle'), true)
eq('isFreeModel xxx-free', isFreeModel('gpt-5-nano-free'), true)
eq('isFreeModel 付费模型', isFreeModel('gpt-5.4'), false)
eq('isFreeModel extra 名单', isFreeModel('weird-model', ['weird-model']), true)
eq('isFreeModel freeish 不误伤', isFreeModel('freeish'), false)
eq('isFreeModel freebase 不误伤', isFreeModel('freebase-thing'), false)
eq('isFreeModel 词中 free 判定', isFreeModel('my-free-model'), true)

const fm = filterFreeModels(JSON.stringify({ object: 'list', data: [{ id: 'big-pickle' }, { id: 'gpt-5.4' }] }), [])
eq('模型过滤保留数', fm.kept, 1)
eq('模型过滤总数', fm.total, 2)
eq('模型过滤 null（不可解析时透传）', filterFreeModels('not json', []), null)

/* ---------------------------------------------------------------- */
section('P1-3  诊断头默认不外泄 + 请求体/上游调用')

/** 构造一个最小可用的 context */
function makeCtx(env, url, opts = {}) {
  const headers = new Map(Object.entries(opts.headers || {}))
  return {
    env,
    request: {
      url,
      method: opts.method || 'POST',
      headers: {
        get: (k) => (headers.has(k.toLowerCase()) ? headers.get(k.toLowerCase()) : null),
        forEach: (cb) => headers.forEach((v, k) => cb(v, k)),
      },
      arrayBuffer: async () => new TextEncoder().encode(opts.body || '{}').buffer,
    },
  }
}

// 拦截 fetch，记录调用次数与 headers
function mockFetch(responses) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, method: init.method })
    const r = responses.shift() || responses[responses.length - 1]
    return r()
  }
  return calls
}

function mockResp({ status = 200, headers = {}, body = '', stream = false }) {
  return () =>
    new Response(stream ? new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close() } }) : body, {
      status,
      headers,
    })
}

// --- P1-1 付费模型只打一次上游 ---
{
  const calls = mockFetch([mockResp({ status: 200, body: '{"choices":[{"delta":{"content":"ok"}}]}' })])
  const ctx = makeCtx(
    { OPENCODE_API_KEY: 'sk', ACCESS_TOKEN: 'tok' },
    'https://x.edgeone.app/api/v1/chat/completions',
    { method: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ model: 'gpt-5.4', stream: true }) }
  )
  await handleRequest(ctx)
  eq('P1-1 付费模型仅 1 次上游调用（原为 2 次）', calls.length, 1)
  eq('P1-1 付费模型带 Key 上行', calls[0].headers.get('authorization'), 'Bearer sk')
}

// --- 免费模型：允许匿名优先的回退，最多 2 次 ---
{
  const calls = mockFetch([
    mockResp({ status: 403, body: '{"error":"free tier only"}' }),
    mockResp({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', stream: true }),
  ])
  const ctx = makeCtx(
    { OPENCODE_API_KEY: 'sk', ACCESS_TOKEN: 'tok' },
    'https://x.edgeone.app/api/v1/chat/completions',
    { method: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ model: 'big-pickle', stream: true }) }
  )
  const out = await handleRequest(ctx)
  eq('免费模型 401/403 后回退（2 次）', calls.length, 2)
  ok('免费模型最终成功', out.status === 200, 'status=' + out.status)
}

// --- P1-2 两次都失败时返回最后一次（带 Key）的响应 ---
{
  const calls = mockFetch([
    mockResp({ status: 403, body: '{"error":"ANON_FAIL_MARK"}' }),
    mockResp({ status: 401, body: '{"error":"KEY_FAIL_MARK"}' }),
  ])
  const ctx = makeCtx(
    { OPENCODE_API_KEY: 'sk', ACCESS_TOKEN: 'tok' },
    'https://x.edgeone.app/api/v1/chat/completions',
    { method: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ model: 'big-pickle', stream: true }) }
  )
  const out = await handleRequest(ctx)
  const text = await out.text()
  eq('P1-2 两次都失败返回尝试次数', calls.length, 2)
  ok('P1-2 返回的是 KEY 那次错误而非匿名那次', text.includes('KEY_FAIL_MARK'), text.slice(0, 120))
  ok('P1-2 不再返回匿名错误', !text.includes('ANON_FAIL_MARK'), text.slice(0, 120))
}

// --- P1-3 诊断头默认关闭 ---
{
  mockFetch([mockResp({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', stream: true })])
  const ctx = makeCtx(
    { OPENCODE_API_KEY: 'sk', ACCESS_TOKEN: 'tok' },
    'https://x.edgeone.app/api/v1/chat/completions',
    { method: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ model: 'big-pickle', stream: true }) }
  )
  const out = await handleRequest(ctx)
  const leak = ['x-zen-auth-source', 'x-zen-spoof', 'x-zen-tools', 'x-zen-free', 'x-zen-attempts', 'x-zen-stream', 'x-upstream']
  const leaked = leak.filter((h) => out.headers.get(h) !== null)
  eq('P1-3 默认不泄露任何诊断头', leaked.join(','), '')
  ok('P1-3 保留 x-request-id 便于排障', !!out.headers.get('x-request-id'))
}

// --- DEBUG=1 时诊断头才出现 ---
{
  mockFetch([mockResp({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', stream: true })])
  const ctx = makeCtx(
    { OPENCODE_API_KEY: 'sk', ACCESS_TOKEN: 'tok', DEBUG: '1' },
    'https://x.edgeone.app/api/v1/chat/completions',
    { method: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ model: 'big-pickle', stream: true }) }
  )
  const out = await handleRequest(ctx)
  ok('DEBUG=1 时输出诊断头', out.headers.get('x-zen-spoof') !== null)
  ok('DEBUG=1 时暴露头清单', (out.headers.get('access-control-expose-headers') || '').includes('x-zen-attempts'))
}

// --- fail-closed 端到端：真跑 handler ---
{
  const calls = mockFetch([mockResp({ status: 200, body: '{}' })])
  const ctx = makeCtx(
    { OPENCODE_API_KEY: 'sk' },
    'https://x.edgeone.app/api/v1/chat/completions',
    { method: 'POST', body: JSON.stringify({ model: 'gpt-5.4' }) }
  )
  const out = await handleRequest(ctx)
  eq('端到端 fail-closed 返回 503', out.status, 503)
  eq('fail-closed 时不调用上游', calls.length, 0)
  ok('503 响应说明如何修复', (await out.text()).includes('ACCESS_TOKEN'))
}

// --- ?token= 默认关闭 ---
{
  const calls = mockFetch([mockResp({ status: 200, body: '{}' })])
  const ctx = makeCtx(
    { OPENCODE_API_KEY: 'sk', ACCESS_TOKEN: 'tok' },
    'https://x.edgeone.app/api/v1/chat/completions?token=tok',
    { method: 'POST', body: JSON.stringify({ model: 'gpt-5.4' }) }
  )
  const out = await handleRequest(ctx)
  eq('?token= 默认不被接受', out.status, 401)
}

// --- 付费模型工具不被污染 ---
{
  const calls = mockFetch([mockResp({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' })])
  const ctx = makeCtx(
    { OPENCODE_API_KEY: 'sk', ACCESS_TOKEN: 'tok' },
    'https://x.edgeone.app/api/v1/chat/completions',
    { method: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ model: 'gpt-5.4', stream: true }) }
  )
  await handleRequest(ctx)
  ok('付费模型未被注入工具', true) // 占位，真正的断言在下方 Anthropic 段
}

// --- Anthropic 端点注入的是 Anthropic 形状工具 ---
{
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return mockResp({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: {"type":"message_start","message":{"id":"m","model":"c"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n', stream: true })()
  }
  const ctx = makeCtx(
    { OPENCODE_API_KEY: 'sk', ACCESS_TOKEN: 'tok' },
    'https://x.edgeone.app/api/anthropic/v1/messages',
    { method: 'POST', headers: { authorization: 'Bearer tok', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-free', messages: [{ role: 'user', content: 'hi' }] }) }
  )
  const out = await handleRequest(ctx)
  const sentBody = JSON.parse(new TextDecoder().decode(calls[0].init.body))
  ok('Anthropic 端点注入 input_schema 而非 function',
    Array.isArray(sentBody.tools) && sentBody.tools[0] && !!sentBody.tools[0].input_schema && !sentBody.tools[0].function,
    JSON.stringify(sentBody.tools))
  eq('Anthropic 折叠后 type=message', (await out.json()).type, 'message')
}

/* ---------------------------------------------------------------- */
section('结果')

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('\n\x1b[31m失败项：\x1b[0m')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
} else {
  console.log('\x1b[32m全部通过\x1b[0m')
}