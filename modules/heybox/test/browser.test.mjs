import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowser, connectCdp } from '../lib/browser.mjs'
import { createVerifier } from '../lib/verify.mjs'
import { defer } from './helpers.mjs'

function harness(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'heybox-browser-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const children = [], connections = [], kills = []
  const browser = createBrowser({
    profileDir: dir, browserPath: () => process.execPath, getPort: options.getPort || (async () => 18888),
    wait: options.wait || (async () => {}), stopWaitMs: 5, platform: 'win32',
    spawnProcess: (_bin, args) => {
      const child = new EventEmitter()
      child.pid = 1234
      child.unref = () => {}
      child.kill = () => child.emit('exit')
      child.args = args
      children.push(child)
      return child
    },
    getBrowserJson: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:18888/devtools/page/1' }],
    connect: () => {
      const c = { closed: false, ready: Promise.resolve(), async send(method) {
        if (method === 'Browser.close') {
          if (options.closeError) throw new Error('正常关闭失败')
          children.at(-1).emit('exit')
        }
        return {}
      }, close() { this.closed = true } }
      connections.push(c)
      return c
    },
    killTree: async (pid) => { kills.push(pid); children.at(-1).emit('exit'); return true },
  })
  return { browser, dir, children, connections, kills }
}

test('并发打开共用浏览器，卸载时关闭 CDP 和自有进程，没有周期性最小化', async (t) => {
  const h = harness(t)
  const [a, b] = await Promise.all([h.browser.open(), h.browser.open()])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(h.children.length, 1)
  assert.equal(h.children[0].args.includes('--start-minimized'), false)
  assert.equal(h.browser.connected(), true)
  await h.browser.close()
  assert.equal(h.browser.connected(), false)
  assert.equal(h.connections[0].closed, true)
  assert.equal(h.kills.length, 0)
})

test('正常关闭失败时结束自有浏览器进程树并关闭连接', async (t) => {
  const h = harness(t, { closeError: true })
  assert.equal((await h.browser.open()).ok, true)
  await h.browser.close()
  assert.deepEqual(h.kills, [1234])
  assert.equal(h.connections[0].closed, true)
  assert.equal(h.browser.connected(), false)
})

test('启动期间关闭不会留下浏览器进程，资料目录锁不能被删除或接管', async (t) => {
  const port = defer()
  const h = harness(t, { getPort: () => port.promise })
  const starting = h.browser.open()
  await new Promise((r) => setImmediate(r))
  const stopping = h.browser.close()
  port.resolve(18888)
  assert.equal((await starting).ok, false)
  await stopping
  assert.equal(h.children.length, 0)
  writeFileSync(join(h.dir, 'SingletonLock'), '其他进程')
  assert.match((await h.browser.open()).message, /资料目录被占用/)
  assert.equal(h.children.length, 0)
})

test('启动过程中卸载验证器会取消启动并释放连接', async (t) => {
  const port = defer()
  const h = harness(t, { getPort: () => port.promise })
  const verifier = createVerifier({ browser: h.browser })
  const starting = verifier.begin()
  await new Promise((r) => setImmediate(r))
  verifier.dispose()
  port.resolve(18888)
  assert.equal((await starting).ok, false)
  await h.browser.close()
  assert.equal(h.children.length, 0)
  assert.equal(h.browser.connected(), false)
})

test('CDP 等待连接或命令时关闭会清理等待', async () => {
  class Socket {
    static last
    listeners = new Map()
    constructor() { Socket.last = this }
    addEventListener(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) || []), fn]) }
    emit(name) { for (const fn of this.listeners.get(name) || []) fn() }
    send() {}
    close() { this.emit('close') }
  }
  const waiting = connectCdp('ws://fake', { WS: Socket })
  waiting.close()
  await assert.rejects(waiting.ready, /连接断了/)
  const open = connectCdp('ws://fake', { WS: Socket })
  Socket.last.emit('open')
  await open.ready
  const command = open.send('Runtime.evaluate')
  open.close()
  await assert.rejects(command, /连接断了/)
})
