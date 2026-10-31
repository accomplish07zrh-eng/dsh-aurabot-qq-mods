// dsh-persona：人格文本渲染与设置清洗的纯函数测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitPersonaSections, dshPersonaText, normalizeStyle } from '../modules/dsh-persona/index.mjs'

test('splitPersonaSections：开场与【标题】节分开', () => {
  const { lead, secs } = splitPersonaSections('你是小鱼。\n\n【怎么说话】\n- 短句。\n\n【背景】\n- 长介绍。')
  assert.equal(lead, '你是小鱼。')
  assert.deepEqual(secs.map((s) => s.title), ['怎么说话', '背景'])
  assert.equal(secs[0].text, '- 短句。')
})

test('dshPersonaText：full 注入全文并带思考指令', () => {
  const out = dshPersonaText('你是小鱼。', { thinkingStyle: 'role', replyStyle: 'full' })
  assert.match(out, /你是小鱼。/)
  assert.match(out, /角色沉浸要求/)
})

test('dshPersonaText：lite 只留开场和「怎么说话」类节，其余丢弃', () => {
  const body = '你是分节小鱼。\n\n【背景设定】\n- 很长的背景介绍。\n\n【怎么说话】\n- 短句。\n\n【记忆规则】\n- 不注入。'
  const out = dshPersonaText(body, { thinkingStyle: 'neutral', replyStyle: 'lite' })
  assert.match(out, /分节小鱼/)
  assert.match(out, /【怎么说话】/)
  assert.doesNotMatch(out, /背景设定/)
  assert.doesNotMatch(out, /记忆规则/)
  assert.match(out, /思维模式要求/)
})

test('dshPersonaText：没有【标题】分节的人设 lite 退回全文', () => {
  const out = dshPersonaText('你是没有分节的小人。', { thinkingStyle: 'neutral', replyStyle: 'lite' })
  assert.ok(out.startsWith('你是没有分节的小人。'))
  assert.ok(out.includes('思维模式要求'))
})

test('dshPersonaText：空文本返回空串；未知思考风格跳过指令', () => {
  assert.equal(dshPersonaText('', {}), '')
  assert.equal(dshPersonaText('你是小鱼。', { thinkingStyle: 'x' }), '你是小鱼。')
})

test('normalizeStyle：默认全关、认不出的值回落', () => {
  assert.deepEqual(normalizeStyle(), { enabled: false, personaId: '', thinkingStyle: 'neutral', replyStyle: 'full' })
  assert.deepEqual(
    normalizeStyle({ enabled: true, personaId: 'p1', thinkingStyle: 'role', replyStyle: 'lite' }),
    { enabled: true, personaId: 'p1', thinkingStyle: 'role', replyStyle: 'lite' },
  )
  assert.deepEqual(
    normalizeStyle({ enabled: 'yes', personaId: 3, thinkingStyle: 'x', replyStyle: 'y' }),
    { enabled: false, personaId: '', thinkingStyle: 'neutral', replyStyle: 'full' },
  )
})
