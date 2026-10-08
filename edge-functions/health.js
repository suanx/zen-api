/**
 * 健康检查：/health
 *
 * 原实现是一份旧版代理残留（无伪装、无强制流式、无模型过滤，且 401 门控与主逻辑不一致），
 * 现改为只上报配置状态——真正的转发逻辑统一在 edge-functions/_shared/proxy.js。
 */
import { healthResponse } from './_shared/proxy.js'

export async function onRequest(context) {
  const request = context.request
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': '*',
        'access-control-max-age': '86400',
      },
    })
  }
  return healthResponse(context)
}