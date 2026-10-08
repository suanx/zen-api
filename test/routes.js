/**
 * 路由注册自检 —— 在本地模拟 EdgeOne Makers 的路由发现规则
 *
 * 历史教训（三次排查，2026-10-08）：
 *   1. functions/ 目录名 → Makers 只扫描 edge-functions/
 *   2. api/[[default]].js catch-all → 实测不注册
 *   3. [a]/[b]/chain.js 动态链 → 也不注册
 *   唯一生效的是普通文件名路由（health.js）。
 *   根因：平台函数发现按 glob 扫描，方括号被当作字符类通配符吞掉。
 * 因此本项目最终采用【普通名显式路由文件】，本自检守住以下不变量：
 *   - 不存在任何方括号路径
 *   - 每个显式路由文件存在且 import 可解析
 *   - 关键 API 路径全部有精确对应文件
 *   - 共享实现的单点来源
 *
 * 用法：node --experimental-default-type=module test/routes.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FUNC_DIR = path.join(ROOT, 'edge-functions')


let pass = 0
let fail = 0
const problems = []

function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log('  \x1b[32mPASS\x1b[0m ' + name)
  } else {
    fail++
    problems.push(name + (detail ? ' -> ' + detail : ''))
    console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  (' + detail + ')' : ''))
  }
}

/* ---------------- 1. 目录与命名 ---------------- */
console.log('\n\x1b[1m1. 目录与命名（三次排查的教训）\x1b[0m')
ok('存在 edge-functions/ 目录', fs.existsSync(FUNC_DIR))
ok(
  '不存在遗留的 functions/ 目录（Makers 不扫描）',
  !fs.existsSync(path.join(ROOT, 'functions'))
)

// 收集所有路由文件（跳过 _shared）
const routeFiles = []
;(function collect(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name)
    const rel = path.relative(FUNC_DIR, abs).split(path.sep).join('/')
    if (e.isDirectory()) {
      if (e.name.startsWith('_')) continue
      collect(abs)
      continue
    }
    if (e.name.endsWith('.js')) routeFiles.push(rel)
  }
})(FUNC_DIR)

const bracketed = routeFiles.filter((f) => /[\[\]]/.test(f))
ok('没有任何方括号路径（glob 会吞掉它们）', bracketed.length === 0, bracketed.join(', '))

/* ---------------- 2. 显式路由清单 ---------------- */
console.log('\n\x1b[1m2. 显式路由清单\x1b[0m')
// 文件 -> URL：dir/index.js -> /dir；dir/name.js -> /dir/name
function toUrl(rel) {
  const parts = rel.replace(/\.js$/, '').split('/')
  if (parts[parts.length - 1] === 'index') {
    parts.pop()
    return '/' + parts.join('/')
  }
  return '/' + parts.join('/')
}
const routes = routeFiles.map(toUrl).sort()
console.log('  共 ' + routes.length + ' 条显式路由')

const REQUIRED = [
  // 用户报障的那条
  '/api/zen/v1/models',
  '/api/zen/v1/chat/completions',
  // OpenAI 兼容组
  '/v1/models',
  '/v1/chat/completions',
  '/v1/responses',
  '/v1/completions',
  '/v1/embeddings',
  '/v1/moderations',
  // Anthropic
  '/api/anthropic/v1/messages',
  '/anthropic/v1/messages',
  '/api/anthropic/v1/complete',
  // 别名组
  '/api/v1/models',
  '/api/v1/chat/completions',
  '/zen/v1/chat/completions',
  // 健康与入口
  '/health',
  '/api',
  '/api/zen',
  '/api/anthropic',
  '/api/v1',
  '/v1',
  '/zen',
  '/anthropic',
]
for (const u of REQUIRED) {
  ok(u + ' 有精确对应路由文件', routes.includes(u), '缺失 -> 会 404 回退静态资源')
}

/* ---------------- 3. import 解析（全部真实加载） ---------------- */
console.log('\n\x1b[1m3. 全量 import 解析\x1b[0m')
let impOk = 0
let impBad = 0
for (const rel of routeFiles) {
  try {
    const mod = await import(pathToFileURL(path.join(FUNC_DIR, rel)).href)
    if (typeof mod.onRequest === 'function') impOk++
    else {
      impBad++
      problems.push(rel + ' 未导出 onRequest')
      console.log('  \x1b[31mFAIL\x1b[0m ' + rel + ' 未导出 onRequest')
    }
  } catch (err) {
    impBad++
    problems.push(rel + ' import 失败: ' + (err.code || err.message))
    console.log('  \x1b[31mFAIL\x1b[0m ' + rel + ' import 失败 ' + (err.code || err.message))
  }
}
ok(
  '全部 ' + routeFiles.length + ' 个路由文件 import 可解析且导出 onRequest',
  impBad === 0 && impOk === routeFiles.length,
  impBad + ' 个失败'
)

/* ---------------- 4. middleware（zip 上传形态的终极方案） ---------------- */
console.log('\n\x1b[1m4. 全局 middleware（项目根）\x1b[0m')
const MW = path.join(ROOT, 'middleware.js')
ok('middleware.js 存在于项目根', fs.existsSync(MW))
if (fs.existsSync(MW)) {
  try {
    const mod = await import(pathToFileURL(MW).href)
    ok('middleware 导出 onRequest', typeof mod.onRequest === 'function')
  } catch (err) {
    ok('middleware import 可解析', false, err.code || err.message)
  }
  const src = fs.readFileSync(MW, 'utf8')
  ok('middleware 覆盖 /api/ /v1/ /zen/ /anthropic/ 前缀', ['/api/', '/v1/', '/zen/', '/anthropic/'].every((p) => src.includes("'" + p + "'")))
  ok('middleware 对非 API 调用 context.next() 放行', /context\.next\(\)/.test(src))
}
ok(
  '根层探针 ping.js 存在（/ping -> pong，验证根层函数注册）',
  fs.existsSync(path.join(FUNC_DIR, 'ping.js'))
)

/* ---------------- 5. 共享实现单点来源 ---------------- */
console.log('\n\x1b[1m5. 共享实现\x1b[0m')
const shared = path.join(FUNC_DIR, '_shared', 'proxy.js')
ok('_shared/proxy.js 存在', fs.existsSync(shared))
const sharedSrc = fs.readFileSync(shared, 'utf8')
ok('导出 handleRequest', /export\s+(async\s+)?function\s+handleRequest/.test(sharedSrc))
ok('导出 healthResponse', /export\s+function\s+healthResponse/.test(sharedSrc))
ok('内置 API 前缀白名单', /API_PREFIXES\s*=\s*\[/.test(sharedSrc))

// 所有路由文件都应 re-export 自 _shared（ping.js 探针除外——它只返回 pong，无代理逻辑）
const inlineImpl = routeFiles.filter((f) => {
  if (f === 'ping.js') return false
  const src = fs.readFileSync(path.join(FUNC_DIR, f), 'utf8')
  return !/_shared\/proxy\.js/.test(src)
})
ok('所有路由文件均 re-export 共享实现（无第二份实现）', inlineImpl.length === 0, inlineImpl.join(', '))

/* ---------------- 结果 ---------------- */
console.log('\n\x1b[1m结果\x1b[0m')
console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('\n\x1b[31m问题：\x1b[0m')
  problems.forEach((p) => console.log('  - ' + p))
  process.exit(1)
} else {
  console.log('\x1b[32m路由注册检查全部通过\x1b[0m')
}