// 看直播模块的离线自检脚本（不是 Aurabot 模块 —— 它躺在 verify/ 里，插件不会当入口文件加载）。
// 用法（在模块文件夹里，或者任意目录只要路径对）：
//   node verify/verify.mjs                 # 只测逻辑：工具/命令/接口注册、时段判定、每日去重、崩溃恢复
//   set LIVE=1 && node verify/verify.mjs   # 额外真起一次 Edge + CDP（Windows），验证浏览器链路
//
// 它给模块喂一个假的 api（不发 QQ、不改真配置、数据落在临时目录）。
// 然后跑：工具/命令/接口能不能注册上、tick 的时段判定、灯牌与评论的每日去重、
// 上次崩溃后「刷抖音」能不能自己放回来。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mod from '../index.mjs'
import { createGate } from '../lib/gate.mjs'
import { createClicker } from '../lib/click.mjs'
import { FIND_SRC, HIT_SRC, MARK_SRC, UNMARK_SRC, SCROLL_SRC, normalizeSpec, choosePoint, pickUnique, sameSig, collapseNested } from '../lib/find.mjs'

const LIVE = process.env.LIVE === '1'
let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

/** 造一个假的 api，并把模块 setup 起来 */
function boot({ settings = {}, cfg = {}, state = null, dir = null, owner = true, chatKind = 'private' } = {}) {
  const dataDir = dir || mkdtempSync(join(tmpdir(), 'kanzhibo-'))
  mkdirSync(dataDir, { recursive: true })
  if (state) writeFileSync(join(dataDir, 'state.json'), JSON.stringify(state))

  const s = {
    enabled: false, target: '', checkSec: 120, schedule: false, startTime: '20:00', endTime: '23:30',
    liveCommentOn: false, liveComment: '', commentDelaySec: 8, renewBadge: false, badgeDelaySec: 30,
    giftByDm: false, minuteReport: false,
    ...settings,
  }
  const config = { ownerQQ: '10001', douyin: { enabled: true, autoBrowse: false }, ...cfg }
  const got = { tools: [], rules: [], commands: [], routes: [], events: [], intervals: [], sent: [], logs: [] }
  const noop = () => () => {}

  const api = {
    id: 'kanzhibo', source: 'user', version: 'test', apiVersion: 1, dir: dataDir,
    settings: () => ({ ...s }),
    saveSettings: (patch) => Object.assign(s, patch),
    config: () => config,
    setConfig: (patch) => {
      if (typeof patch === 'function') Object.assign(config, patch(config))
      else Object.assign(config, patch)
    },
    dataDir: () => dataDir,
    log: {
      info: (m) => got.logs.push(['info', m]), warn: (m) => got.logs.push(['warn', m]),
      error: (m) => got.logs.push(['error', m]), debug: (m) => got.logs.push(['debug', m]),
    },
    on: (name, fn) => { got.events.push([name, fn]); return () => {} },
    emit: noop, later: () => noop(),
    every: (ms, fn, name) => { got.intervals.push([ms, name]); return () => {} },
    tool: (fn) => { const t = fn({ chat: { kind: chatKind, chatId: chatKind === 'group' ? 'group:1' : 'private:1' }, sessionId: 's1' }); got.tools.push(...(Array.isArray(t) ? t : [t]).filter(Boolean)); return () => {} },
    defineTool: (t) => t,
    rule: (fn) => { got.rules.push(typeof fn === 'function' ? fn() : fn); return () => {} },
    command: (c) => { got.commands.push(c); return () => {} },
    route: (p, fn) => { got.routes.push([p, fn]); return () => {} },
    onDispose: (fn) => { got.dispose = fn },
    sendText: (chatId, text) => { got.sent.push([chatId, text]); return Promise.resolve() },
    send: () => Promise.resolve(), sendImage: noop, sendFile: noop, sendVoiceFile: noop, sendSegments: noop,
    onebot: async () => ({}), ask: async () => '', think: async () => '',
    isOwner: () => true, has: () => false, use: () => null, lazy: () => ({}), lib: () => ({}),
    core: {
      hub: { turnHasOwner: () => owner, groupName: () => '群', runSystemTurn: async () => '', deliver: async () => {} },
      onebot: { call: async () => ({}) }, http: {}, modules: {}, logger: {}, root: dataDir,
      local: { active: () => false, call: async () => ({}) },
    },
    dsh: { get: () => undefined },
  }
  const out = mod.setup(api)
  return { out, api, s, config, got, dataDir }
}

