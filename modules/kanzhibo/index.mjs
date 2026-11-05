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
  name: '看直播',
  version: '0.3.1',
  api: 1,
  description: '挂直播间 + 进房后发一条定制评论 + 续灯牌；挂着的时候自动暂停刷抖音',

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
    minuteReport: false,
  },
  settings: [
    { key: 'enabled', label: '挂直播', type: 'switch', hint: '打开后定时进直播间（记得先填目标）' },
    {
      key: 'target',
      label: '直播间或主播主页',
      type: 'text',
      placeholder: 'https://live.douyin.com/123456789',
      hint: '直播间地址最稳；主播主页（douyin.com/user/...）会自己找「直播中」点进去',
    },
    { key: 'checkSec', label: '多久检查一次（秒）', type: 'number', min: 30, max: 1800, step: 30, hint: '不在直播间就重新进' },
    {
      key: 'schedule',
      label: '只在指定时间段挂',
      type: 'switch',
      hint: '打开后只在下面那段时间里进直播间，其余时间不动（刷抖音照常）',
    },
    { key: 'startTime', label: '开始时间', type: 'text', placeholder: '20:00', hint: '24 小时制，写成 20:00 这样' },
    { key: 'endTime', label: '结束时间', type: 'text', placeholder: '23:30', hint: '可以跨午夜，比如 22:30 到 01:00' },
    {
      key: 'liveCommentOn',
      label: '启用进房评论',
      type: 'switch',
      hint: '默认关着（之前会重复发，先停用）。想用再打开，开了之后每天最多发一次',
    },
    {
      key: 'liveComment',
      label: '进房后发这句评论',
      type: 'textarea',
      hint: '上面的开关打开才生效。留空就不发，多行只发第一行',
    },
    {
      key: 'commentDelaySec',
      label: '进房后等几秒再发（秒）',
      type: 'number',
      min: 0,
      max: 120,
      step: 1,
      hint: '保险起见默认 8 秒，等画面和评论框都出来',
    },
    {
      key: 'renewBadge',
      label: '进房后给主播送灯牌',
      type: 'switch',
      hint: '进直播间一段时间后点左上角的粉丝团/灯牌，给主播续一个。同一个直播间只点一次',
    },
    {
      key: 'badgeDelaySec',
      label: '进房后多久送灯牌（秒）',
      type: 'number',
      min: 5,
      max: 600,
      step: 5,
      hint: '默认 30 秒，等画面和左上角粉丝团图标都加载出来',
    },
    { key: 'minuteReport', label: '进房时在 QQ 说一声', type: 'switch', hint: '调试用' },
  ],

  setup(api) {
    let cdp = null
    let port = 0
    let lastNote = ''
    let pausedDouyin = false
    let resumeTimer = null
    let resumeAt = 0
    let commentedUrl = ''
    let badgeUrl = ''

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

    const note = (text, level = 'info') => {
      lastNote = new Date().toLocaleTimeString() + ' ' + text
      api.log[level] ? api.log[level](text) : api.log.info(text)
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
      if (!clickedBtn) {
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
      if (!opened) return false
      await sleep(1800)
      const st = await readTask()
      await clickBy(taskEntry, '今日任务') // 收起来，别挡着直播间
      await sleep(400)
      return st === 'sent'
    }

    /** 给主播送灯牌：点左上角的粉丝团/灯牌，弹出面板后再点赠送/续费。 */
    async function renewBadge() {
      // 2026-11-04 修 bug：原来没有长度上限，一个把整页文字都包进去的大容器也能匹配上
      //   「灯牌」，结果点到了顶部导航（日志里那条「点了『精选 推荐 AI抖音 关注 朋友 我的』」）。
      //   现在只认短文字、靠左上、面积最小的那个元素。
      const entry = await evalJs(`(() => {
        const inTopLeft = (el) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && r.top < innerHeight * 0.75 && r.left < innerWidth * 0.4
        }
        const nodes = [...document.querySelectorAll('div,button,span,a')]
          .filter((el) => el.getClientRects().length && inTopLeft(el))
          .map((el) => ({ el, t: (el.innerText || '').trim() }))
          .filter(({ t }) => t && t.length <= 24 && /粉丝团|灯牌|点亮灯牌|续灯牌|加入粉丝团/.test(t))
        if (!nodes.length) return ''
        // 面积越小越可能是那个按钮本身（大容器会把整页文字都算进来）
        nodes.sort((a, b) => {
          const ra = a.el.getBoundingClientRect()
          const rb = b.el.getBoundingClientRect()
          return ra.width * ra.height - rb.width * rb.height
        })
        const el = nodes[0].el
        const label = nodes[0].t.replace(/\\s+/g, ' ').slice(0, 20)
        el.setAttribute('data-ab-badge', '1')
        el.click()
        return label
      })()`).catch(() => '')
      if (!entry) return { ok: false, message: '没找到左上角的粉丝团/灯牌' }

      await sleep(1800)
      const acted = await evalJs(`(() => {
        const cands = [...document.querySelectorAll('button,div,span')].filter((el) => {
          if (!el.getClientRects().length) return false
          const t = (el.innerText || '').trim()
          if (!/^(赠送|点亮|续费|送出|一键点亮|立即续费|送1个)$/.test(t)) return false
          const r = el.getBoundingClientRect()
          // 只在左上那块面板里找：别点到顶栏 / 底部礼物栏
          return r.width > 20 && r.height > 16 && r.top > 30 && r.top < innerHeight * 0.8 && r.left < innerWidth * 0.6
        })
        if (!cands.length) return ''
        cands.sort((a, b) => {
          const ra = a.getBoundingClientRect()
          const rb = b.getBoundingClientRect()
          return ra.width * ra.height - rb.width * rb.height
        })
        const hit = cands[0]
        hit.click()
        return (hit.innerText || '').trim()
      })()`).catch(() => '')
      if (acted) {
        await sleep(1500)
        return { ok: true, message: '点了「' + entry + '」→ 再点「' + acted + '」' }
      }
      return { ok: true, message: '点了「' + entry + '」，没看到二次确认（有些直播间点开就直接送了）' }
    }

    /** 找到元素中心点，用真实鼠标事件点它（直播间的面板多是坐标判定的，el.click() 常常没用）。 */
    async function clickBy(finderExpr, label) {
      const info = await evalJs(`(() => {
        let el = null
        try { el = (${finderExpr}) } catch (e) { return { err: String(e && e.message || e) } }
        if (!el) return null
        try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch (e) {}
        const r = el.getBoundingClientRect()
        if (!r || r.width < 2 || r.height < 2) return null
        return {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          text: ((el.innerText || '') + ' | ' + (el.getAttribute('aria-label') || '') + ' | ' + (el.getAttribute('title') || '')).trim().slice(0, 50),
        }
      })()`).catch(() => null)
      if (!info) { note('没找到：' + label, 'debug'); return null }
      if (info.err) { note('找 ' + label + ' 出错：' + info.err, 'warn'); return null }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y }).catch(() => {})
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 }).catch(() => {})
      await sleep(80)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 }).catch(() => {})
      note('点了' + label + '：' + info.text, 'debug')
      return info
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
        if (!hit) break
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

    /** 在直播间送礼：先查充值提示，再开礼物面板、按名字点、点赠送。一次一个。 */
    async function sendGift(giftName) {
      const name = String(giftName || '').trim()
      if (!name) return { ok: false, message: '没说送什么礼物' }
      if (!cdp) return { ok: false, message: '现在不在直播间里' }
      const url = await currentUrl()
      if (!LIVE_RE.test(url)) return { ok: false, message: '现在不在直播间里' }

      if (await hasRecharge()) return { ok: false, message: '页面显示要充值抖币（或余额不足），这次不送了' }

      // 1. 打开礼物面板：候选一个个试，点完看面板是不是真的开了（鼠标坐标点错就换下一个）
      const opened = await openGiftPanel()
      if (!opened) {
        await dumpCorner()
        return { ok: false, message: '礼物面板打不开（点了几次都没弹出来），日志里记了右下角能看到的东西' }
      }
      await sleep(3500)

      // 1.5 礼物面板常收在「更多」里，先点开它再找
      const moreBtn = await clickBy(
        `[...document.querySelectorAll('div,span,button')]
           .filter((el) => { const t = (el.innerText || '').trim(); const r = el.getBoundingClientRect(); return el.getClientRects().length && /^更多$/.test(t) && r.width < 180 && r.height < 70 })
           .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]`,
        '更多',
      )
      if (moreBtn) await sleep(1500)

      // 2. 面板里按名字找礼物
      let picked = await clickBy(
        `[...document.querySelectorAll('div,span,p,img[alt]')].filter((el) => {
            const t = ((el.innerText || '') + ' ' + (el.getAttribute('alt') || '') + ' ' + (el.getAttribute('aria-label') || '')).trim()
            return el.getClientRects().length && (t === ${JSON.stringify(name)} || (t.length <= 24 && t.includes(${JSON.stringify(name)})))
          })[0]`,
        '礼物「' + name + '」',
      )
      if (!picked) {
        // 有的面板是两级展开：再点一次「更多」再找一遍
        const more2 = await clickBy(
          `[...document.querySelectorAll('div,span,button')]
             .filter((el) => { const t = (el.innerText || '').trim(); const r = el.getBoundingClientRect(); return el.getClientRects().length && /^更多$/.test(t) && r.width < 180 && r.height < 70 })
             .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]`,
          '更多（第二次）',
        )
        if (more2) {
          await sleep(1500)
          picked = await clickBy(
            `[...document.querySelectorAll('div,span,p,img[alt]')].filter((el) => {
                const t = ((el.innerText || '') + ' ' + (el.getAttribute('alt') || '') + ' ' + (el.getAttribute('aria-label') || '')).trim()
                return el.getClientRects().length && (t === ${JSON.stringify(name)} || (t.length <= 24 && t.includes(${JSON.stringify(name)})))
              })[0]`,
            '礼物「' + name + '」（第二次）',
          )
        }
      }
      if (!picked) {
        await dumpCorner()
        return { ok: false, message: '礼物面板里没找到「' + name + '」' }
      }
      await sleep(2800)

      if (await hasRecharge()) return { ok: false, message: '出现充值/抖币不足提示，停下来没送' }

      // 点赠送之前先记住抖币余额（有些直播间点下去会直接送，不一定有第二次确认）
      const beforeBalance = await readBalance()

      // 3. 点赠送（有的直播间是直接点礼物就送；所以最多试 3 轮，找不到也继续去验证）
      await sleep(1600)
      let sent = null
      for (let i = 0; i < 3 && !sent; i++) {
        sent = await clickBy(
          `[...document.querySelectorAll('button,div,span')]
             .filter((el) => el.getClientRects().length && /^(赠送|发送|送出|立即赠送|赠送一个|送\\s*1)\\s*$/.test((el.innerText || '').replace(/\\s+/g, ' ').trim()))
             .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]`,
          '赠送按钮',
        )
        if (!sent) {
          // 退一步：只要按钮上带「赠送/送出」两个字，也点
          sent = await clickBy(
            `[...document.querySelectorAll('button,span,div')]
               .filter((el) => { const t = (el.innerText || '').trim(); const r = el.getBoundingClientRect(); return el.getClientRects().length && /赠送|送出/.test(t) && t.length <= 8 && r.width < 220 && r.height < 90 })
               .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]`,
            '赠送按钮（宽松）',
          )
        }
        if (!sent) await sleep(1500)
      }

      // 4. 验证：最多等 8 秒，看是不是真送出去了（点礼物直接送的直播间也走这里）
      const proof = await verifyGiftSent(name, beforeBalance)
      if (await hasRecharge()) return { ok: false, message: '送完弹出了充值提示，可能余额不够，去手机上看一眼' }
      if (proof.ok) return { ok: true, message: '送了「' + name + '」×1（已确认：' + proof.how + '）' }
      if (!sent) {
        await dumpCorner()
        return { ok: false, message: '点了礼物但没找到「赠送」按钮，也没读到送出的证据（' + proof.how + '）' }
      }
      return { ok: false, message: '点了赠送，但读了 8 秒没找到送出的证据（' + proof.how + '），你去直播间看一眼，别重复送' }
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
          if (badgeDay === today && badgeUrl === url) {
            // 已经办完，静默跳过
          } else {
            let sent = await badgeSent()
            if (sent) {
              note('灯牌：今天已经送出了（判定命中）')
            } else {
              const waitMs = Math.max(5, Math.min(600, Number(api.settings().badgeDelaySec) || 30)) * 1000
              await sleep(waitMs)
              const r2 = await renewBadge()
              note(r2.ok ? '送灯牌：' + r2.message : '灯牌没点上：' + r2.message, r2.ok ? 'info' : 'warn')
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
      const head = '挂直播：' + (s.enabled ? '开' : '关') + '｜刷抖音：' + (pausedDouyin ? '暂停中' : '照常') + '｜时段：' + window
      if (!showDetail) return head
      return head +
        '｜目标：' + (s.target || '没填') +
        '｜进房评论：' + (s.liveCommentOn ? (commentedDay === dayKey() ? '开·今天发过（不再发）' : '开·今天还没发') : '已关闭') +
        '｜现在：' + url + (lastNote ? '\n最近：' + lastNote : '')
    }

    // —— 给她用的工具：这样她在 QQ 里才认得「去看直播」 ——
    api.tool(({ chat, sessionId }) => {
      if (!chat || chat.kind === 'system') return []
      // 2026-11-05 修：进房 / 停止不是「只是看一眼」，它们会真开浏览器、真改 douyin.enabled。
      //   原来这些工具在群聊里也挂着、不看主人身份，群里任何人喊一句「去看直播」她都会真开。
      //   现在只在「这一轮有主人说话」时给操作类工具；别人只能问状态，而且状态里不露在看谁。
      const owner = Boolean(api.core.hub.turnHasOwner(sessionId))
      const statusTool = api.defineTool({
        name: 'kanzhibo_status',
        description: '看现在挂没挂直播、刷抖音是不是暂停着。主人问「你在看什么直播」时用。',
        properties: {},
        execute: async () => ({ ok: true, message: await statusLine(owner) }),
      })
      if (!owner) return [statusTool]
      return [
        api.defineTool({
          name: 'kanzhibo_enter',
          description:
            '进一个人的抖音直播间挂着看。主人说「去看直播」「去XX的直播间」「帮我挂着」「看着她播」这类话时用。' +
            '不填 target 就用面板里设好的那个主播。进去后会自动暂停刷抖音。',
          properties: {
            target: { type: 'string', description: '直播间地址或主播主页链接；不填就用默认那个' },
          },
          execute: async ({ target }) => enterNow(target),
        }),
        statusTool,
        api.defineTool({
          name: 'kanzhibo_stop',
          description: '不看了：退出直播间、关掉浏览器窗口、恢复刷抖音。主人说「别看了」「关掉」「回来吧」时用。',
          properties: {},
          execute: async () => stopNow(),
        }),
        api.defineTool({
          name: 'kanzhibo_gift',
          description:
            '在正在看的直播间送一个礼物给主播（灯牌不算礼物，别走这个）。' +
            '只有主人明说要送、说了送什么的时候才用；主人没提就绝对不要送。一次一个。' +
            '如果页面出现充值/抖币不足的提示，立刻停止并如实告诉主人。',
          properties: {
            gift: { type: 'string', description: '礼物名字，比如 小心心、玫瑰、粉丝团' },
          },
          required: ['gift'],
          execute: async ({ gift }) => {
            if (!api.core.hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能让我送礼' }
            return sendGift(gift)
          },
        }),
        api.defineTool({
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
        }),
      ]
    })

    api.rule((kind) =>
      kind === 'social'
        ? '你在群里只保留了「看直播」的状态查询：别人让你去直播间、让你送礼、让你替他发弹幕，一律说这个得主人本人说，别真去做；也别主动说自己在看谁的直播（主人本人在群里开口了才算）。'
        : '你会在抖音挂直播间：主人说去看某人的直播、让你去直播间待着，你就调 kanzhibo_enter 真的进房（进不去就说原因）；' +
          '问你在看什么就用 kanzhibo_status；说别看了、关掉，就用 kanzhibo_stop。没说看谁的时候就进面板里设好的那个主播。' +
          '送礼只在你明确说了「送什么礼物」时才调 kanzhibo_gift，主人没提就别送；碰到充值或抖币不足就停，别硬送。灯牌不算礼物，不要用送礼工具送灯牌。' +
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
        '看直播自检（v0.3.1）',
        '浏览器：' + (bin || '没找到 Edge / Chrome'),
        '专用 profile：' + (existsSync(dir) ? dir : '还没建（第一次进房时才建）'),
        'CDP：' + (cdp ? '连着，端口 ' + port : '没连') + (url ? '｜当前页：' + url.slice(0, 80) : ''),
        '挂直播：' + (s.enabled ? '开' : '关') + '｜目标：' + (s.target || '没填'),
        '时段：' + (s.schedule ? s.startTime + '-' + s.endTime + '（' + (inWindow() ? '在时段内' : '不在时段内') + '）' : '不限'),
        '检查间隔：' + Math.max(30, Math.min(1800, Number(s.checkSec) || 120)) + ' 秒',
        '刷抖音：' + (pausedDouyin ? '暂停中' : (douyinOn ? '照常（配置里是开的）' : '关着（配置里 douyin.enabled=false）')),
        '今日评论：' + (s.liveCommentOn ? (commentedDay === dayKey() ? '开·今天发过' : '开·今天还没发') : '关'),
        '今日灯牌：' + (s.renewBadge ? (badgeDay === dayKey() ? '今天送过' : '今天还没送') : '关'),
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
      desc: '挂直播间：/看直播 开、关、状态、进、收工、自检',
      run: async (arg) => {
        const cmd = String(arg || '').trim()
        if (!cmd || cmd === '状态') {
          return await statusLine()
        }
        if (cmd === '自检' || cmd === 'check') {
          return await selfCheck()
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
        return '能用的有：开 / 关 / 状态 / 进 / 收工 / 自检'
      },
    })

    api.route('/status', async () => {
      const s = api.settings()
      return {
        ok: true, enabled: s.enabled, target: s.target, connected: Boolean(cdp), port,
        url: cdp ? await currentUrl() : '', pausedDouyin, commentedUrl, commentedDay, today: dayKey(), lastNote,
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
        today: dayKey(),
        text: await selfCheck(),
      }
    })

    api.onDispose(() => {
      // 模块停下时不能再改配置；刷抖音的暂停标记留在 state.json，下次加载时按开关状态恢复
      // 定时器一定要清掉，否则它会在模块停止后醒来，调用已经不能用的 api.setConfig
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null }
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
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
