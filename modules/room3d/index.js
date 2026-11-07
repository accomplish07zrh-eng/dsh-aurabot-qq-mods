// 3D 房间：托管房间页面、3D 资产和房间状态。
// 页面和资产随模块分发；状态读写在本模块的数据目录里（modules-data/room3d/）。

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const MIME = {
  '.webm': 'video/webm',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.wav': 'audio/wav',
}

export default {
  id: 'room3d',
  name: '房间',
  version: '0.3.0',
  api: 1,
  description: '一个 3D 小屋：小小柒在屋里走动、干活、发呆；场景默认空着，家具库 81 种随便摆。',
  panel: 'panel.js',
  setup(api) {
    const dir = api.dir
    // 状态不能再放在模块目录里：Aurabot 每 3 秒扫一次模块目录，任何文件变动都会
    // 触发「模块文件改了，重新加载」。3D 页面又在不停写世界/相机状态，
    // 于是变成 写一次 → 重载一次 → 页面重连再写 → 一直刷新。
    // 搬到 modules-data/room3d/，模块目录就永远是静的。
    const stateDir = api.dataDir()
    const legacyStateDir = join(dir, 'state')
    if (existsSync(legacyStateDir)) {
      try {
        const migrated = readdirSync(stateDir)
        if (!migrated.length) {
          for (const name of readdirSync(legacyStateDir)) {
            const from = join(legacyStateDir, name)
            try {
              if (statSync(from).isFile()) copyFileSync(from, join(stateDir, name))
            } catch {
              // 单个文件搬不动就跳过
            }
          }
        }
      } catch {
        // 搬不了就用空状态重来
      }
    }
    const http = api.core.http
    const send = (res, code, body, type) => http.send(res, code, body, type)
    const sendFile = (res, file, type) => {
      try {
        if (!existsSync(file)) return send(res, 404, 'not found', 'text/plain; charset=utf-8')
        send(res, 200, readFileSync(file), type || MIME[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream')
      } catch (error) {
        send(res, 500, String(error.message || error), 'text/plain; charset=utf-8')
      }
    }
    const readJson = (name, fallback) => {
      try {
        const file = join(stateDir, name)
        if (!existsSync(file)) return fallback
        return JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        return fallback
      }
    }
    const writeJson = (name, value) => {
      const file = join(stateDir, name)
      writeFileSync(file, JSON.stringify(value, null, 0), 'utf8')
    }
    const bodyOf = async (req) => {
      try { return (await http.body(req)) || {} } catch { return {} }
    }
    // ---- 把房间和世界翻译成人话，让她「看得见」 ----
    const ACTOR_NAME = { xiaoyu: '你', dayu: '老爹', mama: '麻麻', laojie: '老姐', erjie: '二姐' }
    const SPOT_NAME = {
      sofa: '客厅沙发', bed: '主卧床边', kitchen: '厨房', desk: '书房', balcony: '阳台', door: '玄关',
    }
    const FURN_NAME = {
      sofa3: '三人沙发', sofa2: '双人沙发', chair1: '单人沙发', table_round: '圆茶几', table_sq: '方茶几',
      tv_cab: '电视柜', tv75: '75 寸电视', rug: '地毯', floorlamp: '落地灯', shelf: '书架',
      bed_double: '双人床', bed_single: '单人床', nightstand: '床头柜', wardrobe: '衣柜', desk: '书桌',
      officechair: '电脑椅', tablelamp: '台灯', counter: '橱柜台面', stove: '灶台', sink: '水槽',
      fridge: '冰箱', diningtable: '餐桌', diningchair: '餐椅', plant: '盆栽', mirror: '落地镜',
      aquarium: '鱼缸', shoecab: '鞋柜', washer: '洗衣机', cat_tower: '猫爬架', curtain: '窗帘',
      pendant: '吊灯', wall_clock: '挂钟', toybox: '玩具箱', cushion_pile: '抱枕堆',
    }
    const spotName = (id) => SPOT_NAME[id] || String(id || '').trim() || '屋里'
    const actorName = (id) => ACTOR_NAME[id] || String(id || '')
    /** 按当前钟点给「光线 + 窗外」。 */
    const skyOf = (hourRaw) => {
      const hour = Number.isFinite(Number(hourRaw)) ? Number(hourRaw) : new Date().getHours()
      if (hour >= 5 && hour < 11) return { when: '早上', lamp: '屋里的灯还亮着，暖黄色的', sky: '天刚亮，太阳还低' }
      if (hour >= 11 && hour < 16) return { when: hour < 13 ? '中午' : '下午', lamp: '屋里的灯还亮着，暖黄色的', sky: '白天，阳光很亮' }
      if (hour >= 16 && hour < 18) return { when: '下午偏晚', lamp: '屋里的灯还亮着，暖黄色的', sky: '太阳开始往下沉，海面泛金' }
      if (hour >= 18 && hour < 20) return { when: '傍晚', lamp: '屋里的灯还亮着，暖黄色的', sky: '天边压着晚霞，海是暗金色' }
      return { when: '夜里', lamp: '灯已经关了，屋里有点暗', sky: '深蓝一片，只有月光' }
    }
    /** 家具清单 → 「三人沙发、圆茶几、地毯 等 12 件」这种。 */
    const furnitureText = (items) => {
      const list = Array.isArray(items) ? items : []
      if (!list.length) return '屋里还没摆什么家具'
      const seen = []
      for (const it of list) {
        const raw = String(it?.type || it?.id || '').replace(/_\d+$/, '')
        const name = FURN_NAME[raw] || FURN_NAME[String(it?.kind || '')] || ''
        if (name && !seen.includes(name)) seen.push(name)
      }
      if (!seen.length) return `摆着 ${list.length} 件家具`
      return `${seen.slice(0, 6).join('、')}${seen.length > 6 || list.length > 6 ? ' 等' : ''} ${list.length} 件家具`
    }
    const snapshotOf = () => {
      const s = readJson('room-state.json', {})
      const w = readJson('world.json', {})
      const f = readJson('furniture.json', { items: [], walls: [], cats: [] })
      const cats = readJson('cats-live.json', { cats: [] }).cats || f.cats || []
      return { s, w, f, cats }
    }
    /** 谁在哪 —— 一句话，位置事实。 */
    const peopleText = ({ s }) => {
      const rows = ['xiaoyu', 'mama', 'laojie', 'erjie']
        .filter((k) => s?.[k]?.spot)
        .map((k) => {
          const a = s[k]
          const mins = Math.max(0, Math.round((Date.now() / 1000 - Number(a.since || 0)) / 60))
          const reason = String(a.reason || '').trim()
          const tail = reason ? `${mins} 分钟，${reason}` : `${mins} 分钟`
          return `${actorName(k)}在${spotName(a.spot)}（${tail}）`
        })
      // 老爹是聊天对面那个人，他在哪由他自己说，不替他判断
      rows.unshift('老爹在你对面（他在哪儿以他自己说的为准，不要替他判断位置）')
      return rows.join('；')
    }
    const worldText = ({ w, cats }) => {
      const where = w.indoor === false ? (w.place || '外面') : (w.place || '在家里')
      const weather = { clear: '晴', cloudy: '多云', rain: '下雨', snow: '下雪' }[w.weather] || w.weather || '天气不明'
      const act = { idle: '待着', sleep: '睡觉', walk: '走动', sit: '坐着' }[w.action] || w.action || '待着'
      return `${where}，${weather}，人在${act}${cats.length ? `，${cats.length} 只猫` : ''}`
    }
    /** 完整画面：她「抬头看一眼」会看到的东西。 */
    const roomView = () => {
      const snap = snapshotOf()
      const light = skyOf(snap.w.hour)
      return [
        '（你抬头环视了一圈家里，看到的是这样的画面）',
        `光线：现在是${light.when}，${light.lamp}。`,
        `屋里：${furnitureText(snap.f.items)}，隔断 ${(snap.f.walls || []).length} 面。`,
        `窗外：${light.sky}。`,
        `人：${peopleText(snap)}。`,
        `世界：${worldText(snap)}。`,
      ].join('\n')
    }
    /** 每轮都带在身上的那几行：位置事实为主，别太啰嗦。 */
    const situationText = () => {
      const snap = snapshotOf()
      const light = skyOf(snap.w.hour)
      return [
        '【你在「大鱼和小鱼的家」里，一个 3D 小房间】',
        `现在是${light.when}，${light.lamp}；窗外是${light.sky}；外面：${worldText(snap)}。`,
        `${peopleText(snap)}。`,
        '位置随时会变（你自己走或者被安排），问到就按上面说，别说「瞬移」「怎么一下就」；',
        '跟你上一句说的不一样，就当自己刚走过去，一句带过。屋里/窗外具体什么样，用 look_at_room 看，别用 shell、curl 读源码去猜。',
      ].join('\n')
    }
    const ROOM_KEYWORDS = ['窗外', '外面', '海', '沙滩', '日落', '晚霞', '天色', '房间', '在家', '在干嘛', '在干什么', '你在哪', '看看家', '看家', '屋里', '房间里', '你在做', '躺着', '床上', '窗边', '书桌', '地毯', '客厅', '厨房', '阳台']

    api.tool(({ chat, sessionId }) => {
      if (chat.kind === 'system') return []
      return [
        api.defineTool({
          name: 'look_at_room',
          description: '抬头看一眼现在的房间和窗外：光线、家具、猫、每个人在哪、外面的世界。回答时用「我看见……」，不要说数据/系统/接口。',
          properties: {},
          execute: async () => ({ ok: true, message: roomView() }),
        }),
        api.defineTool({
          name: 'go_room_spot',
          description: '让小小柒在房间里走到某个位置，比如 sofa、desk、kitchen、balcony、bed、door。',
          properties: { spot: { type: 'string', description: '目标位置 id' } },
          required: ['spot'],
          execute: async ({ spot }) => {
            if (!api.core.hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '只有主人能让她换位置' }
            const id = String(spot || '').trim().slice(0, 24)
            if (!id) return { ok: false, message: 'spot 是空的' }
            const s = readJson('room-state.json', { ok: true, xiaoyu: {}, dayu: {}, log: [] })
            s.xiaoyu = { ...(s.xiaoyu || {}), spot: id, since: Math.floor(Date.now() / 1000) }
            writeJson('room-state.json', s)
            return { ok: true, message: `走到 ${id}（${spotName(id)}）了` }
          },
        }),
      ]
    })
    api.rule('你会看房间：有人问「你在哪 / 屋里什么样 / 窗外」时用 look_at_room；主人让你换位置时用 go_room_spot。位置以【你在「大鱼和小鱼的家」里】那段为准。')

    // 每轮把房间和世界带进她的视野里（只加在用户消息侧，不动系统提示，保住前缀缓存）
    const perceptionOn = () => readJson('perception.json', { enabled: true }).enabled !== false
    api.on('prompt', async (content, info) => {
      try {
        const chat = info?.chat
        if (!chat || chat.kind === 'system' || !Array.isArray(content)) return content
        if (!perceptionOn()) return content
        let block = situationText()
        // 问到房间/窗外，就顺手把完整画面也给她，省得非得调工具
        const asked = ROOM_KEYWORDS.some((k) => String(info?.queryText || '').includes(k))
        if (asked) block += '\n' + roomView()
        return [{ type: 'text', text: block }, ...content]
      } catch {
        return content
      }
    })

    // 静态页面与资产
    api.route('/page', async (req, res) => sendFile(res, join(dir, 'assets', 'room.html'), 'text/html; charset=utf-8'))
    api.route('/world', async (req, res) => sendFile(res, join(dir, 'assets', 'world.html'), 'text/html; charset=utf-8'))

    for (const sub of ['assets', 'vendor']) {
      const base = join(dir, sub)
      if (!existsSync(base)) continue
      for (const name of readdirSync(base)) {
        const file = join(base, name)
        try { if (!statSync(file).isFile()) continue } catch { continue }
        const type = MIME[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream'
        const handler = async (req, res) => sendFile(res, file, type)
        api.route('/' + sub + '/' + name, handler)
        const encoded = encodeURIComponent(name)
        if (encoded !== name) api.route('/' + sub + '/' + encoded, handler)
      }
    }

    // 读接口
    api.route('/api/room/state', async () => {
      const s = readJson('room-state.json', { ok: true, xiaoyu: { spot: 'sofa', action: 'idle' }, log: [] })
      if (!Array.isArray(s.log)) s.log = []
      return s
    })
    api.route('/api/room/anims', async () => {
      try {
        const names = readdirSync(join(dir, 'assets'))
          .filter((n) => n.endsWith('.webm'))
          .map((n) => n.slice(0, -5))
          .filter((n) => !n.startsWith('老爹') && !n.includes('走路') && !n.includes('待机'))
        return { ok: true, anims: names }
      } catch (error) {
        return { ok: false, err: String(error.message || error) }
      }
    })
    api.route('/api/room/actors', async () => readJson('actors.json', { ok: true, absent: [] }))
    api.route('/api/room/world', async (req, res) => {
      if (req.method === 'POST') {
        const b = await bodyOf(req)
        const state = {
          ok: true,
          indoor: Boolean(b.indoor ?? true),
          spot: String(b.spot || '').slice(0, 24),
          action: String(b.action || 'idle').slice(0, 16),
          place: String(b.place || '').slice(0, 24),
          weather: String(b.weather || 'clear').slice(0, 12),
          hour: b.hour,
          x: b.x,
          z: b.z,
          updated: Math.floor(Date.now() / 1000),
        }
        writeJson('world.json', state)
        return state
      }
      return readJson('world.json', { ok: true, indoor: true, spot: '', action: 'sleep', place: '在屋里睡觉', weather: 'clear', hour: 22, updated: 0 })
    })
    api.route('/api/room/cats-live', async (req) => {
      if (req.method === 'POST') {
        const b = await bodyOf(req)
        const cats = Array.isArray(b.cats) ? b.cats.slice(0, 60) : []
        writeJson('cats-live.json', { ok: true, cats, at: Date.now() / 1000 })
        return { ok: true }
      }
      return readJson('cats-live.json', { ok: true, cats: [] })
    })
    api.route('/api/room/floor', async (req) => {
      if (req.method === 'POST') {
        const b = await bodyOf(req)
        writeJson('floor.json', { ok: true, id: String(b.id || '').slice(0, 40) })
        return { ok: true }
      }
      return readJson('floor.json', { ok: true, id: 'pastel_check' })
    })
    api.route('/api/room/furniture', async (req, res) => {
      if (req.method === 'POST') {
        const b = await bodyOf(req)
        if (!Array.isArray(b.items)) return { ok: false, err: 'items must be a list' }
        const cur = join(stateDir, 'furniture.json')
        try {
          if (existsSync(cur)) {
            const prev = readJson('furniture.json', null)
            if (prev && (prev.items?.length || prev.walls?.length || prev.cats?.length)) copyFileSync(cur, join(stateDir, 'furniture.prev.json'))
          }
        } catch {}
        writeJson('furniture.json', {
          ok: true,
          items: b.items.slice(0, 600),
          walls: (Array.isArray(b.walls) ? b.walls : []).slice(0, 400),
          cats: (Array.isArray(b.cats) ? b.cats : []).slice(0, 60),
          wallOpacity: Number(b.wallOpacity) || 26,
        })
        return { ok: true, count: b.items.length }
      }
      const q = new URL(req.url, 'http://x').searchParams
      return readJson(q.get('prev') ? 'furniture.prev.json' : 'furniture.json', { ok: true, items: [] })
    })
    api.route('/api/room/camera', async (req) => {
      if (req.method === 'POST') {
        const b = await bodyOf(req)
        if (Array.isArray(b.pos) && b.pos.length === 3 && Array.isArray(b.target) && b.target.length === 3) {
          const pos = b.pos.map(Number)
          const target = b.target.map(Number)
          writeJson('camera.json', { ok: true, pos, target })
          return { ok: true }
        }
        return { ok: false, err: 'bad payload' }
      }
      return readJson('camera.json', { ok: false })
    })
    api.route('/api/room/layout', async () => {
      const s = readJson('room-state.json', {})
      return { ok: true, layout: s.layout || {} }
    })
    api.route('/api/room/shot', async (req, res) => {
      for (const name of ['room-shot.jpg', 'room-shot.png']) {
        const file = join(stateDir, name)
        if (existsSync(file)) return sendFile(res, file, name.endsWith('.png') ? 'image/png' : 'image/jpeg')
      }
      send(res, 404, 'no shot', 'text/plain; charset=utf-8')
    })
    api.route('/health', async () => {
      const s = readJson('room-state.json', {})
      return { ok: true, source: 'aurabot-room3d', spot: s.xiaoyu?.spot || '' }
    })

    // 调试用：看看她现在「眼里」是什么样（跟注入到提示词里的那几行一致）
    api.route('/situation', async () => ({
      ok: true,
      enabled: perceptionOn(),
      text: situationText(),
      view: roomView(),
    }))

    // 觉得太费 token 就关掉：POST { enabled: false }
    api.route('/perception', async (req) => {
      if (req.method === 'POST') {
        const b = await bodyOf(req)
        writeJson('perception.json', { enabled: b.enabled !== false })
      }
      return { ok: true, enabled: perceptionOn() }
    })

    // 写接口：移动、日志、事件
    api.route('/api/room/move', async (req) => {
      const b = await bodyOf(req)
      const who = b.who === 'dayu' ? 'dayu' : 'xiaoyu'
      const spot = String(b.spot || 'sofa').slice(0, 24)
      const s = readJson('room-state.json', { ok: true, xiaoyu: {}, dayu: {}, log: [] })
      s[who] = { ...(s[who] || {}), spot }
      writeJson('room-state.json', s)
      return { ok: true, spot }
    })
    api.route('/api/room/log', async (req) => {
      const b = await bodyOf(req)
      const who = b.who === 'dayu' ? 'dayu' : 'xiaoyu'
      const text = String(b.text || '').slice(0, 60)
      if (text) {
        const s = readJson('room-state.json', { ok: true, xiaoyu: {}, dayu: {}, log: [] })
        if (!Array.isArray(s.log)) s.log = []
        s.log.push({ who, text, t: Math.floor(Date.now() / 1000) })
        s.log = s.log.slice(-50)
        writeJson('room-state.json', s)
      }
      return { ok: true }
    })
    api.route('/api/room/event', async (req) => {
      const b = await bodyOf(req)
      const what = String(b.what || '').slice(0, 80)
      if (!what) return { ok: false, err: 'empty' }
      const ev = { who: String(b.who || '小小柒').slice(0, 12), what, where: String(b.where || '').slice(0, 24), t: Math.floor(Date.now() / 1000) }
      const items = readJson('world-events.json', [])
      if (!Array.isArray(items)) return { ok: true, mem: false }
      items.push(ev)
      writeJson('world-events.json', items.slice(-200))
      return { ok: true, mem: false }
    })
    api.route('/api/room/wish', async () => ({ ok: true, changed: 0, layout: {} }))
    api.route('/api/room/auto', async (req) => {
      const b = await bodyOf(req)
      const s = readJson('room-state.json', { ok: true, xiaoyu: {}, dayu: {}, log: [] })
      s.auto = Boolean(b.on ?? true)
      writeJson('room-state.json', s)
      return { ok: true, autoWalk: s.auto }
    })
    api.route('/api/room/frame', async (req) => {
      const b = await bodyOf(req)
      const img = String(b.image || '')
      if (!img.startsWith('data:image')) return { ok: false, err: 'no image' }
      const [head, b64] = img.split(',')
      const ext = head.includes('png') ? 'png' : 'jpg'
      const data = Buffer.from(b64 || '', 'base64')
      if (data.length >= 500 && data.length <= 12 * 1024 * 1024) writeFileSync(join(stateDir, `room-shot.${ext}`), data)
      return { ok: true }
    })
  },
}
