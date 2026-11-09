// sync-dsh-token.mjs —— 把 DSH 的最新启动令牌同步进桥的 config.json
//
// 为什么需要它：**DSH 每次重启都会生成新令牌**，而桥的 config.json 里存的是旧的。
// 症状：state\bridge.log 里一秒一条
//       「事件流中断: DSH *** failed: HTTP 401」
//       → 群里的消息进不来、她也发不出去。
// 原理：DSH 的 WebView 壳每次启动都会往 %LOCALAPPDATA%\DSH\shell.log 追加一行
//       「started own service, token captured -> http://127.0.0.1:3080/?token=xxx」
//       —— 取最后一行里那个就是当前有效的。
//
// 用法：node scripts/sync-dsh-token.mjs      （或双击 qq-bridge\sync-dsh-token.cmd）
// ⚠️ 改完要**重启桥**才生效（桥是启动时读 config 的）。
// ⚠️ 输出故意用英文：.cmd 窗口是 GBK，中文会乱码。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const cfgPath = path.resolve(here, '..', 'config.json')
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const logPath = path.join(localAppData, 'DSH', 'shell.log')

const TOKEN_PATTERN =
  /started own service, token captured -> http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]{43})/g

function latestToken(text) {
  const re = new RegExp(TOKEN_PATTERN.source, 'g')
  let match
  let last = null
  while ((match = re.exec(text)) !== null) last = match[1]
  return last
}

// ⭐ 2026-10-12 加（搬家到官方 DSH 桌面版时）：**第二个来源** ——
//    官方 Electron app **不写** %LOCALAPPDATA%\DSH\shell.log（那是人家自制的
//    WinForms 外壳写的），所以上面那条路在官方 app 下抓不到任何东西。
//    → 解法：在 desktop profile 里挂了一个 `dsh-token-reporter` 插件
//      （`plugins\dsh-token-reporter.mjs`），它用官方自己的公开姿势
//      `ctx.connection.authenticatedUrl(origin)` 把带令牌的 URL 写到这个 json。
//    ⚠️ 那个文件里含凭据 —— 别外发、别贴聊天、别进记忆库。
const launchJsonPath = path.resolve(here, '..', 'state', 'dsh-launch.json')

function tokenFromLaunchJson() {
  try {
    const j = JSON.parse(fs.readFileSync(launchJsonPath, 'utf8'))
    const m = /[?&]token=([A-Za-z0-9_-]+)/.exec(String(j.url || ''))
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

// ⭐ 2026-10-18 加：**baseUrl 也要同步**。
//    来历：DSH 0.2.1 之后端口变成"系统分配"（每次重启都可能变：19387 → 64463 → 59026…），
//    而本脚本原来只换 authToken、不动 baseUrl ——
//    结果桥拿着新令牌去连**旧端口**，日志里一秒一条「事件流中断: fetch failed」，
//    启动器就报「QQ桥已启动但未通过DSH鉴权检查」。
//    ⚠️ 改了 baseUrl 同样要重启桥才生效。
function originFromLaunchJson() {
  try {
    const j = JSON.parse(fs.readFileSync(launchJsonPath, 'utf8'))
    const m = /^(http:\/\/127\.0\.0\.1:\d+)/.exec(String(j.url || ''))
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

function fail(message) {
  console.log('FAIL: ' + message)
  process.exitCode = 1
}

function main() {
  if (!fs.existsSync(cfgPath)) return fail('config.json not found: ' + cfgPath)

  // ⭐ 两个来源，优先插件写的那个（官方 app 下只有它有效）；
  //    都没有才回落到自制外壳的 shell.log（旧环境照旧能用）。
  let token = tokenFromLaunchJson()
  const origin = originFromLaunchJson()
  let source = 'state/dsh-launch.json (token-reporter 插件)'
  if (!token) {
    if (fs.existsSync(logPath)) {
      token = latestToken(fs.readFileSync(logPath, 'utf8'))
      source = 'shell.log (自制外壳)'
    }
  }
  if (token === null || token === undefined || token === '') {
    return fail('no launch token found in either source (dsh-launch.json / shell.log)')
  }
  console.log('source: ' + source)

  const raw = fs.readFileSync(cfgPath, 'utf8')
  const found = /"authToken"\s*:\s*"([^"]*)"/.exec(raw)
  if (found === null) return fail('no dsh.authToken field in config.json')

  const baseFound = /"baseUrl"\s*:\s*"http:\/\/127\.0\.0\.1:(\d+)"/.exec(raw)
  if (baseFound === null) return fail('no dsh.baseUrl field in config.json')

  let changed = false
  let out = raw
  // ⭐ baseUrl 同步（2026-10-18 加）：端口跟着 launch.json 走
  if (origin) {
    const currentPort = baseFound[1]
    if (currentPort !== origin.replace('http://127.0.0.1:', '')) {
      out = out.replace(/(\"baseUrl\"\s*:\s*\"http:\/\/127\.0\.0\.1:)\d+(\")/g, '$1' + origin.replace('http://127.0.0.1:', '') + '$2')
      changed = true
    }
  }
  // ⭐ token 同步（原有行为）
  if (found[1] !== token) {
    out = out.replace(/("authToken"\s*:\s*")[^"]*(")/, '$1' + token + '$2')
    changed = true
  }

  if (!changed) {
    console.log('OK: config already up to date (token ' + token.slice(0, 4) + '..., baseUrl ' + baseFound[1] + '). Nothing changed.')
    return
  }

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  const bakPath = cfgPath + '.bak-' + stamp
  fs.copyFileSync(cfgPath, bakPath)
  fs.writeFileSync(cfgPath, out, 'utf8')

  console.log('DONE: config updated (token ' + token.slice(0, 4) + '..., baseUrl ' + (origin || '(unchanged)') + ')')
  console.log('  old token   -> ' + found[1].slice(0, 4) + '...')
  console.log('  backup      -> ' + path.basename(bakPath))
  console.log('  NEXT STEP   -> restart the bridge (qq-bridge)')
}

main()
