// 小红书模块的面板卡：桥状态、账号、额度、开关一览，加几个手动按钮
// 面板会执行这段函数体，最后 return 一个 React 组件；toast / settings 从组件 props 拿
const { useState, useEffect } = React

return function XhsPanel({ settings, toast }) {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const [showGuide, setShowGuide] = useState(false)
  const say = (t) => { setNote(t); try { toast?.(t) } catch { /* 老面板没有 toast 就只显示在卡片里 */ } }

  const load = async () => {
    try {
      setSt(await call('/state'))
    } catch (e) {
      say('读不到状态：' + e.message)
    }
  }

  useEffect(() => { load() }, [])

  const GUIDE = [
    '帮我在本机搭一座小红书桥，Aurabot 的 xhs 模块用。桥是个本地 HTTP 服务，负责签名后转调小红书接口。',
    '',
    '接口（默认 127.0.0.1:8099，设了 XHS_BRIDGE_TOKEN 就要求 Authorization: Bearer <token>）：',
    'GET  /health                          → {ok, user:{nickname, red_id, guest}}',
    'GET  /search?q=&page=                 → {ok, items:[{id, token, title, author, likes, comments, type}]}',
    'GET  /comments?id=&token=&parent=&cursor= → {ok, comments:[{id, author, ip, likes, sub_count, content}], cursor, has_more}',
    'POST /comment {note_id, content, reply_comment_id?, at_user_id?} → {ok, toast, comment_id, http}（风控时 ok=false 且带 verifytype）',
    'POST /like    {note_id, action}       → {ok, msg}（action 为 like / unlike；内部走 /api/sns/web/v1/note/dislike，参数名 note_oid）',
    'GET  /replies?limit=                  → {ok, count, items:[{note_id, reply_comment_id, user_id, author, content, iso}]}',
    '',
    '做法：克隆 https://github.com/cv-cat/Spider_XHS 做签名，写一个 python3 标准库的 http.server 包一层；',
    'cookie 用浏览器 CDP 的 Network.getAllCookies 导出成 dict，存 ~/xhs-bridge/xhs_cookies.json，每次操作后回写；',
    '起服务：XHS_BRIDGE_HOST=127.0.0.1 XHS_BRIDGE_PORT=8099 XHS_BRIDGE_TOKEN=<随机串> python3 xhs_bridge.py',
    '自检：curl -s -H "Authorization: Bearer <随机串>" http://127.0.0.1:8099/health，guest 必须是 false。',
    '',
    '',
    '7. 常驻与自启（必须做，不做的话机器一重启桥就没了）：',
    '   Linux/NAS：写 systemd 服务 /etc/systemd/system/xhs-bridge.service，Type=simple，Restart=always，RestartSec=3，',
    '     WantedBy=multi-user.target，Environment 里放 XHS_BRIDGE_HOST/PORT/TOKEN，ExecStart 指向 venv 里的 python；',
    '     然后 sudo systemctl daemon-reload && sudo systemctl enable --now xhs-bridge',
    '   Docker：compose 里 restart: always，端口只映射到回环 127.0.0.1:8099:8099，cookie 目录挂进去',
    '   Windows：任务计划程序「登录时运行」指向一个 bat（先 set 环境变量，再 pythonw xhs_bridge.py），',
    '     或者 nssm install XhsBridge <python.exe> xhs_bridge.py 之后 nssm set XhsBridge Start SERVICE_AUTO_START',
    '   配完重启一次机器，再 curl /health 确认自己起来了。',
    '',
    '做完把端口和 token 告诉我，我填进 Aurabot 模块；8099 不通就查进程和防火墙。',
  ].join('\n')

  const copyGuide = async () => {
    try {
      await navigator.clipboard.writeText(GUIDE)
      say('部署说明已复制，粘给你自己的 DSH 就行')
    } catch {
      setShowGuide(true)
      say('浏览器不让自动复制，手动全选下面的文字')
    }
  }

  const act = async (path, label) => {
    setBusy(path)
    try {
      const r = await call(path, {})
      say(r.message || (r.ok ? label + '好了' : label + '没成功'))
      await load()
    } catch (e) {
      say(label + '失败：' + e.message)
    } finally {
      setBusy('')
    }
  }

  const b = st && st.bridge ? st.bridge : null
  const bridgeText = !st ? '读取中…' : (b && b.ok ? `桥在线 · ${b.nickname || '?'}（${b.redId || '?'}）` : `桥没起：现在只能读笔记；搜索/评论/点赞要额外装桥（见 README）`)
  const modeText = !st ? '' : (st.fullMode ? '完整模式：搜索 / 评论 / 点赞已开' : '基础模式：只能读笔记；要搜索评论就装桥并打开完整功能')
  const quotaText = st ? `今天回了 ${st.today || 0} 条${st.daily ? ' / 上限 ' + st.daily : '（不限）'}` : ''
  const cookieText = st ? (st.cookie ? 'cookie 有（面板粘贴）' : 'cookie 没有：面板里粘一份') : ''

  const flag = (on, text) => h('span', { className: 'ab-small', style: { marginRight: 10, opacity: on ? 1 : 0.45 } }, (on ? '✓ ' : '✗ ') + text)

  return h(ui.Card, { title: '小红书' },
    h('div', { className: 'ab-note', style: { marginBottom: 4 } }, bridgeText),
    modeText ? h('div', { className: 'ab-small ab-muted', style: { marginBottom: 8 } }, modeText) : null,
    h('div', { style: { marginBottom: 6 } },
      h('span', { className: 'ab-muted ab-small' }, quotaText + '　·　' + cookieText)),
    st && st.flags
      ? h('div', { style: { marginBottom: 8 } },
        flag(st.flags.enableSearch, '搜索'),
        flag(st.flags.enableRead, '读笔记'),
        flag(st.flags.enableComments, '读评论'),
        flag(st.flags.allowComment, '回帖'),
        flag(st.flags.groupRead, '群里可用'),
        flag(st.flags.sendImages, '发配图')
      )
      : null,
    h(ui.Row, null,
      h(ui.Btn, { onClick: load }, '刷新'),
      h(ui.Btn, { onClick: () => act('/bridge/test', '测试连接') }, busy === '/bridge/test' ? '测试中…' : '测试连接'),
      h(ui.Btn, { onClick: copyGuide }, '复制部署说明'),
      h(ui.Btn, { onClick: () => act('/cookie/check', '检查 cookie') }, busy === '/cookie/check' ? '检查中…' : '检查 cookie'),
      h(ui.Btn, { onClick: () => act('/quota/reset', '清零额度') }, busy === '/quota/reset' ? '清零中…' : '清零今日额度'),
      st && st.riskMinutes
        ? h(ui.Btn, { onClick: () => act('/risk/clear', '解除冷却') }, busy === '/risk/clear' ? '解除中…' : `解除风控冷却（还剩 ${st.riskMinutes} 分钟）`)
        : null
    ),
    st && st.riskWhy
      ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, '上次风控：' + st.riskWhy)
      : null,
    showGuide
      ? h('textarea', {
        readOnly: true,
        value: GUIDE,
        onFocus: (e) => { try { e.target.select() } catch { /* ignore */ } },
        style: { width: '100%', height: 180, marginTop: 8, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5 },
      })
      : null,
    note
      ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, note)
      : null
  )
}
