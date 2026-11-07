// 房间模块的测试：发布内容、场景取舍、路由。
// 不碰真 Aurabot，用一个假的 api 把路由记下来，直接调处理函数看返回。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import mod from '../index.js'

const DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (name) => readFileSync(join(DIR, name), 'utf8')
const manifest = JSON.parse(read('module.json'))

/** 假的 api：路由收集起来，core 用万能代理兜住没预料到的调用。 */
function boot() {
  const routes = new Map()
  const data = mkdtempSync(join(tmpdir(), 'room3d-test-'))
  const anyFn = () => new Proxy(function () {}, { get: () => anyFn(), apply: () => undefined })
  const api = {
    dir: DIR,
    dataDir: () => data,
    route: (path, handler) => routes.set(path, handler),
    tool: () => {},
    defineTool: () => {},
    rule: () => {},
    on: () => {},
    core: new Proxy({ http: { send: (res, code, body, type) => { res.sent = { code, body, type } } } }, { get: (t, k) => t[k] ?? anyFn() }),
    use: () => anyFn(),
  }
  assert.equal(typeof mod.setup, 'function')
  mod.setup(api)
  return { routes, data }
}

const { routes, data } = boot()
test.after(() => rmSync(data, { recursive: true, force: true }))

const call = async (path, req = {}) => {
  const handler = routes.get(path)
  assert.ok(handler, `没有注册路由 ${path}`)
  const res = { headers: {} }
  const out = await handler(req, res)
  return res.sent ? { ...res.sent } : out
}

test('module.json 和入口对得上', () => {
  assert.equal(mod.id, manifest.id)
  assert.equal(mod.id, 'room3d')
  assert.equal(mod.version, manifest.version)
  assert.equal(mod.api, manifest.api)
  assert.equal(typeof mod.version, 'string')
  assert.match(mod.version, /^\d+\.\d+\.\d+$/)
  assert.equal(mod.panel, 'panel.js')
  assert.ok(existsSync(join(DIR, 'LICENSE')))
  assert.ok(existsSync(join(DIR, 'README.md')))
})

test('页面在 assets/ 下，而且没有管理密码', () => {
  for (const name of ['room.html', 'world.html']) {
    const file = join(DIR, 'assets', name)
    assert.ok(existsSync(file), `缺 assets/${name}`)
  }
  const room = read('assets/room.html')
  assert.match(room, /<title>小小柒的家<\/title>/)
  assert.doesNotMatch(room, /ADMIN_PIN|管理密码|room_admin/, '管理密码应该已经删干净')
  assert.doesNotMatch(room, /astrbot|AstrBot|18791/i, '不该再出现旧出处')
  assert.doesNotMatch(read('index.js'), /astrbot|AstrBot|18791/i)
  assert.match(read('assets/world.html'), /会当凌绝顶|大世界/)
})

test('屋里只有小小柒一个角色', () => {
  const room = read('assets/room.html')
  assert.match(room, /const ACTORS = \['xiaoyu'\];/)
  assert.doesNotMatch(room, /charD|charM|charL|charE/)
  assert.doesNotMatch(room, /老爹_待机|老爹_走路/)
  assert.ok(!/id="nd"|id="nm"|id="nl"|id="ne"/.test(room), '其他人的名牌应该没了')
})

test('/page 和 /world 返回页面', async () => {
  const page = await call('/page')
  assert.equal(page.code, 200)
  assert.match(page.type, /text\/html/)
  assert.match(page.body.toString('utf8'), /小小柒的家/)

  const world = await call('/world')
  assert.equal(world.code, 200)
  assert.match(world.type, /text\/html/)
})

test('/api/room/state 默认只有小小柒，家具默认是空的', async () => {
  const state = await call('/api/room/state')
  assert.equal(state.ok, true)
  assert.ok(state.xiaoyu, '默认状态要有小小柒')
  assert.equal(state.dayu, undefined, '不该再给老爹留位置')
  assert.deepEqual(state.log, [])

  const furniture = await call('/api/room/furniture')
  assert.equal(furniture.ok, true)
  assert.deepEqual(furniture.items, [], '默认不摆家具')
})

test('家具库完整保留，只是场景默认空着', async () => {
  const room = read('assets/room.html')
  const from = room.indexOf('const FURN_CATALOG = [')
  const to = room.indexOf('const FURN_BY_ID')
  assert.ok(from > 0 && to > from, '找不到家具库 FURN_CATALOG')
  const kinds = (room.slice(from, to).match(/\{ *id:/g) || []).length
  assert.ok(kinds >= 80, `家具库应该有 81 种，实际只数到 ${kinds} 种`)
  const cats = new Set(room.slice(from, to).match(/cat: *'[^']+'/g) || [])
  assert.ok(cats.size >= 8, `家具分类应该还在，实际 ${cats.size} 类`)

  // 场景里不摆东西 ≠ 家具库没了：默认 items/walls 是空的，家具随时能摆
  const furniture = await call('/api/room/furniture')
  assert.equal(furniture.ok, true)
  assert.deepEqual(furniture.items, [], '默认不摆家具')
})

test('/api/room/anims 只列真正的动作', async () => {
  const { anims } = await call('/api/room/anims')
  assert.ok(Array.isArray(anims) && anims.length > 0, '至少要有几个动作')
  for (const name of anims) {
    assert.equal(typeof name, 'string')
    assert.doesNotMatch(name, /老爹|走路|待机/, `不该把 ${name} 当动作列出来`)
    assert.ok(existsSync(join(DIR, 'assets', `${name}.webm`)), `清单里的 ${name} 没有对应文件`)
  }
  // 清单是扫目录来的：每个 .webm 要么在清单里，要么是被过滤掉的那几类
  const files = readdirSync(join(DIR, 'assets')).filter((n) => n.endsWith('.webm')).map((n) => n.slice(0, -5))
  for (const name of files) {
    if (/老爹|走路|待机/.test(name)) continue
    assert.ok(anims.includes(name), `${name} 没进清单`)
  }
})

test('panel.js 能按插件的方式解析，iframe 指向 /page', () => {
  const source = read('panel.js')
  assert.doesNotThrow(() => new Function(source), 'panel.js 语法错了面板会白屏')
  assert.match(source, /\/aurabot\/api\/ext\/room3d\/page/)
  assert.doesNotMatch(source, /astrbot|18791/i)
})
