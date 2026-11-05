// 和本地小红书画桥通信。桥（xhs_bridge.py）跑在宿主机上，替我们做签名请求。
const DEFAULT_BASE = 'http://127.0.0.1:8099'

async function call(base, path, { method = 'GET', body = null, timeout = 90000, token = '' } = {}) {
  const url = String(base || DEFAULT_BASE).replace(/\/+$/, '') + path
  const opts = { method, signal: AbortSignal.timeout(timeout), headers: {} }
  if (token) opts.headers.authorization = 'Bearer ' + token
  if (body !== null) {
    opts.headers['content-type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const r = await fetch(url, opts)
  const txt = await r.text()
  if (!r.ok) throw new Error(`桥回 HTTP ${r.status}：${txt.slice(0, 120)}`)
  try {
    return JSON.parse(txt)
  } catch {
    throw new Error('桥返回的不是 JSON：' + txt.slice(0, 120))
  }
}

export function createBridge(getBase, getToken = () => '') {
  const base = () => getBase()
  const tk = () => String(getToken() || '').trim()

  return {
    /** 桥活没活、登录的是谁 */
    async health({ timeoutMs = 30000 } = {}) {
      return await call(base(), '/health', { timeout: timeoutMs, token: tk() })
    },

    /** 搜笔记 */
    async search(keyword, page = 1) {
      const q = encodeURIComponent(String(keyword || ''))
      const r = await call(base(), `/search?q=${q}&page=${page}`, { timeout: 120000, token: tk() })
      if (!r.ok) throw new Error(r.message || '搜索失败')
      return r.items || []
    },

    /** 读评论；parent 给了就读楼中楼 */
    async comments({ id, token, parent = null, cursor = '' }) {
      const qs = new URLSearchParams({ id: String(id), token: String(token || '') })
      if (parent) qs.set('parent', String(parent))
      if (cursor) qs.set('cursor', String(cursor))
      const r = await call(base(), `/comments?${qs}`, { timeout: 120000, token: tk() })
      if (!r.ok) throw new Error(r.message || '读评论失败')
      return r
    },

    /** 发评论 / 楼中楼 */
    async postComment({ noteId, content, replyCommentId = null }) {
      const r = await call(base(), '/comment', {
        method: 'POST',
        body: { note_id: String(noteId), content: String(content), reply_comment_id: replyCommentId },
        timeout: 120000,
        token: tk(),
      })
      if (!r.ok) {
        const why = r.verifytype ? `被风控拦了（verifytype ${r.verifytype}）` : (r.toast || r.message || '发布失败')
        throw new Error(why)
      }
      return r
    },
  }
}
