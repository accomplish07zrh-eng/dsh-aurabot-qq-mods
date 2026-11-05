// 读单条笔记：走页面 SSR，不要签名，只吃 cookie。图床要 referer，落盘后再发。
import fs from 'node:fs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const LINK_RE = /https?:\/\/(?:www\.)?(?:xiaohongshu\.com\/[^\s"'<>]+|xhslink\.com\/[^\s"'<>]+)/i
const ID_RE = /^(?:[0-9a-f]{24})$/i

/** 从一段话里抠链接；也接受纯 24 位笔记 id */
export function pickLink(text) {
  const s = String(text || '').trim()
  const m = s.match(LINK_RE)
  if (m) return m[0].replace(/[，。、）)】\]"'>,]+$/, '')
  if (ID_RE.test(s)) return 'https://www.xiaohongshu.com/explore/' + s
  return null
}

/** 从链接里抠出 note id 和 xsec_token */
export function parseIds(url) {
  const u = String(url || '')
  const id = (u.match(/\/(?:explore|discovery\/item)\/([0-9a-f]{24})/i) || [])[1] || ''
  const token = (u.match(/[?&]xsec_token=([^&\s]+)/) || [])[1] || ''
  return { id, token: decodeURIComponent(token) }
}

/** 拼一条能读的笔记地址（搜索结果是 id+token，没有完整链接） */
export function buildUrl(id, token) {
  const base = 'https://www.xiaohongshu.com/explore/' + id
  return token ? `${base}?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_search` : base
}

async function resolveShort(url) {
  if (!/xhslink\.com/i.test(url)) return url
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) })
    return r.url || url
  } catch {
    return url
  }
}

async function fetchPage(url, cookie) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', accept: 'text/html,application/xhtml+xml', cookie },
    signal: AbortSignal.timeout(20000),
  })
  if (!r.ok) throw new Error('页面打不开，HTTP ' + r.status)
  return await r.text()
}

export function parseState(html) {
  const i = html.indexOf('window.__INITIAL_STATE__')
  if (i < 0) throw new Error('页面里没有状态数据（cookie 可能过期了）')
  const start = html.indexOf('{', i)
  const end = html.indexOf('</script>', start)
  let raw = html.slice(start, end < 0 ? undefined : end)
  raw = raw.replace(/new Map\([^)]*\)/g, 'null').replace(/new Set\([^)]*\)/g, 'null')
  raw = raw.replace(/:\s*undefined/g, ':null')
  return JSON.parse(raw)
}

export function pickNote(st) {
  const map = st && st.note && st.note.noteDetailMap
  if (map && typeof map === 'object') {
    for (const v of Object.values(map)) if (v && v.note) return v
  }
  const card = st && st.feed && st.feed.undertakeNote && st.feed.undertakeNote.items && st.feed.undertakeNote.items[0] && st.feed.undertakeNote.items[0].noteCard
  return card ? { note: card } : null
}

const num = (v) => (v === null || v === undefined || v === '' ? '0' : String(v))

function fmtTime(ms) {
  if (!ms) return ''
  try {
    const d = new Date(Number(ms))
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  } catch { return '' }
}

/** 抓一条笔记，返回 { note, text, images } */
export async function readNote(input, cookie, tokenHint = '', { maxChars = 1200 } = {}) {
  let url = pickLink(input) || String(input || '').trim()
  if (!/^https?:\/\//.test(url)) {
    const { id, token } = parseIds(url)
    if (!id) throw new Error('这不是小红书链接')
    url = buildUrl(id, token || String(tokenHint || ''))
  } else if (tokenHint && !/[?&]xsec_token=/.test(url)) {
    // 有 token 但链接里没带，补上，不然拿到的是空壳
    url += (url.includes('?') ? '&' : '?') + 'xsec_token=' + encodeURIComponent(String(tokenHint))
  }
  url = await resolveShort(url)
  const html = await fetchPage(url, cookie)
  const holder = pickNote(parseState(html))
  if (!holder) throw new Error('页面打开了，但里面没笔记内容，cookie 可能过期了')

  const n = holder.note || {}
  const tags = (n.tagList || []).map((t) => t.name).filter(Boolean)
  const ii = n.interactInfo || {}
  const lines = [
    '《' + (n.title || '（无标题）') + '》',
    '作者：' + ((n.user && n.user.nickname) || '未知') + (n.ipLocation ? `（${n.ipLocation}）` : ''),
    '类型：' + (n.type === 'video' ? '视频' : '图文') + (fmtTime(n.time) ? '｜' + fmtTime(n.time) : ''),
    `互动：赞 ${num(ii.likedCount)}｜藏 ${num(ii.collectedCount)}｜评 ${num(ii.commentCount)}｜转 ${num(ii.shareCount)}`,
  ]
  let desc = String(n.desc || '').trim()
  const cap = Math.min(Math.max(Number(maxChars) || 1200, 200), 6000)
  if (desc.length > cap) desc = desc.slice(0, cap) + '……（后面还长，截了）'
  if (desc) lines.push('', desc)
  if (tags.length) lines.push('', '标签：' + tags.slice(0, 20).join('、'))
  const imgs = (n.imageList || []).filter((x) => x && (x.urlDefault || x.urlPre || x.url))
  if (imgs.length) lines.push('', `配图 ${imgs.length} 张` + (n.type === 'video' ? '（这条是视频笔记）' : ''))
  lines.push('', url)

  const { id, token } = parseIds(url)
  return {
    note: n,
    id: id || n.noteId || '',
    xsecToken: token,
    url,
    text: lines.join('\n'),
    images: imgs.map((x) => x.urlDefault || x.urlPre || x.url),
  }
}

/** 图床要 referer，下来存本地再发 */
export async function cacheImage(url, dir, idx) {
  const u = String(url || '').replace(/^http:\/\//, 'https://')
  const r = await fetch(u, {
    headers: { 'user-agent': UA, referer: 'https://www.xiaohongshu.com/' },
    signal: AbortSignal.timeout(20000),
  })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 1024) throw new Error('图太小，估计没下到')
  const file = dir(`img-${Date.now()}-${idx}.jpg`)
  fs.writeFileSync(file, buf)
  return file
}
