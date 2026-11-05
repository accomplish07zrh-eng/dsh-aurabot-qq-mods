// 小红书模块的面板卡：桥状态、账号、额度、开关一览，加几个手动按钮
// 面板会执行这段函数体，最后 return 一个 React 组件；toast / settings 从组件 props 拿
const { useState, useEffect } = React

return function XhsPanel({ settings, toast }) {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const say = (t) => { setNote(t); try { toast?.(t) } catch { /* 老面板没有 toast 就只显示在卡片里 */ } }

  const load = async () => {
    try {
      setSt(await call('/state'))
    } catch (e) {
      say('读不到状态：' + e.message)
    }
  }

  useEffect(() => { load() }, [])

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
  const bridgeText = !st ? '读取中…' : (b && b.ok ? `桥在线 · ${b.nickname || '?'}（${b.redId || '?'}）` : `桥连不上：${(b && b.error) || '?'}`)
  const quotaText = st ? `今天回了 ${st.today || 0} 条${st.daily ? ' / 上限 ' + st.daily : '（不限）'}` : ''
  const cookieText = st ? (st.cookie ? 'cookie 有（面板粘贴）' : 'cookie 没有：面板里粘一份') : ''

  const flag = (on, text) => h('span', { className: 'ab-small', style: { marginRight: 10, opacity: on ? 1 : 0.45 } }, (on ? '✓ ' : '✗ ') + text)

  return h(ui.Card, { title: '小红书' },
    h('div', { className: 'ab-note', style: { marginBottom: 8 } }, bridgeText),
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
