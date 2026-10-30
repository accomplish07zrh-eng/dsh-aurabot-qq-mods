import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, defer, json, ok } from './helpers.mjs'
import { createVerifier, VERIFY_PROBE } from '../lib/verify.mjs'

function browserFake() {
  const b = {
    url: 'about:blank', why: '', list: [{ domain: '.xiaoheihe.cn', name: 'pkey', value: 'new' }], calls: [], isOpen: false,
    async open() { this.isOpen = true; this.calls.push('open'); return { ok: true } },
    connected() { return this.isOpen },
    async evaluate(expression) {
      if (expression === 'location.href') return this.url
      assert.equal(expression, VERIFY_PROBE)
      if (this.why instanceof Error) throw this.why
      return this.why
    },
    async goto(url) { this.url = url; this.calls.push(['goto', url]) },
    async show(visible) { this.calls.push(['show', visible]) },
    async cookies() { this.calls.push('cookies'); return this.list },
    async screenshot() { return 'data:image/png;base64,AA' },
    async close() { this.calls.push('close'); this.isOpen = false },
  }
  return b
}

const cooling = { risk: { level: 1, until: new Date(2026, 5, 8, 11).getTime(), reason: 'captcha', at: 1 } }

test('页面探测允许小黑盒子域名，并拒绝其他域名和未加载的页面', () => {
  const run = new Function('location', 'document', 'getComputedStyle', `return ${VERIFY_PROBE}`)
  const document = { readyState: 'complete', querySelectorAll: () => [] }
  assert.equal(run({ protocol: 'https:', hostname: 'www.xiaoheihe.cn' }, document, () => ({})), '')
  assert.equal(run({ protocol: 'https:', hostname: 'account.xiaoheihe.cn' }, document, () => ({})), '')
  assert.throws(() => run({ protocol: 'https:', hostname: 'evilxiaoheihe.cn' }, document, () => ({})), /页面尚未加载/)
  assert.throws(() => run({ protocol: 'https:', hostname: 'www.xiaoheihe.cn' }, { ...document, readyState: 'loading' }, () => ({})), /页面尚未加载/)
  const captcha = { innerText: '手动验证', getBoundingClientRect: () => ({ width: 120, height: 60 }), parentElement: null }
  const page = { ...document, querySelectorAll: () => [captcha] }
  assert.equal(run({ protocol: 'https:', hostname: 'www.xiaoheihe.cn' }, page, () => ({ visibility: 'visible', display: 'block', opacity: '1' })), '手动验证')
})

test('浏览器验证必须显示窗口，探测出错或仍有验证时不读取 Cookie', async (t) => {
  const browser = browserFake()
  const verifier = createVerifier({ browser })
  t.after(() => verifier.dispose())
  assert.equal((await verifier.begin()).ok, true)
  assert.equal((await verifier.finish()).ok, false)
  assert.equal(browser.calls.includes('cookies'), false)
  assert.equal((await verifier.showWindow(true)).ok, true)
  browser.why = new Error('页面探测失败')
  assert.equal((await verifier.finish()).verified, false)
  assert.equal(browser.calls.includes('cookies'), false)
  browser.why = undefined
  assert.equal((await verifier.finish()).verified, false)
  browser.why = '请完成滑块'
  const waiting = await verifier.finish()
  assert.equal(waiting.state, 'waiting')
  assert.equal(waiting.cookie, undefined)
  assert.equal(browser.calls.includes('cookies'), false)
  assert.deepEqual(browser.calls.filter((c) => Array.isArray(c) && c[0] === 'show'), [['show', false], ['show', true]])
})

test('通过页面探测和账号检查后才保存 Cookie 并解除冷却，接口不返回 Cookie', async (t) => {
  const browser = browserFake()
  browser.list.push({ domain: 'evilxiaoheihe.cn', name: 'bad', value: 'outside' })
  const verifier = createVerifier({ browser })
  let mode = 'empty'
  const f = fixture({ verifier, initialState: cooling, fetcher: async (url, options) => {
    assert.equal(url.pathname, '/account/restore_login')
    assert.equal(options.headers.cookie, 'pkey=new')
    if (mode === 'empty') return ok({})
    if (mode === 'error') throw new Error('网络出错')
    return ok({ profile: { heybox_id: '42', username: '盒友' } })
  } })
  t.after(() => f.close())
  assert.equal((await f.hb.verifyStart({ visible: true })).ok, true)
  browser.why = '安全验证'
  assert.equal((await f.hb.verifyFinish()).verified, false)
  assert.equal(f.calls.length, 0)
  assert.equal(f.hb.risk().level, 1)
  browser.why = ''
  assert.equal((await f.hb.verifyFinish()).verified, false)
  assert.equal(f.cfg.heybox.cookie, 'pkey=old; heybox_id=1')
  assert.equal(f.hb.risk().level, 1)
  mode = 'error'
  assert.equal((await f.hb.verifyFinish()).verified, false)
  assert.equal(f.hb.risk().level, 1)
  mode = 'ok'
  const result = await f.hb.verifyFinish()
  assert.equal(result.ok, true)
  assert.equal(result.verified, true)
  assert.equal(result.cookie, undefined)
  assert.equal(result.heyboxId, '42')
  assert.equal(f.cfg.heybox.cookie, 'pkey=new')
  assert.equal(f.hb.risk().level, 0)
  assert.equal((await f.hb.verifyFinish()).ok, false)
})

