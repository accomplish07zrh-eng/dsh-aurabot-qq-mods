// 离线测试：不联网、不碰账号。node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { pickLink, parseIds, buildUrl, parseState, pickNote } from '../lib/read.mjs'

test('pickLink：从一段话里抠链接', () => {
  const s = '看这个 https://www.xiaohongshu.com/explore/6acca8e9000000001802e91a?xsec_token=ABC&xsec_source=app_share 好看'
  assert.equal(pickLink(s), 'https://www.xiaohongshu.com/explore/6acca8e9000000001802e91a?xsec_token=ABC&xsec_source=app_share')
})

test('pickLink：去掉中文标点尾巴', () => {
  assert.equal(pickLink('链接在这https://xhslink.com/a/abc，'), 'https://xhslink.com/a/abc')
})

test('pickLink：纯 24 位 id 也能认', () => {
  assert.equal(pickLink('6acca8e9000000001802e91a'), 'https://www.xiaohongshu.com/explore/6acca8e9000000001802e91a')
})

test('pickLink：不是链接就返回 null', () => {
  assert.equal(pickLink('今天天气不错'), null)
  assert.equal(pickLink(''), null)
})

test('parseIds：抠 id 和 xsec_token', () => {
  const r = parseIds('https://www.xiaohongshu.com/explore/6acca8e9000000001802e91a?xsec_token=AB%2BC%3D&xsec_source=pc_search')
  assert.equal(r.id, '6acca8e9000000001802e91a')
  assert.equal(r.token, 'AB+C=')
})

test('parseIds：没有 token 时为空串', () => {
  const r = parseIds('https://www.xiaohongshu.com/explore/6acca8e9000000001802e91a')
  assert.equal(r.id, '6acca8e9000000001802e91a')
  assert.equal(r.token, '')
})

test('buildUrl：带 token 时拼 pc_search', () => {
  assert.equal(
    buildUrl('abc123', 'TOK+/='),
    'https://www.xiaohongshu.com/explore/abc123?xsec_token=TOK%2B%2F%3D&xsec_source=pc_search',
  )
})

test('parseState：洗掉 new Map(...) 之后还能 parse', () => {
  const html = '<script>window.__INITIAL_STATE__={"a":{"b":new Map([])},"note":{"noteDetailMap":{"x":{"note":{"title":"标题","desc":"正文"}}}}}</script>'
  const st = parseState(html)
  assert.equal(st.note.noteDetailMap.x.note.title, '标题')
})

test('parseState：没有状态对象就抛错', () => {
  assert.throws(() => parseState('<html></html>'), /没有状态数据/)
})

test('pickNote：从 noteDetailMap 取第一条', () => {
  const st = { note: { noteDetailMap: { k: { note: { title: 'T' } } } } }
  assert.equal(pickNote(st).note.title, 'T')
})

test('pickNote：退回到 feed 里的 noteCard', () => {
  const st = { feed: { undertakeNote: { items: [{ noteCard: { title: 'C' } }] } } }
  assert.equal(pickNote(st).note.title, 'C')
})

test('pickNote：都没有就返回 null', () => {
  assert.equal(pickNote({}), null)
})
