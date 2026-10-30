// 小黑盒业务层：信息流 / 帖子详情 / 热榜 / 搜索 / 点赞 / 评论 / 发帖（带图）/ 删帖 / 配额。
//
// 几条硬经验（实测踩出来的，别改）：
//   · 发帖 link_tag：11=文章（富文本、行内插图真正夹在文字中间）、27=图文（图片被挤到文末）、28=动态（只能纯文本）
//   · topic_ids 必须是真的分区 id（7214 / 18745 / 806933），乱填一直报「错误的帖子类型」
//   · 帖详情接口频繁访问会触发验证码，还会连坐浏览器会话 → 统一限速 900ms 起
//   · 搜索接口最容易弹验证码 → 单独拉长间隔，被挡就降级，不阻断主流程
//   · 图片走腾讯云 COS 四步直传，任何一步失败都只是少一张图，不打断发帖

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { HeyboxClient, HeyboxError, cosSign, WEB_BASE, TOPICS } from './api.mjs'
import { POST_STYLES, DEFAULT_POST_STYLE, styleOf, stylePrompt } from './styles.mjs'

const HOME = process.env.USERPROFILE || os.homedir()
const CRED_DIR = path.join(HOME, '.heybox-ai')
const CRED_FILE = path.join(CRED_DIR, 'credentials.json')

const DEFAULT_STATE = {
  account: { checkedAt: 0, nickname: '', heyboxId: '', loggedIn: false, message: '' },
  quota: { date: '', like: 0, comment: 0, post: 0, browse: 0 },
  history: [],
  lastRun: 0,
  lastSkipReason: '',
}

const today = () => new Date().toISOString().slice(0, 10)
const nowMs = () => Date.now()

/** 把 blocks 里的正文抽成纯文本（正文是 JSON 块数组，可能是 text / html / img） */
function textOf(value) {
  if (typeof value !== 'string') return ''
  try {
    const blocks = JSON.parse(value)
    if (Array.isArray(blocks)) {
      return blocks.map((b) => {
        if (!b) return ''
        if (b.type === 'text') return b.text || ''
        if (b.type === 'html') return String(b.text || '').replace(/<[^>]+>/g, '')
        return ''
      }).filter(Boolean).join('\n')
    }
  } catch { /* 不是 JSON，原样返回 */ }
  return value
}

const htmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const countWords = (s) => String(s || '').replace(/\s/g, '').length

/** 从各种写法的链接里挖出 link_id */
export function linkIdOf(input) {
  const s = String(input || '')
  const m = s.match(/link\/(\d+)/)
  if (m) return m[1]
  const digits = s.replace(/\D/g, '')
  return digits.length >= 6 ? digits : ''
}

