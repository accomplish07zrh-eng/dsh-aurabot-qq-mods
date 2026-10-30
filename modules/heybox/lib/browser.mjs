// 小黑盒验证窗口需要的最小 CDP 实现；不控制鼠标键盘，验证由主人在窗口里完成。
import { createServer } from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const CANDIDATES = [
  process.env.EDGE_PATH, process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(1500) })
  if (!r.ok) throw new Error(`浏览器调试端口返回 ${r.status}`)
  return r.json()
}

export function connectCdp(url, { WS = globalThis.WebSocket } = {}) {
  if (!WS) throw new Error('当前 Node 没有 WebSocket（要 Node 22 以上）')
  const sock = new WS(url)
  const pending = new Map()
  let nextId = 1, closed = false, finishReady = () => {}
  const ready = new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => finishReady(new Error('连不上浏览器调试端口')), 10000)
    finishReady = (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    sock.addEventListener('open', () => finishReady())
    sock.addEventListener('error', () => finishReady(new Error('连不上浏览器调试端口')))
  })
  sock.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()) } catch { return }
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message || 'CDP 出错'))
    else p.resolve(msg.result || {})
  })
  const disconnect = () => {
    if (closed) return
    closed = true
    finishReady(new Error('浏览器连接断了'))
    for (const p of pending.values()) p.reject(new Error('浏览器连接断了'))
    pending.clear()
  }
  sock.addEventListener('close', disconnect)
  return {
    ready,
    get closed() { return closed },
    send(method, params = {}, ms = 30000) {
      if (closed) return Promise.reject(new Error('浏览器连接断了'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`浏览器没响应（${method}）`)) }, ms)
        pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
        try { sock.send(JSON.stringify({ id, method, params })) } catch (error) { pending.delete(id); clearTimeout(timer); reject(error) }
      })
    },
    close() { disconnect(); try { sock.close() } catch {} },
  }
}

function windowsKillTree(pid) {
  return new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, (error) => resolve(!error)))
}

