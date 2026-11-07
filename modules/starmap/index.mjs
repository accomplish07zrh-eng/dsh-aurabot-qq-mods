// 星图（识海）：把 Aurabot 的记忆库渲染成 3D 星图。
// 页面随模块分发，数据来自 Aurabot 自己的 memory 模块；取数逻辑在 lib/graph.mjs，这里只做路由和缓存。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildGraph } from './lib/graph.mjs'

const TTL = 15000
let cache = { at: 0, data: null }

/** 清掉缓存（测试用；15 秒缓存对页面足够）。 */
export function resetCache() {
  cache = { at: 0, data: null }
}

function graphOf(api) {
  if (cache.data && Date.now() - cache.at < TTL) return cache.data
  cache = { at: Date.now(), data: buildGraph(api.use('memory')) }
  return cache.data
}

export default {
  id: 'starmap',
  name: '星图',
  version: '1.0.0',
  api: 1,
  description: '把 Aurabot 自己的记忆渲染成可交互的 3D 星图；点星星看正文。',
  panel: 'panel.js',
  setup(api) {
    api.route('/page', async (req, res) => {
      try {
        const html = readFileSync(join(api.dir, 'assets', 'page.html'))
        api.core.http.send(res, 200, html, 'text/html; charset=utf-8')
      } catch (error) {
        api.core.http.send(res, 500, String(error.message || error), 'text/plain; charset=utf-8')
      }
    })

    api.route('/graph', async () => {
      const data = graphOf(api)
      return { ok: true, nodes: data.nodes, links: data.links, count: data.nodes.length }
    })

    api.route('/node', async (req) => {
      const q = String(req.url || '').split('?')[1] || ''
      const id = new URLSearchParams(q).get('id') || ''
      if (!id) return { ok: false, error: 'missing id' }
      const data = graphOf(api)
      const text = data.texts.get(id)
      if (!text) return { ok: false, error: 'not found' }
      return { ok: true, id, name: text.label, text: text.text }
    })

    api.route('/health', async () => {
      const data = graphOf(api)
      return { ok: true, source: 'aurabot-memory', nodes: data.nodes.length, links: data.links.length }
    })
  },
}
