// 小红书模块的面板卡：桥状态、账号、额度、开关一览，加几个手动按钮
// 面板会执行这段函数体，最后 return 一个 React 组件；toast / settings 从组件 props 拿
const { useState, useEffect } = React

return function XhsPanel({ settings, draftSettings, setSettings, toast }) {
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
    '帮我在本机装一座小红书桥（Aurabot 的 xhs 模块要用）。桥是本地 HTTP 服务，负责签名后转调小红书接口。',
    '按下面 7 步做，第 7 步是开机自启，别漏。',
    '',
    '1. 拉桥：git clone https://github.com/yuccc7878/xhs-bridge.git ~/xhs-bridge',
    '   桥是 MIT；它依赖的 Spider_XHS 上游没许可证，不在仓库里，第 4 步自己 clone',
    '2. 装 Python 依赖（Python >= 3.10）：cd ~/xhs-bridge && pip install -r requirements.txt',
    '3. 装 Node 依赖（Node >= 20）：cd ~/xhs-bridge && npm i crypto-js',
    '   x-rap 签名是 PyExecJS 调 Node 算的，cwd 必须是桥目录，不然报 Cannot find module crypto-js',
    '4. clone 签名库：git clone https://github.com/cv-cat/Spider_XHS ~/xhs-bridge/spider_xhs',
    '   确认这两个模板都在：',
    '     ~/xhs-bridge/spider_xhs/xhs_utils/xhs_creator/js/rap_fingerprint_creator.json   # 436B，发帖用',
    '     ~/xhs-bridge/spider_xhs/xhs_utils/xhs_pc/js/rap_fingerprint_template.json       # 219B',
    '   漏了 436B 那个，发帖会报 -9059 参数错误（看着像参数写错，其实是模板没找到）',
    '5. 起服务：cd ~/xhs-bridge && XHS_BRIDGE_HOST=127.0.0.1 XHS_BRIDGE_PORT=8099 python3 xhs_bridge.py',
    '6. 自检：curl -s http://127.0.0.1:8099/health —— guest 要是 false，features 里要有',
    '   search / comments / comment / like / replies / upload / publish',
    '   这一步过了就不用改模块设置：默认连 127.0.0.1:8099、不带密钥',
    '7. 常驻与自启（必须做，不做的话机器一重启桥就没了）：',
    '   Linux/NAS：/etc/systemd/system/xhs-bridge.service，Type=simple，Restart=always，RestartSec=3，WantedBy=multi-user.target，',
    '     Environment 放 XHS_BRIDGE_HOST/PORT（要跨容器再放 TOKEN），ExecStart 指向 venv 里的 python；',
    '     然后 sudo systemctl daemon-reload && sudo systemctl enable --now xhs-bridge',
    '   Docker：compose 里 restart: always，端口只映射回环 127.0.0.1:8099:8099，cookie 和 spider_xhs 目录挂进去',
    '   Windows：任务计划程序「登录时运行」指向一个 bat（先 set 环境变量，再 pythonw xhs_bridge.py），',
    '     或者 nssm install XhsBridge <python.exe> xhs_bridge.py，然后 nssm set XhsBridge Start SERVICE_AUTO_START',
    '   配完重启一次机器，再 curl /health 确认它自己起来了。',
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
  const bridgeText = !st ? '读取中…' : (b && b.ok ? `桥在线 · ${b.nickname || '?'}（${b.redId || '?'}）` : `桥没起（${(st && st.bridgeUrl) || 'http://127.0.0.1:8099'}）：现在只能读笔记；要完整功能就按下面的说明搭桥`)
  const nextAt = st && st.auto && st.auto.nextRunAt ? new Date(st.auto.nextRunAt) : null
  const nextText = nextAt ? nextAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''
  const autoText = !st || !st.auto ? '' : (!st.auto.on
    ? '自动刷帖：关（设置里能开）'
    : st.auto.paused
      ? `自动刷帖：今天停了（${st.auto.pausedWhy || '风控'}）`
      : `自动刷帖：开 · 今天 ${st.auto.notes}/${st.auto.cap} 篇 · ${st.auto.runs}/${st.auto.runsCap} 轮${nextText ? ' · 下次约 ' + nextText : ''}${st.auto.reply ? ' · 会自动回评论' : ''}`)
  const modeText = !st ? '' : (st.fullMode ? '完整模式：搜索 / 评论 / 点赞已开' : '基础模式：只能读笔记；要搜索评论就装桥并打开完整功能')
  const quotaText = st ? `今天回了 ${st.today || 0} 条${st.daily ? ' / 上限 ' + st.daily : '（不限）'}` : ''
  const cookieText = st ? (st.cookie ? 'cookie 有（面板粘贴）' : 'cookie 没有：面板里粘一份') : ''

  const cur = { ...(settings || {}), ...(draftSettings || {}) }
  const full = cur.fullMode === true
  const patch = (key, value) => {
    try { setSettings?.({ [key]: value }) } catch { /* 老插件没有这个属性 */ }
    say('已改，记得点下面的「保存设置」')
  }
  const sw = (key, label, hint, forceOff) => h(ui.Row, { label, hint },
    h(ui.Switch, { on: cur[key] !== false, disabled: forceOff, onChange: (v) => patch(key, v) }))

  const flag = (on, text) => h('span', { className: 'ab-small', style: { marginRight: 10, opacity: on ? 1 : 0.45 } }, (on ? '✓ ' : '✗ ') + text)

  return h(ui.Card, { title: '小红书' },
    h('div', { className: 'ab-note', style: { marginBottom: 4 } }, bridgeText),
    h(ui.Row, { label: '完整功能（搜索 / 评论 / 点赞 / 发帖）', hint: '总开关。打开并保存后，下面「完整功能」那一区的开关才生效；桥不通时这些工具仍然不会出现' },
      h(ui.Switch, { on: full, onChange: (v) => patch('fullMode', v) })),

    // —— 基础功能：不要桥 ——
    h('div', { className: 'ab-small ab-muted', style: { margin: '12px 0 2px' } }, '基础功能（不要桥）'),
    sw('enableRead', '允许读笔记', '关掉后链接也打不开'),
    sw('groupRead', '群里也能看', '默认关：只有主人私聊能看；群友让她看会消耗额度'),
    sw('sendImages', '顺便发配图', '读笔记时把配图一起发过来；关掉只发文字'),
    sw('sendImagesInGroup', '群里也发配图', '默认关，避免在群里刷图'),

    // —— 完整功能：都要桥 ——
    h('div', { className: 'ab-small ab-muted', style: { margin: '12px 0 2px' } }, '完整功能（需要桥）'),
    h(ui.Row, { label: '搭桥说明', hint: '点「复制部署说明」，粘给你自己的 DSH / 别的 AI；它会装桥、配开机自启' },
      h(ui.Btn, { onClick: copyGuide }, '复制部署说明')),
    showGuide
      ? h('textarea', {
        readOnly: true,
        value: GUIDE,
        onFocus: (e) => { try { e.target.select() } catch { /* ignore */ } },
        style: { width: '100%', height: 180, margin: '4px 0 8px', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5 },
      })
      : null,
    h('div', { className: 'ab-small ab-muted', style: { margin: '2px 0 8px' } }, full ? '下面的开关需要桥在线才会生效' : '现在是基础模式：只能读笔记；要用下面的功能，先打开完整功能并装桥'),
    sw('enableSearch', '允许搜索', '关掉后她不会去搜，只能读别人发来的链接', !full),
    sw('enableComments', '允许读评论', '关掉后不挂读评论工具', !full),
    sw('allowComment', '允许回帖（评论别人的笔记）', '只有主人私聊能触发，受间隔和每日上限约束。评论发出去也撤不回，只能自己上小红书删', !full),
    sw('autoBrowse', '自动刷帖', '按间隔自己搜、自己看；受下面设置里的篇数/轮次/时段限制', !full),
    sw('autoLike', '刷到就点赞（等于收藏）', '小红书点赞=收藏，会挂在你主页上；默认关，想清楚再开', !full),
    sw('autoReply', '自动回评论', '刷到合适的会留一句评论，受每日回帖上限和冷却约束', !full),
    sw('autoNotify', '刷完告诉主人', '每轮结束给主人私聊发一条汇总', !full),
    sw('allowPublish', '允许发帖（发布新笔记）', '在自己主页发新的图文笔记，不是评论；只认私聊 /xhs 发帖。发出去撤不回，只能你登录创作者后台手动删', !full),
    sw('publishPrivate', '发成仅自己可见', '默认开。公开的出去就只能你手动去创作者后台删，先用这个试', !full),
    modeText ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 8 } }, modeText) : null,
    autoText ? h('div', { className: 'ab-small ab-muted', style: { marginBottom: 8 } }, autoText) : null,
    h('div', { style: { marginBottom: 6 } },
      h('span', { className: 'ab-muted ab-small' }, quotaText + '　·　' + cookieText)),
    st && st.flags
      ? h('div', { style: { marginBottom: 8 } },
        flag(st.flags.enableRead, '读笔记'),
        flag(st.flags.groupRead, '群里可用'),
        flag(st.flags.sendImages, '发配图')
      )
      : null,
    h(ui.Row, null,
      h(ui.Btn, { onClick: load }, '刷新'),
      h(ui.Btn, { onClick: () => act('/bridge/test', '测试连接') }, busy === '/bridge/test' ? '测试中…' : '测试连接'),
      st && st.fullMode ? h(ui.Btn, { onClick: () => act('/auto/run', '刷一轮') }, busy === '/auto/run' ? '刷着…' : '立即刷一次') : null,
      h(ui.Btn, { onClick: () => act('/cookie/check', '检查 cookie') }, busy === '/cookie/check' ? '检查中…' : '检查 cookie'),
      h(ui.Btn, { onClick: () => act('/quota/reset', '清零额度') }, busy === '/quota/reset' ? '清零中…' : '清零今日额度'),
      st && st.riskMinutes
        ? h(ui.Btn, { onClick: () => act('/risk/clear', '解除冷却') }, busy === '/risk/clear' ? '解除中…' : `解除风控冷却（还剩 ${st.riskMinutes} 分钟）`)
        : null
    ),
    st && st.riskWhy
      ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, '上次风控：' + st.riskWhy)
      : null,
    note
      ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, note)
      : null
  )
}
