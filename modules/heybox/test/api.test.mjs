import test from 'node:test'
import assert from 'node:assert/strict'
import { HeyboxClient, COOLDOWN_STEPS, tierOf } from '../api.mjs'
import { defer, json, ok } from './helpers.mjs'

test('限速按接口分档并串行执行，等待后重新检查冷却', async () => {
  let clock = 10000
  const wake = defer(), waiting = defer(), response = defer()
  const requests = []
  const c = new HeyboxClient({ now: () => clock, random: () => 0.5, delay: async (ms) => { waiting.resolve(ms); await wake.promise; clock += ms }, fetchImpl: async (url) => { requests.push(url); return response.promise } })
  assert.equal(tierOf('/bbs/app/api/general/search/v1'), 'search')
  assert.equal(c.gapOf('/bbs/app/api/general/search/v1', 'GET'), 8000)
  assert.equal(c.gapOf('/bbs/app/link/tree', 'GET'), 2500)
  assert.equal(c.gapOf('/bbs/app/feeds', 'GET'), 1200)
  assert.equal(c.gapOf('/bbs/app/feeds', 'POST'), 3000)
  const first = c.get('/bbs/app/feeds')
  const second = c.get('/bbs/app/feeds')
  await new Promise((r) => setImmediate(r))
  assert.equal(requests.length, 1)
  response.resolve(ok())
  await first
  assert.equal(await waiting.promise, 1200)
  c.escalate('captcha')
  wake.resolve()
  await assert.rejects(second, (e) => e.code === 'cooldown')
  assert.equal(requests.length, 1)
  c.dispose()
})

test('403、HTML 验证码和 429 都进入持久冷却，普通请求不得再发', async () => {
  for (const response of [json({ status: 'show_captcha', msg: '需要验证' }, 403), new Response('需要安全验证', { status: 403 }), json({ status: 'error' }, 429)]) {
    const persisted = []
    let calls = 0
    const c = new HeyboxClient({ now: () => 1000, onRisk: (info) => persisted.push(info), fetchImpl: async () => { calls++; return response } })
    await assert.rejects(c.get('/x'), (e) => ['captcha', 'rate_limit'].includes(e.code))
    assert.equal(persisted[0].until, 1000 + COOLDOWN_STEPS[0])
    await assert.rejects(c.get('/x'), (e) => e.code === 'cooldown')
    assert.equal(calls, 1)
    const restored = new HeyboxClient({ risk: persisted[0], now: () => 1001, fetchImpl: async () => { throw new Error('不应联网') } })
    await assert.rejects(restored.get('/x'), (e) => e.code === 'cooldown')
    c.dispose(); restored.dispose()
  }
})

test('429 的响应体不可读也立即进入冷却；明确为 0 的验证码字段不误报', async () => {
  const c = new HeyboxClient({ fetchImpl: async () => ({ status: 429, text: async () => { throw new Error('读取失败') } }) })
  await assert.rejects(c.get('/x'), (e) => e.code === 'rate_limit')
  assert.equal(c.riskInfo().level, 1)
  c.dispose()
  const clean = new HeyboxClient({ fetchImpl: async () => ok({ show_captcha: 0, need_captcha: '0' }) })
  await clean.get('/x')
  assert.equal(clean.riskInfo().level, 0)
  clean.dispose()
})

test('dispose 中断等待中的请求并拒绝后续请求', async () => {
  const waiting = defer()
  const c = new HeyboxClient({ interval: 10000, random: () => 0.5, fetchImpl: async () => ok(), delay: async (_ms, signal) => { waiting.resolve(); return new Promise((_resolve, reject) => signal.addEventListener('abort', reject, { once: true })) } })
  await c.get('/x')
  const pending = c.get('/x')
  await waiting.promise
  c.dispose()
  await assert.rejects(pending, (e) => e.code === 'disposed')
  await assert.rejects(c.get('/x'), (e) => e.code === 'disposed')
})
