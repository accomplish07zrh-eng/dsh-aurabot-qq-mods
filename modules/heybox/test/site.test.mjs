import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, defer, ok } from './helpers.mjs'
import { isPeakTime, today } from '../site.mjs'

// 固定东八区，让本地午夜和 UTC 日期不同，能检出 UTC 重置的回归。
process.env.TZ = 'Asia/Shanghai'

const feed = async (url) => {
  assert.equal(url.pathname, '/bbs/app/feeds')
  return ok({ links: [{ linkid: '123456', title: '游戏' }] })
}

test('hasLogin 认 pkey 和 user_pkey，自动逛额度和 lastRun 落盘', async (t) => {
  const f = fixture({ fetcher: feed })
  t.after(() => f.close())
  assert.equal(f.hb.hasLogin(), true)
  f.cfg.heybox.cookie = 'user_pkey=abc'
  assert.equal(f.hb.hasLogin(), true)
  f.cfg.heybox.cookie = 'pkey='
  assert.equal(f.hb.hasLogin(), false)
  await f.hb.tick()
  assert.equal(f.calls.length, 0)
  f.cfg.heybox.cookie = 'pkey=abc'
  await f.hb.tick()
  assert.equal(f.turns.length, 1)
  assert.equal(f.hb.state().quota.browse, 1)
  assert.equal(f.hb.state().lastRun, f.time)
  await f.hb.tick()
  assert.equal(f.turns.length, 1)
})

test('总开关、dryRun、醒着时间和缺失配置都按语义处理', async (t) => {
  const f = fixture({ fetcher: feed })
  t.after(() => f.close())
  f.cfg.enabled = false
  await f.hb.tick(); assert.equal((await f.hb.runDuty()).ok, false)
  f.cfg.enabled = true; f.cfg.dryRun = true
  await f.hb.tick(); assert.equal((await f.hb.runDuty()).ok, false)
  f.cfg.dryRun = false; f.cfg.speakUp = { awakeFrom: 12, awakeTo: 23 }
  await f.hb.tick(); assert.equal(f.calls.length, 0)
  f.cfg.speakUp = { awakeFrom: 0, awakeTo: 24 }
  // shareToOwner / offPeakOnly 不存在时默认关，不影响自动逛。
  await f.hb.tick()
  assert.equal(f.turns.length, 1)
  assert.equal(f.sends.length, 0)
})

test('today 使用本地日历，旧额度跨本地午夜重置', async (t) => {
  const date = new Date(2026, 0, 2, 0, 30)
  assert.equal(today(date), '2026-01-02')
  assert.equal(date.toISOString().slice(0, 10), '2026-01-01')
  const f = fixture({ now: date.getTime(), initialState: { quota: { date: '2026-01-01', browse: 5, share: 2 } } })
  t.after(() => f.close())
  assert.equal(f.hb.state().quota.date, '2026-01-02')
  assert.equal(f.hb.state().quota.browse, 0)
  assert.equal(f.hb.state().quota.share, 0)
})

test('峰时左闭右开、支持跨午夜及按起始日判断周末', () => {
  const cross = { peakStartAM: 22, peakEndAM: 2, peakStartPM: 0, peakEndPM: 0 }
  const monday = (h, m = 0) => new Date(2026, 5, 8, h, m)
  assert.equal(isPeakTime(cross, monday(21, 59)), false)
  assert.equal(isPeakTime(cross, monday(22)), true)
  assert.equal(isPeakTime(cross, new Date(2026, 5, 9, 1, 59)), true)
  assert.equal(isPeakTime(cross, new Date(2026, 5, 9, 2)), false)
  // 周六凌晨属于周五的跨午夜峰时；周一凌晨属于周日。
  assert.equal(isPeakTime(cross, new Date(2026, 5, 13, 1)), true)
  assert.equal(isPeakTime(cross, monday(1)), false)
  assert.equal(isPeakTime({ ...cross, peakWeekend: true }, monday(1)), true)
  assert.equal(isPeakTime({}, monday(9)), true)
  assert.equal(isPeakTime({}, monday(12)), false)
  assert.equal(isPeakTime({}, monday(14)), true)
  assert.equal(isPeakTime({}, monday(18)), false)
})

