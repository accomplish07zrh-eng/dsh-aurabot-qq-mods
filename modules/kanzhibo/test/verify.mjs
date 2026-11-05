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

const LIVE = process.env.LIVE === '1'
let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

/** 造一个假的 api，并把模块 setup 起来 */
function boot({ settings = {}, cfg = {}, state = null, dir = null, owner = true } = {}) {
  const dataDir = dir || mkdtempSync(join(tmpdir(), 'kanzhibo-'))
  mkdirSync(dataDir, { recursive: true })
  if (state) writeFileSync(join(dataDir, 'state.json'), JSON.stringify(state))

  const s = {
    enabled: false, target: '', checkSec: 120, schedule: false, startTime: '20:00', endTime: '23:30',
    liveCommentOn: false, liveComment: '', commentDelaySec: 8, renewBadge: false, badgeDelaySec: 30, minuteReport: false,
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
    tool: (fn) => { const t = fn({ chat: { kind: 'private', chatId: 'private:1' }, sessionId: 's1' }); got.tools.push(...(Array.isArray(t) ? t : [t]).filter(Boolean)); return () => {} },
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
ok('有 defaults + settings 表单', Object.keys(mod.defaults || {}).length > 5 && mod.settings.length >= 10, mod.settings.length + ' 个设置项')

console.log('\n=== 2. setup 注册了什么 ===')
const b = boot()
ok('5 个给她用的工具', b.got.tools.length === 5, b.got.tools.map((t) => t.name).join(', '))
ok('工具名都对', ['kanzhibo_enter', 'kanzhibo_status', 'kanzhibo_stop', 'kanzhibo_gift', 'kanzhibo_say'].every((n) => tool(b.got, n)))
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

if (LIVE) {
  console.log('\n=== 8. 真起一次浏览器（LIVE=1）===')
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