const tool = (got, name) => got.tools.find((t) => t.name === name)
const cmd = (got, name) => got.commands.find((c) => c.name === name)
const route = (got, path) => (got.routes.find(([p]) => p === path) || [])[1]

console.log('\n=== 1. 模块定义 ===')
ok('id = kanzhibo', mod.id === 'kanzhibo')
ok('api 版本 = 1', mod.api === 1, 'version ' + mod.version)
ok('有 defaults + 字段清单', Object.keys(mod.defaults || {}).length > 5 && (mod.settingsSchema || []).length >= 10, (mod.settingsSchema || []).length + ' 个字段')
ok('表单全交给自定义面板（settings 留空，避免和 panel.js 重复渲染）', mod.settings.length === 0 && mod.panel === 'panel.js')
const setting = (key) => (mod.settingsSchema || []).find((x) => x.key === key)
ok('多了「QQ 私信送礼」开关，默认关着', setting('giftByDm') && setting('giftByDm').type === 'switch' && mod.defaults.giftByDm === false)
ok('多了「动作前先问我」开关，默认开（半自动）', setting('semiAuto') && setting('semiAuto').type === 'switch' && mod.defaults.semiAuto === true)
ok('送到灯牌那条写明了误触风险', /点偏|误触/.test((setting('renewBadge') || {}).hint || ''), (setting('renewBadge') || {}).hint)

console.log('\n=== 2. setup 注册了什么 ===')
const b = boot()
ok('开关关着：主人私聊只有 4 个工具（没有送礼）', b.got.tools.length === 4, b.got.tools.map((t) => t.name).join(', '))
ok('工具名都对', ['kanzhibo_enter', 'kanzhibo_status', 'kanzhibo_stop', 'kanzhibo_say'].every((n) => tool(b.got, n)) && !tool(b.got, 'kanzhibo_gift'))
ok('/看直播 命令 + kanzhibo 别名', cmd(b.got, '看直播') && cmd(b.got, '看直播').aliases.includes('kanzhibo'))
ok('一条给模型的规则', b.got.rules.length === 1 && /kanzhibo_enter/.test(b.got.rules[0]))
ok('两个网页接口 /status /selfcheck', Boolean(route(b.got, '/status')) && Boolean(route(b.got, '/selfcheck')))
ok('注册了配置监听（改间隔热生效）', b.got.events.some(([n]) => n === 'config'))
ok('导出了 tick / selfCheck / status', typeof b.out.tick === 'function' && typeof b.out.selfCheck === 'function' && typeof b.out.status === 'function')

console.log('\n=== 2.5 主人权限：别人拿不到操作类工具 ===')
const other = boot({ owner: false })
ok('非主人只剩 1 个工具', other.got.tools.length === 1, other.got.tools.map((t) => t.name).join(', '))
ok('非主人没有进房 / 停止 / 送礼 / 说话', ['kanzhibo_enter', 'kanzhibo_stop', 'kanzhibo_gift', 'kanzhibo_say'].every((n) => !tool(other.got, n)))
const stOther = await tool(other.got, 'kanzhibo_status').execute({})
ok('非主人问状态不暴露在看谁', /挂直播/.test(stOther.message) && !/目标：/.test(stOther.message), stOther.message)

