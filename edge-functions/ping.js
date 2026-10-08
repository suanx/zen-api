/**
 * 根层探针：/ping -> "pong"
 * 用于部署后验证「edge-functions/ 根层普通名函数可注册」这一平台行为仍然成立。
 * 与 /health（配置状态 JSON）互补；是路由排障的判别点之一。
 */
export function onRequest() {
  return new Response('pong', {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}