// 只连接本实例启动的浏览器，资料目录被占用时不接管也不删除锁。
export function createBrowser({ profileDir, browserPath = () => '', log, spawnProcess = spawn, getPort = freePort, getBrowserJson = getJson, connect = connectCdp, wait = sleep, platform = process.platform, killTree = windowsKillTree, killGroup = (pid) => process.kill(-pid, 'SIGKILL'), stopWaitMs = 3000 } = {}) {
  let child = null, cdp = null, attaching = null, opening = null, closing = null, generation = 0
  let exited = true, childError = null
  const connected = () => Boolean(child && !exited && cdp && !cdp.closed)
  const check = (started) => { if (generation !== started) throw new Error('小黑盒验证已关闭') }
  function waitExit(p) {
    if (exited) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, stopWaitMs)
      p.done.then(() => { clearTimeout(timer); resolve() })
    })
  }

  async function stopChild() {
    const p = child
    if (!p) return
    if (!exited && cdp && !cdp.closed) {
      try { await cdp.send('Browser.close', {}, 1000) } catch {}
      await waitExit(p)
    }
    cdp?.close()
    cdp = null
    if (!exited && p.pid) {
      if (platform === 'win32') {
        let killed = false
        try { killed = await killTree(p.pid) } catch {}
        if (!killed) try { p.kill('SIGKILL') } catch {}
      } else {
        try { killGroup(p.pid) } catch { try { p.kill('SIGKILL') } catch {} }
      }
      await waitExit(p)
    }
    if (!exited && p.pid) throw new Error('无法确认小黑盒浏览器已退出')
    if (child === p) child = null
  }

  async function open() {
    if (closing) await closing
    if (connected()) return { ok: true }
    if (opening) return opening
    const started = generation
    opening = Promise.resolve().then(async () => {
      try {
        if (child) await stopChild()
        check(started)
        try { lstatSync(join(profileDir, 'SingletonLock')); throw new Error('小黑盒浏览器资料目录被占用，请先关闭占用该目录的浏览器') }
        catch (error) { if (error.code !== 'ENOENT') throw error }
        const explicit = browserPath()
        const bin = explicit ? (existsSync(explicit) ? explicit : '') : [process.env.EDGE_PATH, process.env.CHROME_PATH, ...CANDIDATES].find((p) => p && existsSync(p))
        if (!bin) throw new Error(explicit ? `浏览器路径不对：${explicit}` : '找不到 Edge / Chrome，请先安装浏览器')
        mkdirSync(profileDir, { recursive: true })
        const port = await getPort()
        check(started)
        try { lstatSync(join(profileDir, 'SingletonLock')); throw new Error('小黑盒浏览器资料目录被占用，请先关闭占用该目录的浏览器') }
        catch (error) { if (error.code !== 'ENOENT') throw error }
        log?.info?.('启动小黑盒验证浏览器')
        const p = spawnProcess(bin, [
          `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
          '--no-first-run', '--no-default-browser-check', '--window-size=1280,860', '--window-position=-2400,-2400', 'about:blank',
        ], { stdio: 'ignore', detached: true })
        child = p
        exited = false
        childError = null
        p.done = new Promise((resolve) => {
          p.once('exit', () => { exited = true; cdp?.close(); resolve() })
          p.once('error', (error) => { childError = error; if (!p.pid) { exited = true; resolve() } })
        })
        p.unref?.()
        let target
        for (let i = 0; i < 60; i++) {
          await wait(250)
          check(started)
          if (exited || childError) throw childError || new Error('小黑盒浏览器提前退出')
          const pages = await getBrowserJson(`http://127.0.0.1:${port}/json/list`).catch(() => [])
          check(started)
          if (exited || childError) throw childError || new Error('小黑盒浏览器提前退出')
          target = pages.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
          if (target) break
        }
        if (!target) throw new Error('小黑盒浏览器启动超时')
        // 调试端口只连本机，避免页面列表中的外部 WebSocket 地址。
        const ws = new URL(target.webSocketDebuggerUrl)
        if (ws.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(ws.hostname) || Number(ws.port) !== port) throw new Error('浏览器调试地址不在本机')
        attaching = connect(target.webSocketDebuggerUrl)
        await attaching.ready
        check(started)
        await attaching.send('Page.enable')
        await attaching.send('Runtime.enable')
        check(started)
        if (exited || childError) throw childError || new Error('小黑盒浏览器提前退出')
        cdp = attaching
        attaching = null
        return { ok: true }
      } catch (error) {
        attaching?.close()
        attaching = null
        try { await stopChild() } catch (stopError) { log?.warn?.('关闭小黑盒浏览器失败：' + stopError.message) }
        return { ok: false, message: error.message }
      }
    }).finally(() => { opening = null })
    return opening
  }

  function need() { if (!connected()) throw new Error('小黑盒浏览器没连上'); return cdp }
  async function evaluate(expression) {
    const r = await need().send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面脚本出错')
    return r.result?.value
  }
  async function goto(url) {
    const r = await need().send('Page.navigate', { url })
    if (r.errorText) throw new Error(r.errorText)
    for (let i = 0; i < 60; i++) {
      const ready = await evaluate('location.href.startsWith("https://www.xiaoheihe.cn/") && document.readyState !== "loading"').catch(() => false)
      if (ready) return
      await wait(250)
    }
    throw new Error('小黑盒页面加载超时')
  }
  async function cookies() { return (await need().send('Network.getAllCookies')).cookies || [] }
  async function screenshot() {
    const r = await need().send('Page.captureScreenshot', { format: 'png' })
    return r.data ? 'data:image/png;base64,' + r.data : ''
  }
  async function show(visible) {
    const c = need()
    const { windowId } = await c.send('Browser.getWindowForTarget')
    if (!visible) {
      await c.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
      return
    }
    await c.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await c.send('Browser.setWindowBounds', { windowId, bounds: { left: 80, top: 60, width: 1280, height: 860 } })
    await c.send('Page.bringToFront')
  }
  async function close() {
    if (closing) return closing
    generation++
    const pending = opening
    closing = Promise.resolve().then(async () => {
      attaching?.close()
      if (pending) await pending
      await stopChild()
    }).finally(() => { closing = null })
    return closing
  }
  return { open, connected, evaluate, goto, cookies, screenshot, show, close }
}
