// 扩展模块「看直播」—— 放在 Aurabot 数据目录 modules/kanzhibo/ 里，插件升级不会动它。
// 保存就生效（几秒内自动重新加载），出错了去面板「已安装」页看原因。
//
// 干的事：
//   1. 用一台独立的 Edge 窗口挂在抖音直播间（给直播间地址，或给主播主页自己找「直播中」）。
//   2. 进房期间把「刷抖音」暂停，离开直播间 / 关掉挂直播后自动恢复。
//   3. 等页面真正加载出来（有评论框了）再发一条你自己定制的评论，同一个房间只发一次。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClicker } from './lib/click.mjs'
import { createGate } from './lib/gate.mjs'

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

const LIVE_RE = /^https:\/\/live\.douyin\.com\//

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findBrowser() {
  return BROWSERS.find((p) => existsSync(p)) || ''
}

async function getJson(url, ms = 3000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return r.json()
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP 出错'))
      else p.resolve(msg.result || {})
    })
    ws.addEventListener('close', () => {
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('浏览器连接断了')) }
      this.pending.clear()
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连 CDP 超时')), 8000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连不上 CDP')) })
    })
    return new Cdp(ws)
  }

  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP 超时：' + method)) }, 20000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try { this.ws.close() } catch {}
  }
}