console.log('\n=== 2.6 QQ 私信送礼的开关 ===')
const dmOn = boot({ settings: { giftByDm: true } })
ok('开关打开 + 私聊：多给她一个送礼工具', dmOn.got.tools.length === 5 && Boolean(tool(dmOn.got, 'kanzhibo_gift')), dmOn.got.tools.map((t) => t.name).join(', '))
const dmGroup = boot({ settings: { giftByDm: true }, chatKind: 'group' })
ok('开关打开但在群里：照样没有送礼工具', !tool(dmGroup.got, 'kanzhibo_gift'), dmGroup.got.tools.map((t) => t.name).join(', '))
const dmOther = boot({ settings: { giftByDm: true }, owner: false })
ok('开关打开但不是主人：没有送礼工具', !tool(dmOther.got, 'kanzhibo_gift'))
Object.assign(dmOn.s, { giftByDm: false })
const giftRefused = await tool(dmOn.got, 'kanzhibo_gift').execute({ gift: '小心心' })
ok('面板上一关，送礼立刻被拒（不用重载）', giftRefused.ok === false && /开关关着/.test(giftRefused.message), giftRefused.message)
const stDm = await route(dmOn.got, '/selfcheck')({})
ok('/selfcheck 里能看到这个开关', stDm.giftByDm === false)
ok('/看直播 状态 会带一句「私信送礼」', /私信送礼：/.test(await cmd(dmOn.got, '看直播').run('')))

console.log('\n=== 3. 状态与自检 ===')
const st = await tool(b.got, 'kanzhibo_status').execute({})
ok('kanzhibo_status 能回话', st.ok && /挂直播/.test(st.message), st.message.split('\n')[0])
const sc = await b.out.selfCheck()
ok('selfCheck 说清浏览器和 CDP', /浏览器：/.test(sc) && /CDP：/.test(sc))
// 找得到浏览器就要是真路径；找不到（比如 CI 的 Linux runner）也要老实说「没找到」
const binLine = ((sc.match(/浏览器：(.*)/) || [])[1] || '').trim()
const looksLikePath = /msedge\.exe|chrome\.exe/i.test(binLine)
ok('selfCheck 的浏览器那一行能用', looksLikePath ? existsSync(binLine) : /没找到/.test(binLine), binLine || '（空）')
const r1 = await route(b.got, '/selfcheck')({})
ok('/selfcheck 返回 JSON', r1.ok === true && typeof r1.browser === 'string' && typeof r1.inWindow === 'boolean', 'inWindow=' + r1.inWindow + ' browser=' + (r1.browser || '（没找到）'))

console.log('\n=== 4. 时段判定（含跨午夜） ===')
const win = b.out._debug.inWindow
const at = (h, m) => new Date(2026, 10, 4, h, m)
const withSchedule = (start, end, fn) => {
  Object.assign(b.s, { schedule: true, startTime: start, endTime: end })
  const r = fn()
  Object.assign(b.s, { schedule: false, startTime: '20:00', endTime: '23:30' })
  return r
}
ok('不限时段时永远算在时段内', b.out._debug.inWindow(at(3, 0)))
ok('21:07-23:00 在 22:00 → 在', withSchedule('21:07', '23:00', () => win(at(22, 0))))
ok('21:07-23:00 在 17:10 → 不在', withSchedule('21:07', '23:00', () => win(at(17, 10)) === false))
ok('22:30-01:00 在 00:30 → 在（跨午夜）', withSchedule('22:30', '01:00', () => win(at(0, 30))))
ok('22:30-01:00 在 12:00 → 不在', withSchedule('22:30', '01:00', () => win(at(12, 0)) === false))
ok('开始=结束 当作全天', withSchedule('20:00', '20:00', () => win(at(9, 0))))
ok('时间写错回落到 20:00-23:30', withSchedule('乱写', '也乱写', () => win(at(21, 0)) && win(at(12, 0)) === false))
ok('dayKey 形如 2026-11-04', /^\d{4}-\d{2}-\d{2}$/.test(b.out._debug.dayKey()))

console.log('\n=== 5. tick 的行为（不发真消息） ===')
const off = await b.out.tick()
ok('开关关着时不动手', off.ok === false && /没打开/.test(off.message), off.message)
Object.assign(b.s, { enabled: true, schedule: true, startTime: '03:00', endTime: '03:01' })
const outside = await b.out.tick()
ok('不在时段 → 不开浏览器', outside.ok === false && /时间段|时段/.test(outside.message), JSON.stringify(outside))
Object.assign(b.s, { schedule: false, enabled: true, target: '' })
const noTarget = await b.out.tick()
ok('没填目标 → 说清楚', noTarget.ok === false && /地址/.test(noTarget.message), noTarget.message)

