// 看小红书：搜索、看帖、看评论、回帖。
// 签名请求（搜索/评论）交给宿主机上的 Python 桥（xhs_bridge.py，默认 127.0.0.1:8099）；
// 读单条笔记不用桥，页面 SSR 加 cookie 就够，图落盘再发。
import fs from 'node:fs'
import { createBridge } from './lib/bridge.mjs'
import { readNote, cacheImage, pickLink, parseIds, buildUrl } from './lib/read.mjs'

export default {
  id: 'xhs',
  name: '看小红书',
  version: '0.6.0',
  api: 1,
  description: '搜笔记、看帖子、读评论、回评论；靠本地桥做签名请求',
  panel: 'panel.js',
  defaults: {
    bridgeUrl: 'http://127.0.0.1:8099',
    bridgeToken: '',
    cookie: '',
    enableSearch: true,
    enableRead: true,
    enableComments: true,
    groupRead: false,
    sendImages: true,
    sendImagesInGroup: false,
    maxImages: 3,
    imageGapMs: 400,
    maxDescChars: 1200,
    maxResults: 10,
    allowComment: true,
    cooldownSec: 60,
    dailyComments: 10,
    riskCooldownMin: 10,
    fullMode: false,
  },
  settings: [
    { key: 'cookie', label: '小红书 cookie', type: 'textarea', hint: '手动粘贴：整串 cookie 粘进来（a=1; b=2; …）。只认这一份，不读文件' },
    { key: 'enableRead', label: '允许读笔记', type: 'switch', hint: '关掉后链接也打不开' },
    { key: 'groupRead', label: '群里也能看', type: 'switch', hint: '默认关：只有主人私聊能看。群友让她看会消耗桥的额度' },
    { key: 'sendImages', label: '顺便发配图', type: 'switch' },
    { key: 'sendImagesInGroup', label: '群里也发配图', type: 'switch', hint: '默认关，避免在群里刷图' },
    { key: 'maxImages', label: '最多发几张', type: 'number', min: 0, max: 9, step: 1 },
    { key: 'imageGapMs', label: '配图间隔(毫秒)', type: 'number', min: 0, max: 5000, step: 100, hint: '连发多张之间的停顿，太小容易被网关限流' },
    { key: 'maxDescChars', label: '正文最多读多少字', type: 'number', min: 200, max: 6000, step: 100, hint: '太长会截断，省 token' },
    { key: 'maxResults', label: '搜索返回几条', type: 'number', min: 1, max: 20, step: 1 },
    { key: 'cooldownSec', label: '两条评论间隔(秒)', type: 'number', min: 0, max: 3600, step: 10 },
    { key: 'dailyComments', label: '每天最多回几条', type: 'number', min: 0, max: 200, step: 1, hint: '0 = 不限。按自然日算，落盘，重启不清零' },
    { key: 'riskCooldownMin', label: '风控冷却(分钟)', type: 'number', min: 1, max: 1440, step: 1, hint: '撞到验证码/429 后暂停多久' },
  ],

  setup(api) {
    const settings = () => api.settings() || {}
    const log = api.log
    const bridge = createBridge(
      () => settings().bridgeUrl || 'http://127.0.0.1:8099',
      () => settings().bridgeToken || '',
    )
    // 桥在不在：没桥时搜索/评论这些工具不挂出来，只留「读笔记」（读笔记走页面 SSR + cookie）
    let bridgeOk = null
    async function probeBridge() {
      try { await bridge.health({ timeoutMs: 5000 }); bridgeOk = true }
      catch { bridgeOk = false }
      return bridgeOk
    }
    probeBridge()
    api.every(60_000, probeBridge, '探小红书桥')
    let lastCommentAt = 0 // 进程内兜底；正式记录在 state.json 里，重启不丢

    // ---------- 落盘状态：回复冷却 / 每日额度 / 风控冷却 ----------
    const stateFile = () => api.dataDir('state.json')
    function readState() {
      try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {} } catch { return {} }
    }
    function saveState(patch) {
      const next = { ...readState(), ...patch }
      try { fs.writeFileSync(stateFile(), JSON.stringify(next)) } catch (e) { log.warn('状态存不下：' + e.message) }
      return next
    }
    const today = () => new Date().toISOString().slice(0, 10)
    function quotaUsed() {
      const st = readState()
      return st.day === today() ? Number(st.count) || 0 : 0
    }
    function riskMinutesLeft() {
      const until = Number(readState().riskUntil) || 0
      return until > Date.now() ? Math.ceil((until - Date.now()) / 60000) : 0
    }
    function markRisk(minutes, why) {
      saveState({ riskUntil: Date.now() + minutes * 60000, riskWhy: String(why || '').slice(0, 120) })
      log.warn(`小红书进冷却 ${minutes} 分钟：${why}`)
    }
    /** 桥的报错里带风控痕迹就记一笔，别硬打 */
    function noteRisk(error) {
      const msg = String(error?.message || error || '')
      if (/verifytype|风控|验证码|HTTP 429|限流|频繁/i.test(msg)) {
        markRisk(Number(settings().riskCooldownMin ?? 10) || 10, msg)
      }
    }

    // cookie 只有一份来源：面板里手动粘贴。不读文件、不自动抓
    function readCookieInfo() {
      const cookie = String(settings().cookie || '').trim()
      return { cookie, source: cookie ? '面板' : '' }
    }
    const readCookie = () => readCookieInfo().cookie

    function pruneImages() {
      try {
        const dir = api.dataDir()
        const files = fs.readdirSync(dir)
          .filter((f) => f.startsWith('img-'))
          .map((f) => ({ f, t: fs.statSync(dir + '/' + f).mtimeMs }))
          .sort((a, b) => b.t - a.t)
        for (const x of files.slice(60)) fs.unlinkSync(dir + '/' + x.f)
      } catch { /* 清理失败无所谓 */ }
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

    async function sendImages(chatId, urls) {
      const s = settings()
      if (s.sendImages === false) return 0
      const inGroup = String(chatId || '').startsWith('group:')
      if (inGroup && s.sendImagesInGroup !== true) return 0
      const max = Math.min(Number(s.maxImages ?? 3) || 0, 9)
      if (max <= 0 || !chatId || !urls.length) return 0
      const gap = Math.min(Math.max(Number(s.imageGapMs ?? 400) || 0, 0), 5000)
      let sent = 0
      for (let i = 0; i < Math.min(max, urls.length); i++) {
        try {
          const file = await cacheImage(urls[i], (...p) => api.dataDir(...p), i)
          await api.sendImage(chatId, file)
          sent++
          if (i < Math.min(max, urls.length) - 1 && gap > 0) await sleep(gap + Math.round(Math.random() * 200))
        } catch (e) {
          log.warn('配图没发出去：' + e.message)
        }
      }
      pruneImages()
      return sent
    }

    function needCookie() {
      const c = readCookie()
      if (!c) throw new Error('小红书 cookie 没配：面板里手动粘贴一份再试（读正文要用它）')
      return c
    }

    // ---------- 动作 ----------
    const NOTE_ID = /^[0-9a-f]{24}$/i

    async function doSearch(keyword, page = 1) {
      let raw = []
      try { raw = await bridge.search(keyword, page) } catch (e) { noteRisk(e); throw e }
      // 桥会把推荐位、直播卡、商品卡一起塞进来，id 不是 24 位十六进制的都不是笔记
      const items = (raw || []).filter((it) => NOTE_ID.test(String(it?.id || '').trim()))
      if (!items.length) {
        return { ok: true, message: `搜「${keyword}」没搜到能用的笔记${raw.length ? `（${raw.length} 条返回里没有一条是笔记 id）` : ''}` }
      }
      const want = Math.min(Math.max(Number(settings().maxResults ?? 10) || 10, 1), 20)
      const lines = items.slice(0, want).map((it, i) =>
        `${i + 1}. 《${String(it.title || '（无标题）').trim()}》 ${it.author || '?'}｜赞 ${it.likes ?? 0}｜评 ${it.comments ?? 0}\n   ${buildUrl(it.id, it.token)}`)
      return {
        ok: true,
        message: `「${keyword}」第 ${page} 页，${items.length} 条可用${raw.length > items.length ? `（另 ${raw.length - items.length} 条无效已过滤）` : ''}：\n` +
          lines.join('\n') + '\n\n要细看直接把那条链接给 xhs_read；读评论给 xhs_comments。',
      }
    }

    async function doRead(input, chatId, tokenHint = '') {
      const cookie = needCookie()
      const maxChars = Math.min(Math.max(Number(settings().maxDescChars ?? 1200) || 1200, 200), 6000)
      const r = await readNote(input, cookie, tokenHint, { maxChars })
      const sent = await sendImages(chatId, r.images)
      // 看过的内容记一笔「见过」，不进人物事实，也不参与画像
      try {
        api.use('memory')?.addEvent?.({
          kind: 'seen',
          text: `看了小红书《${String(r.note?.title || '笔记').slice(0, 60)}》`,
          meta: {
            title: String(r.note?.title || '').slice(0, 160),
            author: String(r.note?.user?.nickname || '').slice(0, 80),
            url: String(r.url || '').slice(0, 500),
            platform: '小红书',
            id: String(r.id || '').slice(0, 100),
          },
        })
      } catch { /* 记忆写不进去不影响这次读 */ }
      let text = r.text
      if (sent) text += `\n（图发了 ${sent} 张）`
      text += `\n\nnote_id=${r.id}` + (r.xsecToken ? ` xsec_token=${r.xsecToken}` : '')
      return { ok: true, message: text }
    }

    async function doComments({ id, url, token, parent, cursor }) {
      let noteId = String(id || '').trim()
      let tk = String(token || '').trim()
      if (!noteId && url) {
        const p = parseIds(pickLink(url) || url)
        noteId = p.id
        tk = tk || p.token
      }
      if (!noteId) throw new Error('给我 note_id 或者笔记链接')
      if (!tk && url) {
        const p = parseIds(pickLink(url) || url)
        tk = p.token
      }
      const r = await (async () => {
        try { return await bridge.comments({ id: noteId, token: tk, parent, cursor }) }
        catch (e) { noteRisk(e); throw e }
      })()
      if (!r.comments.length) return { ok: true, message: '这条下面没读到评论（可能真没有，也可能被软限流，过会儿再试）' }
      const lines = r.comments.slice(0, 12).map((c, i) =>
        `${i + 1}. ${c.author}（${c.ip || '?'}）赞${c.likes}${c.sub_count ? ` 回复${c.sub_count}` : ''}\n   ${c.content.slice(0, 160)}\n   comment_id=${c.id}`)
      return {
        ok: true,
        message: `共读到 ${r.comments.length} 条评论${parent ? '（楼中楼）' : ''}：\n` + lines.join('\n') +
          (r.has_more ? '\n还有更多，可以带 cursor 继续翻。' : ''),
      }
    }

    async function doLike({ id, url, action }) {
      const risk = riskMinutesLeft()
      if (risk) return { ok: false, message: `小红书还在风控冷却里，再等 ${risk} 分钟` }
      let noteId = String(id || '').trim()
      if (!noteId && url) noteId = parseIds(pickLink(url) || url).id
      if (!noteId) throw new Error('给我 note_id 或者笔记链接')
      const act = action === 'unlike' || action === '取消' || action === '取消赞' ? 'unlike' : 'like'
      let r
      try { r = await bridge.like(noteId, act) }
      catch (e) { noteRisk(e); throw e }
      return { ok: true, message: (act === 'like' ? '点了赞' : '取消赞了') + `（${noteId}）` }
    }

    async function doReplies({ limit } = {}) {
      const r = await bridge.replies(Number(limit) || 10)
      if (!r.count) return { ok: true, message: '我发过的评论下面暂时没人回。想看得勤一点，可以让我隔一阵再查。' }
      const lines = r.items.slice(0, 10).map((x, i) =>
        `${i + 1}. ${x.author}：${x.content.slice(0, 80)}${x.iso ? '（' + x.iso + '）' : ''}\n   note_id=${x.note_id} reply_comment_id=${x.reply_comment_id} at=${x.user_id}`)
      return {
        ok: true,
        message: `有人回我了，共 ${r.count} 条：\n` + lines.join('\n') +
          '\n\n要接话就调 xhs_comment：id 用 note_id，reply_to 用 reply_comment_id，at_user 用 at 那个号。',
      }
    }

    async function doComment({ id, url, content, reply_to, replyTo, at_user, atUser }, chat) {
      const s = settings()
      if (s.allowComment === false) return { ok: false, message: '回帖功能被关掉了（面板里能开）' }
      if (!(chat && chat.kind === 'private' && api.isOwner(chat.userId))) {
        return { ok: false, message: '只有主人私聊时才能替她回帖' }
      }
      const body = String(content || '').trim()
      if (!body) return { ok: false, message: '评论内容是空的' }
      if (body.length > 300) return { ok: false, message: '评论太长了，小红书这条最多 300 字' }

      const risk = riskMinutesLeft()
      if (risk) return { ok: false, message: `小红书还在风控冷却里，再等 ${risk} 分钟` }

      const st = readState()
      const cd = Number(s.cooldownSec ?? 60) * 1000
      const last = Number(st.lastCommentAt) || lastCommentAt
      const wait = last + cd - Date.now()
      if (wait > 0) return { ok: false, message: `刚发过，等 ${Math.ceil(wait / 1000)} 秒再说` }

      const daily = Number(s.dailyComments ?? 10)
      const used = quotaUsed()
      if (daily > 0 && used >= daily) return { ok: false, message: `今天已经回了 ${used} 条，够了` }

      let noteId = String(id || '').trim()
      let tk = ''
      if (!noteId && url) {
        const p = parseIds(pickLink(url) || url)
        noteId = p.id
        tk = p.token
      }
      if (!noteId) throw new Error('给我 note_id 或者笔记链接')

      const replyId = String(reply_to || replyTo || '').trim() || null
      const atId = String(at_user || atUser || '').trim() || null

      let r
      try {
        r = await bridge.postComment({ noteId, content: body, replyCommentId: replyId, atUserId: atId })
      } catch (e) {
        noteRisk(e)
        throw e
      }
      lastCommentAt = Date.now()
      saveState({ lastCommentAt, day: today(), count: used + 1 })
      try {
        api.use('memory')?.addEvent?.({
          text: `我在小红书回了一条评论：${body.slice(0, 40)}`,
          tags: ['小红书'],
          importance: 0.4,
        })
      } catch { /* 记不上不影响发出去 */ }
      log.info(`发了评论：note=${noteId} ${replyId ? 'reply=' + replyId + ' ' : ''}${atId ? 'at=' + atId + ' ' : ''}${body.slice(0, 30)}`)
      return {
        ok: true,
        message: `发出去了（${r.toast || '已发布'}）comment_id=${r.comment_id || '?'}` +
          (r.http ? ` HTTP ${r.http}` : ''),
      }
    }

    // ---------- 工具 ----------
    api.tool(({ chat }) => {
      if (!chat || chat.kind === 'system') return []
      const s = settings()
      // 群里默认不给她看小红书：群友一句「去搜一下」就要烧桥的额度
      if (chat.kind === 'group' && s.groupRead !== true) return []
      const tools = []

      const withBridge = s.fullMode === true && bridgeOk !== false
      if (s.enableSearch !== false && withBridge) tools.push(api.defineTool({
        name: 'xhs_search',
        description: '在小红书搜笔记，返回标题、作者、点赞评论数和 id/token。想找某个话题的内容、或者别人让你去小红书看看时用。',
        properties: {
          keyword: { type: 'string', description: '搜索词' },
          page: { type: 'number', description: '第几页，默认 1' },
        },
        required: ['keyword'],
        execute: async ({ keyword, page }) => {
          try { return await doSearch(String(keyword || ''), Number(page) || 1) }
          catch (e) { log.warn('搜小红书失败：' + e.message); return { ok: false, message: '搜不了：' + e.message } }
        },
      }))

      if (s.enableRead !== false) tools.push(api.defineTool({
        name: 'xhs_read',
        description: '打开一条小红书笔记，读出标题、正文、作者、互动数据，需要时把配图发出来。别人发来链接、或者搜到 id 想细看时用。',
        properties: {
          url: { type: 'string', description: '笔记链接' },
          id: { type: 'string', description: '或者 24 位 note_id（和 url 二选一）' },
          token: { type: 'string', description: 'xsec_token（搜索结果里有；纯 id 时必须给，不然页面是空壳）' },
        },
        required: [],
        execute: async ({ url, id, token }) => {
          try { return await doRead(String(url || id || ''), chat.chatId, String(token || '')) }
          catch (e) { log.warn('读小红书失败：' + e.message); return { ok: false, message: '打不开：' + e.message } }
        },
      }))

      if (s.enableComments !== false && withBridge) tools.push(api.defineTool({
        name: 'xhs_comments',
        description: '读一条笔记下面的评论。看完想接话、想知道大家怎么说时用。给 note_id + token，或者直接给链接。',
        properties: {
          id: { type: 'string', description: 'note_id' },
          url: { type: 'string', description: '或者笔记链接' },
          token: { type: 'string', description: 'xsec_token（搜索结果里有）' },
          parent: { type: 'string', description: '想读某条评论下面的楼中楼时给它的 comment_id' },
        },
        execute: async (args) => {
          try { return await doComments(args || {}) }
          catch (e) { log.warn('读评论失败：' + e.message); return { ok: false, message: '读不到评论：' + e.message } }
        },
      }))

      if (s.allowComment !== false && withBridge && chat.kind === 'private' && api.isOwner(chat.userId)) {
        tools.push(api.defineTool({
          name: 'xhs_comment',
          description: '在小红书笔记下发一条评论，或者回复某条评论（楼中楼）。主人明确让你回、并且内容你已经想好了再用；发出去就是真发了，不能撤回。',
          properties: {
            id: { type: 'string', description: 'note_id' },
            url: { type: 'string', description: '或者笔记链接' },
            content: { type: 'string', description: '评论内容，300 字以内' },
            reply_to: { type: 'string', description: '要回复的 comment_id（楼中楼），不填就是直接评论' },
            at_user: { type: 'string', description: '要 @ 的用户 id（回复别人的回复时填上，对方才收得到提醒）' },
          },
          required: ['content'],
          execute: async (args) => {
            try { return await doComment(args || {}, chat) }
            catch (e) { log.warn('发评论失败：' + e.message); return { ok: false, message: '没发出去：' + e.message } }
          },
        }))
      }

      if (withBridge && chat.kind === 'private' && api.isOwner(chat.userId)) {
        tools.push(api.defineTool({
          name: 'xhs_like',
          description: '给小红书笔记点赞或取消赞。主人让你点个赞、或者说这条不错点一下时用。',
          properties: {
            id: { type: 'string', description: 'note_id' },
            url: { type: 'string', description: '或者笔记链接' },
            action: { type: 'string', description: 'like（默认）或 unlike' },
          },
          execute: async (args) => {
            try { return await doLike(args || {}) }
            catch (e) { log.warn('点赞失败：' + e.message); return { ok: false, message: '没成功：' + e.message } }
          },
        }))

        tools.push(api.defineTool({
          name: 'xhs_replies',
          description: '看谁回复了我发过的评论。想知道有没有人接话、要不要继续聊时用。',
          properties: {
            limit: { type: 'number', description: '看最近几条，默认 10' },
          },
          execute: async (args) => {
            try { return await doReplies(args || {}) }
            catch (e) { log.warn('查回复失败：' + e.message); return { ok: false, message: '查不到：' + e.message } }
          },
        }))
      }

      return tools
    })

    // ---------- 面板接口（/aurabot/api/ext/xhs/...） ----------
    api.route('/state', async () => {
      const st = readState()
      let bridgeInfo
      try {
        const h = await bridge.health({ timeoutMs: 6000 })
        const u = h.user || {}
        bridgeInfo = { ok: true, nickname: u.nickname || '', redId: u.red_id || u.redId || '', guest: Boolean(u.guest) }
      } catch (e) {
        bridgeInfo = { ok: false, error: String(e.message || e).slice(0, 140) }
      }
      const s = settings()
      const info = readCookieInfo()
      const daily = Number(s.dailyComments ?? 10) || 0
      const used = quotaUsed()
      return {
        ok: true,
        pluginVersion: api.version,
        bridge: bridgeInfo,
        bridgeUrl: String(s.bridgeUrl || 'http://127.0.0.1:8099'),
        cookie: Boolean(info.cookie),
        cookieSource: info.source,
        today: used,
        daily,
        left: daily > 0 ? Math.max(daily - used, 0) : -1,
        lastCommentAt: Number(st.lastCommentAt) || 0,
        riskMinutes: riskMinutesLeft(),
        riskWhy: st.riskWhy || '',
        fullMode: s.fullMode === true,
        flags: {
          fullMode: s.fullMode === true,
          enableSearch: s.enableSearch !== false,
          enableRead: s.enableRead !== false,
          enableComments: s.enableComments !== false,
          groupRead: s.groupRead === true,
          allowComment: s.allowComment !== false,
          sendImages: s.sendImages !== false,
          sendImagesInGroup: s.sendImagesInGroup === true,
        },
        limits: {
          maxImages: Number(s.maxImages ?? 3) || 0,
          imageGapMs: Number(s.imageGapMs ?? 400) || 0,
          maxDescChars: Number(s.maxDescChars ?? 1200) || 0,
          maxResults: Number(s.maxResults ?? 10) || 0,
          cooldownSec: Number(s.cooldownSec ?? 60) || 0,
          dailyComments: daily,
          riskCooldownMin: Number(s.riskCooldownMin ?? 10) || 0,
        },
      }
    })

    api.route('/risk/clear', async () => {
      try { await bridge.health() } catch (e) {
        return { ok: false, message: '桥连不上，没法核对账号，先不解除：' + e.message }
      }
      saveState({ riskUntil: 0, riskWhy: '' })
      return { ok: true, message: '风控冷却清掉了' }
    })

    api.route('/quota/reset', async () => {
      saveState({ day: today(), count: 0, lastCommentAt: 0 })
      return { ok: true, message: '今天的评论额度清零了' }
    })

    api.route('/bridge/test', async () => {
      try {
        const h = await bridge.health({ timeoutMs: 5000 })
        const u = h.user || {}
        const nick = u.nickname || '?'
        return {
          ok: true,
          guest: Boolean(u.guest),
          message: u.guest ? `桥通了，但没登录（guest）——重新导一份 cookie` : `桥通了，登录的是 ${nick}`,
        }
      } catch (e) {
        return { ok: false, message: '连不上桥：' + String(e.message || e).slice(0, 120) }
      }
    })

    api.route('/cookie/check', async () => {
      const info = readCookieInfo()
      return { ok: true, cookie: Boolean(info.cookie), source: info.source, length: info.cookie.length }
    })

    // ---------- 命令 ----------
    api.command({
      name: 'xhs',
      aliases: ['小红书'],
      desc: '看小红书：/xhs 链接｜/xhs 关键词｜/xhs 健康',
      run: async (arg, msg) => {
        const a = String(arg || '').trim()
        if (!a) return '用法：/xhs 链接 或 /xhs 关键词'
        if (a === '健康' || a === 'health') {
          try {
            const h = await bridge.health()
            const u = h.user || {}
            return `桥活着，登录账号：${u.nickname || '?'}（${u.red_id || u.redId || '?'}），guest=${u.guest}`
          } catch (e) { return '桥连不上：' + e.message }
        }
        if (pickLink(a)) {
          const r = await doRead(a, msg.chatId)
          return r.message
        }
        const r = await doSearch(a, 1)
        return r.message
      },
    })

    api.rule(() => {
      const s = settings()
      const can = s.allowComment !== false
      return '你会逛小红书：xhs_search 搜笔记，xhs_read 看正文和配图，xhs_comments 读评论' +
        (can ? '，主人让你回的时候用 xhs_comment 发评论。' : '。') +
        '看完用你自己的话说，别照抄原文；评论要短，别写成小作文。'
    })

    bridge.health().then((h) => {
      const u = h.user || {}
      log.info(`小红书模块就绪｜桥在线，账号 ${u.nickname || '?'}`)
    }).catch((e) => log.warn('小红书桥连不上：' + e.message))

    return { search: doSearch, read: doRead, comments: doComments, comment: doComment, bridge }
  },
}
