#!/usr/bin/env node
/**
 * 打包脚本：版本号自动 +1，更新 version.txt 与 package.json，内联 middleware 实现，然后打 zip 到 Downloads。
 *
 * 用法:  node scripts/pack.mjs        （或 npm run pack）
 *
 * 版本号规则：每个 zip 包 build 号 +1（历史 build 1-7 见 .build 与 git 历史）。
 * version.txt 会作为静态资源部署，线上 `GET /version.txt` 即可确认是哪个包。
 *
 * middleware 内联：repo 里的 middleware.js 通过 `// @pack-inline <path>` 标记引用
 * edge-functions/_shared/proxy.js。build 7 实测根文件跨目录 import 导致全站 HTTP 545，
 * 因此打包时把该 import 行替换为被引文件的完整实现（剥离 export），zip 内自包含。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_FILE = path.join(ROOT, '.build')
const OUT = 'C:/Users/ericlx/Downloads/zen-api-final.zip'
const PY = 'C:/Users/ericlx/.workbuddy/binaries/python/versions/3.13.12/python.exe'

/* ---------- 1. build 号 +1 ---------- */
const prev = fs.existsSync(BUILD_FILE) ? parseInt(fs.readFileSync(BUILD_FILE, 'utf8').trim(), 10) : 3
if (!Number.isFinite(prev) || prev < 1) {
  console.error('.build 内容非法: ' + fs.readFileSync(BUILD_FILE, 'utf8'))
  process.exit(1)
}
const build = prev + 1
fs.writeFileSync(BUILD_FILE, String(build) + '\n')

/* ---------- 2. 更新 package.json ---------- */
const pkgPath = path.join(ROOT, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.version = `1.0.${build}`
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

/* ---------- 3. 生成 version.txt（部署后可线上访问） ---------- */
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
  `${pad(now.getHours())}:${pad(now.getMinutes())}`
const versionTxt = `zen-api-final 部署指纹
=====================
build   : ${build}
package : ${pkg.version}
built   : ${ts}
mode    : root-middleware (zip 上传形态: 仅根层函数生效, API 由 middleware 短路处理)

判别方法:
  GET /version.txt          -> 含 build ${build} 即本包已部署
  GET /ping                 -> pong 即根层函数注册正常
  GET /health               -> 200 JSON 即配置状态
  GET /api/zen/v1/models    -> 200 JSON 即全部正常
`
fs.writeFileSync(path.join(ROOT, 'version.txt'), versionTxt)

/* ---------- 4. middleware 内联（剥离 export 后替换 @pack-inline import 行） ---------- */
const mwPath = path.join(ROOT, 'middleware.js')
const mwSrc = fs.readFileSync(mwPath, 'utf8')
const inlineRe = /^import\s*\{[^}]*}\s*from\s*'([^']+)'\s*\/\/\s*@pack-inline.*$/m
const m = mwSrc.match(inlineRe)
if (!m) {
  console.error('middleware.js 缺少 @pack-inline 标记行，打包中止')
  process.exit(1)
}
const implRel = m[1] // ./edge-functions/_shared/proxy.js
const implSrc = fs.readFileSync(path.join(ROOT, implRel), 'utf8')
// 剥离 export 关键字，使其成为 middleware 模块内部的普通声明
const implInline = implSrc
  .replace(/^export\s+(async\s+)?/gm, '$1')
  .replace(/^export\s+/gm, '')
const mwStandalone = mwSrc.replace(inlineRe, () => implInline)
// 确认内联后无残留跨目录 import
if (mwStandalone.match(/^import .*edge-functions/m)) {
  console.error('middleware 内联后仍有跨目录 import，打包中止')
  process.exit(1)
}

// 语法自检：内联产物必须可解析且导出 onRequest（进程内动态 import，避免 Windows spawn EBUSY）
const tmpCheck = path.join(os.tmpdir(), 'zenapi_mw_check_' + build + '.mjs')
fs.writeFileSync(tmpCheck, mwStandalone)
try {
  const mod = await import(pathToFileURL(tmpCheck).href)
  if (typeof mod.onRequest !== 'function') {
    throw new Error('内联产物未导出 onRequest')
  }
  console.log('middleware 内联完成: ' + implSrc.length + 'B 实现 -> zip 内自包含, import+语法检查通过')
} catch (e) {
  console.error('内联后的 middleware 校验失败：')
  console.error(String(e.message || e).slice(0, 800))
  try { fs.unlinkSync(tmpCheck) } catch (e2) {}
  process.exit(1)
}
try { fs.unlinkSync(tmpCheck) } catch (e2) {}

/* ---------- 5. 打 zip（先在临时树中替换 middleware） ---------- */
// _zip.py 直接扫 ROOT；为让 zip 内的 middleware 是内联版而 repo 原件不动，
// 备份放系统临时目录（避免被打进 zip），打包完成后还原。
const bakPath = path.join(os.tmpdir(), 'zenapi_mw_repo_' + build + '.js')
fs.copyFileSync(mwPath, bakPath)
fs.writeFileSync(mwPath, mwStandalone)
fs.mkdirSync(path.dirname(OUT), { recursive: true })
try {
  fs.unlinkSync(OUT)
} catch (e) {}
const pyList = [PY, 'python', 'py']
let used = null
try {
  for (const py of pyList) {
    try {
      execFileSync(py, [path.join(ROOT, 'scripts', '_zip.py'), ROOT, OUT, ''], { stdio: 'inherit' })
      used = py
      break
    } catch (e) {
      /* 尝试下一个 */
    }
  }
} finally {
  // 无论成败都还原 repo 原件
  try {
    fs.copyFileSync(bakPath, mwPath)
    fs.unlinkSync(bakPath)
  } catch (e) {
    console.error('警告：还原 middleware.js 失败', e.message)
  }
}
if (!used) {
  console.error('没有可用的 python，无法打 zip')
  process.exit(1)
}

const size = (fs.statSync(OUT).size / 1024).toFixed(1)
console.log(`\nbuild ${build} (${pkg.version}) 打包完成 -> ${OUT} (${size} KB, python=${used})`)
console.log(`部署后访问 /version.txt 应显示 build ${build}`)
