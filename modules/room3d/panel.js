return function Panel() {
  return h(ui.Card, { title: '房间' },
    h('div', { className: 'ab-note', style: { marginBottom: '10px' } },
      '拖动旋转、滚轮缩放，点她自己会回应。页面和 3D 资产随模块分发，房间状态存在模块数据目录里。'
    ),
    h('iframe', {
      src: '/aurabot/api/ext/room3d/page',
      style: { width: '100%', height: '80vh', border: '0', borderRadius: '10px', background: '#05070f' },
      title: '房间',
    })
  )
}