export default {
  id: 'kanzhibo',
  // 名字里有「抖音」：面板导航的分组是看模块名来分的（逛/刷/B站/抖音/小红书/闲鱼/淘宝/微博/知乎/贴吧/快手/触站/小黑盒 → 「平台」组，
  // 其余归一「系统」组）。所以这个模块要在「平台」下挂着，名字就得带上「抖音」。改名会连带面板标签一起变。
  name: '抖音看直播',
  version: '0.4.3',
  api: 1,
  description: '挂抖音直播间 + 进房评论 + 续粉丝团灯牌，挂着时自动暂停刷抖音；送礼另有一道锁（只认主人私聊）',

  defaults: {
    enabled: false,
    target: '',
    checkSec: 120,
    schedule: false,
    startTime: '20:00',
    endTime: '23:30',
    liveCommentOn: false,
    liveComment: '',
    commentDelaySec: 8,
    renewBadge: false,
    badgeDelaySec: 30,
    // 2026-11-06 加：送礼是花抖币的真动作，单独一道锁，默认关着。
    giftByDm: false,
    // 2026-11-06 加：半自动 —— 真点下去之前先截图发主人私聊，等他一句「确认」。
    semiAuto: true,
    // 等你点头等多少秒（超时就自动撤，不点）
    confirmSec: 90,
    minuteReport: false,
  },
  // 面板是自定义的（panel.js 按大类分卡片）；字段清单放在 settingsSchema 里，自检脚本也读它。
  settings: [],
  settingsSchema: [
  // 顺序按「要不要挂 → 什么时候挂 → 挂谁 → 进房评论 → 灯牌 → 礼物 → 调试」排（面板里是按大类分的卡片）。
    // —— 挂直播：要不要挂 / 什么时候挂 ——
    { key: 'enabled', label: '挂直播', type: 'switch', hint: '开着才按下面的时段自己进房；进房期间刷抖音自动暂停' },
    { key: 'schedule', label: '只在时段内挂', type: 'switch', hint: '关掉 = 全天挂着；开着只在下面那段时间进房，其余时间刷抖音照常' },
    { key: 'startTime', label: '开始时间', type: 'text', placeholder: '21:07', hint: '24 小时制，写成 21:07' },
    { key: 'endTime', label: '结束时间', type: 'text', placeholder: '23:00', hint: '可以跨午夜，比如 22:30 → 01:00' },
    // —— 挂谁 ——
    {
      key: 'target',
      label: '直播间或主页',
      type: 'text',
      placeholder: 'https://live.douyin.com/123456789',
      hint: '直播间链接最稳；给主播主页（douyin.com/user/…）会自己找「直播中」点进去',
    },
    { key: 'checkSec', label: '多久看一次（秒）', type: 'number', min: 30, max: 1800, step: 30, hint: '不在直播间就重新进；改完立刻生效，不用重载模块' },
    // —— 进房评论（默认关）——
    { key: 'liveCommentOn', label: '进房发评论', type: 'switch', hint: '默认关。打开后每天最多发一次，同一个直播间不重复发' },
    { key: 'liveComment', label: '评论内容', type: 'textarea', hint: '多行只发第一行；留空就不发' },
    { key: 'commentDelaySec', label: '等几秒再发（秒）', type: 'number', min: 0, max: 120, step: 1, hint: '等画面和评论框出来，默认 8 秒' },
    // —— 粉丝团灯牌：真的会去点左上角那一块，有误触风险 ——
    {
      key: 'renewBadge',
      label: '续粉丝团灯牌',
      type: 'switch',
      hint: '⚠ 真会去点左上角：可能点偏到顶栏 / 礼物栏 / 别人的头像，点完会回读「今日任务」确认。细节看下面「风险与现场」',
    },
    { key: 'badgeDelaySec', label: '等几秒再续（秒）', type: 'number', min: 5, max: 600, step: 5, hint: '默认 30 秒。越早越容易点偏，宁晚不早' },
    // —— 礼物：花抖币，只认主人私聊 + 这道开关 ——
    {
      key: 'giftByDm',
      label: 'QQ 私信送礼',
      type: 'switch',
      hint: '打开后你在私聊里说「送个小心心」她才会真的送；关着就没这个本事。群里永远不送。花的是你的抖币，送出去没有撤回',
    },
    // —— 怎么动手（半自动 / 自动）——
    {
      key: 'semiAuto',
      label: '动作前先问我',
      type: 'switch',
      hint: '开 = 半自动：续灯牌 / 送礼之前，先把要点的位置截图发你私聊，回「/看直播 确认」才点；关 = 自动，直接点（照样要过命中校验）。90 秒不回就撤',
    },
    { key: 'confirmSec', label: '等你多少秒', type: 'number', min: 10, max: 600, step: 5, hint: '半自动默认 90 秒；到点没收到「确认」就自动撤销，不点' },
    // —— 调试 ——
    { key: 'minuteReport', label: '进房时通知我', type: 'switch', hint: '进房后私聊说一声' },
  ],
  panel: 'panel.js',   // 自动表单下面再加一张「风险与现场」卡（只读状态 + 误触提示）

  setup(api) {
    let cdp = null
    let port = 0
    let lastNote = ''
    let pausedDouyin = false
    let resumeTimer = null
    let resumeAt = 0
    let commentedUrl = ''
    let badgeUrl = ''
    let clicker = null
    let viewport = null

    const profileDir = () => join(api.dataDir(), 'live-profile')
    const stateFile = () => join(api.dataDir(), 'state.json')

    const loadState = () => {
      try { return JSON.parse(readFileSync(stateFile(), 'utf8')) || {} } catch { return {} }
    }
    const saveState = (patch) => {
      try { writeFileSync(stateFile(), JSON.stringify({ ...loadState(), ...patch }, null, 2)) } catch {}
    }

    // 进房评论每天只发一次：记住发过的那天，跨天自动重来
    const dayKey = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    let commentedDay = String(loadState().commentedDay || '')
    let badgeDay = String(loadState().badgeDay || '')
    let badgeReportDay = String(loadState().badgeReportDay || '')
    // 灯牌连续失败计数：连挂 3 次就当天降级成「提醒主人自己点」
    let badgeRejectDay = String(loadState().badgeRejectDay || '')
    let badgeRejectStreak = Number(loadState().badgeRejectStreak || 0)
    let badgeGiveUpDay = String(loadState().badgeGiveUpDay || '')

    const note = (text, level = 'info') => {
      lastNote = new Date().toLocaleTimeString() + ' ' + text
      api.log[level] ? api.log[level](text) : api.log.info(text)
    }

    // —— 半自动闸门：一次只放一个动作，90 秒不回就撤 ——
    const gate = createGate({ ttlMs: 90_000 })
    let gateLater = null

    const ownerChat = () => {
      const q = api.config().ownerQQ
      return q ? 'private:' + q : ''
    }

    /** 给主人私聊发一句话 + 可选一张图（发不出去也不影响主流程）。 */
    async function tellOwner(text, imagePath) {
      const chat = ownerChat()
      if (!chat) return false
      try { await api.sendText(chat, text) } catch (e) { note('私聊没发出去：' + (e && e.message), 'debug') }
      if (imagePath) {
        try { await api.sendImage(chat, imagePath) } catch (e) { note('截图没发出去：' + (e && e.message), 'warn') }
      }
      return true
    }

    const shotsDir = () => {
      const dir = join(api.dataDir(), 'shots')
      try { mkdirSync(dir, { recursive: true }) } catch {}
      return dir
    }

    /** 截当前页面（整屏，或只截某块）。给「等确认」和失败复盘用。 */
    async function shot(name, rect) {
      if (!cdp) return ''
      try {
        let params = { format: 'png' }
        if (rect) {
          const sc = await clicker.scroll()
          const pad = 28
          params = {
            format: 'png',
            clip: {
              x: Math.max(0, rect.left + sc.x - pad),
              y: Math.max(0, rect.top + sc.y - pad),
              width: Math.max(16, rect.width + pad * 2),
              height: Math.max(16, rect.height + pad * 2),
              scale: 1,
            },
            captureBeyondViewport: true,
          }
        }
        const r = await cdp.send('Page.captureScreenshot', params)
        const file = join(shotsDir(), name + '-' + Date.now() + '.png')
        writeFileSync(file, Buffer.from(r.data, 'base64'))
        return file
      } catch (e) {
        note('截图失败：' + (e && e.message), 'debug')
        return ''
      }
    }

    /**
     * 半自动第一段：把「要点的位置」截图发给主人，开一个待确认。
     * 这里不点任何花钱的按钮；截图里红框就是它打算按下去的地方。
     */
    async function askOwner({ kind, label, prepared, extra, data }) {
      const live = gate.peek()
      if (live) return { ok: false, message: '还有一个在等你确认：' + live.label + '（先回 /看直播 确认 或 /看直播 取消）' }
      let full = ''
      try {
        await clicker.mark(0)
        full = await shot(kind + '-aim', prepared.cand.rect)
      } finally {
        await clicker.unmark()
      }
      const sec0 = Math.max(10, Math.min(600, Number(api.settings().confirmSec) || 90))
      gate.setTtl(sec0 * 1000)
      const opened = gate.open({ kind, label, prepared, data: data || {}, shot: full })
      if (!opened.ok) return { ok: false, message: opened.reason }
      armGate()
      const sec = Math.round(gate.ttlMs / 1000)
      const lines = [
        '【等你点头】' + label,
        '要按的是：' + (prepared.cand ? prepared.cand.text : '') + '（' + prepared.desc + '）',
        '坐标：' + prepared.point.x + ',' + prepared.point.y + (viewport ? '　视口 ' + viewport.w + '×' + viewport.h : ''),
        extra || '',
        '红框那张图就是要点的位置。回 /看直播 确认 我就点；/看直播 取消 就撤；' + sec + ' 秒不回我自己撤。',
      ].filter(Boolean)
      await tellOwner(lines.join('\n'), full)
      note('等你确认：' + label + '（' + (prepared.cand ? prepared.cand.text : '') + '）', 'info')
      return { ok: false, pending: true, message: '要点的位置已经截图发你私聊了，等你回 /看直播 确认（' + sec + ' 秒）' }
    }

    /** 闸门过期扫描：到点了就撤，并告诉主人一声。 */
    const armGate = () => {
      if (gateLater) { try { gateLater() } catch {} }
      gateLater = api.later(gate.ttlMs + 5_000, async () => {
        gateLater = null
        const gone = gate.sweep()
        if (!gone) return
        note('待确认超时作废：' + gone.label, 'warn')
        await tellOwner('【已撤销】' + gone.label + '：等了 ' + Math.round(gate.ttlMs / 1000) + ' 秒没收到你的确认，这次不点了。')
      })
    }

    /** 主人回「确认」：取走闸门 → 重新校验 → 真点 → 回报。只能用一次。 */
    async function confirmPending() {
      const live = gate.peek()
      if (!live) return '现在没有等你确认的动作（可能已经过期了）'
      const action = gate.take()
      if (!action) return '这个确认已经过期了，这次不点。'
      try {
        if (action.kind === 'badge') {
          const r = await commitBadge(action.prepared)
          await tellOwner((r.ok ? '✅ 灯牌：' : '⚠️ 灯牌：') + r.message, r.shot || '')
          return r.message
        }
        if (action.kind === 'gift') {
          const r = await commitGift(action.prepared, action.data.name, action.data.balance, action.data.directSend)
          await tellOwner((r.ok ? '✅ 礼物：' : '⚠️ 礼物：') + r.message)
          return r.message
        }
        return '这个确认没认出来，先不点。'
      } catch (e) {
        return '执行出错：' + ((e && e.message) || e)
      }
    }

    /** 主人回「取消」：把待确认撤掉；面板顺手按 Esc 收起来。 */
    async function cancelPending() {
      const live = gate.peek()
      if (!live) return '现在没有等你确认的事'
      gate.take()
      try {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      } catch {}
      note('主人取消了：' + live.label, 'info')
      return '撤了，这次不点。'
    }

    /** 灯牌连续失败 3 次：当天降级成提醒（一天只提一次）。 */
    async function badgeReject(why) {
      const today = dayKey()
      if (badgeRejectDay !== today) { badgeRejectDay = today; badgeRejectStreak = 0 }
      badgeRejectStreak++
      saveState({ badgeRejectDay: today, badgeRejectStreak })
      note('灯牌这轮没成：' + why, 'warn')
      if (badgeRejectStreak >= 3 && badgeGiveUpDay !== today) {
        badgeGiveUpDay = today
        saveState({ badgeGiveUpDay: today })
        await tellOwner('灯牌连着 3 次没点上（' + why + '）。今天先不自动试了，你顺手点一下？想让我再试就发 /看直播 灯牌')
      }
    }

    /** 现在在不在设定时间段里。没开定时 = 永远在。支持跨午夜（22:30 → 01:00）。 */
    const inWindow = (date = new Date()) => {
      const s = api.settings()
      if (!s.schedule) return true
      const toMin = (text, fallback) => {
        const m = /^(\d{1,2})\s*[:：]\s*(\d{2})$/.exec(String(text || '').trim())
        if (!m) return fallback
        return Math.max(0, Math.min(23, Number(m[1]))) * 60 + Math.max(0, Math.min(59, Number(m[2])))
      }
      const a = toMin(s.startTime, 20 * 60)
      const b = toMin(s.endTime, 23 * 60 + 30)
      const now = date.getHours() * 60 + date.getMinutes()
      if (a === b) return true
      return a < b ? now >= a && now < b : now >= a || now < b
    }

    // —— 和刷抖音互斥 ——
    // 看直播期间把 douyin.enabled 关掉；离开直播间 / 手动关掉挂直播后恢复。
    // 暂停状态写进 state.json，插件重启后不会让刷抖音一直关着。
    const pauseDouyin = () => {
      if (pausedDouyin) return
      const cur = api.config().douyin || {}
      if (!cur.enabled) { pausedDouyin = true; saveState({ pausedDouyin: true }); return }
      pausedDouyin = true
      saveState({ pausedDouyin: true })
      api.setConfig((c) => ({ ...c, douyin: { ...c.douyin, enabled: false } }))
      note('看直播期间先暂停刷抖音')
    }
    const resumeDouyin = ({ delayMs = 0 } = {}) => {
      if (!pausedDouyin && !resumeTimer) return
      const cur0 = api.config().douyin || {}
      if (delayMs > 0) {
        // 2026-11-05 修：已经在冷却里就别再往后推。
        //   tick 每轮都会调一次，原来每轮都重排定时器 + 打一条「直播间刚关」，
        //   冷却时间被无限推后（刷抖音永远放不回来），日志还被刷满。
        if (resumeAt > Date.now()) return
        // 直播间刚关：抖音那边可能还占着同一个浏览器，先晾一会儿再放回去
        resumeAt = Date.now() + delayMs
        saveState({ pausedDouyin: true, resumeAt })
        if (resumeTimer) clearTimeout(resumeTimer)
        resumeTimer = setTimeout(() => { resumeTimer = null; resumeDouyin() }, delayMs)
        try { resumeTimer.unref?.() } catch {}
        note('直播间刚关，' + Math.round(delayMs / 60_000) + ' 分钟后再放开刷抖音')
        return
      }
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null }
      resumeAt = 0
      if (!pausedDouyin) return
      pausedDouyin = false
      saveState({ pausedDouyin: false })
      const cur = api.config().douyin || {}
      if (!cur.enabled) {
        api.setConfig((c) => ({ ...c, douyin: { ...c.douyin, enabled: true } }))
        note('刷抖音恢复了')
      }
    }
    // 模块刚加载时：上次是挂着直播停的，但这次没在挂 —— 到冷却时间了就把刷抖音放回来。
    // 2026-11-04 修 bug：resumeDouyin 开头有「没暂停过就早退」的守卫，直接调它是空操作，
    //   状态文件里的 pausedDouyin 永远清不掉、刷抖音一直关着。先把内存标记立起来再走正常恢复流程。
    {
      const st = loadState()
      const cooling = Boolean(st.resumeAt) && Date.now() < Number(st.resumeAt)
      if (st.pausedDouyin && !api.settings().enabled && !cooling) {
        pausedDouyin = true
        resumeDouyin()
      } else if (!st.pausedDouyin && pausedDouyin) {
        pausedDouyin = false
      }
    }

    async function attach(p) {
      const list = await getJson('http://127.0.0.1:' + p + '/json/list', 5000)
      const page = list.find((t) => t.type === 'page')
      if (!page) throw new Error('浏览器里没有可用页面')
      cdp = await Cdp.connect(page.webSocketDebuggerUrl)
      port = p
    }

    async function launch() {
      const bin = findBrowser()
      if (!bin) throw new Error('找不到 Edge / Chrome，先装一个')
      const dir = profileDir()
      mkdirSync(dir, { recursive: true })

      try {
        const saved = Number(String(readFileSync(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
        if (saved && (await getJson('http://127.0.0.1:' + saved + '/json/version', 1200).catch(() => null))) {
          await attach(saved)
          return saved
        }
      } catch {}

      const p = 9300 + Math.floor(Math.random() * 400)
      note('启动看直播专用浏览器')
      const child = spawn(bin, [
        '--user-data-dir=' + dir,
        '--remote-debugging-port=' + p,
        '--remote-debugging-address=127.0.0.1',
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion',
        '--window-size=1280,860',
        'about:blank',
      ], { stdio: ['ignore', 'ignore', 'ignore'], detached: true })
      child.unref()

      for (let i = 0; i < 60; i++) {
        await sleep(250)
        if (await getJson('http://127.0.0.1:' + p + '/json/version', 900).catch(() => null)) {
          try { writeFileSync(join(dir, 'DevToolsActivePort'), p + '\n/devtools/browser/kanzhibo\n') } catch {}
          await attach(p)
          return p
        }
      }
      throw new Error('浏览器没起来')
    }

    async function ensureBrowser() {
      if (!cdp) await launch()
    }

    /** 真的把浏览器关掉（不是只断连接）：发 Browser.close，进程自己退。 */
    async function closeBrowser() {
      if (!cdp) return
      try { await cdp.send('Browser.close') } catch {}
      try { cdp.close() } catch {}
      cdp = null
      await sleep(900)
    }

    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      return r.result ? r.result.value : undefined
    }

    clicker = createClicker({
      evalJs: (expr) => evalJs(expr),
      send: (method, params) => cdp.send(method, params),
      sleep,
      note: (t, l) => note(t, l),
    })

    /**
     * 坐标系契约（第③条）：固定窗口 / 视口 / 缩放，别让同一套判断今天对明天错。
     * 每次动手前调一次；拉不回来只记日志，不硬点。
     */
    async function ensureViewport() {
      const want = { width: 1280, height: 900 }
      try {
        const w = await cdp.send('Browser.getWindowForTarget')
        const b = await cdp.send('Browser.getWindowBounds', { windowId: w.windowId })
        const bb = (b && b.bounds) || {}
        if (Math.abs((bb.width || 0) - want.width) > 8 || Math.abs((bb.height || 0) - want.height) > 8) {
          await cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { width: want.width, height: want.height, windowState: 'normal' } }).catch(() => {})
          await sleep(500)
        }
      } catch (e) { note('窗口尺寸没调成：' + (e && e.message), 'debug') }
      try { await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }) } catch {}
      try { await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }) } catch {}
      const vp = await evalJs('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, scale: (visualViewport && visualViewport.scale) || 1 })').catch(() => null)
      if (vp) viewport = vp
      return viewport
    }

    async function currentUrl() {
      try { return String((await evalJs('location.href')) || '') } catch { return '' }
    }

    async function navigate(url) {
      await cdp.send('Page.enable').catch(() => {})
      await cdp.send('Page.navigate', { url })
      await sleep(3500)
    }

    /** 页面真的加载出来了没有：直播间有评论框才算渲染完。 */
    async function waitRoomReady(ms = 30000) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        const ok = await evalJs(`(() => {
          const boxes = [...document.querySelectorAll('textarea, div[contenteditable="true"]')]
            .filter((el) => el.getClientRects().length)
          if (boxes.length) return true
          return /直播|直播间/.test(document.title || '')
        })()`).catch(() => false)
        if (ok) return true
        await sleep(1500)
      }
      return false
    }

    async function enterFromProfile(url) {
      await navigate(url)
      for (let i = 0; i < 6; i++) {
        const r = await evalJs(`(() => {
          const alive = [...document.querySelectorAll('a[href*="live.douyin.com"]')]
            .find((el) => /直播中|正在直播|LIVE/i.test(el.innerText || ''))
          if (alive) return { kind: 'link', url: alive.href }
          const btn = [...document.querySelectorAll('div,button,span')]
            .find((el) => /^直播中$/.test((el.innerText || '').trim()) && el.getClientRects().length)
          if (btn) { btn.click(); return { kind: 'click' } }
          return { kind: '' }
        })()`).catch(() => null)
        if (r && r.kind === 'link' && r.url) { await navigate(r.url); return 'link' }
        if (r && r.kind === 'click') { await sleep(3000); return 'click' }
        await sleep(2500)
      }
      return ''
    }

    /** 在直播间发一条评论。真实鼠标点框 → 输入 → 点发送/回车。 */
    async function sendComment(text) {
      const content = String(text || '').trim()
      if (!content) return { ok: false, message: '没说要发什么' }
      if (!cdp) return { ok: false, message: '现在不在直播间里' }
      if (!LIVE_RE.test(await currentUrl())) return { ok: false, message: '现在不在直播间里' }

      const box = await clickBy(
        `[...document.querySelectorAll('textarea, div[contenteditable="true"], input[type="text"]')]
           .filter((el) => el.getClientRects().length && !el.disabled)
           .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]`,
        '评论框',
      )
      if (!box) return { ok: false, message: '没找到评论输入框（页面可能还没加载完）' }
      if (box.blocked) return { ok: false, message: '评论框被挡住 / 命中校验没过（' + ((box.hit && box.hit.good) || 0) + '/9 点命中），这次不发' }
      await sleep(400)

      await cdp.send('Input.insertText', { text: content })
      await sleep(700)
      const typed = await evalJs(`(() => {
        const el = document.activeElement
        return el ? String(el.value || el.innerText || '').trim() : ''
      })()`).catch(() => '')
      if (!typed) return { ok: false, message: '字没进到评论框里' }

      const clickedBtn = await clickBy(
        `[...document.querySelectorAll('button,div,span')]
           .filter((el) => el.getClientRects().length && /^(发送|送出)$/.test((el.innerText || '').trim()))
           .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]`,
        '发送按钮',
      )
      if (!clickedBtn || clickedBtn.blocked) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      }
      await sleep(1600)

      const left = await evalJs(`(() => {
        const el = document.activeElement
        return el ? String(el.value || el.innerText || '').trim() : ''
      })()`).catch(() => '')
      if (left && left.includes(content.slice(0, 3))) return { ok: false, message: '点了发送但框里还有字，可能没成功' }
      return { ok: true, message: '在直播间说了：' + content }
    }

    /**
     * 判定「今天的粉丝团灯牌送了没」。
     * 🔴 2026-11-03（主人指的位置）：看「今日任务」面板里那一行
     *   「粉丝团灯牌 … 已完成」——带「已完成 / 已送出 / 已领取」就算今天送过了。
     *   面板开着就直接读，关着就点开读一下再收起来；读不到一律当「没送」。
     */
    async function badgeSent() {
      const readTask = () => evalJs(`(() => {
        // 只认「任务行」：灯牌 + （亲密度 / 已完成 / 送1个）这类字样；
        // 聊天区的「送出了 粉丝团灯牌 × 1」不算，别把它当任务面板。
        const rows = [...document.querySelectorAll('div,span,p,li')].filter((el) => {
          const t = (el.innerText || '').trim()
          if (!t || t.length > 160) return false
          if (!/灯牌/.test(t)) return false
          return /亲密度|已完成|送1个|粉丝团任务/.test(t)
        })
        if (!rows.length) return 'none'
        const texts = rows.map((el) => (el.innerText || '').trim())
        if (texts.some((t) => /已完成|已送出|已领取|已点亮/.test(t))) return 'sent'
        return 'todo'
      })()`).catch(() => 'none')

      const taskEntry = `(() => {
        const nodes = [...document.querySelectorAll('div,span,button,a')].filter((el) => {
          const r = el.getBoundingClientRect()
          if (!(r.width > 8 && r.height > 8 && r.top < innerHeight * 0.75 && r.left < innerWidth * 0.7)) return false
          const t = (el.innerText || '').trim()
          return t && t.length < 30 && /今日任务/.test(t)
        })
        if (!nodes.length) return null
        nodes.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)
        return nodes[0]
      })()`

      const first = await readTask()
      if (first === 'sent') return true
      if (first === 'todo') { await clickBy(taskEntry, '今日任务'); await sleep(400); return false } // 面板开着：收起来
      const opened = await clickBy(taskEntry, '今日任务')
      if (!opened || opened.blocked) return false
      await sleep(1800)
      const st = await readTask()
      await clickBy(taskEntry, '今日任务') // 收起来，别挡着直播间
      await sleep(400)
      return st === 'sent'
    }

    /**
     * 灯牌：拆成「准备」和「确认后执行」两段。
     *   准备 = 点开左上角粉丝团入口（不花钱）+ 找出面板里的「赠送/点亮」按钮（只找不点）；
     *   执行 = 重新校验一次，签名没变、命中校验过了，才真按下去。
     * 2026-11-06：这套替换了原来的 el.click() —— 那版只要选错元素就直接点到别处去了。
     */
    const BADGE_ENTRY_SPEC = {
      text: '粉丝团|灯牌|加入粉丝团|点亮灯牌|续灯牌|今日任务',
      region: { top: 0, left: 0, right: 0.42, bottom: 0.78 },
      maxTextLen: 24,
      maxWidth: 220,
      maxHeight: 90,
    }
    // 抖音的按钮常把价格写在文字里：「点亮（1钻）」「赠送 10 钻」。所以价格括号要允许，
    // 但别的字一律不许跟 —— 「点亮粉丝团恢复勋章」这种标题就不会被当成按钮。
    const BADGE_CONFIRM_SPEC = {
      text: '^(赠送|点亮|续费|送出|一键点亮|立即续费|送1个|送灯牌|点亮灯牌)(\\s*[（(][^）)]{0,8}[）)])?$',
      region: { top: 0.02, left: 0.2, right: 0.8, bottom: 0.9 },
      maxTextLen: 14,
      maxWidth: 260,
      maxHeight: 100,
      // 观众列表里也有「点亮」，靠祖先里那句「点亮粉丝团恢复勋章」把面板认出来
      ancestorText: '点亮粉丝团|恢复勋章|粉丝团灯牌|灯牌',
    }

    /** 准备：只做「不花钱」的那一步 + 找到最后要按的按钮。 */
    async function prepareBadge() {
      await ensureViewport()
      // 面板可能已经开着（主人刚点过、或者上一轮留下的）：那一下「入口」是开关，
      // 再点一次会把面板关掉。所以先看「赠送/点亮」在不在，在就直接用。
      let prep = await clicker.prepare({ label: '灯牌「赠送」', spec: BADGE_CONFIRM_SPEC, tries: 2 })
      let entryText = ''
      if (!prep.ok) {
        const entry = await clicker.clickOnce({
          label: '粉丝团/灯牌入口',
          spec: BADGE_ENTRY_SPEC,
          allowMultiple: true, // 入口旁边常有名字/图标/人数，允许挑面积最小的那个
          settleMs: 2600,
        })
        if (!entry.ok) return { ok: false, message: '入口没点成：' + entry.reason }
        entryText = (entry.cand && entry.cand.text) || ''
        prep = await clicker.prepare({ label: '灯牌「赠送」', spec: BADGE_CONFIRM_SPEC, tries: 10 })
      }
      if (!prep.ok) return { ok: false, message: '面板里没找到可点的「赠送/点亮」：' + prep.reason }
      return { ok: true, prepared: prep, entry: entryText }
    }

    /** 灯牌成没成：今日任务 / 飘屏字样 / 抖币余额，认一个就算。 */
    async function badgeEvidence(beforeBalance) {
      try { if (await badgeSent()) return { ok: true, how: '「今日任务」显示已完成' } } catch {}
      const banner = await evalJs(`(() => {
        const t = (document.body && document.body.innerText) || ''
        if (/送出点亮粉丝团|送出了\\s*灯牌|点亮粉丝团灯牌|灯牌\\s*[×x]\\s*\\d/.test(t)) return '飘屏/提示里出现了灯牌'
        return ''
      })()`).catch(() => '')
      if (banner) return { ok: true, how: banner }
      const after = await readBalance()
      if (beforeBalance != null && after != null && after < beforeBalance) return { ok: true, how: '抖币 ' + beforeBalance + ' → ' + after }
      return { ok: false, how: '今日任务、飘屏、余额都没变化' }
    }

    /** 执行：重新找 → 比对签名 → 再验命中 → 真点 → 查证据。 */
    async function commitBadge(prepared) {
      await ensureViewport()
      const before = await readBalance()
      const r = await clicker.commit(prepared, { settleMs: 1600 })
      if (!r.ok) return { ok: false, message: r.reason }
      await sleep(1800)
      const file = await shot('badge-result')
      const ev = await badgeEvidence(before)
      const today = dayKey()
      // 2026-11-06（真机跑出来的教训）：这一下已经按下去了，不管证据到没到，
      //   今天都必须记成「动过」——否则 2 分钟一轮的 tick 会再点一次，重复花钱。
      badgeDay = today
      badgeUrl = (await currentUrl()) || badgeUrl
      saveState({ badgeDay, badgeUrl, badgeEvidence: (ev.ok ? ev.how : '未确认：' + ev.how) })
      if (ev.ok) {
        if (badgeReportDay !== today) {
          badgeReportDay = today
          saveState({ badgeReportDay })
          await tellOwner('今天的灯牌已经送出了')
        }
        return { ok: true, message: '灯牌送出去了（' + ev.how + '）', shot: file }
      }
      await tellOwner('灯牌点了，但没读到确认的证据（' + ev.how + '）。今天不再自动点，你瞄一眼直播间。')
      return { ok: false, message: '点了，但没读到确认证据（' + ev.how + '）；今天不再重试，免得重复花钱', shot: file }
    }

    /** 灯牌一轮：半自动就先问主人，自动就直接点。 */
    async function doBadge() {
      const prep = await prepareBadge()
      if (!prep.ok) return prep
      if (api.settings().semiAuto) {
        return await askOwner({
          kind: 'badge',
          label: '续粉丝团灯牌',
          prepared: prep.prepared,
          extra: '点了就是给「' + (prep.entry || '这个主播') + '」续一次灯牌。',
        })
      }
      return await commitBadge(prep.prepared)
    }

    /**
     * 点一个「返回元素的表达式」（老的 finder 全部走这里）。
     * 现在补了三件事：先标出来 → 命中校验（9 点采样，被挡住就不点）→ 真坐标按下。
     * 返回 null = 没找到；{ blocked: true } = 找到了但不让点。
     */
    async function clickBy(finderExpr, label, opts) {
      return await clicker.clickExpr(finderExpr, label, opts)
    }

    const hasRecharge = () =>
      evalJs('/充值|抖币不足|余额不足|不够抖币|去充值/.test(document.body.innerText || "")').catch(() => false)

    /** 右下角那一带的元素文字，找不到东西时打出来方便排查。 */
    async function dumpCorner() {
      const list = await evalJs(`(() => {
        const out = []
        for (const el of document.querySelectorAll('div,button,span,[aria-label]')) {
          const r = el.getBoundingClientRect()
          if (!el.getClientRects().length) continue
          if (r.top < innerHeight * 0.55 || r.left < innerWidth * 0.55) continue
          if (r.width > 300 || r.height > 300) continue
          const t = ((el.innerText || '') + '|' + (el.getAttribute('aria-label') || '')).trim()
          if (t && t.length <= 40) out.push(t)
        }
        return [...new Set(out)].slice(0, 30)
      })()`).catch(() => [])
      if (list && list.length) note('右下角能看到的元素：' + list.join(' / '), 'debug')
    }

    /** 礼物面板开没开：面板里有「赠送 / 背包 / 全部礼物」这类字样。 */
    async function giftPanelOpen() {
      return await evalJs(`(() => /赠送|送出|背包|全部礼物|热门礼物|礼物\s*$/m.test(document.body.innerText || ''))()`).catch(() => false)
    }

    /** 试着打开礼物面板：把像礼物按钮的元素按「越靠右下越优先」一个个点，点完检查面板有没有出来。 */
    async function openGiftPanel() {
      if (await giftPanelOpen()) return true
      const sel = `[...document.querySelectorAll('[data-e2e*="gift" i], [aria-label*="礼物"], [title*="礼物"], [class*="gift" i], [class*="Gift"]')]
        .filter((el) => {
          const r = el.getBoundingClientRect()
          return el.getClientRects().length && r.width > 8 && r.height > 8 && r.bottom > innerHeight * 0.4
        })
        .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right || b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)`
      for (let i = 0; i < 6; i++) {
        const hit = await clickBy(`${sel}[${i}]`, '礼物按钮#' + (i + 1))
        if (!hit || hit.blocked) break
        await sleep(1600)
        if (await giftPanelOpen()) return true
      }
      // 再退一步：找文字里有「礼物」的小元素
      const txt = await clickBy(
        `[...document.querySelectorAll('div,span,button')]
           .filter((el) => { const t = ((el.innerText || '') + (el.getAttribute('aria-label') || '')).trim(); const r = el.getBoundingClientRect(); return el.getClientRects().length && /礼物/.test(t) && t.length <= 20 && r.width < 200 && r.height < 120 })
           [0]`,
        '礼物按钮（文字）',
      )
      if (txt) {
        await sleep(1600)
        if (await giftPanelOpen()) return true
      }
      return false
    }

    /**
     * 送礼：也拆两段。
     *   准备 = 打开礼物面板、按名字选中礼物（这一步不花钱）；
     *   执行 = 重新校验「赠送」按钮，签名没变才按。
     * 礼物名里的正则元字符先转义，别让「(新)」这种名字变成模式。
     */
    const escapeRe = (s) => String(s || '').split('').map((c) => ('\\^$.*+?()[]{}|'.includes(c) ? '\\' + c : c)).join('')

    // 礼物格子：把底部那条常驻礼物栏排除掉 —— 那一条点下去也会直接送，而且不是「面板里的选择」。
    const GIFT_CELL_SPEC = (name) => ({
      text: escapeRe(name),
      region: { top: 0.08, left: 0.33, right: 0.86, bottom: 0.86 },
      maxTextLen: 26,
      maxWidth: 300,
      maxHeight: 170,
    })
    // 有些版式是「选中礼物 → 再点赠送」；赠送按钮的文字偶尔带价格（赠送 10钻）。
    const GIFT_CONFIRM_SPEC = {
      text: '^(赠送|发送|送出|立即赠送|赠送一个|送\\s*1)(\\s*[（(][^）)]{0,8}[）)])?$',
      region: { top: 0.08, left: 0.3, right: 0.92, bottom: 0.88 },
      maxTextLen: 12,
      maxWidth: 260,
      maxHeight: 120,
      ancestorText: '礼物|赠送|背包',
    }

    async function prepareGift(giftName) {
      const name = String(giftName || '').trim()
      if (!name) return { ok: false, message: '没说送什么礼物' }
      if (!cdp) return { ok: false, message: '现在不在直播间里' }
      if (!LIVE_RE.test(await currentUrl())) return { ok: false, message: '现在不在直播间里' }
      await ensureViewport()
      if (await hasRecharge()) return { ok: false, message: '页面显示要充值抖币（或余额不足），这次不送了' }

      const opened = await openGiftPanel()
      if (!opened) {
        await dumpCorner()
        return { ok: false, message: '礼物面板打不开（点了几次都没弹出来），日志里记了右下角能看到的东西' }
      }
      await sleep(2600)

      // 礼物面板常收在「更多」里，先点开它再找
      const moreBtn = await clickBy(
        `[...document.querySelectorAll('div,span,button')]
           .filter((el) => { const t = (el.innerText || '').trim(); const r = el.getBoundingClientRect(); return el.getClientRects().length && /^更多$/.test(t) && r.width < 180 && r.height < 70 })
           .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]`,
        '更多',
      )
      if (moreBtn && !moreBtn.blocked) await sleep(1200)

      // ① 先看有没有独立的「赠送」按钮（选中 → 再送的版式）。有的话，花钱的就是它。
      const confirmFirst = await clicker.prepare({ label: '赠送按钮', spec: GIFT_CONFIRM_SPEC, tries: 2 })
      if (confirmFirst.ok) {
        return { ok: true, prepared: confirmFirst, name, balance: await readBalance(), directSend: false }
      }

      // ② 没有独立按钮：这个版式是「点礼物就直接送」。只定位，一下都不点。
      const cell = await clicker.prepare({ label: '礼物「' + name + '」', spec: GIFT_CELL_SPEC(name), tries: 6, allowMultiple: true })
      if (!cell.ok) {
        await dumpCorner()
        return { ok: false, message: '礼物面板里找不到「' + name + '」：' + cell.reason }
      }
      return { ok: true, prepared: cell, name, balance: await readBalance(), directSend: true }
    }

    async function commitGift(prepared, name, beforeBalance, directSend) {
      await ensureViewport()
      if (await hasRecharge()) return { ok: false, message: '出现充值提示，停下来没送' }
      const r = await clicker.commit(prepared, { settleMs: directSend ? 1400 : 900 })
      if (!r.ok) return { ok: false, message: r.reason }
      const proof = await verifyGiftSent(name, beforeBalance == null ? await readBalance() : beforeBalance)
      if (await hasRecharge()) return { ok: false, message: '送完弹出了充值提示，可能余额不够，去手机上看一眼' }
      if (proof.ok) return { ok: true, message: '送了「' + name + '」×1（已确认：' + proof.how + '）' }
      return { ok: false, message: '按了，但读了 8 秒没找到送出的证据（' + proof.how + '），你去直播间看一眼，别重复送' }
    }

    /** 送礼一轮：半自动先问主人，自动直接点。 */
    async function sendGift(giftName) {
      const prep = await prepareGift(giftName)
      if (!prep.ok) return prep
      if (api.settings().semiAuto) {
        return await askOwner({
          kind: 'gift',
          label: '送礼物「' + prep.name + '」',
          prepared: prep.prepared,
          extra: prep.directSend
            ? '⚠ 这个版式是「点礼物就直接送」，按下去就花抖币、没有撤回。'
            : '点的是「赠送」按钮，按下去就花抖币、没有撤回。',
          data: { name: prep.name, balance: prep.balance, directSend: prep.directSend },
        })
      }
      return await commitGift(prep.prepared, prep.name, prep.balance, prep.directSend)
    }

    /** 读页面上的抖币余额；读不到返回 null。 */
    async function readBalance() {
      const v = await evalJs(`(() => {
        const m = (document.body.innerText || '').match(/([\\d][\\d,]{0,9})\\s*(?:抖币|钻)/);
        return m ? Number(m[1].replace(/,/g, '')) : null;
      })()`).catch(() => null)
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    }

    /** 送礼后的回读：余额变少 / 出现送出成功提示 / 礼物飘屏里有这个名字，三者算一个就算成了。 */
    async function verifyGiftSent(name, beforeBalance) {
      const deadline = Date.now() + 8000
      let how = '余额没变、也没看到成功提示'
      while (Date.now() < deadline) {
        await sleep(1200)
        const after = await readBalance()
        if (beforeBalance != null && after != null && after < beforeBalance) {
          return { ok: true, how: '抖币 ' + beforeBalance + ' → ' + after }
        }
        const hit = await evalJs(`(() => {
          const t = document.body.innerText || '';
          if (/赠送成功|送出成功|已送出|送礼成功|再送一个/.test(t)) return 'success-toast';
          const n = ${JSON.stringify(name)};
          if (n && new RegExp(n + '\\\\s*[x×]\\\\s*\\\\d').test(t)) return 'gift-banner';
          return '';
        })()`).catch(() => '')
        if (hit === 'success-toast') return { ok: true, how: '页面出现赠送成功提示' }
        if (hit === 'gift-banner') return { ok: true, how: '礼物飘屏里出现了它' }
        if (after == null && beforeBalance == null) how = '页面上读不到抖币余额'
      }
      return { ok: false, how }
    }

    async function ensureInRoom(force, overrideTarget) {
      const s = api.settings()
      const target = String(overrideTarget || s.target || '').trim()
      if (!target) return { ok: false, message: '还没填直播间地址或主播主页' }

      await ensureBrowser()
      let url = await currentUrl()
      if (!url) {
        try { cdp?.close() } catch {}
        cdp = null
        await ensureBrowser()
        url = await currentUrl()
      }

      // 已经在直播间里就留着，别刷新 —— 刷新会把播放和评论都打断。
      // 只有明确指定了另一个直播间（id 不同）才换房。
      if (LIVE_RE.test(url)) {
        const liveId = (u) => (/^https?:\/\/live\.douyin\.com\/(\d+)/.exec(String(u || '')) || [])[1] || ''
        const curId = liveId(url)
        const wantId = liveId(target)
        if (!wantId || !curId || wantId === curId) return { ok: true, url, joined: false }
      }

      if (/^https?:\/\/live\.douyin\.com\//.test(target)) {
        await navigate(target)
        note('进了直播间：' + target)
        return { ok: true, url: target, joined: true }
      }
      if (/douyin\.com\/user\//.test(target)) {
        const how = await enterFromProfile(target)
        const now = await currentUrl()
        if (how && LIVE_RE.test(now)) {
          note('主播在播，已经进去了：' + now)
          return { ok: true, url: now, joined: true }
        }
        note('主播现在没在播（页面停在主页）', 'debug')
        return { ok: true, url: now, joined: false, message: '现在没在播' }
      }
      if (/^https?:\/\//.test(target)) {
        await navigate(target)
        return { ok: true, url: target, joined: true }
      }
      throw new Error('地址看不懂，填 https://live.douyin.com/... 或 https://www.douyin.com/user/...')
    }

    let busy = false
    async function tick(force = false) {
      if (!api.settings().enabled) return { ok: false, message: '挂直播没打开' }
      if (busy) return { ok: false, message: '上一轮还没结束' }
      if (!inWindow()) {
        if (cdp) {
          await closeBrowser()
          note('到点了，把直播间浏览器关了')
        }
        resumeDouyin({ delayMs: 10 * 60_000 })
        return { ok: false, message: '不在设定的时间段，直播间已经关了' }
      }
      busy = true
      try {
        const r = await ensureInRoom(force)
        const url = await currentUrl()
        const inLive = LIVE_RE.test(url)

        if (!inLive) {
          // 不在直播间（主播下播 / 被跳走）：刷抖音放回来
          resumeDouyin({ delayMs: 10 * 60_000 })
          return { ...r, ok: r.ok, url }
        }

        pauseDouyin()

        // 进房后发评论：等页面真的渲染完，同一个房间只发一次
        const text = String(api.settings().liveComment || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''
        const today = dayKey()
        if (api.settings().liveCommentOn && text && commentedDay !== today) {
          const ready = await waitRoomReady(30000)
          if (ready) {
            const wait = Math.max(0, Math.min(120, Number(api.settings().commentDelaySec) || 0)) * 1000
            if (wait) await sleep(wait)
            const sent = await sendComment(text)
            if (sent.ok) {
              commentedUrl = url
              commentedDay = today
              saveState({ commentedUrl: url, commentedDay: today })
              note('进房评论：' + text + '（今天不再发了）')
            } else {
              note('评论没发成：' + sent.message, 'warn')
            }
          } else {
            note('页面 30 秒还没加载出评论框，这次没发评论', 'warn')
          }
        }

        /**
         * 送灯牌（2026-11-03 改）：**先判定，没送才送，送完再判定**。
         *   判定看「今日任务」面板里那一行「粉丝团灯牌 … 已完成」——已完成就说明今天已经送出过。
         *   判定成功就走人（并且给主人回一句「今天的灯牌已经送出了」，每天只说一次）。
         */
        if (api.settings().renewBadge) {
          const today = dayKey()
          // 2026-11-04：今天这个直播间已经确认送出过就别再判一遍了。
          // （之前每 2 分钟都打一条「今天已经送出了」，日志被刷满。）
          // 2026-11-06：连着挂 3 次 → 当天降级成提醒；有动作在等确认就别抢。
          if (badgeDay === today && badgeUrl === url) {
            // 已经办完，静默跳过
          } else if (badgeGiveUpDay === today) {
            // 今天已经放弃自动，不再点（放弃时已经提醒过一次）
          } else if (gate.peek()) {
            note('灯牌：还有个动作在等你确认，这轮先不送', 'debug')
          } else {
            let sent = await badgeSent()
            if (sent) {
              note('灯牌：今天已经送出了（判定命中）')
            } else {
              const waitMs = Math.max(5, Math.min(600, Number(api.settings().badgeDelaySec) || 30)) * 1000
              await sleep(waitMs)
              const r2 = await doBadge()
              if (r2.pending) note('灯牌：' + r2.message, 'info')
              else if (r2.ok) note('灯牌：' + r2.message, 'info')
              else await badgeReject(r2.message || '没点成')
              await sleep(1500)
              sent = await badgeSent()
            }
            if (sent) {
              if (badgeDay !== today || badgeUrl !== url) {
                badgeDay = today
                badgeUrl = url
                saveState({ badgeDay: today, badgeUrl: url })
              }
              if (badgeReportDay !== today) {
                badgeReportDay = today
                saveState({ badgeReportDay: today })
                const owner = api.config().ownerQQ
                if (owner) api.sendText('private:' + owner, '今天的灯牌已经送出了').catch(() => {})
              }
            } else {
              note('灯牌：送完还是没判到「已完成」，这轮不记成功', 'warn')
            }
          }
        }

        if (r.joined && api.settings().minuteReport) {
          const owner = api.config().ownerQQ
          if (owner) api.sendText('private:' + owner, '我去看直播了：' + url).catch(() => {})
        }
        return { ...r, url }
      } catch (error) {
        note('挂直播出错：' + error.message, 'warn')
        try { cdp.close() } catch {}
        cdp = null
        resumeDouyin({ delayMs: 10 * 60_000 })
        return { ok: false, message: error.message }
      } finally {
        busy = false
      }
    }

    /** 立刻进房一次（给她用工具时走这条，不要求面板里的「挂直播」开着）。 */
    async function enterNow(targetText) {
      const target = String(targetText || api.settings().target || '').trim()
      if (!target) return { ok: false, message: '没说看谁的直播，面板里也没设默认主播' }
      if (busy) return { ok: false, message: '正在弄，等一下下' }
      busy = true
      try {
        const r = await ensureInRoom(true, target)
        const url = await currentUrl()
        if (LIVE_RE.test(url)) {
          pauseDouyin()
          note('进了直播间：' + url)
          return { ok: true, url, message: '进直播间了：' + url }
        }
        return { ok: true, url, message: r.message || '打开了页面：' + (url || target) }
      } catch (error) {
        note('手动进直播间失败：' + error.message, 'warn')
        return { ok: false, message: error.message }
      } finally {
        busy = false
      }
    }

    /**
     * 停下来：真的关掉浏览器、把刷抖音放回来、再把挂直播开关关掉。
     * 🔴 2026-11-03 修 bug：原来是「先排一个 10 分钟后恢复刷抖音的定时器，紧接着把自己关掉」。
     *  模块一停，那个定时器 10 分钟后触发时 setConfig 会被内核直接拒绝（日志里那 5 条
     *  「模块已停止，不能调用 setConfig」就是它）；而模块停了也不会再加载，
     *  加载时那条「冷却到了就恢复」的分支永远走不到 —— 结果刷抖音一直关着，得手动开。
     *  现在改成在关自己之前就把刷抖音放回来。
     */
    async function stopNow() {
      await closeBrowser()
      resumeDouyin()
      api.saveSettings({ enabled: false })
      return { ok: true, message: '直播看完了，浏览器关了，刷抖音已经放回来' }
    }

    /** 状态一句话，工具和命令共用。showDetail=false 时只说「开没开、在不在时段」，不暴露目标主播和当前地址。 */
    const statusLine = async (showDetail = true) => {
      const s = api.settings()
      const url = cdp ? (await currentUrl()).slice(0, 70) : '没开浏览器'
      const window = s.schedule ? `${s.startTime}-${s.endTime}（${inWindow() ? '在时段内' : '不在时段内'}）` : '不限时段'
      const head = '挂直播：' + (s.enabled ? '开' : '关') + '｜刷抖音：' + (pausedDouyin ? '暂停中' : '照常') +
        '｜时段：' + window + '｜模式：' + (s.semiAuto ? '半自动' : '自动')
      if (!showDetail) return head
      const wait = gate.peek()
      return head +
        '｜目标：' + (s.target || '没填') +
        '｜进房评论：' + (s.liveCommentOn ? (commentedDay === dayKey() ? '开·今天发过（不再发）' : '开·今天还没发') : '已关闭') +
        '｜私信送礼：' + (s.giftByDm ? '开' : '关') +
        '｜现在：' + url +
        (wait ? '\n待确认：' + wait.label + '（回 /看直播 确认 或 /看直播 取消）' : '') +
        (lastNote ? '\n最近：' + lastNote : '')
    }

    // —— 给她用的工具：这样她在 QQ 里才认得「去看直播」 ——
    api.tool(({ chat, sessionId }) => {
      if (!chat || chat.kind === 'system') return []
      // 2026-11-05 修：进房 / 停止不是「只是看一眼」，它们会真开浏览器、真改 douyin.enabled。
      //   原来这些工具在群聊里也挂着、不看主人身份，群里任何人喊一句「去看直播」她都会真开。
      //   现在只在「这一轮有主人说话」时给操作类工具；别人只能问状态，而且状态里不露在看谁。
      const owner = Boolean(api.core.hub.turnHasOwner(sessionId))
      // 2026-11-06：送礼是花抖币的真动作，单独一道开关，而且只认「主人的 QQ 私聊」。
      //   开关关着、或者在群里，连工具都不挂给她（省得她嘴上答应、手上没本事）；
      //   工具清单是会话级缓存的，所以 execute 里再按当前设置判一次 —— 面板改完不用重载模块。
      const giftOn = () => Boolean(api.settings().giftByDm) && chat.kind === 'private' && Boolean(api.core.hub.turnHasOwner(sessionId))
      const statusTool = api.defineTool({
        name: 'kanzhibo_status',
        description: '看现在挂没挂直播、刷抖音是不是暂停着。主人问「你在看什么直播」时用。',
        properties: {},
        execute: async () => ({ ok: true, message: await statusLine(owner) }),
      })
      if (!owner) return [statusTool]

      const enterTool = api.defineTool({
        name: 'kanzhibo_enter',
        description:
          '进一个人的抖音直播间挂着看。主人说「去看直播」「去XX的直播间」「帮我挂着」「看着她播」这类话时用。' +
          '不填 target 就用面板里设好的那个主播。进去后会自动暂停刷抖音。',
        properties: {
          target: { type: 'string', description: '直播间地址或主播主页链接；不填就用默认那个' },
        },
        execute: async ({ target }) => enterNow(target),
      })
      const stopTool = api.defineTool({
        name: 'kanzhibo_stop',
        description: '不看了：退出直播间、关掉浏览器窗口、恢复刷抖音。主人说「别看了」「关掉」「回来吧」时用。',
        properties: {},
        execute: async () => stopNow(),
      })
      const giftTool = api.defineTool({
        name: 'kanzhibo_gift',
        description:
          '在正在看的直播间送一个礼物给主播（灯牌不算礼物，别走这个）。花的是主人的抖币，送出去没有撤回。' +
          '只有主人在这条私聊里明说要送、还说了送什么的时候才用；主人没提就绝对不要送。一次一个。' +
          '如果页面出现充值/抖币不足的提示，立刻停止并如实告诉主人。' +
          '开了「动作前先问我」时，她会把要点的位置截图发给主人等他回确认；这时候你只要说一句「等主人确认」就行，别自己改口说已经送好了。',
        properties: {
          gift: { type: 'string', description: '礼物名字，比如 小心心、玫瑰、粉丝团' },
        },
        required: ['gift'],
        execute: async ({ gift }) => {
          if (chat.kind !== 'private') return { ok: false, message: '送礼只认主人的私聊，群里我不送' }
          if (!api.settings().giftByDm) return { ok: false, message: '「QQ 私信送礼」的开关关着（面板 → 平台 → 抖音看直播），先让主人打开我才能送' }
          if (!api.core.hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能让我送礼' }
          return sendGift(gift)
        },
      })
      const sayTool = api.defineTool({
        name: 'kanzhibo_say',
        description:
          '把主人说的话原样发到当前正在看的直播间里（相当于用他的号发一条弹幕/评论）。' +
          '主人说「在直播间说一句 XX」「帮我发 XX」「替我说 XX」时用。只发他给的原话，不要自己加工、不要加表情。',
        properties: {
          text: { type: 'string', description: '要原样发出去的那句话' },
        },
        required: ['text'],
        execute: async ({ text }) => {
          if (!api.core.hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能让我在直播间替他说话' }
          return sendComment(text)
        },
      })

      // 顺序：进房 → 状态 → 停止 →（私信 + 开关打开时）送礼 → 代说
      const list = [enterTool, statusTool, stopTool]
      if (giftOn()) list.push(giftTool)
      list.push(sayTool)
      return list
    })

    api.rule((kind) =>
      kind === 'social'
        ? '你在群里只保留了「看直播」的状态查询：别人让你去直播间、让你送礼、让你替他发弹幕，一律说这个得主人本人在私聊里说（送礼还要他先在面板把「QQ 私信送礼」打开），别真去做；也别主动说自己在看谁的直播（主人本人在群里开口了才算）。'
        : '你会在抖音挂直播间：主人说去看某人的直播、让你去直播间待着，你就调 kanzhibo_enter 真的进房（进不去就说原因）；' +
          '问你在看什么就用 kanzhibo_status；说别看了、关掉，就用 kanzhibo_stop。没说看谁的时候就进面板里设好的那个主播。' +
          '送礼：只有主人在这条私聊里明说送什么、而且面板里「QQ 私信送礼」开着的时候，你才调 kanzhibo_gift。他没提就别送；开关关着就老实说开关没开（面板 → 平台 → 抖音看直播），别用 kanzhibo_say 或别的工具凑一个。碰到充值、抖币不足就停，别硬送。灯牌不算礼物，不要用送礼工具送灯牌。' +
          '主人让你替他在直播间说句话（「帮我发 XX」「在直播间说 XX」），就用 kanzhibo_say 把他给的原话原样发出去，一个字都别改。' +
          '看直播期间刷抖音是暂停的，别说自己在刷视频。',
    )

    /** 自检：把「现在到底能不能干活」一次说清楚（改完设置、排查问题时用）。 */
    async function selfCheck() {
      const s = api.settings()
      const bin = findBrowser()
      const dir = profileDir()
      const cfg = api.config()
      const douyinOn = Boolean((cfg.douyin || {}).enabled)
      const url = cdp ? await currentUrl() : ''
      return [
        '看直播自检（v0.4.0）',
        '浏览器：' + (bin || '没找到 Edge / Chrome'),
        '专用 profile：' + (existsSync(dir) ? dir : '还没建（第一次进房时才建）'),
        'CDP：' + (cdp ? '连着，端口 ' + port : '没连') + (url ? '｜当前页：' + url.slice(0, 80) : ''),
        '挂直播：' + (s.enabled ? '开' : '关') + '｜目标：' + (s.target || '没填'),
        '时段：' + (s.schedule ? s.startTime + '-' + s.endTime + '（' + (inWindow() ? '在时段内' : '不在时段内') + '）' : '不限'),
        '检查间隔：' + Math.max(30, Math.min(1800, Number(s.checkSec) || 120)) + ' 秒',
        '刷抖音：' + (pausedDouyin ? '暂停中' : (douyinOn ? '照常（配置里是开的）' : '关着（配置里 douyin.enabled=false）')),
        '今日评论：' + (s.liveCommentOn ? (commentedDay === dayKey() ? '开·今天发过' : '开·今天还没发') : '关'),
        '今日灯牌：' + (s.renewBadge ? (badgeDay === dayKey() ? '今天送过' : '今天还没送') : '关') +
          (badgeGiveUpDay === dayKey() ? '（今天已放弃自动，改成提醒你）' : ''),
        '私信送礼：' + (s.giftByDm ? '开（只认主人的私聊）' : '关（她不会送）'),
        '打法：' + (s.semiAuto ? '半自动（点之前截图发你，等你回 /看直播 确认）' : '自动（直接点，仍然过命中校验）'),
        '视口：' + (viewport ? viewport.w + '×' + viewport.h + ' · DPR ' + viewport.dpr + ' · 缩放 ' + viewport.scale : '还没读（进房后才有）'),
        '待确认：' + (gate.peek() ? gate.peek().label + '（' + Math.round((gate.peek().deadline - Date.now()) / 1000) + ' 秒后作废）' : '没有'),
        '状态文件：' + stateFile(),
        '最近一条：' + (lastNote || '（还没有）'),
      ].join('\n')
    }

    // 检查间隔改成能热改：面板里改完 checkSec 不用重载模块，下一轮就按新间隔走。
    let tickTimer = null
    let tickSec = 0
    const armTick = () => {
      const sec = Math.max(30, Math.min(1800, Number(api.settings().checkSec) || 120))
      if (tickTimer && sec === tickSec) return
      if (tickTimer) clearInterval(tickTimer)
      tickSec = sec
      tickTimer = setInterval(() => { tick(false).catch((e) => note('定时检查出错：' + (e && e.message), 'warn')) }, sec * 1000)
      try { tickTimer.unref?.() } catch {}
    }
    armTick()
    api.on('config', () => armTick())

    api.command({
      name: '看直播',
      aliases: ['kanzhibo'],
      desc: '挂直播间：/看直播 开、关、状态、进、收工、确认、取消、灯牌、自检',
      run: async (arg) => {
        const cmd = String(arg || '').trim()
        if (!cmd || cmd === '状态') {
          return await statusLine()
        }
        if (cmd === '自检' || cmd === 'check') {
          return await selfCheck()
        }
        if (cmd === '确认' || cmd === 'ok' || cmd === '好') return await confirmPending()
        if (cmd === '取消' || cmd === '算了' || cmd === '不用了') return await cancelPending()
        if (cmd === '待确认' || cmd === 'pending') {
          const w = gate.peek()
          return w ? '等你确认：' + w.label + '（' + Math.round((w.deadline - Date.now()) / 1000) + ' 秒后作废）' : '现在没有等你确认的事'
        }
        if (cmd === '灯牌') {
          if (!cdp) return '直播间浏览器没开，先发 /看直播 进'
          badgeGiveUpDay = ''
          saveState({ badgeGiveUpDay: '' })
          const r = await doBadge()
          return r.pending ? r.message : (r.ok ? r.message : '没点成：' + r.message)
        }
        if (cmd === '开') {
          api.saveSettings({ enabled: true })
          const r = await tick(true)
          return r.ok ? '开了，在 ' + r.url : '开了，但没进去：' + r.message
        }
        if (cmd === '关') {
          // 先放回刷抖音再关自己：关掉模块之后就不能再改配置了（同 stopNow 的 bug）
          resumeDouyin()
          api.saveSettings({ enabled: false })
          return '关了，刷抖音已经放回来（窗口先留着；要关窗口发 /看直播 收工）'
        }
        if (cmd === '进') {
          const r = await tick(true)
          return r.ok ? '进了：' + r.url : '没进去：' + r.message
        }
        if (cmd === '收工') {
          await closeBrowser()
          resumeDouyin({ delayMs: 10 * 60_000 })
          return '浏览器关了；刷抖音晾 10 分钟再放开'
        }
        return '能用的有：开 / 关 / 状态 / 进 / 收工 / 灯牌 / 确认 / 取消 / 自检'
      },
    })

    /** 面板用：现在有没有在等确认。 */
    api.route('/pending', async () => ({
      ok: true,
      semiAuto: Boolean(api.settings().semiAuto),
      pending: gate.state(),
    }))

    /**
     * 排查用（只读优先）：把「界面里到底有哪些候选」摊开，不花钱的点击要 ?open=1 才做。
     *   /aurabot/api/ext/kanzhibo/probe?what=badge&open=1&shot=1&target=https://live.douyin.com/xxx
     *   /aurabot/api/ext/kanzhibo/probe?what=gift&name=小心心&open=1&shot=1
     */
    api.route('/probe', async (req) => {
      const q = api.core.http.query(req)
      const what = String(q.what || 'badge')
      const target = String(q.target || '').trim()
      try {
        if (what === 'expiry') {
          // 只测「到点自动撤销」：开一个假动作（confirm 也点不出东西），不发 QQ 请求、不碰浏览器。
          gate.setTtl(8000)
          const g = gate.open({ kind: 'test', label: '超时测试（不会点任何东西）', prepared: { ok: false }, data: {} })
          if (g.ok) armGate()
          return { ok: true, what, opened: g.ok, pending: gate.state(), ttlMs: gate.ttlMs, serverNow: Date.now() }
        }
        if (target) {
          const r = await enterNow(target)
          if (!r.ok) return { ok: false, message: r.message }
        }
        if (!cdp) return { ok: false, message: '浏览器没开：带上 ?target=直播间地址，或者先发 /看直播 进' }
        await ensureViewport()
        await waitRoomReady(20000)
        const out = { ok: true, what, url: await currentUrl(), title: await evalJs('document.title'), viewport }
        if (String(q.reload || '') === '1') {
          try {
            await cdp.send('Page.enable').catch(() => {})
            await cdp.send('Page.reload', { ignoreCache: false })
            await sleep(4000)
            await waitRoomReady(25000)
          } catch {}
        }
        if (what === 'badge') {
          if (String(q.esc || '') === '1') {
            try {
              await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
              await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
              await sleep(700)
            } catch {}
          }
          if (String(q.open || '') === '1') {
            out.entry = await clicker.clickOnce({ label: '粉丝团/灯牌入口', spec: BADGE_ENTRY_SPEC, allowMultiple: true, settleMs: 1500 })
            await sleep(1200)
          }
          out.entryCandidates = await clicker.find(BADGE_ENTRY_SPEC)
          out.confirmCandidates = await clicker.find(BADGE_CONFIRM_SPEC)
          if (String(q.shot || '') === '1') out.shot = await shot('probe-badge')
        }
        if (what === 'gift') {
          const name = String(q.name || '小心心')
          if (String(q.open || '') === '1') {
            out.opened = await openGiftPanel()
            await sleep(2600)
          }
          out.giftCandidates = await clicker.find(GIFT_CELL_SPEC(name))
          out.confirmCandidates = await clicker.find(GIFT_CONFIRM_SPEC)
          if (String(q.shot || '') === '1') out.shot = await shot('probe-gift')
        }
        if (what === 'prep') {
          const prep = await prepareBadge()
          out.badgePrep = prep.ok
            ? { ok: true, text: prep.prepared.cand.text, sig: prep.prepared.cand.sig, desc: prep.prepared.desc, point: prep.prepared.point, entry: prep.entry }
            : prep
          if (String(q.shot || '') === '1') out.shot = await shot('probe-prep')
        }
        if (what === 'mark') {
          const found = await clicker.find(BADGE_CONFIRM_SPEC)
          out.candidates = found
          const marked = await clicker.mark(0)
          out.marked = marked
          out.shotFull = await shot('probe-mark-full')
          out.shotZoom = marked ? await shot('probe-mark-zoom', marked) : ''
          await clicker.unmark()
        }
        if (what === 'ask' || what === 'ok' || what === 'no') {
          if (what === 'ask') out.result = await doBadge()
          else if (what === 'ok') out.result = { message: await confirmPending() }
          else out.result = { message: await cancelPending() }
          out.pending = gate.state()
          if (String(q.shot || '') === '1') out.shot = await shot('probe-' + what)
        }
        if (what === 'prepgift') {
          const prep = await prepareGift(String(q.name || '小心心'))
          out.giftPrep = prep.ok
            ? { ok: true, name: prep.name, text: prep.prepared.cand.text, desc: prep.prepared.desc, point: prep.prepared.point, balance: prep.balance, directSend: prep.directSend }
            : prep
          if (String(q.shot || '') === '1') out.shot = await shot('probe-giftprep')
        }
        if (what === 'hit') {
          const x = Number(q.x)
          const y = Number(q.y)
          out.at = await evalJs(`(() => {
            const x = ${Number.isFinite(x) ? x : 0}, y = ${Number.isFinite(y) ? y : 0}
            const el = document.elementFromPoint(x, y)
            if (!el) return null
            const chain = []
            let cur = el
            for (let i = 0; i < 6 && cur; i++, cur = cur.parentElement) {
              const r = cur.getBoundingClientRect()
              chain.push({ tag: cur.tagName.toLowerCase(), cls: String(cur.className || '').slice(0, 40), text: ((cur.textContent || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 40), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], role: cur.getAttribute && cur.getAttribute('role'), tab: cur.getAttribute && cur.getAttribute('tabindex'), cursor: getComputedStyle(cur).cursor })
            }
            return chain
          })()`)
        }
        if (what === 'click') {
          const x = Number(q.x)
          const y = Number(q.y)
          if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, message: '要给 x 和 y' }
          await clicker.clickAt(x, y)
          await sleep(1200)
          out.clicked = { x, y }
          out.hitAt = await evalJs(`(() => {
            const el = document.elementFromPoint(${x}, ${y})
            if (!el) return null
            return { tag: el.tagName.toLowerCase(), text: ((el.textContent || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 40), rect: (() => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })() }
          })()`)
          if (String(q.shot || '') === '1') out.shot = await shot('probe-click')
        }
        if (what === 'info') {
          out.info = await evalJs(`(() => ({
            href: location.href,
            title: document.title,
            bodyLen: (document.body && document.body.innerText || '').length,
            bodyHead: (document.body && document.body.innerText || '').slice(0, 300),
            iframes: [...document.querySelectorAll('iframe')].map((f) => {
              let info = { src: String(f.src || '').slice(0, 120), rect: [Math.round(f.getBoundingClientRect().left), Math.round(f.getBoundingClientRect().top), Math.round(f.getBoundingClientRect().width), Math.round(f.getBoundingClientRect().height)] }
              try {
                const doc = f.contentDocument
                info.sameOrigin = Boolean(doc)
                if (doc) {
                  info.bodyLen = (doc.body && doc.body.innerText || '').length
                  info.textLen = (doc.body && doc.body.textContent || '').length
                  info.head = (doc.body && doc.body.innerText || '').replace(/\s+/g, ' ').slice(0, 120)
                  info.textHead = (doc.body && doc.body.textContent || '').replace(/\s+/g, ' ').slice(0, 160)
                  info.nodes = doc.querySelectorAll('*').length
                  info.shadows = [...doc.querySelectorAll('*')].filter((x) => x.shadowRoot).length
                  info.hasLight = (doc.body && doc.body.textContent || '').includes('点亮')
                }
              } catch (e) { info.err = String((e && e.message) || e) }
              return info
            }),
            frames: window.frames.length,
            nodes: document.querySelectorAll('*').length,
            dpr: devicePixelRatio,
            vw: innerWidth,
            vh: innerHeight,
          }))()`)
        }
        if (what === 'text') {
          const word = String(q.q || '点亮')
          out.matches = await evalJs(`(() => {
            const word = ${JSON.stringify(word)}
            const out = []
            for (const el of document.querySelectorAll('*')) {
              const t = (el.textContent || '').replace(/\\s+/g, ' ').trim()
              if (!t || t.length > 40 || !t.includes(word)) continue
              const r = el.getBoundingClientRect()
              if (!r.width || !r.height) continue
              out.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 48), text: t, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })
            }
            return out.slice(0, 40)
          })()`)
        }
        if (what === 'room') {
          out.commentBoxes = await clicker.find({ text: '.', raw: true, maxTextLen: 999, region: { top: 0, left: 0, right: 1, bottom: 1 } })
          if (String(q.shot || '') === '1') out.shot = await shot('probe-room')
        }
        return out
      } catch (e) {
        return { ok: false, message: String((e && e.message) || e) }
      }
    })

    api.route('/status', async () => {
      const s = api.settings()
      return {
        ok: true, enabled: s.enabled, target: s.target, connected: Boolean(cdp), port,
        url: cdp ? await currentUrl() : '', pausedDouyin, commentedUrl, commentedDay, today: dayKey(), lastNote,
        semiAuto: Boolean(s.semiAuto), pending: gate.state(), viewport,
      }
    })

    api.route('/selfcheck', async () => {
      const s = api.settings()
      return {
        ok: true,
        browser: findBrowser(),
        profileDir: profileDir(),
        profileExists: existsSync(profileDir()),
        connected: Boolean(cdp),
        port,
        url: cdp ? await currentUrl() : '',
        enabled: Boolean(s.enabled),
        target: s.target || '',
        inWindow: inWindow(),
        schedule: Boolean(s.schedule),
        checkSec: Math.max(30, Math.min(1800, Number(s.checkSec) || 120)),
        pausedDouyin,
        douyinEnabled: Boolean((api.config().douyin || {}).enabled),
        commentedDay,
        badgeDay,
        giftByDm: Boolean(s.giftByDm),
        semiAuto: Boolean(s.semiAuto),
        badgeGiveUpDay,
        pending: gate.state(),
        viewport,
        today: dayKey(),
        text: await selfCheck(),
      }
    })

    api.onDispose(() => {
      // 模块停下时不能再改配置；刷抖音的暂停标记留在 state.json，下次加载时按开关状态恢复
      // 定时器一定要清掉，否则它会在模块停止后醒来，调用已经不能用的 api.setConfig
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null }
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
      if (gateLater) { try { gateLater() } catch {} gateLater = null }
      try { gate.dispose() } catch {}
      try { cdp.close() } catch {}
      cdp = null
    })

    return {
      tick,
      selfCheck,
      status: () => ({ enabled: api.settings().enabled, target: api.settings().target, connected: Boolean(cdp), pausedDouyin }),
      _debug: { inWindow, dayKey, findBrowser },
    }
  },
}
// touch 1793900150040
// touch 1793900198302
// touch 1793900591462
// touch 1793900665449
// touch 1793900727197
// touch 1793900743126
// touch 1793900757418
// touch 1793900843766
// touch 1793900857898
// touch 1793901412185