test('浏览器验证遇到新风控或配置换号时不保存、不解除冷却', async (t) => {
  for (const change of ['risk', 'cookie']) {
    const started = defer(), pending = defer()
    const browser = browserFake()
    const f = fixture({ verifier: createVerifier({ browser }), initialState: cooling, fetcher: async () => { started.resolve(); return pending.promise } })
    t.after(() => f.close())
    await f.hb.verifyStart({ visible: true })
    const finishing = f.hb.verifyFinish()
    await started.promise
    assert.equal((await f.hb.verifyFinish()).state, 'busy')
    assert.equal((await f.hb.qrStart()).state, 'busy')
    assert.equal((await f.hb.clearRisk()).ok, false)
    if (change === 'cookie') f.cfg.heybox.cookie = 'pkey=other'
    pending.resolve(change === 'risk' ? json({ status: 'need_captcha' }, 403) : ok({ profile: { heybox_id: '42' } }))
    assert.equal((await finishing).verified, false)
    assert.equal(f.cfg.heybox.cookie, change === 'cookie' ? 'pkey=other' : 'pkey=old; heybox_id=1')
    assert.equal(f.hb.risk().level, change === 'risk' ? 2 : 1)
  }
})

test('账号检查期间出现验证或换了浏览器 Cookie 时不保存、不解除冷却', async (t) => {
  for (const change of ['captcha', 'cookie']) {
    const started = defer(), pending = defer()
    const browser = browserFake()
    const f = fixture({ verifier: createVerifier({ browser }), initialState: cooling, fetcher: async () => { started.resolve(); return pending.promise } })
    t.after(() => f.close())
    await f.hb.verifyStart({ visible: true })
    const finishing = f.hb.verifyFinish()
    await started.promise
    if (change === 'captcha') browser.why = '安全验证'
    else browser.list[0].value = 'other'
    pending.resolve(ok({ profile: { heybox_id: '42' } }))
    assert.equal((await finishing).verified, false)
    assert.equal(f.cfg.heybox.cookie, 'pkey=old; heybox_id=1')
    assert.equal(f.hb.risk().level, 1)
  }
})

test('模块卸载时调用宿主返回对象的 dispose 释放验证窗口', async (t) => {
  const { createModules } = globalThis.aurabot.lib('core/modules.js')
  const { default: mod } = await import('../index.mjs')
  const browser = browserFake()
  const verifier = createVerifier({ browser })
  const methods = []
  const tracked = { ...verifier, dispose() { methods.push('dispose'); verifier.dispose() } }
  const { createHeybox } = await import('../lib/site.mjs')
  const f = fixture()
  t.after(() => f.close())
  f.cfg.safeMode = true
  const module = { ...mod, setup: () => createHeybox({ getConfig: () => f.cfg, verifier: tracked, stateFile: f.stateFile, credFile: 'missing' }) }
  const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this } }
  const modules = createModules({ ctx: {}, core: {}, getConfig: () => f.cfg, setConfig() {}, logger: log, version: '1.2.0', builtins: [module] })
  await modules.sync()
  const hb = modules.use('heybox')
  assert.equal((await hb.verifyStart({ visible: true })).ok, true)
  modules.stop('heybox')
  assert.deepEqual(methods, ['dispose'])
  assert.equal(browser.isOpen, false)
  modules.dispose()
})

test('卸载时关闭浏览器，验证检查中的请求被中断且不能保存', async (t) => {
  const started = defer()
  const browser = browserFake()
  const f = fixture({ verifier: createVerifier({ browser }), initialState: cooling, fetcher: async (_url, options) => {
    started.resolve()
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('中断')), { once: true }))
  } })
  t.after(() => f.close())
  await f.hb.verifyStart({ visible: true })
  const finishing = f.hb.verifyFinish()
  await started.promise
  f.hb.dispose()
  assert.equal((await finishing).ok, false)
  assert.equal(f.cfg.heybox.cookie, 'pkey=old; heybox_id=1')
  assert.equal(browser.calls.filter((c) => c === 'close').length, 1)
})