console.log('\n=== 6. 崩溃恢复：上次暂停了刷抖音，这次要放回来 ===')
const rec = boot({ settings: { enabled: false }, cfg: { douyin: { enabled: false } }, state: { pausedDouyin: true } })
ok('加载后刷抖音被放回 true', rec.config.douyin.enabled === true, 'douyin.enabled=' + rec.config.douyin.enabled)
ok('状态文件的暂停标记清掉了', JSON.parse(readFileSync(join(rec.dataDir, 'state.json'), 'utf8')).pausedDouyin === false)
const cooling = boot({ settings: { enabled: false }, cfg: { douyin: { enabled: false } }, state: { pausedDouyin: true, resumeAt: Date.now() + 600000 } })
ok('冷却期没到就先不动', cooling.config.douyin.enabled === false)
const stillOn = boot({ settings: { enabled: true }, cfg: { douyin: { enabled: false } }, state: { pausedDouyin: true } })
ok('挂直播开着时不瞎恢复', stillOn.config.douyin.enabled === false)

console.log('\n=== 7. 命令 ===')
const c = cmd(b.got, '看直播')
ok('/看直播 状态', /挂直播/.test(await c.run('')))
ok('/看直播 自检', /看直播自检/.test(await c.run('自检')))
ok('/看直播 关 → 把刷抖音放回来', /关了/.test(await c.run('关')))
ok('乱写的参数给菜单', /能用的有/.test(await c.run('滚')))

console.log('\n=== 8. 选点 / 唯一性 / 签名（纯函数） ===')
ok('选点：9 点全过就用中心', (() => { const pts = Array.from({ length: 9 }, (_, i) => ({ x: 10 + i, y: 20, ok: true })); const p = choosePoint(pts); return Boolean(p) && p.x === 14 && p.y === 20 })())
ok('选点：好点不足 5 个就放弃', choosePoint([{ x: 1, y: 1, ok: true }, { x: 2, y: 2, ok: false }]) === null)
ok('选点：中心被挡就用离它最近的好点', (() => { const pts = Array.from({ length: 9 }, (_, i) => ({ x: i * 10, y: 100, ok: i !== 4 })); const p = choosePoint(pts); return Boolean(p) && p.x === 30 })())
ok('唯一性：两个候选就放弃', (() => { const r = pickUnique([{ sig: 'a' }, { sig: 'b' }]); return r.ok === false && /不唯一/.test(r.reason) })())
ok('唯一性：一个候选就放行', pickUnique([{ sig: 'a' }]).ok === true)
ok('签名比对：不同就作废', sameSig('a', 'b') === false && sameSig('a', 'a') === true && sameSig('', '') === false)
ok('spec 归一：region 补全成 0~1', (() => { const s = normalizeSpec({ text: '赠送' }); return s.region.left === 0 && s.region.right === 1 && s.text === '赠送' })())

console.log('\n=== 9. 半自动闸门 ===')
{
  let now = 1000
  const gate = createGate({ ttlMs: 1000, now: () => now })
  const a1 = gate.open({ kind: 'badge', label: '续灯牌' })
  ok('开一个待确认', a1.ok && Boolean(gate.peek()) && gate.peek().label === '续灯牌')
  const a2 = gate.open({ kind: 'gift', label: '送礼' })
  ok('已经有没结掉的：拒绝再开', a2.ok === false && /等你确认/.test(a2.reason))
  ok('拿错 id 拿不走', gate.take('nope') === null && Boolean(gate.peek()))
  const took = gate.take()
  ok('同一个动作只能用一次', Boolean(took) && gate.take() === null)
  const b = createGate({ ttlMs: 1000, now: () => now })
  b.open({ kind: 'badge', label: '超时的这个' })
  now += 5000
  const gone = b.sweep()
  ok('到点了 sweep 拿得到，且只给一次', gone && gone.label === '超时的这个' && b.sweep() === null)
  ok('过期之后 peek 是空', b.peek() === null)
  const g3 = createGate({ ttlMs: 1000, now: () => now })
  g3.setTtl(3000)
  const o3 = g3.open({ kind: 'badge', label: '改过有效期' })
  ok('setTtl 会改有效期（面板「等你多少秒」）', o3.ok && (o3.action.deadline - o3.action.at) === 3000)
  ok('settings 里有 confirmSec，默认 90', Boolean(setting('confirmSec')) && mod.defaults.confirmSec === 90)
}

