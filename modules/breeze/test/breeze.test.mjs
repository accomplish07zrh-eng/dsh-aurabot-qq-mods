// breeze 的纯函数测试：时间和登录态的折算、签到返回怎么翻成人话。
// 跑法（仓库根目录）：AURABOT_PLUGIN_DIR=<插件源码> node --import ./scripts/plugin-env.mjs --test "modules/*/test/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  checkinAction,
  describeClaim,
  formatDate,
  hm,
  looksLoggedIn,
  msUntil,
  nowMinutes,
  toMinutes,
} from '../lib/pure.mjs'

test('hm 解析时:分，空的或写坏了按 08:10', () => {
  assert.deepEqual(hm('08:10'), [8, 10])
  assert.deepEqual(hm('9:05'), [9, 5])
  assert.deepEqual(hm('23:59'), [23, 59])
  assert.deepEqual(hm(''), [8, 10])
  assert.deepEqual(hm(undefined), [8, 10])
  assert.deepEqual(hm('abc'), [8, 10])
  assert.deepEqual(hm('12'), [12, 10])
})

test('toMinutes 比的是分钟数，不是字符串', () => {
  assert.equal(toMinutes('08:10'), 490)
  assert.equal(toMinutes('9:00'), 540)
  // 字符串比大小会得出 '9:00' < '08:10'，分钟数才是对的
  assert.ok(toMinutes('9:00') > toMinutes('08:10'))
})

test('nowMinutes 取的是本地时间的分钟数', () => {
  const d = new Date(2026, 10, 6, 9, 30, 15)
  assert.equal(nowMinutes(d), 570)
})

test('formatDate 补零到 YYYY-MM-DD', () => {
  assert.equal(formatDate(new Date(2026, 10, 6)), '2026-11-06')
  assert.equal(formatDate(new Date(2026, 0, 1)), '2026-01-01')
})

test('msUntil 算到今天/明天的那一次', () => {
  const morning = new Date(2026, 10, 6, 7, 10, 0) // 07:10，还没到
  assert.equal(msUntil('08:10', morning), 60 * 60 * 1000)
  const later = new Date(2026, 10, 6, 9, 10, 0) // 已经过点，算明天
  assert.equal(msUntil('08:10', later), 23 * 60 * 60 * 1000)
  const exact = new Date(2026, 10, 6, 8, 10, 0) // 正好到点也算明天
  assert.equal(msUntil('08:10', exact), 24 * 60 * 60 * 1000)
})

test('looksLoggedIn 只认 breeze_blue_session、且值不能是空壳', () => {
  assert.equal(looksLoggedIn(['a=1', 'breeze_blue_session=wsBHRoB-4qS_IEnLecF1zyYy']), true)
  assert.equal(looksLoggedIn(['breeze_blue_session=']), false)
  assert.equal(looksLoggedIn(['breeze_blue_session=abc']), false)
  assert.equal(looksLoggedIn(['other=value']), false)
  assert.equal(looksLoggedIn([]), false)
  assert.equal(looksLoggedIn(null), false)
})

test('describeClaim 认得「领到」「已领过」「没领到」三种回包', () => {
  const got = describeClaim({ claimed: true, credits_issued: 400, balance: 1770.4 })
  assert.equal(got.claimed, true)
  assert.equal(got.balance, 1770)
  assert.equal(got.msg, '领到 400 积分')
  assert.equal(got.message, '领到 400 积分（余额 1770）')

  const already = describeClaim({ already_claimed: true, balance: 1766 })
  assert.equal(already.claimed, false)
  assert.equal(already.msg, '今天已经领过了')
  assert.equal(already.message, '今天已经领过了（余额 1766）')

  const unavailable = describeClaim({ claimed: false, daily_claim_available: false })
  assert.equal(unavailable.msg, '今天已经领过了')

  const nothing = describeClaim({ claimed: false })
  assert.equal(nothing.msg, '这次没领到（可能已经领过）')

  const serverMsg = describeClaim({ message: '积分日额度已用尽' })
  assert.equal(serverMsg.msg, '积分日额度已用尽')

  const empty = describeClaim({})
  assert.equal(empty.msg, '领好了')
  assert.equal(empty.balance, null)
  assert.equal(empty.message, '领好了')
})

test('describeClaim 没有余额数字时不硬凑「余额」', () => {
  const r = describeClaim({ claimed: true, credits_issued: 200 })
  assert.equal(r.balance, null)
  assert.equal(r.message, '领到 200 积分')
})

test('checkinAction：关掉、没登录、领过了、没到点、试满了都跳过', () => {
  const base = { on: true, hasCookie: true, done: '', day: '2026-11-06', tries: 0, at: '08:10', now: 600 }
  assert.equal(checkinAction(base), 'run')
  assert.equal(checkinAction({ ...base, on: false }), 'skip')
  assert.equal(checkinAction({ ...base, hasCookie: false }), 'skip')
  assert.equal(checkinAction({ ...base, done: '2026-11-06' }), 'skip')
  assert.equal(checkinAction({ ...base, now: 480 }), 'skip')
  assert.equal(checkinAction({ ...base, tries: 3 }), 'skip')
  assert.equal(checkinAction({ ...base, tries: 2 }), 'run')
  // 昨天领过的不影响今天
  assert.equal(checkinAction({ ...base, done: '2026-11-05' }), 'run')
})