test('峰时跳过自动逛，不联网、不消耗模型或额度', async (t) => {
  const f = fixture({ config: { heybox: { offPeakOnly: true } }, fetcher: feed })
  t.after(() => f.close())
  await f.hb.tick()
  assert.equal(f.calls.length, 0)
  assert.equal(f.turns.length, 0)
  assert.equal(f.hb.state().quota.browse, 0)
  assert.match(f.hb.state().lastSkipReason, /峰时/)
  f.cfg.heybox.offPeakOnly = false
  await f.hb.tick()
  assert.equal(f.hb.state().quota.browse, 1)
})

test('分享默认关闭，先占额防并发；失败回滚，超时不重发', async (t) => {
  const gate = defer()
  const calls = []
  let mode = 'pending'
  const f = fixture({ onebot: { call: async (...args) => {
    calls.push(args)
    if (mode === 'pending') return gate.promise
    if (mode === 'fail') throw new Error('发送失败')
    if (mode === 'timeout') throw new Error('网关超时')
    return { message_id: 1 }
  } } })
  t.after(() => f.close())
  const verdict = (id) => ({ share: '分享一条游戏帖子', linkId: id })
  assert.equal((await f.hb.shareToOwner(verdict('123456'))).skipped, true)
  f.cfg.heybox.shareToOwner = true
  f.cfg.heybox.shareDaily = 1
  const first = f.hb.shareToOwner(verdict('123456'))
  assert.equal(f.hb.state().quota.share, 1)
  assert.equal((await f.hb.shareToOwner(verdict('234567'))).skipped, true)
  assert.deepEqual(calls[0][2], { retries: 0, timeoutMs: 30000 })
  gate.reject(new Error('发送失败'))
  assert.equal((await first).ok, false)
  assert.equal(f.hb.state().quota.share, 0)
  mode = 'fail'
  assert.equal((await f.hb.shareToOwner(verdict('234567'))).ok, false)
  assert.equal(f.hb.state().quota.share, 0)
  mode = 'timeout'
  const timed = await f.hb.shareToOwner(verdict('345678'))
  assert.equal(timed.uncertain, true)
  assert.equal(f.hb.state().quota.share, 1)
  f.cfg.heybox.shareDaily = 3
  assert.equal((await f.hb.shareToOwner(verdict('345678'))).skipped, true)
  assert.equal(calls.length, 3)
})

test('并发 tick 只启动一轮，运行期间关掉总开关后不分享', async (t) => {
  const turn = defer(), started = defer()
  const f = fixture({ fetcher: feed, config: { heybox: { shareToOwner: true } }, hub: { runSystemTurn: async () => { started.resolve(); return turn.promise } } })
  t.after(() => f.close())
  const first = f.hb.tick()
  await started.promise
  await f.hb.tick()
  f.cfg.enabled = false
  turn.resolve(JSON.stringify({ note: '游戏', share: '看这个', linkId: '123456' }))
  await first
  assert.equal(f.calls.length, 1)
  assert.equal(f.sends.length, 0)
  assert.equal(f.hb.state().quota.browse, 1)
})

test('模块重建后未完成的分享继续占额并阻止重发', async (t) => {
  const gate = defer()
  const f = fixture({ config: { heybox: { shareToOwner: true, shareDaily: 1 } }, onebot: { call: async () => gate.promise } })
  t.after(() => f.close())
  const first = f.hb.shareToOwner({ share: '看看', linkId: '123456' })
  assert.equal(f.hb.state().quota.share, 1)
  // 同一个状态文件被重新加载时，待确认记录仍然生效。
  const { createHeybox } = await import('../site.mjs')
  const reloaded = createHeybox({ getConfig: () => f.cfg, stateFile: f.stateFile, credFile: 'missing', onebot: { call: async () => { throw new Error('不应发送') } } })
  t.after(() => reloaded.dispose())
  assert.equal((await reloaded.shareToOwner({ share: '看看', linkId: '123456' })).skipped, true)
  assert.equal(reloaded.clearQuota().ok, false)
  gate.reject(new Error('超时'))
  assert.equal((await first).uncertain, true)
})

test('自动分享仅允许模型选择本轮信息流的帖子并检查 dryRun', async (t) => {
  const f = fixture({ fetcher: feed, config: { heybox: { shareToOwner: true } }, hub: { runSystemTurn: async () => JSON.stringify({ note: '游戏', share: '看这个', linkId: '123456' }) } })
  t.after(() => f.close())
  await f.hb.tick()
  assert.equal(f.sends.length, 1)
  assert.equal(f.hb.state().quota.share, 1)
  f.cfg.dryRun = true
  assert.equal((await f.hb.shareToOwner({ share: '看看', linkId: '234567' })).skipped, true)
  assert.equal(f.sends.length, 1)
})