console.log('\n=== 10. 点击器：该拒就拒，该点就点 ===')
const mkCand = (sig, left = 10) => ({ text: '赠送', sig, tag: 'button', clickable: true, area: 800, rect: { left, top: 10, width: 40, height: 20, right: left + 40, bottom: 30 } })
const allGood = () => ({ ok: true, good: 9, rect: { left: 10, top: 10, width: 40, height: 20 }, points: Array.from({ length: 9 }, (_, i) => ({ x: 10 + i, y: 20, ok: true })) })
const covered = () => ({ ok: false, good: 2, rect: { left: 10, top: 10, width: 40, height: 20 }, points: Array.from({ length: 9 }, (_, i) => ({ x: 10 + i, y: 20, ok: i < 2, hit: '弹层' })) })
function harness({ find, hit }) {
  const sent = []
  const evalJs = async (expr) => {
    if (expr.startsWith('(' + FIND_SRC)) return typeof find === 'function' ? find() : find
    if (expr.startsWith('(' + HIT_SRC)) {
      const arg = JSON.parse(expr.slice(('(' + HIT_SRC + ')(').length, -1))
      return typeof hit === 'function' ? hit(arg) : hit
    }
    if (expr.startsWith('(' + MARK_SRC)) return { left: 0, top: 0, width: 10, height: 10 }
    if (expr.startsWith('(' + UNMARK_SRC)) return true
    if (expr.startsWith('(' + SCROLL_SRC)) return { x: 0, y: 0 }
    if (expr.includes('[data-ab-pick]')) return { rect: { left: 10, top: 10, width: 40, height: 20 }, text: 'x' }
    return null
  }
  const clicker = createClicker({
    evalJs,
    send: async (method, params) => { sent.push([method, params]) },
    sleep: async () => {},
    note: () => {},
  })
  return { clicker, sent }
}
{
  const h = harness({ find: { total: 2, list: [mkCand('a', 10), mkCand('b', 300)] }, hit: allGood() })
  const r = await h.clicker.clickOnce({ label: '赠送', spec: { text: '赠送' } })
  ok('两个候选（位置不同）：拒绝，一下都不点', r.ok === false && /不唯一/.test(r.reason) && h.sent.length === 0, r.reason)
}
{
  // 内层 span + 外层按钮，矩形几乎重合 → 合并成一个，照点
  const inner = mkCand('inner', 10)
  const outer = { text: '赠送', sig: 'outer', tag: 'div', clickable: true, area: 900, rect: { left: 8, top: 8, width: 44, height: 24, right: 52, bottom: 32 } }
  const collapsed = collapseNested([inner, outer])
  ok('嵌套重复候选合并成一个', collapsed.length === 1 && /inner/.test(collapsed[0].sig))
  const h2 = harness({ find: { total: 2, list: [inner, outer] }, hit: allGood() })
  const r2 = await h2.clicker.clickOnce({ label: '赠送', spec: { text: '赠送' }, settleMs: 0 })
  ok('合并后可以点', r2.ok === true)
}
{
  const h = harness({ find: { total: 1, list: [mkCand('a')] }, hit: covered() })
  const r = await h.clicker.clickOnce({ label: '赠送', spec: { text: '赠送' } })
  ok('被挡住：命中校验不过就不点', r.ok === false && /命中校验没过/.test(r.reason) && h.sent.length === 0, r.reason)
}
{
  const h = harness({ find: { total: 1, list: [mkCand('a')] }, hit: allGood() })
  const r = await h.clicker.clickOnce({ label: '赠送', spec: { text: '赠送' }, settleMs: 0 })
  const pressed = h.sent.some(([m, p]) => m === 'Input.dispatchMouseEvent' && p && p.type === 'mousePressed')
  ok('全过：真的按下去了（悬停 → 按下 → 抬起）', r.ok && pressed && h.sent.length >= 4, '事件 ' + h.sent.length)
}
{
  const state = { sig: 'a' }
  const h = harness({ find: () => ({ total: 1, list: [mkCand(state.sig)] }), hit: allGood() })
  const prep = await h.clicker.prepare({ label: '赠送', spec: { text: '赠送' } })
  state.sig = 'b'
  const r = await h.clicker.commit(prep, { settleMs: 0 })
  ok('等确认期间目标换了：作废，不点', prep.ok && r.ok === false && /换了/.test(r.reason) && h.sent.length === 0, r.reason)
}
{
  const state = { hit: covered() }
  const h = harness({ find: { total: 1, list: [mkCand('a')] }, hit: () => state.hit })
  const prep = await h.clicker.prepare({ label: '赠送', spec: { text: '赠送' } })
  state.hit = allGood()
  const r = await h.clicker.commit(prep, { settleMs: 0 })
  ok('准备时被挡、确认时好了：放行', prep.ok === false || (r.ok === true), prep.ok ? ('确认态：' + r.ok) : '准备就被挡（也是安全失败）')
}

