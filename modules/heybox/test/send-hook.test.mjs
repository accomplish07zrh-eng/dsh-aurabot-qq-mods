// 使用插件里的真实消息中枢，验证扩展发送钩子和宿主隐藏网关超时的行为。
import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers.mjs'

const { createHub } = globalThis.aurabot.lib('chat/hub.js')
const { createOneBotClient } = globalThis.aurabot.lib('onebot/client.js')

function hubFixture(f, handler) {
  const calls = []
  const hooks = []
  const hub = createHub({
    dsh: {}, getConfig: () => ({ ...f.cfg, stickers: { faces: false } }),
    log: { info() {}, warn() {}, debug() {} }, stickers: {},
    onebot: { call: async (...args) => { calls.push(args); return handler(...args) } },
    hooks: { send: async (message, info) => {
      hooks.push(info)
      return [...message, { type: 'text', data: { text: '（扩展签名）' } }]
    } },
  })
  return { hub, calls, hooks }
}

test('分享经过真实宿主发送钩子，超时被宿主转换为 null 时不回滚、不重发', async (t) => {
  const f = fixture()
  t.after(() => f.close())
  let mode = 'ok'
  const real = hubFixture(f, async () => { if (mode === 'timeout') throw new Error('网关超时'); return { message_id: 7 } })
  t.after(() => real.hub.dispose())
  const { createHeybox } = await import('../lib/site.mjs')
  const hb = createHeybox({ getConfig: () => f.cfg, hub: real.hub, stateFile: f.stateFile, credFile: 'missing' })
  t.after(() => hb.dispose())
  assert.equal((await hb.shareToOwner({ share: '看看', linkId: '123456' })).ok, true)
  assert.equal(real.hooks[0].chatId, 'private:12345678')
  assert.equal(real.calls[0][0], 'send_private_msg')
  assert.equal(real.calls[0][1].message.at(-1).data.text, '（扩展签名）')
  mode = 'timeout'
  const result = await hb.shareToOwner({ share: '看看', linkId: '234567' })
  assert.equal(result.uncertain, true)
  assert.equal(hb.state().quota.share, 2)
  assert.equal((await hb.shareToOwner({ share: '看看', linkId: '234567' })).skipped, true)
  assert.equal(real.calls.length, 2)
})

test('真实宿主和 OneBot 发送链路遇到超时只请求一次', async (t) => {
  const f = fixture()
  t.after(() => f.close())
  const oldFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = oldFetch })
  let requests = 0, hooks = 0
  globalThis.fetch = async () => { requests++; throw Object.assign(new Error('超时'), { name: 'AbortError' }) }
  const log = { info() {}, warn() {}, debug() {} }
  const onebot = createOneBotClient({ endpoint: () => ({ httpUrl: 'http://127.0.0.1:1' }), log, retryDelays: [0, 0] })
  const hub = createHub({ dsh: {}, getConfig: () => ({ ...f.cfg, stickers: { faces: false } }), log, onebot, stickers: {}, hooks: { send: async (message) => { hooks++; return message } } })
  t.after(() => hub.dispose())
  const { createHeybox } = await import('../lib/site.mjs')
  const hb = createHeybox({ getConfig: () => f.cfg, hub, stateFile: f.stateFile, credFile: 'missing' })
  t.after(() => hb.dispose())
  assert.equal((await hb.shareToOwner({ share: '看看', linkId: '123456' })).uncertain, true)
  assert.equal((await hb.shareToOwner({ share: '看看', linkId: '123456' })).skipped, true)
  assert.equal(requests, 1)
  assert.equal(hooks, 1)
})
