# Zen API — OpenCode Zen 反向代理

部署在 EdgeOne Makers（Edge Functions）上的 OpenCode Zen 反向代理。
统一 OpenAI / Anthropic / Responses 三套协议，带客户端身份伪装、流式折叠与 fail-closed 鉴权。

> ⚠ **上游免费档已被封锁**（2026-10-05 起实测确认）：调用 `-free` / `big-pickle` 会返回
> `FreeTierError: OpenCode's free tier can only be used from within OpenCode`，
> 已验证与伪装无关。**付费档（自带 Key）不受影响。**
> 本项目当前的实际价值是：自有域名统一入口 + 三套协议转换 + 鉴权管控。

## 快速开始

1. 把整个目录上传到 EdgeOne Makers（构建输出目录即仓库根）。
2. 在「项目设置 → 环境变量」至少配置 `ACCESS_TOKEN`（见下）。
3. 访问 `/health` 确认配置状态 —— 返回 JSON 说明函数已生效。
4. 访问 `/api/zen/v1/models` 确认代理路由已生效。
5. 本地跑 `npm test`，其中路由自检会确认目录名等易错项。

> 如果 `/health` 正常但 `/api/*` 404，几乎一定是目录名写成了 `functions/` 而非 `edge-functions/`。
> 跑 `node --experimental-default-type=module test/routes.js` 可自检。

## 端点

| 路径 | 上游 | 用途 |
|---|---|---|
| `/api/zen/v1/*` | `opencode.ai/zen/v1/*` | **推荐**，OpenAI SDK |
| `/api/anthropic/v1/*` | `opencode.ai/zen/v1/*` | Anthropic SDK |
| `/api/v1/*` | `opencode.ai/zen/v1/*` | 等价于上面两条 |
| `/v1/*` `/zen/*` `/anthropic/*` | 同上 | 兼容路径 |

`base_url` 填 `<域名>/api/zen/v1`，Anthropic 填 `<域名>/api/anthropic`。

## 环境变量

### 鉴权（必读）

| 变量 | 默认 | 说明 |
|---|---|---|
| `ACCESS_TOKEN` | — | **网关口令**。客户端必须带 `Authorization: Bearer <ACCESS_TOKEN>` |
| `OPENCODE_API_KEY` | — | 服务端上游 Key。填了客户端就无需自带 Key |
| `ZEN_API_KEY` | — | `OPENCODE_API_KEY` 的别名 |
| `ALLOW_OPEN_ACCESS` | `0` | 设为 `1` 才允许「有服务端 Key 但无口令」的裸奔模式（不建议） |
| `ALLOW_QUERY_TOKEN` | `0` | 设为 `1` 才允许 `?token=xxx`（会进日志/Referer，默认关闭） |
| `ALLOWED_ORIGINS` | `*` | 逗号分隔的 Origin 白名单 |

> **fail-closed**：配置了 `OPENCODE_API_KEY` 却没配 `ACCESS_TOKEN` 时，网关一律返回 **503**。
> 这是有意的——否则任何人都能白嫖你的付费 Key。确需开放请显式设 `ALLOW_OPEN_ACCESS=1`。

### 功能开关

| 变量 | 默认 | 说明 |
|---|---|---|
| `PUBLIC_MODELS` | 未配置时 = 无服务端 Key | 显式 `1` 则 `/models` 始终匿名放行；显式关闭词则始终要求口令 |
| `FREE_MODELS_ONLY` | `1` | `/models` 只返回免费模型 |
| `FREE_MODEL_EXTRA` | — | 逗号分隔，额外视为免费的模型 ID |
| `ZEN_SPOOF_CLIENT` | `1` | 开启官方客户端身份伪装 |
| `ZEN_SPOOF_ALL` | `1` | 付费模型也伪装（上游只校验免费档，伪装无害） |
| `ZEN_FORCE_TOOLS` | `1` | 免费档补齐上游要求的 `bash` / `read` 工具 |
| `FREE_TIER_ANONYMOUS` | `1` | 免费档优先匿名请求，失败再回退 Key |
| `DEBUG` | `0` | 设为 `1` 才输出 `x-zen-*` 诊断头（默认关闭，避免泄露付费模式/伪装状态） |