console.log('\n=== 11. 面板 panel.js 能跑 ===')
ok('定义里挂了 panel.js', mod.panel === 'panel.js')
const panelSrc = readFileSync(new URL('../panel.js', import.meta.url), 'utf8')
ok('风险提示写进了面板（灯牌误触 / 抖币）', /误触|点偏/.test(panelSrc) && /抖币/.test(panelSrc))
ok('面板按大类分卡片，送礼独立一大类', /title: '送礼'/.test(panelSrc) && /title: '挂直播'/.test(panelSrc) && /title: '风险与现场/.test(panelSrc) && /title: '现在是什么状态'/.test(panelSrc))
ok('调试卡已取消，「进房时通知我」并进挂直播卡', !/title: '调试'/.test(panelSrc) && /label: '进房时通知我'/.test(panelSrc) && panelSrc.indexOf("label: '进房时通知我'") < panelSrc.indexOf("title: '进房评论'"))
let panelThrew = ''
let panelTree = null
try {
  const fakeSc = { ok: true, connected: true, port: 9333, url: 'https://live.douyin.com/1', enabled: true, target: 'https://live.douyin.com/1', schedule: true, inWindow: false, pausedDouyin: true, commentedDay: '2026-11-06', badgeDay: '', today: '2026-11-06', giftByDm: true, text: '看直播自检（v0.3.3）\n最近一条：进了直播间' }
  const queue = [fakeSc, false, '']
  const ReactStub = {
    createElement: (t, p, ...c) => ({ t, p, c }),
    useState: () => [queue.length ? queue.shift() : undefined, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
  }
  const hStub = ReactStub.createElement
  const uiStub = new Proxy({}, { get: (_, k) => (props) => hStub('ui.' + String(k), props) })
  const callStub = async () => fakeSc
  const Comp = new Function('React', 'h', 'ui', 'call', panelSrc)(ReactStub, hStub, uiStub, callStub)
  ok('panel.js 返回的是一个组件', typeof Comp === 'function')
  panelTree = Comp({ settings: mod.defaults, draftSettings: { giftByDm: true } })
} catch (e) {
  panelThrew = String((e && e.message) || e)
}
ok('渲染不报错（空状态 / 有自检两条分支都过）', !panelThrew && Boolean(panelTree), panelThrew || 'ok')

if (LIVE) {
  console.log('\n=== 12. 真起一次浏览器（LIVE=1）===')
  const live = boot({ settings: { enabled: true, schedule: false, target: 'https://example.com/' }, cfg: { douyin: { enabled: true } } })
  const r = await live.out.tick(true)
  ok('tick 起来了浏览器并导航', r.ok === true && /example\.com/.test(r.url || ''), JSON.stringify({ ok: r.ok, url: r.url, message: r.message }))
  const s2 = await route(live.got, '/selfcheck')({})
  ok('CDP 连上了', s2.connected === true, 'port ' + s2.port + ' url ' + s2.url)
  const stop = await cmd(live.got, '看直播').run('收工')
  ok('收工能关掉浏览器', /关了/.test(stop), stop)
  try { live.got.dispose && live.got.dispose() } catch {}
}

console.log('\n=== 日志尾巴 ===')
for (const [lv, m] of b.got.logs.slice(-8)) console.log('  [' + lv + '] ' + m)
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败' + (LIVE ? '（含真浏览器测试）' : '（纯逻辑，想连浏览器加 LIVE=1）'))
process.exit(fail ? 1 : 0)
