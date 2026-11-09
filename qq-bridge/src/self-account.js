// 机器人自己的公开资料。与管理员私人记忆预设隔离，不提供任意 OneBot action。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {dayKey,nextDay} from './qzone-policy.js'
const DAY = 24 * 60 * 60 * 1000
const INTERVAL = { groupCard: DAY, nickname: DAY, signature: DAY, avatar: DAY, qzone: 0 }
const TYPES = { groupCard: 'set_group_card', nickname: 'set_qq_profile', signature: 'set_self_longnick', avatar: 'set_qq_avatar', qzone: 'send_qzone_msg' }

export class SelfAccount {
  constructor(root, sensitive) {
    this.root = root
    this.sensitive = sensitive
    this.stateFile = path.join(root, 'state', 'self-account.json')
    this.images = path.join(root, 'assets', 'self-avatars')
    this.busy = false
  }
  load() {
    if (!fs.existsSync(this.stateFile)) return { expectedSelfId: null, last: {} }
    const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8').replace(/^\uFEFF/, ''))
    if (!data || !data.last || typeof data.last !== 'object' || Array.isArray(data.last)) throw new Error('账号状态损坏，请由管理端处理')
    if(data.pending?.operation==='qzone'&&!data.qzonePending)data.qzonePending={day:dayKey(data.pending.at),at:data.pending.at,legacy:true}
    return data
  }
  save(data) {
    const temporary = this.stateFile + '.' + crypto.randomUUID() + '.tmp'
    try {
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { flag: 'wx' })
      fs.renameSync(temporary, this.stateFile)
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
  }
  async onebot(cfg, action, params = {}) {
    const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '')
    const response = await fetch(base + '/' + action, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(cfg.snowluma?.accessToken ? { authorization: 'Bearer ' + cfg.snowluma.accessToken } : {}) },
      body: JSON.stringify(params), signal: AbortSignal.timeout(15000),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || !body || body.status !== 'ok' || body.retcode !== 0) throw new Error('QQ接口未确认成功，请由管理端查看网关状态')
    return body.data
  }
  async pin(cfg) {
    const info = await this.onebot(cfg, 'get_login_info')
    const id = String(info?.user_id ?? '')
    if (!/^[1-9]\d*$/.test(id)) throw new Error('未取得机器人登录身份')
    const state = this.load()
    if (state.expectedSelfId && state.expectedSelfId !== id) throw new Error('登录账号与已绑定机器人不同，停止资料操作')
    state.expectedSelfId = id
    this.save(state)
    return { pinned: true }
  }
  checkedImage(name) {
    if (typeof name !== 'string' || name.length > 100 || !/\.(png|jpe?g|webp)$/i.test(name) || /[\\/:\x00-\x1f]/.test(name) || name.includes('..')) throw new Error('图片ID无效')
    const root = path.resolve(this.images)
    const rootInfo = fs.lstatSync(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || fs.realpathSync(root).toLowerCase() !== root.toLowerCase()) throw new Error('图片目录不可用')
    const actualName = fs.readdirSync(root).find(item => item === name)
    if (!actualName) throw new Error('图片不在批准的候选列表')
    const candidate = path.join(root, actualName)
    const before = fs.lstatSync(candidate)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4 * 1024 * 1024) throw new Error('图片不符合读取规则')
    if (path.dirname(fs.realpathSync(candidate)).toLowerCase() !== root.toLowerCase()) throw new Error('图片不符合读取规则')
    const fd = fs.openSync(candidate, 'r')
    try {
      const opened = fs.fstatSync(fd)
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error('图片读取期间发生变化')
      const data = Buffer.alloc(before.size)
      let total = 0
      while (total < data.length) { const amount = fs.readSync(fd, data, total, data.length - total, null); if (!amount) break; total += amount }
      const after = fs.lstatSync(candidate)
      const final = fs.fstatSync(fd)
      if (total !== before.size || after.isSymbolicLink() || after.ino !== opened.ino || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs) throw new Error('图片读取期间发生变化')
      const valid = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || (data[0] === 255 && data[1] === 216 && data[2] === 255) || (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP')
      if (!valid) throw new Error('仅允许PNG、JPEG、WebP图片')
      return 'base64://' + data.toString('base64')
    } finally { fs.closeSync(fd) }
  }
  text(value, max, multiline = false) {
    if (typeof value !== 'string') throw new Error('需要文本参数')
    const text = (multiline ? value.replace(/\r\n?/g, '\n') : value).trim()
    const controls = multiline ? /[\x00-\x09\x0b-\x1f\x7f]/ : /[\x00-\x1f\x7f]/
    if (!text || Array.from(text).length > max || controls.test(text) || /\[CQ:/i.test(text)) throw new Error('文本为空、过长或包含控制内容')
    this.sensitive.lastIndex = 0
    if (this.sensitive.test(text)) throw new Error('公开文本触发隐私审计，请改写')
    return text
  }
  async execute(cfg, key, input, qzoneAuthorization=null) {
    if (this.busy) throw new Error('账号操作进行中，请稍后再试')
    this.busy = true
    try {
      const state = this.load()
      if (!state.expectedSelfId) throw new Error('尚未由管理端绑定机器人身份')
      const login = await this.onebot(cfg, 'get_login_info')
      if (String(login?.user_id ?? '') !== state.expectedSelfId) throw new Error('当前登录账号不是已绑定机器人')
      const operation = String(input.operation ?? '')
      if (operation === 'status') {
        const candidates = fs.existsSync(this.images) ? fs.readdirSync(this.images).filter(name => /\.(png|jpe?g|webp)$/i.test(name)) : []
        return { ok: true, nickname: login.nickname, avatarCandidates: candidates,
          nextAllowedAt: Object.fromEntries(Object.entries(INTERVAL).map(([name, interval]) => {
            const bucket = name === 'groupCard' ? 'groupCard:' + key : name
            return [name, state.last[bucket] ? new Date(name==='qzone'?nextDay(state.last[bucket]):state.last[bucket]+interval).toISOString() : null]
          })), qzoneVisibility: '好友可见', qzoneMaxPerDay: 1, qzoneTimezone:'Asia/Shanghai', qzoneMode:'random-today-experiences-or-skip',qzoneNeedsReview:!!state.qzonePending }
      }
      if (!Object.hasOwn(TYPES, operation)) throw new Error('账号操作不支持')
      const limits = cfg.socialV2?.selfAccount ?? {}
      if (limits.enabled === false || limits[operation] === false) throw new Error('管理端已关闭该能力')
      const bucket = operation === 'groupCard' ? 'groupCard:' + key : operation
      const now = Date.now()
      if(operation==='qzone'){
        if(state.qzonePending)throw new Error('动态上次结果待核对，不自动重发');
        if(state.last.qzone&&dayKey(state.last.qzone)===dayKey(now))throw new Error('动态当天已占用名额，一天最多一条');
      }
      if (state.last[bucket] && now - state.last[bucket] < INTERVAL[operation]) throw new Error('尚未到允许再次操作的时间：' + new Date(state.last[bucket] + INTERVAL[operation]).toISOString())
      let params, qzoneProof
      if (operation === 'groupCard') params = { group_id: Number(key.slice(6)), user_id: Number(state.expectedSelfId), card: this.text(input.text, 30) }
      if (operation === 'nickname') params = { nickname: this.text(input.text, 30) }
      if (operation === 'signature') params = { longNick: this.text(input.text, 100) }
      if (operation === 'avatar') params = { file: this.checkedImage(input.imageId) }
      if (operation === 'qzone') {
        const ids = input.imageIds ?? []
        if (!Array.isArray(ids) || ids.length > 4) throw new Error('动态最多4张批准的图片')
        params = { content: this.text(input.text, 500, true), ugc_right: 4 }
        if (ids.length) params.images = ids.map(id => this.checkedImage(id))
        qzoneProof = typeof qzoneAuthorization === 'function' ? qzoneAuthorization() : qzoneAuthorization
        if (!qzoneProof || qzoneProof.day !== dayKey(now)) throw new Error('动态缺少当天有效随机机会')
      }
      // 先持久化占用窗口。接口超时后可能已成功，禁止自动重发产生重复动态。
      state.last[bucket] = now
      state.pending = { operation, at: now }
      if(operation==='qzone')state.qzonePending={day:dayKey(now),at:now,evidenceIds:qzoneProof.evidenceIds};
      this.save(state)
      try {
        await this.onebot(cfg, TYPES[operation], params)
        state.pending = null
        if(operation==='qzone')state.qzonePending=null;
        this.save(state)
        return { ok: true, operation, nextAllowedAt: new Date(operation==='qzone'?nextDay(now):now+INTERVAL[operation]).toISOString() }
      } catch {
        throw new Error('QQ未确认结果，可能已经执行；请管理员查看，不要自动重试')
      }
    } finally { this.busy = false }
  }
}
