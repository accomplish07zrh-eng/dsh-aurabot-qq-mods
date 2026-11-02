// 逛热榜循环：定时到点 → 挑榜 → 拉榜 → 让她读榜给感想 → 私聊分享 + 写记忆。
// 完全对照 B 站 duty.js 的三段式（选→看→产出），但纯读不写：不评论、不发帖，只在私聊里分享。
// 所有外部依赖（think/sendText/memory/fetcher）都从参数注入，测试好假。

import { readFileSync, writeFileSync } from 'node:fs'

const STATE_FILE = 'state.json'
const SEEN_FILE = 'seen.json'

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}
function saveJson(path, data) {
  try { writeFileSync(path, JSON.stringify(data)) } catch { /* 状态存不上就当没记住，不致命 */ }
}
/** 简单指纹：标题去掉空白取 hash，识别「这条之前分享过没」 */
function fp(title) {
  const s = String(title || '').replace(/\s+/g, '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 131 + s.charCodeAt(i)) >>> 0
  return String(h)
}
/** 从模型输出里抠 JSON 数组（容错：带 ```json 围栏、前后废话都能取） */
function parseLlmJson(text) {
  const m = String(text || '').match(/\[[\s\S]*\]/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

/**
 * @param {object} o
 * @param {object} o.api        模块 api（用 dataDir/every/log/settings）
 * @param {object} o.fetcher    lib/fetch.mjs 的 createFetcher 产物
 * @param {object} o.memory     api.lazy('memory')（可缺）
 * @param {string} o.ownerQQ    主人 QQ
 * @param {Function} o.think    api.think（runSystemTurn 包装，这轮不发聊天）
 * @param {Function} o.sendText api.sendText
 * @param {object} [o.now]      注入当前时间（测试用），缺省 () => new Date()
 */
export function createBrowse({ api, fetcher, memory, ownerQQ, think, sendText, now = () => new Date() }) {
  const statePath = api.dataDir(STATE_FILE)
  const seenPath = api.dataDir(SEEN_FILE)
  const state = loadJson(statePath, { slots: {}, recent: [], lastTour: 0 })
  const seen = loadJson(seenPath, [])
  const seenSet = new Set(seen)
  let touring = false

  function save() { saveJson(statePath, state); saveJson(seenPath, seen.slice(-2000)) }

  const cfg = () => api.settings?.() || {}
  /** 「09:30,21:00」→ ['09:30','21:00']，脏值全部丢掉 */
  function slots() {
    return String(cfg().tourTimes || '')
      .split(/[,，;；\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d{1,2}:\d{2}$/.test(s))
  }

  /** 每 60 秒 tick 一次：到点没做过今天的这个场次就逛一轮 */
  async function tick() {
    const c = cfg()
    if (!c.enabled || touring) return
    const d = now()
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    for (const s of slots()) {
      const key = `${day} ${s}`
      if (state.slots[key]) continue
      if (hm < s) continue           // 还没到点
      state.slots[key] = { startedAt: Date.now() }   // 先记账再逛，失败也不当天重试
      save()
      await tour().catch((e) => api.log?.warn?.(`逛热榜这轮出了岔子：${e.message}`))
      return                          // 一次 tick 只逛一场
    }
    // 槽位记账只留最近 7 天，别无限涨
    const keys = Object.keys(state.slots)
    if (keys.length > 40) {
      for (const k of keys.slice(0, keys.length - 20)) delete state.slots[k]
      save()
    }
  }

  /**
   * 逛一轮。force=true 跳过场次判断（面板手动跑、工具触发都走这里）。
   * 返回 { ok, message, ... } 给面板/工具展示。
   */
  async function tour(o = {}) {
    if (touring) return { ok: false, message: '上一轮还没逛完' }
    touring = true
    try {
      const c = cfg()
      const picked = await pick(o.nodes)
      if (!picked.length) return { ok: false, message: '没有可逛的榜（取数全失败了，等冷却过再试）' }

      // 读榜：每个榜前 N 条喂给她，给感想
      const boards = []
      for (const name of picked) {
        const r = await fetcher.hot(name, { fresh: o.fresh })
        if (r.ok) boards.push({ node: name, items: r.items.slice(0, c.itemsPerNode || 15) })
      }
      if (!boards.length) return { ok: false, message: '榜都拉不下来（网络或接口问题）' }

      const about = memory?.recall?.('主人喜欢什么', { limit: 3 }) || []
      const recentText = state.recent.map((t) => '- ' + t).join('\n') || '（暂无）'
      const feed = boards.map((b) =>
        `【${b.node}】\n` + b.items.map((it, i) => `${i + 1}. ${it.title}${it.hot ? `（热度${it.hot}）` : ''}`).join('\n')
      ).join('\n\n')
      const out = await think(
        `你在逛全网热榜，不是聊天，这轮的产出不会自动发出去。你感兴趣的按你自己的性子来，也想想主人会喜欢什么。\n` +
        `你记得的关于主人的事：\n${about.map((x) => '- ' + (x.text || x)).join('\n') || '（暂无）'}\n` +
        `最近逛过的榜：\n${recentText}\n\n` +
        `今天的热榜：\n${feed}\n\n` +
        `看完给感想。输出 JSON 数组，每个榜一个对象：` +
        `{"node":"榜名","feeling":"一句你的真实感受","share":"想私聊分享给主人的话（挑主人可能感兴趣的 1~3 条热点，说人话、别像播报，觉得没什么可分享就空字符串）","remember":"值得记住的一件事（没有就空字符串）"}。` +
        `只输出 JSON。`,
        { title: '逛热榜', timeoutMs: 180000 }
      )
      const verdicts = parseLlmJson(out)
      if (!verdicts?.length) return { ok: false, message: '她没给出可用的感想（输出不是 JSON）' }

      // 产出：分享（去重 + 限量）、记忆
      const limit = Math.max(0, Number(c.shareLimit) || 0)
      let shared = 0, remembered = 0
      for (const v of verdicts) {
        if (!v || typeof v !== 'object') continue
        if (v.remember && remembered < 3) {
          memory?.add?.({ text: `热榜上看到：${String(v.remember).slice(0, 200)}`, importance: 0.5, tags: ['热榜'], source: 'tophub' })
          remembered++
        }
        const share = String(v.share || '').trim()
        if (share && shared < limit && !seenSet.has(fp(v.feeling + share))) {
          const src = boards.find((b) => b.node === v.node)
          const head = src?.items?.slice(0, 3).map((x) => x.title).join('、') || ''
          await sendText(`private:${ownerQQ}`, `${share}${head ? `\n（${v.node}：${head}）` : ''}`)
          seenSet.add(fp(v.feeling + share))
          seen.push(fp(v.feeling + share))
          shared++
        }
      }

      state.lastTour = Date.now()
      state.recent = boards.map((b) => b.node)
      save()
      const msg = `逛了 ${boards.length} 个榜（${boards.map((b) => b.node).join('、')}），分享给你 ${shared} 条${remembered ? `，记了 ${remembered} 件事` : ''}`
      api.log?.info?.('热榜巡游：' + msg)
      return { ok: true, message: msg, boards: boards.map((b) => b.node), shared, remembered }
    } finally {
      touring = false
    }
  }

  /** 挑这次逛哪些榜：优先没最近逛过的，取前 count 个；o 可带 { nodes, count } 覆盖 */
  async function pick(o = {}) {
    const c = cfg()
    const all = (Array.isArray(c.nodes) && c.nodes.length ? c.nodes : []).filter(Boolean)
    const names = all.length ? all : fetcher.nodes().map((x) => x.name)
    const freshOnes = names.filter((n) => !state.recent.includes(n))
    const order = [...freshOnes, ...names.filter((n) => !freshOnes.includes(n))]
    const count = Math.max(1, Number(o.count || c.nodesPerTour) || 2)
    const out = []
    for (const n of order.slice(0, count + 2)) {   // 多备两个，第一个挂了还有替补
      if (out.length >= count) break
      out.push(n)
    }
    return out
  }

  /** 面板 /state 用 */
  function status() {
    return {
      slots: state.slots, recent: state.recent, lastTour: state.lastTour,
      seenCount: seenSet.size, touring, todaySlots: slots(),
    }
  }

  return { tick, tour, status, slots }
}
