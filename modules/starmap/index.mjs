// 星图（识海）：把 Aurabot 的记忆库渲染成 3D 星图。
// 页面随模块分发，数据来自 Aurabot 自己的 memory 模块，不读 congling。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let cache = { at: 0, data: null }

const clean = (s, n = 200) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
const pad = (n) => String(n).padStart(2, '0')
const fmt = (ms) => {
  const t = Number(ms) || 0
  if (!t) return ''
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const typeOf = (m) => {
  if (m.source === 'diary') return 'daily'
  if (m.source === 'event' || m.kind === 'seen') return 'daily'
  if (m.source === 'gist') return 'daily'
  if (m.source === 'import') return 'reference'
  return 'reference'
}

function build(api) {
  const mem = api.use('memory')
  if (!mem) return { nodes: [], links: [], texts: new Map() }
  const items = (mem.list?.('') || []).filter((m) => m && m.text)
  const gists = (mem.gists?.({}) || []).filter((g) => g && g.text)
  const profiles = (mem.profiles?.() || []).filter((p) => p && p.qq)
  const people = (mem.personaOverview?.() || []).filter((p) => p && p.qq)

  const nodes = new Map()
  const texts = new Map()
  const links = []
  const add = (node) => {
    if (!node?.id || nodes.has(node.id) || nodes.size >= 700) return
    nodes.set(node.id, node)
  }
  const link = (source, target, weight = 0.5, kind = 'related') => {
    if (source && target && source !== target) links.push({ source, target, weight, kind })
  }

  const nameOf = new Map()
  for (const p of people) nameOf.set(String(p.qq), clean(p.alias || p.name || p.qq, 30))
  for (const p of profiles) if (!nameOf.has(String(p.qq))) nameOf.set(String(p.qq), clean(p.alias || p.name || p.qq, 30))

  const subjectNodes = new Set()
  const ensureSubject = (qq) => {
    const id = String(qq || '')
    if (!id) return ''
    if (!subjectNodes.has(id)) {
      subjectNodes.add(id)
      const name = nameOf.get(id) || id
      add({
        id: 'subject:' + id,
        label: name,
        desc: `${name}（${id}）`,
        title: name,
        type: 'session',
        session: id,
        uses: 0,
        created: '',
        updated: '',
        chars: 0,
        size: 7,
      })
      texts.set('subject:' + id, { label: name, text: `${name}（${id}）` })
    }
    return 'subject:' + id
  }

  for (const p of people) ensureSubject(p.qq)

  for (const p of profiles) {
    const qq = String(p.qq)
    const subject = ensureSubject(qq)
    const id = 'profile:' + qq
    const label = `档案 · ${clean(p.alias || p.name || nameOf.get(qq) || qq, 30)}`
    add({
      id,
      label,
      desc: clean(p.text || '', 220),
      title: label,
      type: 'project',
      session: qq,
      uses: 0,
      created: '',
      updated: fmt(p.at),
      chars: String(p.text || '').length,
      size: 6,
    })
    texts.set(id, { label, text: p.text || '' })
    link(subject, id, 1, 'type')
  }

  for (const m of items) {
    const id = 'item:' + String(m.id)
    const label = clean(m.displayText || m.text, 44) || '记忆'
    add({
      id,
      label,
      desc: clean(m.text, 220),
      title: label,
      type: typeOf(m),
      session: clean(m.aboutName || m.about || m.chatId || '', 40),
      uses: Number(m.hits) || 0,
      created: fmt(m.at || m.saidAt),
      updated: fmt(m.at),
      chars: String(m.text || '').length,
      size: 1.6 + Math.min(5, Math.log1p(Number(m.hits) || 0) * 1.3) + (Number(m.importance) || 0.5) * 2.2,
    })
    texts.set(id, {
      label,
      text: `${m.text || ''}\n\n${fmt(m.at)}${m.source ? ' · ' + m.source : ''}${m.aboutName ? ' · ' + m.aboutName : ''}`,
    })
    if (m.about) link(id, ensureSubject(m.about), 0.8, 'session')
    for (const rel of m.related || []) link(id, 'item:' + String(rel), 0.35, 'related')
  }

  for (const g of gists) {
    const id = 'gist:' + String(g.id)
    const label = clean(g.text, 44) || '摘要'
    add({
      id,
      label,
      desc: clean(g.text, 220),
      title: label,
      type: 'daily',
      session: clean(g.aboutName || g.about || g.chatId || '', 40),
      uses: 0,
      created: fmt(g.at || g.saidAt),
      updated: fmt(g.at),
      chars: String(g.text || '').length,
      size: 4.2,
    })
    texts.set(id, {
      label,
      text: `${g.text || ''}\n\n${fmt(g.at)}${g.source ? ' · ' + g.source : ''}`,
    })
    if (g.about) link(id, ensureSubject(g.about), 0.8, 'session')
  }

  const ids = new Set(nodes.keys())
  return {
    nodes: [...nodes.values()],
    links: links.filter((l) => ids.has(l.source) && ids.has(l.target)),
    texts,
  }
}

function graph(api) {
  if (cache.data && Date.now() - cache.at < 15000) return cache.data
  cache = { at: Date.now(), data: build(api) }
  return cache.data
}

export default {
  id: 'starmap',
  name: '星图',
  version: '1.0.0',
  api: 1,
  description: '把 Aurabot 自己的记忆渲染成可交互的 3D 星图；数据来自 memory.sqlite，不读 congling。',
  panel: 'panel.js',
  setup(api) {
    api.route('/page', async (req, res) => {
      try {
        const html = readFileSync(join(api.dir, 'assets', 'page.tpl'))
        api.core.http.send(res, 200, html, 'text/html; charset=utf-8')
      } catch (error) {
        api.core.http.send(res, 500, String(error.message || error), 'text/plain; charset=utf-8')
      }
    })

    api.route('/graph', async () => {
      const data = graph(api)
      return { ok: true, nodes: data.nodes, links: data.links, count: data.nodes.length }
    })

    api.route('/node', async (req) => {
      const q = String(req.url || '').split('?')[1] || ''
      const id = new URLSearchParams(q).get('id') || ''
      if (!id) return { ok: false, error: 'missing id' }
      const data = graph(api)
      const text = data.texts.get(id)
      if (!text) return { ok: false, error: 'not found' }
      return { ok: true, id, name: text.label, text: text.text }
    })

    api.route('/health', async () => {
      const data = graph(api)
      return { ok: true, source: 'aurabot-memory', nodes: data.nodes.length, links: data.links.length }
    })
  },
}
