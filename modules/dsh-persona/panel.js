// panel.js —— DSH 人设与风格 面板（独立标签页）
// 注意：本文件被面板当作「函数体」执行，React / h / ui / call 是**外层闭包变量**，
// 不是组件 props——组件签名里只接 settings / save / toast，ui 和 call 直接用闭包里的。

return function Panel({ settings, save, toast }) {
  const { useState, useEffect } = React
  const { Card, Btn, Switch, Row, Select, Seg } = ui

  const [saved, setSaved] = useState(null)   // 已生效的设置（来自 /state）
  const [draft, setDraft] = useState(null)   // 未确认的草稿；null = 与已生效一致
  const [personas, setPersonas] = useState([])
  const [current, setCurrent] = useState('')

  const load = () => call('/state').then((r) => {
    if (!r || r.ok === false) throw new Error(r && r.message ? r.message : '读取失败')
    setSaved(r.style); setPersonas(r.personas || []); setCurrent(r.current || ''); setDraft(null)
  }).catch((e) => toast('读不到设置：' + e.message, 'err'))
  useEffect(() => { load() }, [])

  const style = draft || saved || { enabled: false, personaId: '', thinkingStyle: 'neutral', replyStyle: 'full' }
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved)
  const setField = (patch) => setDraft({ ...style, ...patch })
  const confirm = async () => {
    try { await save(draft); await load() } catch (e) { toast('没设置成功：' + e.message, 'err') }
  }

  return h(Card, { title: 'DSH 人设与风格', icon: '🧩',
      desc: '把一张人格连同思考/回复风格注入 DSH 的所有会话，不改变大肥鱼 QQ 聊天用的人格。默认未启用、不注入任何内容；关掉开关即撤销注入，下一轮对话起恢复默认人格。改动要点「确认生效」才应用。' },
    saved ? [
      h(Row, { label: '启用注入', hint: '默认关：不向 DSH 注入任何内容。关掉即撤销已注入的内容。' },
        h(Switch, { on: style.enabled === true, onChange: (v) => setField({ enabled: v }) })),
      h(Row, { label: '注入 DSH 的人格', hint: '默认跟随当前正在用的人格' },
        h(Select, { value: style.personaId || '', width: 240, placeholder: '跟随当前人格',
          options: [{ value: '', label: '跟随当前人格' }].concat(personas.map((p) => ({ value: p.id, label: p.name, desc: p.id === current ? '正在用' : '' }))),
          onChange: (v) => setField({ personaId: v }) })),
      h(Row, { label: '思考风格', hint: '中立=思考保持分析、只在回复里扮演（推荐）；角色化=思考也进角色（沉浸但可能影响干活）' },
        h(Seg, { value: style.thinkingStyle, options: [{ value: 'neutral', label: '中立思考' }, { value: 'role', label: '角色化思考' }], onChange: (v) => setField({ thinkingStyle: v }) })),
      h(Row, { label: '回复风格', hint: '完整=整张人格注入；精简=只注入开场和「怎么说话」类短节（人设按【标题】分节才生效）' },
        h(Seg, { value: style.replyStyle, options: [{ value: 'full', label: '完整人设' }, { value: 'lite', label: '精简人设' }], onChange: (v) => setField({ replyStyle: v }) })),
      h('div', { className: 'ab-flex', style: { marginTop: 10 } },
        dirty ? h('span', { className: 'ab-muted ab-small' }, '改了还没确认，点「确认生效」才会应用') : null,
        h('div', { style: { flex: 1 } }),
        dirty ? h(Btn, { small: true, onClick: () => setDraft(null) }, '撤销') : null,
        h(Btn, { small: true, onClick: confirm }, dirty ? '确认生效' : '已生效')),
    ] : h('p', { className: 'ab-muted ab-small' }, '加载中…'))
}