export function createHeybox({ getConfig, hub, memory, log }) {
  let client = null
  let clientCookie = ''
  let searchAt = 0

  /** Cookie 从配置或凭据文件读；配置优先（面板里填的） */
  function cookie() {
    const c = (getConfig().heybox || {}).cookie || ''
    if (c) return String(c).trim()
    try {
      const j = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
      return Object.entries(j.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ')
    } catch { return '' }
  }

  function getClient() {
    const c = cookie()
    if (!client || c !== clientCookie) {
      client = new HeyboxClient({ cookie: c })
      clientCookie = c
    }
    return client
  }

  /** 状态文件：主板数据，掉线也不丢 */
  function readState() {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(HOME, '.dsh', 'heybox-state.json'), 'utf8'))
      return { ...DEFAULT_STATE, ...raw }
    } catch { return { ...DEFAULT_STATE } }
  }

  function writeState(next) {
    try {
      fs.mkdirSync(path.join(HOME, '.dsh'), { recursive: true })
      fs.writeFileSync(path.join(HOME, '.dsh', 'heybox-state.json'), JSON.stringify(next, null, 2))
    } catch (e) { log?.warn?.('写小黑盒状态失败：' + e.message) }
  }

  function quota() {
    const st = readState()
    if (st.quota.date !== today()) return { date: today(), like: 0, comment: 0, post: 0, browse: 0 }
    return st.quota
  }

  function bump(kind) {
    const st = readState()
    const q = quota()
    q[kind] = (q[kind] || 0) + 1
    st.quota = q
    writeState(st)
    return q[kind]
  }

  function left(kind) {
    const c = getConfig().heybox || {}
    const cap = { like: c.likeDaily, comment: c.commentDaily, post: c.maxPostsPerDay, browse: c.maxRunsPerDay }[kind] ?? 0
    return Math.max(0, (Number(cap) || 0) - (quota()[kind] || 0))
  }

  function pushHistory(item) {
    const st = readState()
    st.history = [{ at: nowMs(), ...item }, ...(st.history || [])].slice(0, 60)
    writeState(st)
  }

  // ── 只读：信息流 / 帖子 / 热榜 / 搜索 / 分区 ─────────────────────────

  async function feed(offset = 0) {
    const d = await getClient().get('/bbs/app/feeds', { pull: 0, offset, dw: 604 })
    const r = d.result || {}
    const list = r.links || r.list || []
    return list.map((x) => ({
      linkId: String(x.linkid ?? x.link_id ?? ''),
      title: String(x.title || ''),
      author: String((x.user && (x.user.username || x.user.nickname)) || ''),
      likes: Number(x.link_like_count ?? x.like_num ?? 0),
      comments: Number(x.comment_num ?? x.comment_count ?? 0),
      topics: (Array.isArray(x.topics) ? x.topics : []).map((t) => String(t.name || '')).filter(Boolean),
    })).filter((x) => x.linkId)
  }

  async function feedReport() {
    const list = await feed(0)
    return {
      ok: true,
      message: list.length
        ? list.map((x) => `[${x.linkId}] ${x.title || '（无标题）'}　by ${x.author}　赞${x.likes} 评${x.comments}`).join('\n')
        : '信息流是空的',
      links: list,
    }
  }

  function findComments(value, depth = 0) {
    if (!value || depth > 4) return null
    if (Array.isArray(value)) {
      if (value.length && value.every((v) => v && typeof v === 'object' && ('commentid' in v || 'comment_id' in v))) return value
      for (const v of value) { const r = findComments(v, depth + 1); if (r) return r }
      return null
    }
    if (typeof value === 'object') {
      for (const k of ['comments', 'comment_list', 'list', 'data']) {
        if (value[k]) { const r = findComments(value[k], depth + 1); if (r) return r }
      }
      for (const v of Object.values(value)) { const r = findComments(v, depth + 1); if (r) return r }
    }
    return null
  }

  async function detail(linkId) {
    const d = await getClient().get('/bbs/app/link/tree', {
      link_id: linkId, page: 1, is_first: 1, index: 1, owner_only: 0, offset: 0, limit: 20, sort_filter: 'hot',
    })
    const r = d.result || {}
    const link = r.link || r
    const user = link.user || {}
    const comments = findComments(r) || []
    return {
      linkId,
      url: `${WEB_BASE}/app/bbs/link/${linkId}`,
      title: String(link.title || ''),
      author: String(user.username ?? user.nickname ?? ''),
      likes: Number(link.link_like_count ?? link.like_num ?? 0),
      body: textOf(link.text) || String(link.description || ''),
      topics: (Array.isArray(link.topics) ? link.topics : []).map((t) => '#' + String(t.name || '') + '#').filter((t) => t.length > 2),
      comments: comments.slice(0, 12).map((c) => ({
        id: String(c.commentid ?? c.comment_id ?? ''),
        user: String((c.user && (c.user.username || c.user.nickname)) || '匿名'),
        likes: Number(c.up ?? c.like_num ?? 0),
        text: String(c.text ?? c.content ?? ''),
        replyId: String(c.replyid ?? c.reply_id ?? '-1'),
      })),
    }
  }

  async function watch(link) {
    const id = linkIdOf(link)
    if (!id) return { ok: false, message: '没看出帖子编号（要 /link/数字 或者 6 位以上的数字 id）' }
    const d = await detail(id)
    return {
      ok: true,
      message: [
        `《${d.title || '（无标题）'}》by ${d.author || '未知'}　赞${d.likes}`,
        d.topics.join(' '),
        '',
        d.body.slice(0, 800) || '（无正文）',
        '',
        d.comments.length ? '热评：' : '（还没有评论）',
        ...d.comments.slice(0, 6).map((c) => `· ${c.user}：${c.text.slice(0, 80)}`),
      ].join('\n'),
      url: d.url,
    }
  }

  /** 热榜：接口 result.Lists 是几组，只取「黑盒热议」那组 */
  async function hot(limit = 8) {
    const d = await getClient().get('/bbs/app/api/search/welcome_page/v2', { force_refresh: 'false' })
    const r = d.result || {}
    const groups = r.Lists
    if (!Array.isArray(groups)) throw new HeyboxError('热榜接口结构变了，找不到 Lists', 'schema')
    const target = groups.find((g) => String(g?.head_text || '').includes('热议'))
      || groups.find((g) => Array.isArray(g?.items) && g.items.length)
      || groups[0]
    const items = Array.isArray(target?.items) ? target.items : []
    const list = []
    for (const it of items.slice(0, Math.max(1, Number(limit) || 8))) {
      const text = String(it?.text || '').trim()
      if (text) list.push({ text, tag: String((it?.right_tag && (it.right_tag.text || it.right_tag)) || '').slice(0, 20) })
    }
    return {
      ok: true,
      group: String(target?.head_text || ''),
      list,
      message: [`【${target?.head_text || '热榜'}】`].concat(list.map((x, i) => `${i + 1}. ${x.text}${x.tag ? ' [' + x.tag + ']' : ''}`)).join('\n'),
    }
  }

  /**
   * 搜索：最容易验证码的接口，单独 8 秒间隔；被挡返回 blocked 而不是抛错，
   * 好让上层的「写帖流程」降级到「热榜 + 信息流」。
   */
  async function search(query, limit = 8, { sort = 'award_num', timeRange = '7d' } = {}) {
    const q = String(query || '').trim()
    if (!q) return { ok: false, message: '要给个关键词' }
    const wait = 8000 - (Date.now() - searchAt)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    searchAt = Date.now()
    let d
    try {
      d = await getClient().get('/bbs/app/api/general/search/v1', {
        q, search_type: 'general', is_pull_down: '0', offset: 0,
        limit: Math.max(1, Math.min(Number(limit) || 8, 30)), dw: 744,
        sort_filter: sort, time_range: timeRange,
      })
    } catch (err) {
      return { ok: false, blocked: true, message: '搜索被小黑盒挡了（' + err.message + '）。这接口查太勤就会要验证码，隔一会儿再试，或者先用 heybox_feed 看信息流找角度。' }
    }
    const r = d.result || {}
    const items = Array.isArray(r.items) ? r.items : []
    const list = items.map((it) => {
      const x = it.link || it.info || it
      return {
        linkId: String(x.linkid ?? x.link_id ?? ''),
        title: String(x.title ?? x.link_title ?? x.text ?? ''),
        likes: Number(x.link_like_count ?? x.like_num ?? x.award_num ?? 0),
        comments: Number(x.comment_num ?? x.comment_count ?? 0),
      }
    }).filter((x) => x.linkId || x.title).slice(0, Number(limit) || 8)
    return {
      ok: true,
      list,
      message: list.length
        ? list.map((x) => `[${x.linkId || '—'}] ${x.title}　赞${x.likes} 评${x.comments}`).join('\n')
        : '没搜到',
    }
  }

  async function topicList() {
    const fallback = Object.entries(TOPICS).map(([id, name]) => ({ id, name }))
    try {
      const d = await getClient().get('/bbs/app/api/topic/index', { is_post: 1 })
      const r = d.result || {}
      const raw = r.topics || r.list || r.categories || []
      const out = []
      const walk = (arr, dep = 0) => {
        if (!Array.isArray(arr) || dep > 2) return
        for (const t of arr) {
          if (t && t.topic_id && t.name) out.push({ id: String(t.topic_id), name: String(t.name) })
          if (t && Array.isArray(t.children)) walk(t.children, dep + 1)
        }
      }
      walk(raw)
      if (out.length) return { ok: true, list: out, message: out.map((t) => `${t.id} = ${t.name}`).join('\n') }
    } catch { /* 拿不到就用内置的三个 */ }
    return { ok: true, list: fallback, message: fallback.map((t) => `${t.id} = ${t.name}`).join('\n') + '（接口没返回，这是内置的三个）' }
  }

  // ── 写：点赞 / 评论 / 删帖 ───────────────────────────────────────

  async function like(link) {
    const id = linkIdOf(link)
    if (!id) return { ok: false, message: '没看出帖子编号' }
    if (left('like') <= 0) return { ok: false, message: '今天的点赞额度用完了' }
    await getClient().post('/bbs/app/profile/award/link', { link_id: id, award_type: '1' })
    bump('like')
    pushHistory({ kind: 'like', linkId: id })
    return { ok: true, message: `给 [${id}] 点了个赞`, url: `${WEB_BASE}/app/bbs/link/${id}` }
  }

  async function comment(link, text, { rootId = '-1', replyId = '-1' } = {}) {
    const id = linkIdOf(link)
    if (!id) return { ok: false, message: '没看出帖子编号' }
    const t = String(text || '').trim().slice(0, 100)
    if (!t) return { ok: false, message: '评论内容空了' }
    if (left('comment') <= 0) return { ok: false, message: '今天的评论额度用完了' }
    await getClient().post('/bbs/app/comment/create', { link_id: id, text: t, root_id: String(rootId), reply_id: String(replyId), is_cy: '0' })
    bump('comment')
    pushHistory({ kind: 'comment', linkId: id, text: t })
    return { ok: true, message: `评论发了：${t}`, url: `${WEB_BASE}/app/bbs/link/${id}` }
  }

  async function remove(link) {
    const id = linkIdOf(link)
    if (!id) return { ok: false, message: '没看出帖子编号' }
    await getClient().post('/bbs/app/link/delete', { link_id: id })
    pushHistory({ kind: 'delete', linkId: id })
    return { ok: true, message: `删掉了 [${id}]` }
  }

  // ── 写：发帖（文章模式 + 行内图） ────────────────────────────────

  function imageInfo(buf, filename) {
    const head = buf.slice(0, 8).toString('latin1')
    const isPng = head.includes('PNG')
    const isJpg = buf.slice(0, 2).toString('latin1') === '\u00ff\u00d8'
    return {
      mimetype: isPng ? 'image/png' : isJpg ? 'image/jpeg' : 'image/jpeg',
      name: filename || (isPng ? 'a.png' : 'a.jpg'),
    }
  }

  /** 腾讯云 COS 四步直传，返回 { url, width, height } */
  async function uploadImage(buf, filename, width, height) {
    const c = getClient()
    const info = imageInfo(buf, filename)
    const fileInfos = JSON.stringify([{ name: info.name, mimetype: info.mimetype, fsize: buf.length, width: width || 1000, height: height || 600 }])

    const step1 = await c.post('/bbs/app/api/qcloud/cos/upload/info/v2', { file_infos: fileInfos, scope: 'bbs', need_cache: '0' })
    const r1 = step1.result || {}
    const key = (r1.keys || [])[0]
    if (!key) throw new HeyboxError('图片上传第一步没拿到 key', 'upload')

    const step2 = await c.post('/bbs/app/api/qcloud/cos/upload/token/v2', {
      bucket: r1.bucket, keys: JSON.stringify([key]), mimetypes: JSON.stringify([info.mimetype]), is_multipart_upload: '0',
    })
    const creds = (step2.result || {}).credentials || {}
    if (!creds.tmpSecretId) throw new HeyboxError('图片上传第二步没拿到临时凭证', 'upload')

    const cosHost = `${r1.bucket}.cos.${r1.region}.myqcloud.com`
    const now = Math.floor(Date.now() / 1000)
    const keyTime = `${now};${now + 180}`
    const auth = cosSign({ secretId: creds.tmpSecretId, secretKey: creds.tmpSecretKey, path: key, host: cosHost, contentLength: buf.length, keyTime })
    await c.putCOS(`https://${cosHost}${key.split('/').map(encodeURIComponent).join('/')}`, buf, {
      contentType: info.mimetype, authorization: auth, sessionToken: creds.sessionToken,
    })

    const step4 = await c.post('/bbs/app/api/qcloud/cos/upload/callback/v2', { keys: JSON.stringify([key]) }, { is_finished: 'true' })
    const url = ((step4.result || {}).preview_urls || [])[0]
    if (!url) throw new HeyboxError('图片上传最后一步没拿到地址', 'upload')
    return { url, width: width || 1000, height: height || 600 }
  }

  /** 文章模式组装：html 块（行内 <img>）+ 末尾 img 引用块（封面/图库） */
  async function buildArticle(segments) {
    const htmlParts = []
    const imgRefs = []
    const texts = []
    for (const seg of segments || []) {
      if (seg.type === 'text') {
        const t = String(seg.text || '').replace(/\n+$/, '')
        if (!t.trim()) continue
        texts.push(t)
        const esc = htmlEscape(t)
        for (const para of esc.split(/\n\s*\n/)) {
          if (para.trim()) htmlParts.push('<p>' + para.trim().replace(/\n/g, '<br>') + '</p>')
        }
      } else if (seg.type === 'img' && seg.buf) {
        let up
        try { up = await uploadImage(seg.buf, seg.filename, seg.width, seg.height) } catch (e) {
          log?.warn?.('小黑盒配图上传失败，跳过这张：' + e.message)
          continue
        }
        imgRefs.push(up)
        htmlParts.push(`<p><img data-type="image" data-original="${up.url}" data-width="${up.width}" data-height="${up.height}" data-description=""></p>`)
      }
    }
    if (!htmlParts.length) throw new HeyboxError('没内容可发', 'input')
    const blocks = [{ type: 'html', text: htmlParts.join('') }]
    for (const b of imgRefs) blocks.push({ type: 'img', url: b.url, width: String(b.width), height: String(b.height) })
    return { blocks, fullText: texts.join('\n') || '（图片帖）' }
  }

  /** 创作者中心最新帖 id：文章模式一般直接返回 link_id，这个只做兜底 */
  async function latestPostId() {
    try {
      const d = await getClient().get('/bbs/app/author/concept/article/list', {
        article_type: 'all', artilce_state: 'all', sort_filter: 'create_at', offset: 0, limit: 1,
      })
      const r = d.result || {}
      const list = r.articles || r.links || r.list || []
      const first = list[0]
      return first ? String(first.linkid ?? first.link_id ?? '') : ''
    } catch { return '' }
  }

  async function post({ title, text = '', images = [], topic = '', style = '' }) {
    const cfg = getConfig().heybox || {}
    if (left('post') <= 0) return { ok: false, message: '今天的发帖额度用完了（建议一天别超过 3 篇）' }
    const t = String(title || '').trim()
    if (!t) return { ok: false, message: '标题不能空' }
    if (t.length > 30) return { ok: false, message: `标题 ${t.length} 字，太长了（最多 30 字）` }

    // 风格只影响提示词和字数下限，不改发帖接口
    const st = styleOf(style || cfg.postStyle)
    const words = countWords(text)
    if (text && words && words < st.words[0] * 0.6) {
      log?.warn?.(`小黑盒发帖正文 ${words} 字，比「${st.label}」建议的 ${st.words[0]}~${st.words[1]} 字短不少`)
    }

    const topicId = String(topic || cfg.defaultTopic || 7214)
    const segs = []
    if (text) segs.push({ type: 'text', text })
    for (const p of images) {
      try {
        const buf = fs.readFileSync(p)
        segs.push({ type: 'img', buf, filename: path.basename(p) })
      } catch { log?.warn?.('配图读不到，跳过：' + p) }
    }

    const { blocks, fullText } = await buildArticle(segs)
    const desc = fullText.replace(/\s+/g, ' ').slice(0, 80)
    const d = await getClient().post('/bbs/app/api/link/post', {
      link_tag: '11',                         // 11=文章（富文本，行内插图真正生效）
      text: JSON.stringify(blocks),
      title: t,
      desc,
      words_count: String(countWords(fullText)),
      topic_ids: topicId,                     // 必须给，否则「请添加分区」
      hashtags: '[]',
      schedule_ts: '0',
      view_limit: '1',                        // 1=所有人
      post_type: '1',
      original: '1',
      declaration: '0',
    })

    const r = d.result || {}
    let id = String((typeof r === 'object' && (r.link_id ?? r.linkid)) || d.link_id || d.linkid || '')
    if (!id) id = await latestPostId()
    bump('post')
    const url = id ? `${WEB_BASE}/app/bbs/link/${id}` : ''
    pushHistory({ kind: 'post', linkId: id, title: t })
    memory?.addEvent?.({ text: `我在小黑盒发了一帖《${t}》`, tags: ['小黑盒'], importance: 0.5 })

    const inline = blocks[0]?.type === 'html' ? (blocks[0].text.match(/<img /g) || []).length : 0
    return {
      ok: true,
      message: (url ? `发出去了：${url}` : '发出去了，但没拿到帖子编号') + `（风格：${st.label}，行内图 ${inline} 张）`,
      url, linkId: id, inline, topicId, style: st.id,
    }
  }

  /** 按风格给「这一帖该怎么写」的提示词（她生成正文前拿这个） */
  function postBrief(style = '', ctx = {}) {
    return stylePrompt(style || (getConfig().heybox || {}).postStyle, ctx)
  }

  // ── 定时自己逛（只读） ─────────────────────────────────────────

  async function browse({ ownerAsked = false, report } = {}) {
    const c = getConfig().heybox || {}
    if (!c.enabled) return { ok: false, message: '小黑盒没打开' }
    if (!cookie()) return { ok: false, message: '还没登录小黑盒（面板里填 Cookie）' }
    if (left('browse') <= 0) return { ok: false, message: '今天逛的轮数到上限了' }
    try {
      const list = await feed(0)
      const picked = list.slice(0, Math.max(1, Number(c.perRun) || 3))
      bump('browse')
      const st = readState()
      st.lastRun = nowMs()
      st.lastSkipReason = ''
      writeState(st)
      pushHistory({ kind: 'browse', count: picked.length })
      return {
        ok: true,
        message: picked.length
          ? '逛完了，看到这些：\n' + picked.map((x) => `《${x.title || '无标题'}》赞${x.likes} 评${x.comments}  ${WEB_BASE}/app/bbs/link/${x.linkId}`).join('\n')
          : '逛完了，信息流是空的',
        links: picked,
      }
    } catch (e) {
      return { ok: false, message: '逛小黑盒失败：' + e.message }
    }
  }

  // ── 后台会话：定时自己刷（独立 system 会话，带人格，结果不发到 QQ） ──
  //
  // 说明（原作者 review 里点到的）：
  //   · 工具永远跑在「调用它的那个聊天」的会话里，所以要有独立会话就得自己开一个；
  //   · api.think / hub.runSystemTurn 会建 system:ext-heybox 后台会话，带人格；
  //   · 记忆是全局一份，但后台 system 会话不会自动带记忆、也不会被提取，
  //     所以这里手动 recall 拼进 prompt，想留下的再用 memory.add 写回去。

  async function runDuty({ memory, owner = '' } = {}) {
    const c = getConfig().heybox || {}
    if (!c.enabled || !c.autoBrowse || !hasLogin()) return { ok: false, message: '没开或没登录' }
    if (left('browse') <= 0) return { ok: false, message: '今天逛的轮数到上限了' }

    // 手动把相关记忆拼进 prompt（后台会话不会自动带）
    let about = []
    try {
      about = memory?.recall?.('小黑盒 游戏 帖子 兴趣', { limit: 6 }) || []
    } catch { about = [] }
    const aboutText = (Array.isArray(about) ? about : []).map((m) => '- ' + (m.text || m)).join('\n') || '（暂无）'

    const prompt = [
      '【刷小黑盒，不是聊天，这一轮不会发到 QQ】',
      owner ? `主人是 ${owner}。` : '',
      `你记得的关于游戏/社区的事：\n${aboutText}`,
      '先看热榜挑一个游戏相关的题（电竞和商业新闻不适合），再看社区高赞帖在聊什么角度，然后决定这次做什么。',
      '只读浏览不用征求同意；要发帖、点赞、评论的话，先按你的自检清单过一遍再动手。',
      '做完用一两句话说说你看了什么、做了什么，别写成报告。',
    ].filter(Boolean).join('\n\n')

    const out = await hub.runSystemTurn('heybox', 'QQ · 刷小黑盒', prompt, { timeoutMs: 240000 })
    bump('browse')
    const st = readState()
    st.lastRun = nowMs()
    st.lastSkipReason = ''
    writeState(st)
    pushHistory({ kind: 'browse', note: String(out || '').slice(0, 80) })

    // 想留下的东西写进记忆
    try {
      const t = String(out || '').trim()
      if (t && t.length > 10) memory?.addEvent?.({ text: `我在小黑盒逛了一圈：${t.slice(0, 120)}`, tags: ['小黑盒'], importance: 0.45 })
    } catch { /* 记忆模块没在跑就算了 */ }

    return { ok: true, message: String(out || '').slice(0, 300), session: 'system:ext-heybox' }
  }

  async function tick({ memory, owner } = {}) {
    const c = getConfig().heybox || {}
    if (!c.enabled || !c.autoBrowse || !hasLogin()) return
    const st = readState()
    const gap = (Number(c.intervalHours) || 4) * 3600_000
    if (st.lastRun && nowMs() - st.lastRun < gap) return
    if (left('browse') <= 0) {
      st.lastSkipReason = '今天逛的轮数到上限了'
      writeState(st)
      return
    }
    try {
      const r = await runDuty({ memory, owner })
      if (!r.ok) { st.lastSkipReason = r.message; writeState(st) }
      else log?.info?.('小黑盒后台会话跑完：' + r.message.slice(0, 40))
    } catch (e) {
      st.lastSkipReason = e.message
      writeState(st)
      log?.warn?.('小黑盒后台会话失败：' + e.message)
    }
  }


  async function account(force = false) {
    const st = readState()
    const ck = cookie()
    if (!ck) {
      const next = { loggedIn: false, message: '还没填 Cookie', checkedAt: nowMs(), nickname: '', heyboxId: '' }
      st.account = next
      writeState(st)
      return { ok: true, ...next }
    }
    if (!force && st.account.checkedAt && nowMs() - st.account.checkedAt < 10 * 60_000) return { ok: true, ...st.account }
    try {
      const d = await getClient().get('/account/restore_login')
      const r = d.result || {}
      const profile = r.profile || r.account_detail || {}
      const next = {
        loggedIn: true,
        nickname: String(profile.username ?? profile.nickname ?? ''),
        heyboxId: String(profile.heybox_id ?? r.heybox_id ?? ''),
        message: '',
        checkedAt: nowMs(),
      }
      st.account = next
      writeState(st)
      return { ok: true, ...next }
    } catch (e) {
      const next = { loggedIn: false, nickname: '', heyboxId: '', message: e.message, checkedAt: nowMs() }
      st.account = next
      writeState(st)
      return { ok: true, ...next }
    }
  }

  function saveCookie(raw) {
    const s = String(raw || '').trim()
    if (!s) return { ok: false, message: 'Cookie 是空的' }
    if (!/pkey=/.test(s)) return { ok: false, message: '这串 Cookie 里没有 pkey，多半没复制全' }
    clientCookie = s
    client = null
    const st = readState()
    st.account = { ...DEFAULT_STATE.account }
    writeState(st)
    return { ok: true, cookie: s, message: /x_xhh_tokenid=/.test(s) ? 'Cookie 存好了（有发帖令牌，写操作也能用）' : 'Cookie 存好了（缺 x_xhh_tokenid，点赞评论可能会被拒）' }
  }

  function clearQuota() {
    const st = readState()
    st.quota = { date: today(), like: 0, comment: 0, post: 0, browse: 0 }
    writeState(st)
    return { ok: true, message: '今天的小黑盒额度清零了' }
  }

  function state() {
    const st = readState()
    const c = getConfig().heybox || {}
    return {
      ...st,
      quota: quota(),
      limits: { likeDaily: c.likeDaily, commentDaily: c.commentDaily, maxPostsPerDay: c.maxPostsPerDay, maxRunsPerDay: c.maxRunsPerDay },
      left: { like: left('like'), comment: left('comment'), post: left('post'), browse: left('browse') },
      hasCookie: Boolean(cookie()),
      hasToken: /x_xhh_tokenid=/.test(cookie()),
      topics: TOPICS,
    }
  }

  log?.info?.('小黑盒模块起来了' + (cookie() ? '' : '（还没填 Cookie）'))

  return {
    feed, feedReport, detail, watch, hot, search, topicList,
    like, comment, remove, post, browse, tick, account, saveCookie, clearQuota, state,
    linkIdOf, postBrief, POST_STYLES, DEFAULT_POST_STYLE, runDuty,
  }
}
