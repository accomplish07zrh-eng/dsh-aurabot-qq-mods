// panel.js —— 看直播的面板（自定义排版）：设置按「大类」分卡片，送礼单独一大类。
// 字段值走 draftSettings / setSettings，所以底部「保存设置」照常可用（dirty 也照常亮）。
// 面板的执行方式：插件把这份文件的内容当函数体、用 Function 构造器跑一遍 → return 一个组件。
const { useState, useEffect } = React

return function KanzhiboPanel({ settings, draftSettings, setSettings, toast }) {
  const base = settings || {}
  const draft = draftSettings || {}
  const v = (k) => (draft[k] !== undefined ? draft[k] : base[k])
  const set = (k, val) => { if (setSettings) setSettings({ [k]: val }) }

  const sw = (k) => h(ui.Switch, { on: !!v(k), onChange: (x) => set(k, x) })
  const text = (k, props) => h('input', { className: 'ab-input', ...(props || {}), value: v(k) == null ? '' : v(k), onChange: (e) => set(k, e.target.value) })
  const num = (k, props) => h('input', { className: 'ab-input sm', type: 'number', ...(props || {}), value: v(k) == null ? '' : v(k), onChange: (e) => set(k, e.target.value === '' ? '' : Number(e.target.value)) })
  const area = (k, props) => h('textarea', { className: 'ab-input', rows: 3, ...(props || {}), value: v(k) == null ? '' : v(k), onChange: (e) => set(k, e.target.value) })
  const unit = (t) => h('span', { className: 'ab-muted ab-small' }, t)

  const [sc, setSc] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [waiting, setWaiting] = useState(null)

  const load = async () => {
    setBusy(true)
    try {
      const r = await call('/selfcheck')
      if (r && r.ok) { setSc(r); setErr('') } else setErr((r && r.message) || '读不到自检')
      const p = await call('/pending').catch(() => null)
      setWaiting(p && p.pending ? p.pending : null)
    } catch (e) {
      setErr(String((e && e.message) || e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => { load() }, [])

  const row = (label, value, tone) => h(ui.Row, { key: label, label },
    h('span', { className: tone ? 'ab-small' : 'ab-small ab-muted', style: tone ? { color: tone } : null }, value))

  const lastNote = sc && sc.text ? (String(sc.text).split('\n').filter((x) => x.indexOf('最近一条') === 0)[0] || '') : ''

  return h('div', { className: 'ab-grid' },

    // ① 挂直播（大类）
    h(ui.Card, { title: '挂直播', desc: '要不要挂、什么时候挂、挂谁的直播间。' },
      h(ui.Row, { label: '挂直播', hint: '开着才按下面的时段自己进房；进房期间刷抖音自动暂停' }, sw('enabled')),
      h(ui.Row, { label: '只在时段内挂', hint: '关掉＝全天挂着；开着只在下面那段时间进房' }, sw('schedule')),
      h(ui.Row, { label: '时段', hint: '24 小时制，可以跨午夜（22:30 → 01:00）' },
        text('startTime', { placeholder: '21:07', style: { maxWidth: 110 } }), unit('→'), text('endTime', { placeholder: '23:00', style: { maxWidth: 110 } })),
      h(ui.Row, { label: '直播间或主页', hint: '直播间链接最稳；给主播主页（douyin.com/user/…）会自己找「直播中」' },
        text('target', { placeholder: 'https://live.douyin.com/123456789' })),
      h(ui.Row, { label: '多久看一次', hint: '不在直播间就重新进；改完立刻生效' }, num('checkSec', { min: 30, max: 1800, step: 30 }), unit('秒')),
      h(ui.Row, { label: '进房时通知我', hint: '进房后私聊说一声' }, sw('minuteReport'))
    ),

    // ② 进房评论
    h(ui.Card, { title: '进房评论', desc: '进房后发一条固定的评论；默认关，每天最多一次。' },
      h(ui.Row, { label: '进房发评论', hint: '打开后每天最多一次，同一个直播间不重复' }, sw('liveCommentOn')),
      h(ui.Row, { label: '评论内容', hint: '多行只发第一行；留空就不发' }, area('liveComment', { placeholder: 'h的大肥鱼进场了' })),
      h(ui.Row, { label: '等几秒再发', hint: '等画面和评论框出来' }, num('commentDelaySec', { min: 0, max: 120, step: 1 }), unit('秒'))
    ),

    // ③ 灯牌
    h(ui.Card, { title: '粉丝团灯牌', desc: '续粉丝团灯牌：会真的去点页面左上角那一块。' },
      h(ui.Row, { label: '续粉丝团灯牌', hint: '⚠ 可能点偏；点完回读「今日任务」，读不到就不算送过' }, sw('renewBadge')),
      h(ui.Row, { label: '等几秒再续', hint: '越早越容易点偏，宁晚不早' }, num('badgeDelaySec', { min: 5, max: 600, step: 5 }), unit('秒'))
    ),

    // ④ 送礼（一大类）
    h(ui.Card, {
      title: '送礼',
      desc: '花抖币、没有撤回；只认你的私聊，群里永远不送。这个版式甚至可能「点一下就直接送」，所以下面的确认尤其重要。',
    },
      h(ui.Row, { label: '允许私信送礼', hint: '关着时她手上根本没有送礼工具；打开后也只认主人的私聊' }, sw('giftByDm')),
      h(ui.Row, { label: '动作前先问我', hint: '开＝半自动：把要按的位置截图发你，回 /看直播 确认 才点；关＝自动（照样过命中校验）' }, sw('semiAuto')),
      h(ui.Row, { label: '等你多少秒', hint: '到点没收到「确认」就自动撤销，不点' }, num('confirmSec', { min: 10, max: 600, step: 5 }), unit('秒')),
      h('div', { className: 'ab-note', style: { marginTop: 6 } },
        '现在的打法：' + (v('semiAuto') ? '半自动。' : '自动。'),
        v('semiAuto')
          ? '动手前截图给你（红框就是那一下），确认后还会重新校验一次；点完回读抖币余额 / 飘屏告诉你成没成。'
          : '不打扰你，直接按；每一步都要过候选唯一 + 区域带 + 9 点命中，过不了就放弃并记日志。')
    ),

    // ⑤ 风险与现场
    h(ui.Card, { title: '风险与现场：这两件事没有撤销', desc: '都是拿你的号在真实直播间里做，不是模拟。' },
      h('div', { className: 'ab-note warn', style: { marginBottom: 8 } },
        h('b', null, '续灯牌有误触风险。'),
        ' 它点的是屏幕左上角那一块。页面没加载完、抖音改版、窗口被拉小时都可能点偏；现在要先过「候选唯一 + 区域带 + 9 点命中」，' +
        '点完回读「今日任务」，读不到就不算送过 —— 而且当天不再自动重试，免得重复花钱。'),
      h('div', { className: 'ab-note warn' },
        h('b', null, '送礼花的是抖币，送出去退不回来。'),
        ' 一个一送；出现「充值 / 抖币不足 / 去充值」立刻停手。锁在单独的开关后面，只认你的 QQ 私聊 —— 群里谁让你送，她都不会送。')
    ),

    h(ui.Card, {
      title: '现在是什么状态',
      desc: '只读，用来核对它到底在不在干活。',
      right: h(ui.Btn, { small: true, onClick: load, disabled: busy }, busy ? '读…' : '刷新'),
    },
      err ? h('div', { className: 'ab-note err' }, '读不到自检：' + err) : null,
      sc ? [
        row('浏览器', sc.connected ? '连上了（CDP 端口 ' + sc.port + '）' : '没连 —— 还没进房，或者已经收工', sc.connected ? 'var(--ab-ok)' : null),
        row('当前页', sc.url || '不在直播间'),
        row('挂直播', (sc.enabled ? '开' : '关') + '｜目标：' + (sc.target || '还没填')),
        row('时段', sc.schedule ? (sc.inWindow ? '在时段内' : '不在时段内，现在不会进房') : '不限时段', sc.schedule && !sc.inWindow ? 'var(--ab-warn)' : null),
        row('刷抖音', sc.pausedDouyin ? '暂停中（看直播期间会自动关掉）' : '照常'),
        row('今日评论', sc.commentedDay === sc.today ? '今天发过了，不再发' : '今天还没发'),
        row('今日灯牌', sc.badgeDay === sc.today ? '今天送过了' : '今天还没送'),
        row('私信送礼', v('giftByDm') ? '开 —— 只在你的私聊里、你说送什么才送' : '关 —— 她手上压根没有送礼这个工具', v('giftByDm') ? 'var(--ab-ok)' : null),
        row('打法', v('semiAuto') ? '半自动 —— 动手前截图发你，等你回 /看直播 确认' : '自动 —— 直接点（仍然先过命中校验）', v('semiAuto') ? 'var(--ab-ok)' : null),
        row('待确认', waiting ? waiting.label + '（' + Math.round((waiting.leftMs || 0) / 1000) + ' 秒后作废）' : '没有在等你点头的事', waiting ? 'var(--ab-warn)' : null),
      ] : h(ui.Empty, { icon: '⏳', text: '正在读自检…' }),
      lastNote ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 8 } }, lastNote) : null
    )
  )
}
