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

    /** 点赞 / 取消赞 */
    async like(noteId, action = 'like') {
      const r = await call(base(), '/like', {
        method: 'POST',
        body: { note_id: String(noteId), action },
        timeout: 60000,
        token: tk(),
      })
      if (!r.ok) throw new Error(r.msg || r.message || '操作失败')
      return r
    },

    /** 我发过的评论 */
    async mine(limit = 20) {
      const r = await call(base(), `/mine?limit=${limit}`, { timeout: 30000, token: tk() })
      if (!r.ok) throw new Error(r.message || '读不到')
      return r.items || []
    },

    /** 谁回了我的评论 */
    async replies(limit = 10) {
      const r = await call(base(), `/replies?limit=${limit}`, { timeout: 180000, token: tk() })
      if (!r.ok) throw new Error(r.message || '读不到')
      return r
    },

    /** 传一张图，拿 file_id（发布用） */
    async upload({ filename, mime, dataBase64 }) {
      const r = await call(base(), '/upload', {
        method: 'POST',
        body: { filename, mime, data_base64: dataBase64 },
        timeout: 120000,
        token: tk(),
      })
      if (!r.ok) throw new Error(r.message || '图片上传失败')
      return r
    },

    /** 发一篇图文笔记 */
    async publish({ title, content, fileIds, topics = [], private: isPrivate = false }) {
      const r = await call(base(), '/publish', {
        method: 'POST',
        body: { title, content, file_ids: fileIds, topics, private: isPrivate },
        timeout: 180000,
        token: tk(),
      })
      return r
    },

    /** 发评论 / 楼中楼 */
    async postComment({ noteId, content, replyCommentId = null, atUserId = null }) {
      const r = await call(base(), '/comment', {
        method: 'POST',
        body: { note_id: String(noteId), content: String(content), reply_comment_id: replyCommentId, at_user_id: atUserId },
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
