// 看小红书：搜索、看帖、看评论、回帖。
// 签名请求（搜索/评论）交给宿主机上的 Python 桥（xhs_bridge.py，默认 127.0.0.1:8099）；
// 读单条笔记不用桥，页面 SSR 加 cookie 就够，图落盘再发。
import fs from 'node:fs'
import path from 'node:path'
import { createBridge } from './lib/bridge.mjs'
import { readNote, cacheImage, pickLink, parseIds, buildUrl } from './lib/read.mjs'

export default {
  id: 'xhs',
  name: '看小红书',
  version: '0.6.1',
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
    autoBrowse: false,
    autoIntervalMin: 180,
    autoKeywords: '',
    autoPerRun: 1,
    autoDailyNotes: 10,
    autoRunsPerDay: 8,
    autoHours: '9-23',
    autoLike: false,
    autoDailyLikes: 5,
    autoReply: false,
    autoNotify: false,
    allowPublish: false,
    dailyPosts: 3,
    postGapMin: 10,
    publishPrivate: true,
  },
  settings: [
    // 基础功能：粘个 cookie 就能用，不需要桥
    { key: 'cookie', label: '基础 · 小红书 cookie', type: 'textarea', hint: '手动粘贴：整串 cookie 粘进来（a=1; b=2; …）。只认这一份，不读文件' },
    { key: 'maxImages', label: '基础 · 读笔记最多发几张图', type: 'number', min: 0, max: 9, step: 1, hint: '0 = 只发正文不发图' },
    { key: 'imageGapMs', label: '基础 · 配图间隔(毫秒)', type: 'number', min: 0, max: 5000, step: 100, hint: '连发多张之间的停顿，太小容易被网关限流' },
    { key: 'maxDescChars', label: '基础 · 正文最多读多少字', type: 'number', min: 200, max: 6000, step: 100, hint: '太长会截断，省 token' },
    // 完整功能：都要桥
    { key: 'maxResults', label: '搜索 · 一次返回几条', type: 'number', min: 1, max: 20, step: 1, hint: '太多占上下文' },
    { key: 'cooldownSec', label: '回帖 · 两条间隔(秒)', type: 'number', min: 0, max: 3600, step: 10, hint: '两次回帖之间至少隔多久；0 = 不限制（不建议）' },
    { key: 'dailyComments', label: '回帖 · 每天最多几条', type: 'number', min: 0, max: 200, step: 1, hint: '0 = 不限。按自然日算，落盘，重启不清零' },
    { key: 'riskCooldownMin', label: '风控 · 冷却(分钟)', type: 'number', min: 1, max: 1440, step: 1, hint: '撞到验证码/429 后暂停多久' },
    { key: 'autoIntervalMin', label: '自动刷帖 · 间隔(分钟)', type: 'number', min: 30, max: 1440, step: 30, hint: '两轮之间至少隔多久；实际会在 0.8–1.3 倍之间随机浮动' },
    { key: 'autoKeywords', label: '自动刷帖 · 关键词', type: 'text', hint: '逗号分隔，轮着搜；留空用内置的宽泛词' },
    { key: 'autoPerRun', label: '自动刷帖 · 每轮几篇', type: 'number', min: 1, max: 3, step: 1, hint: '1–3 篇' },
    { key: 'autoDailyNotes', label: '自动刷帖 · 每天最多几篇', type: 'number', min: 1, max: 50, step: 1, hint: '到上限当天就不再刷，第二天自动重置' },
    { key: 'autoRunsPerDay', label: '自动刷帖 · 每天最多几轮', type: 'number', min: 1, max: 24, step: 1, hint: '和「每天最多几篇」同时生效，谁先到就停' },
    { key: 'autoHours', label: '自动刷帖 · 活跃时段', type: 'text', hint: '格式 9-23，只在这个小时区间里刷' },
    { key: 'autoDailyLikes', label: '自动刷帖 · 每天最多几个赞', type: 'number', min: 0, max: 50, step: 1, hint: '0 = 不点赞' },
    { key: 'dailyPosts', label: '发帖 · 每天最多几条', type: 'number', min: 1, max: 10, step: 1, hint: '和「两条间隔」同时生效' },
    { key: 'postGapMin', label: '发帖 · 两条间隔(分钟)', type: 'number', min: 1, max: 1440, step: 1, hint: '两篇之间至少隔多久' },
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
    let bridgeFeatures = null
    async function probeBridge() {
      try {
        const h = await bridge.health({ timeoutMs: 5000 })
        bridgeOk = true
        bridgeFeatures = Array.isArray(h.features) ? h.features : null
      } catch {
        bridgeOk = false
        bridgeFeatures = null
      }
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

    // ---------- 自动刷帖：定时搜、定时看，按开关决定点不点赞、回不回 ----------
    const AUTO_WORDS = ['治愈', '咖啡', '读书']
    function autoSnapshot() {
      const st = readState()
      const day = today()
      return {
        st,
        notes: st.autoDay === day ? Number(st.autoNotes) || 0 : 0,
        likes: st.autoDay === day ? Number(st.autoLikes) || 0 : 0,
        runs: st.autoDay === day ? Number(st.autoRuns) || 0 : 0,
        lastRunAt: Number(st.autoLastRunAt) || 0,
        nextDueAt: Number(st.autoNextDueAt) || 0,
        paused: st.autoPauseDay === day,
        pausedWhy: st.autoPauseDay === day ? String(st.autoPauseWhy || '') : '',
        seen: Array.isArray(st.seenNotes) ? st.seenNotes : [],
      }
    }
    function autoPause(reason) {
      saveState({ autoPauseDay: today(), autoPauseWhy: String(reason || '').slice(0, 120) })
      log.warn('小红书自动刷帖今天停了：' + reason)
    }
    function inAutoHours(hours) {
      const m = String(hours || '9-23').match(/^(\d{1,2})\s*[-~]\s*(\d{1,2})$/)
      if (!m) return true
      const from = Number(m[1])
      const to = Number(m[2])
      const h = new Date().getHours()
      return from <= to ? (h >= from && h <= to) : (h >= from || h <= to)
    }
    function cleanComment(text) {
      const first = String(text || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''
      const t = first.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').replace(/\s+/g, ' ').trim()
      return t.length > 120 ? t.slice(0, 120) : t
    }
    async function autoComment(note, text) {
      const s = settings()
      const risk = riskMinutesLeft()
      if (risk) return { ok: false, message: '还在风控冷却' }
      const st = readState()
      if (Date.now() - (Number(st.lastCommentAt) || 0) < Number(s.cooldownSec ?? 60) * 1000) return { ok: false, message: '评论冷却中' }
      const daily = Number(s.dailyComments ?? 10)
      const used = quotaUsed()
      if (daily > 0 && used >= daily) return { ok: false, message: '今日回帖额度用完' }
      try {
        const r = await bridge.postComment({ noteId: note.id, content: text, replyCommentId: null, atUserId: null })
        saveState({ lastCommentAt: Date.now(), day: today(), count: used + 1 })
        log.info(`自动回了一条：note=${note.id} ${text.slice(0, 30)}`)
        return { ok: true, id: r.comment_id || '' }
      } catch (e) {
        noteRisk(e)
        return { ok: false, message: e.message }
      }
    }

    let autoRunning = false
    async function autoRound({ force = false } = {}) {
      const s = settings()
      if (s.fullMode !== true || s.autoBrowse !== true) return { ok: false, message: '自动刷帖没开（要完整功能 + 自动刷帖开关）' }
      if (bridgeOk === false) return { ok: false, message: '桥没起' }
      if (riskMinutesLeft()) return { ok: false, message: '风控冷却中' }
      const a = autoSnapshot()
      if (a.paused) return { ok: false, message: '今天先停了：' + (a.pausedWhy || '风控') }
      if (!inAutoHours(s.autoHours)) return { ok: false, message: '不在活跃时段' }
      const cap = Number(s.autoDailyNotes ?? 10) || 10
      if (a.notes >= cap) return { ok: false, message: `今天已经刷了 ${a.notes} 篇，到上限了` }
      const runCap = Number(s.autoRunsPerDay ?? 8) || 8
      if (a.runs >= runCap) return { ok: false, message: `今天已经跑了 ${a.runs} 轮，到上限了` }
      if (!force && a.nextDueAt && Date.now() < a.nextDueAt) return { ok: false, message: '还没到下一轮' }
      if (autoRunning) return { ok: false, message: '上一轮还在跑' }
      autoRunning = true
      try {
        const words = String(s.autoKeywords || '').split(/[,，\s]+/).filter(Boolean)
        const list = words.length ? words : AUTO_WORDS
        const kw = list[a.notes % list.length]
        let items = []
        try {
          items = (await bridge.search(kw, 1)) || []
        } catch (e) {
          noteRisk(e)
          autoPause('搜索失败：' + e.message)
          return { ok: false, message: '搜索失败：' + e.message }
        }
        const seen = new Set(a.seen)
        const pick = items.filter((x) => x && x.id && !seen.has(x.id)).slice(0, Math.max(1, Number(s.autoPerRun ?? 1) || 1))
        if (!pick.length) {
          saveState({ autoLastRunAt: Date.now() })
          return { ok: true, message: `「${kw}」没刷到新笔记` }
        }
        let notes = a.notes
        let likes = a.likes
        let liked = 0
        let replied = 0
        for (const it of pick) {
          let detail = null
          try {
            detail = await readNote(it.id, readCookie(), it.token, { maxChars: Number(s.maxDescChars ?? 1200) })
          } catch { /* 没正文就只用标题 */ }
          if (s.autoLike !== false && likes < (Number(s.autoDailyLikes ?? 5) || 0)) {
            try { await bridge.like(it.id, 'like'); likes++; liked++ } catch (e) { noteRisk(e); if (/verifytype|风控|429|频繁|验证/.test(e.message)) autoPause('点赞被拦：' + e.message) }
          }
          if (s.autoReply === true && (typeof api.think === 'function' || typeof api.ask === 'function')) {
            try {
              const body = detail ? String(detail.note?.desc || '') : ''
              const brief = `标题：${it.title || ''}\n作者：${it.author || ''}\n${body ? '正文：' + body.slice(0, 400) : '（只拿到标题，没读到正文）'}`
              let gen = ''
              if (typeof api.think === 'function') {
                // 带人格和记忆，用她自己的口气；不想说就回 SKIP
                gen = await api.think(
                  `你刷到一条小红书笔记：\n${brief}\n\n用你平时的口气写一条 15–40 字的评论，别客套、别彩虹屁、不提 AI、不劝关注、不引战。不想说就只回 SKIP。`,
                  { title: '刷小红书', timeoutMs: 90_000 },
                )
              } else {
                gen = await api.ask({
                  system: '你在小红书刷到一条笔记，写一句像真人的短评论：15–40 字，口语，别客套别彩虹屁，不提 AI，不劝关注，不引战。只输出评论本身。',
                  text: brief,
                  maxTokens: 120,
                })
              }
              const text = cleanComment(gen)
              if (text && !/^skip$/i.test(text) && !/^skip[。.!！]?$/i.test(text)) {
                if ((await autoComment({ id: it.id }, text)).ok) {
                  replied++
                  try {
                    api.use('memory')?.addEvent?.({ text: `我在小红书回了一条评论：${text.slice(0, 40)}`, tags: ['小红书'], importance: 0.4 })
                  } catch { /* 记不上不影响 */ }
                }
              }
            } catch (e) { log.warn('自动回复失败：' + e.message) }
          }
          seen.add(it.id)
          notes++
        }
        const gapMs = Math.max(30, Number(s.autoIntervalMin ?? 180) || 180) * 60000
        const nextDueAt = Date.now() + Math.round(gapMs * (0.8 + Math.random() * 0.5))
        saveState({
          autoLastRunAt: Date.now(),
          autoNextDueAt: nextDueAt,
          autoDay: today(),
          autoNotes: notes,
          autoLikes: likes,
          autoRuns: a.runs + 1,
          seenNotes: [...seen].slice(-300),
        })
        try {
          api.use('memory')?.addEvent?.({ text: `刷小红书看到《${pick[0].title || '一篇笔记'}》`, tags: ['小红书'], importance: 0.2 })
        } catch { /* 记不上不影响 */ }
        const bits = [`刷了 ${pick.length} 篇`]
        if (liked) bits.push(`点了 ${liked} 个赞`)
        if (replied) bits.push(`回了 ${replied} 条`)
        log.info('自动刷帖：' + bits.join('，'))
        if (s.autoNotify === true) {
          const to = readState().ownerChatId
          if (to) {
            try { await api.send(to, '小红书刷了一轮：' + bits.join('，')) } catch (e) { log.warn('刷帖汇总没发出去：' + e.message) }
          }
        }
        return { ok: true, message: bits.join('，') }
      } finally {
        autoRunning = false
      }
    }
    api.every(60_000, () => { autoRound().catch(() => {}) }, '小红书自动刷帖')

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
      if (chat.kind === 'private' && chat.chatId && api.isOwner(chat.userId) && readState().ownerChatId !== chat.chatId) {
        saveState({ ownerChatId: chat.chatId })
      }
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
        features: bridgeFeatures || [],
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
        auto: (() => {
          const a = autoSnapshot()
          const gap = Math.max(30, Number(s.autoIntervalMin ?? 180) || 180) * 60000
          return {
            on: s.autoBrowse === true,
            reply: s.autoReply === true,
            like: s.autoLike !== false,
            notes: a.notes,
            cap: Number(s.autoDailyNotes ?? 10) || 10,
            likes: a.likes,
            likeCap: Number(s.autoDailyLikes ?? 5) || 0,
            runs: a.runs,
            runsCap: Number(s.autoRunsPerDay ?? 8) || 8,
            lastRunAt: a.lastRunAt,
            nextRunAt: a.nextDueAt || (a.lastRunAt ? a.lastRunAt + gap : 0),
            paused: a.paused,
            pausedWhy: a.pausedWhy,
          }
        })(),
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

    api.route('/auto/run', async () => autoRound({ force: true }))

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

    // ---------- 发帖：命令触发，先草稿再确认 ----------
    const POST_MAX_IMAGES = 9
    const POST_MAX_BYTES = 10 * 1024 * 1024
    const POST_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

    function postState() {
      const st = readState()
      const day = today()
      return {
        used: st.postDay === day ? Number(st.postCount) || 0 : 0,
        lastAt: Number(st.lastPostAt) || 0,
        draft: st.publishDraft || null,
      }
    }

    function imageUrlsOf(msg) {
      const out = []
      for (const seg of (msg && msg.images) || []) {
        const d = (seg && seg.data) || {}
        const u = String(d.url || d.file || '').trim()
        if (u) out.push(u)
      }
      return out.slice(0, POST_MAX_IMAGES)
    }

    async function downloadPostImage(url, idx) {
      if (/^https?:\/\//i.test(url)) {
        const r = await fetch(url, { headers: { 'user-agent': POST_UA }, signal: AbortSignal.timeout(25000) })
        if (!r.ok) throw new Error('图片下载失败 HTTP ' + r.status)
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length > POST_MAX_BYTES) throw new Error('图片超过 10MB')
        const file = api.dataDir(`post-${Date.now()}-${idx}.jpg`)
        fs.writeFileSync(file, buf)
        return file
      }
      const file = String(url).replace(/^file:\/\//, '')
      if (!fs.existsSync(file)) throw new Error('找不到图片：' + file)
      if (fs.statSync(file).size > POST_MAX_BYTES) throw new Error('图片超过 10MB')
      return file
    }

    function draftSummary(d) {
      const lines = [
        '草稿：',
        `标题：${d.title}`,
        `正文：${d.content.length > 80 ? d.content.slice(0, 80) + '…' : d.content}`,
        `配图：${(d.images || []).length} 张`,
      ]
      if (d.topics && d.topics.length) lines.push('话题：' + d.topics.map((t) => '#' + t).join(' '))
      lines.push('可见范围：' + (d.private !== false ? '仅自己可见' : '公开（撤不回）'))
      lines.push('', '要发就回 /xhs 发，不发就 /xhs 取消。30 分钟内有效。')
      return lines.join('\n')
    }

    async function doPublishDraft(draft) {
      const s = settings()
      if (bridgeFeatures && !bridgeFeatures.includes('publish')) return { ok: false, message: '桥不支持发帖，先更新桥' }
      if (s.allowPublish !== true) return { ok: false, message: '发帖功能关着（设置里「允许发帖」）' }
      const risk = riskMinutesLeft()
      if (risk) return { ok: false, message: `小红书还在风控冷却里，再等 ${risk} 分钟` }
      const q = postState()
      const daily = Number(s.dailyPosts ?? 3) || 3
      if (q.used >= daily) return { ok: false, message: `今天已经发了 ${q.used} 条，够了` }
      const gap = Number(s.postGapMin ?? 10) * 60000
      if (Date.now() - q.lastAt < gap) return { ok: false, message: `刚发过，隔 ${Math.ceil((q.lastAt + gap - Date.now()) / 60000)} 分钟再来` }
      if (!(draft.images || []).length) return { ok: false, message: '图文笔记至少要一张图' }

      const fileIds = []
      for (let i = 0; i < draft.images.length; i++) {
        const p = draft.images[i]
        try {
          const buf = fs.readFileSync(p)
          const r = await bridge.upload({ filename: path.basename(p), mime: 'image/jpeg', dataBase64: buf.toString('base64') })
          fileIds.push(r.file_id)
        } catch (e) {
          return { ok: false, message: `第 ${i + 1} 张图没传上去：${e.message}` }
        }
      }
      const r = await bridge.publish({
        title: draft.title,
        content: draft.content,
        fileIds,
        topics: draft.topics || [],
        private: draft.private !== false,
      })
      if (!r.ok) {
        if (r.verifytype) markRisk(Number(settings().riskCooldownMin ?? 10) || 10, `发帖被拦 verifytype=${r.verifytype}`)
        return { ok: false, message: r.verifytype ? `发帖被风控拦了（verifytype ${r.verifytype}）` : (r.toast || r.message || '发布失败') }
      }
      saveState({ postDay: today(), postCount: q.used + 1, lastPostAt: Date.now(), publishDraft: null })
      try {
        api.use('memory')?.addEvent?.({ text: `我在小红书发了一篇：${draft.title}`, tags: ['小红书'], importance: 0.5 })
      } catch { /* 记不上不影响 */ }
      return { ok: true, message: `发出去了（${r.toast || '成功'}）note_id=${r.note_id || '?'}${r.private ? '，仅自己可见' : ''}` }
    }

    // ---------- 命令 ----------
    api.command({
      name: 'xhs',
      aliases: ['小红书'],
      desc: '看小红书：/xhs 链接｜/xhs 关键词｜/xhs 健康',
      run: async (arg, msg) => {
        const a = String(arg || '').trim()
        if (!a) return '用法：/xhs 链接｜/xhs 关键词｜/xhs 发帖 标题 | 正文（带图）｜/xhs 发｜/xhs 取消'
        if (a === '取消') { saveState({ publishDraft: null }); return '草稿扔了' }
        if (a === '草稿') { const d = postState().draft; return d ? draftSummary(d) : '现在没有草稿' }
        if (a === '发' || a === '发布') {
          const q = postState()
          if (!q.draft) return '没有草稿，先 /xhs 发帖 标题 | 正文（带图）'
          if (Date.now() - (Number(q.draft.at) || 0) > 30 * 60000) { saveState({ publishDraft: null }); return '草稿过期了，重新发一次' }
          const r = await doPublishDraft(q.draft)
          return r.message
        }
        if (a.startsWith('发帖')) {
          if (!msg || !String(msg.chatId || '').startsWith('private:')) return '发帖只在私聊里用'
          if (bridgeFeatures && !bridgeFeatures.includes('publish')) return '现在的桥还不支持发帖（/health 的 features 里没有 publish），先更新桥'
          const rest = a.slice(2).trim()
          const [titlePart, ...bodyParts] = rest.split(/[|｜]/)
          const body = bodyParts.join('|').trim()
          const title = (body ? titlePart : '').trim() || String(body || rest).split('\n')[0].slice(0, 20)
          const content = (body || rest).trim()
          if (!content) return '写点东西：/xhs 发帖 标题 | 正文，图片一起发过来'
          const urls = imageUrlsOf(msg)
          if (!urls.length) return '图文笔记至少要一张图，把图跟命令一起发过来'
          const files = []
          for (let i = 0; i < urls.length; i++) {
            try { files.push(await downloadPostImage(urls[i], i)) } catch (e) { return `第 ${i + 1} 张图有问题：${e.message}` }
          }
          const topics = [...content.matchAll(/#([^\s#]{1,20})/g)].map((m) => m[1]).slice(0, 5)
          const s0 = settings()
          const draft = {
            title: title.slice(0, 20),
            content: content.slice(0, 1000),
            images: files,
            topics,
            private: s0.publishPrivate !== false,
            at: Date.now(),
          }
          saveState({ publishDraft: draft })
          return draftSummary(draft)
        }
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
