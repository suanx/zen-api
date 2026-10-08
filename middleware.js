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

import { handleRequest } from './edge-functions/_shared/proxy.js' // @pack-inline

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