控制台不允许把变量留空，填 `anonymous` / `none` / `off` / `false` / `0` / `-` 等关闭词视为「未配置」。

## 架构

> ⚠ **路由注册的三个坑（三次线上排查得出，全部实测验证）**
>
> 1. **目录名必须是 `edge-functions/`**。写成 `functions/`（旧版 Pages Functions 的目录名），
>    平台根本不扫描——静态页正常，但函数全部不注册。
> 2. **`[[default]].js` catch-all 实测不注册**（官方文档声称支持，实测回退静态资源）。
> 3. **方括号命名的文件/目录（含动态链 `[a]/[b]`）也不注册**——平台函数发现按 glob 扫描，
>    方括号被当作字符类通配符吞掉。
>
> 因此本项目最终采用**普通名称的显式路由文件**（`api/zen/v1/models.js` → `/api/zen/v1/models`），
> 这是唯一被线上验证可靠的形态。部署判别：`GET /version.txt` 看 build 号。
>
> 判断技巧：`/health` 正常而 `/api/*` 404 = 路由没注册（查上面三条）；连 `/` 都打不开 = 站点/域名层问题。

```
edge-functions/
  _shared/proxy.js          唯一实现来源（下划线前缀，不注册为路由）
  api/zen/v1/models.js      显式路由，每条路径一个普通名文件
  api/zen/v1/chat/completions.js
  api/anthropic/v1/messages.js
  v1/... zen/... anthropic/...   兼容路径组（models/chat/completions/responses/embeddings/moderations）
  api/index.js              → /api（usage 说明）
  health.js                 → /health，只上报配置状态
index.html                 落地页
test.html                  Playground
test/run.js                回归测试（81 项）
test/routes.js             路由注册自检（31 项，含 import 全量加载）
scripts/pack.mjs           打包脚本（build 号自动 +1，写 version.txt）
version.txt                部署指纹，线上可访问，用于确认部署的是哪个 build
```

注意：API 端点为**显式枚举**（models / chat/completions / completions / responses /
embeddings / moderations / messages / complete）。上游新增端点时需在
`edge-functions/` 下补对应文件（3 行 re-export），再跑 `npm test`。

注意：`[[default]].js` 是 catch-all，按平台规则匹配**一段或多段**子路径。
`api/[[default]].js` 能匹配 `/api/zen/v1/models`，但不匹配 `/v2/vip/1024`。

## 开发

```bash
npm test                    # 跑两个测试
node --experimental-default-type=module test/run.js      # 功能回归 81 项
node --experimental-default-type=module test/routes.js   # 路由自检 31 项
```

零依赖，覆盖 fail-closed 鉴权、路径映射、三套协议的 SSE 折叠、重试顺序、诊断头开关。

## 已知限制

- **上游免费档已被封锁（2026-10-05 起实测确认）**。调用 `-free` / `big-pickle` 会返回
  `FreeTierError: OpenCode's free tier can only be used from within OpenCode`。
  已验证与伪装无关——完整客户端头、非流式、无伪装头三种方式均返回同一错误，
  上游已在校验真实客户端身份。**付费档（自带 Key）不受影响。**
  因此本项目当前的实际价值是：自有域名统一入口 + 三套协议转换 + 鉴权管控。
- 免费模型判定依赖模型名含 `free` / `big-pickle`。若上游新增不带后缀的免费模型，
  需把它们加进 `FREE_MODEL_EXTRA`。
- 上游客户端身份校验随版本更新可能变化，届时需更新 `ZEN_UA_VERSION`。
- 非流式请求时网关会强制上游走 SSE 再折叠回来，因此**大回复会整体缓冲**，延迟略高于原生非流式。
- `edge-functions/_shared/` 以下划线开头，EdgeOne 不会将其识别为路由，仅作模块引用。

## 前端

- `index.html` —— 落地页，如实反映上游现状与部署要点。
- `test.html` —— Playground。Key 只存本机 localStorage，提供「清除本地保存的 Key」按钮；
  所有状态渲染走 `textContent` / DOM 构造，不拼 innerHTML；curl 预览里 Key 首尾各留 2 位、其余打码。