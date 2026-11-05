// lib/find.mjs —— 页面里跑的「找元素 / 命中校验 / 高亮」脚本，加上几个纯函数。
// 2026-11-06：抖音现在会把粉丝团面板塞进「同源 iframe + 影子树」，所以查找要同时穿 iframe 和 shadow root，
// 坐标统一换成「主页面坐标」；点击仍然用主坐标（浏览器会把事件路由进 iframe/影子树）。

/** 可搜索的根：主文档 + 同源 iframe + 影子树（都带主轴偏移）。 */
const ROOTS_SRC = `
  var roots = []
  var addRoot = function (root, ox, oy, depth) {
    if (!root) return
    var doc = root.ownerDocument || root
    roots.push({ root: root, doc: doc, ox: ox, oy: oy })
    if (depth <= 0) return
    var els
    try { els = root.querySelectorAll('*') } catch (e) { return }
    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      if (el.shadowRoot) addRoot(el.shadowRoot, ox, oy, depth - 1)
    }
    var frames
    try { frames = root.querySelectorAll('iframe') } catch (e) { return }
    for (var f = 0; f < frames.length; f++) {
      var cd = null
      try { cd = frames[f].contentDocument } catch (e) { cd = null }
      if (!cd) continue
      var fr
      try { fr = frames[f].getBoundingClientRect() } catch (e) { continue }
      if (fr.width < 40 || fr.height < 40) continue
      addRoot(cd, ox + fr.left, oy + fr.top, depth - 1)
    }
  }
  addRoot(document, 0, 0, 3)
`;

export const FIND_SRC = `(function (spec) {
  var norm = function (s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim() }
  var hit
  try { hit = new RegExp(spec.text, spec.flags || 'u') } catch (e) { return { error: '正则写错：' + String(e), total: 0, list: [] } }
  ${ROOTS_SRC}
  var vw = innerWidth, vh = innerHeight
  var R = spec.region || { top: 0, left: 0, right: 1, bottom: 1 }
  var x1 = R.left * vw, y1 = R.top * vh, x2 = R.right * vw, y2 = R.bottom * vh
  var maxTextLen = spec.maxTextLen || 24
  var maxW = spec.maxWidth || vw * 0.5
  var maxH = spec.maxHeight || vh * 0.3
  var minW = spec.minWidth || 10, minH = spec.minHeight || 10
  var up = spec.up == null ? 4 : spec.up

  var styleOf = function (el) {
    try { return (el.ownerDocument.defaultView || window).getComputedStyle(el) } catch (e) { return null }
  }
  var visible = function (el) {
    if (!el.getClientRects || !el.getClientRects().length) return false
    var cs = styleOf(el)
    if (!cs) return false
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false
    var r = el.getBoundingClientRect()
    return r.width > 2 && r.height > 2
  }
  var clicks = function (el) {
    if (!el || el.nodeType !== 1) return false
    var tag = el.tagName
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT') return true
    var role = el.getAttribute('role')
    if (role === 'button' || role === 'link' || role === 'menuitem' || role === 'tab') return true
    if (el.hasAttribute('tabindex') && el.tabIndex >= 0) return true
    if (el.onclick) return true
    var cs = styleOf(el)
    if (cs && cs.cursor === 'pointer') return true
    return false
  }
  var plainText = function (el) { return norm(el.textContent || '') }
  var ancHit = null
  try { if (spec.ancestorText) ancHit = new RegExp(spec.ancestorText, spec.flags || 'u') } catch (e) { ancHit = null }
  // parentElement 在影子树顶端会断掉，要跳到宿主继续往上找
  var parentOf = function (el) {
    var p = el.parentElement
    if (p) return p
    try {
      var root = el.getRootNode && el.getRootNode()
      if (root && root.host) return root.host
    } catch (e) {}
    return null
  }
  // 祖先里得有一段「像那块面板」的文字：挡住「同一个词出现在别处」的误选（比如观众列表里的点亮）
  var ancestorMatches = function (el) {
    if (!ancHit) return true
    var cur = parentOf(el)
    for (var i = 0; i < 6 && cur; i++) {
      var txt = plainText(cur)
      if (txt.length > 0 && txt.length <= 600 && ancHit.test(txt)) return true
      cur = parentOf(cur)
    }
    return false
  }
  var ancestorClickable = function (el) {
    var cur = el
    for (var i = 0; i <= up && cur; i++) {
      if (clicks(cur) && visible(cur)) return cur
      cur = parentOf(cur)
    }
    return null
  }
  var sigOf = function (el) {
    var cls = ''
    try { cls = Array.prototype.slice.call(el.classList, 0, 3).join('.') } catch (e) {}
    var anc = ''
    var p = parentOf(el)
    for (var i = 0; i < 3 && p; i++) {
      anc += '>' + p.tagName.toLowerCase() + (p.getAttribute('data-e2e') ? '[' + p.getAttribute('data-e2e') + ']' : '')
      p = parentOf(p)
    }
    return (el.tagName.toLowerCase() + (cls ? '.' + cls : '') + anc + '|' + plainText(el).slice(0, 24)).slice(0, 160)
  }

  var marks = document.querySelectorAll('[data-ab-pick]')
  for (var k = 0; k < marks.length; k++) marks[k].removeAttribute('data-ab-pick')

  var pairs = []
  for (var ri = 0; ri < roots.length; ri++) {
    var root = roots[ri]
    var all
    try { all = root.root.querySelectorAll('*') } catch (e) { continue }
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      var t = plainText(el)
      if (!t || t.length > maxTextLen) continue
      if (!hit.test(t)) continue
      if (!visible(el)) continue
      var target = spec.raw ? el : (ancestorClickable(el) || el)
      if (!target) continue
      if (!ancestorMatches(target)) continue
      var dup = false
      for (var j = 0; j < pairs.length; j++) if (pairs[j].target === target) { dup = true; break }
      if (dup) continue
      var r = target.getBoundingClientRect()
      var rect = { left: r.left + root.ox, top: r.top + root.oy, width: r.width, height: r.height, right: r.right + root.ox, bottom: r.bottom + root.oy }
      if (rect.width < minW || rect.height < minH || rect.width > maxW || rect.height > maxH) continue
      if (rect.left < x1 - 2 || rect.top < y1 - 2 || rect.right > x2 + 2 || rect.bottom > y2 + 2) continue
      pairs.push({ target: target, text: plainText(el).slice(0, 30), rect: rect, sig: sigOf(target), clickable: clicks(target), depth: root.ox !== 0 || root.oy !== 0 ? 'frame' : 'doc' })
    }
  }
  pairs.sort(function (a, b) { return a.rect.width * a.rect.height - b.rect.width * b.rect.height })
  pairs = pairs.slice(0, 20)
  var list = []
  for (var n = 0; n < pairs.length; n++) {
    var p = pairs[n]
    try { p.target.setAttribute('data-ab-pick', String(n)) } catch (e) {}
    list.push({
      text: p.text,
      sig: p.sig,
      tag: p.target.tagName.toLowerCase(),
      clickable: p.clickable,
      where: p.depth,
      area: Math.round(p.rect.width * p.rect.height),
      rect: {
        left: Math.round(p.rect.left), top: Math.round(p.rect.top),
        right: Math.round(p.rect.right), bottom: Math.round(p.rect.bottom),
        width: Math.round(p.rect.width), height: Math.round(p.rect.height),
      },
    })
  }
  return { vw: vw, vh: vh, dpr: devicePixelRatio, roots: roots.length, total: list.length, list: list }
})`;

/** 命中校验：在元素所在的根里做 9 点采样（影子树里 elementFromPoint 返回宿主，用 shadowRoot.contains 判）。 */
export const HIT_SRC = `(function (pick) {
  ${ROOTS_SRC}
  var pickEl = null
  var pickRoot = null
  for (var i = 0; i < roots.length && !pickEl; i++) {
    var found = null
    try { found = roots[i].root.querySelector('[data-ab-pick="' + Number(pick) + '"]') } catch (e) { found = null }
    if (found) { pickEl = found; pickRoot = roots[i] }
  }
  if (!pickEl) return { ok: false, reason: '目标不见了（页面刷新或被关掉）', points: [] }
  var r = pickEl.getBoundingClientRect()
  if (!r || r.width < 4 || r.height < 4) return { ok: false, reason: '目标尺寸异常', points: [] }
  var doc = pickEl.ownerDocument
  var inside = function (node) {
    if (!node) return false
    if (node === pickEl || pickEl.contains(node)) return true
    try { if (node.shadowRoot && node.shadowRoot.contains(pickEl)) return true } catch (e) {}
    return false
  }
  var inset = Math.max(3, Math.min(6, Math.round(r.width / 6)))
  var xs = [r.left + inset, r.left + r.width / 2, r.right - inset]
  var ys = [r.top + inset, r.top + r.height / 2, r.bottom - inset]
  var points = []
  for (var yi = 0; yi < ys.length; yi++) {
    for (var xi = 0; xi < xs.length; xi++) {
      var lx = Math.round(xs[xi]), ly = Math.round(ys[yi])
      var node = null
      try { node = doc.elementFromPoint(lx, ly) } catch (e) { node = null }
      points.push({
        x: Math.round(lx + pickRoot.ox), y: Math.round(ly + pickRoot.oy),
        ok: inside(node),
        hit: node ? (((node.textContent || '').trim().slice(0, 18)) || node.tagName) : '（空）',
      })
    }
  }
  var good = 0
  for (var g = 0; g < points.length; g++) if (points[g].ok) good++
  return {
    ok: good >= 5,
    good: good,
    rect: { left: Math.round(r.left + pickRoot.ox), top: Math.round(r.top + pickRoot.oy), width: Math.round(r.width), height: Math.round(r.height) },
    points: points,
  }
})`;

/** 在页面上把候选框出来（截图给人看的时候用），不做任何点击。 */
export const MARK_SRC = `(function (pick) {
  ${ROOTS_SRC}
  for (var i = 0; i < roots.length; i++) {
    var el = null
    try { el = roots[i].root.querySelector('[data-ab-pick="' + Number(pick) + '"]') } catch (e) { el = null }
    if (!el) continue
    var r = el.getBoundingClientRect()
    var old = document.getElementById('ab-mark')
    if (old) old.parentNode.removeChild(old)
    var d = document.createElement('div')
    d.id = 'ab-mark'
    // 用 absolute（页面坐标）而不是 fixed：截图裁剪是按页面坐标来的，fixed 元素会漂/被漏掉。
    var sx = window.scrollX || 0, sy = window.scrollY || 0
    d.style.cssText = 'position:absolute;z-index:2147483647;pointer-events:none;border:3px solid #ff2d55;border-radius:6px;background:rgba(255,45,85,.16);left:' +
      Math.round(r.left + roots[i].ox + sx - 4) + 'px;top:' + Math.round(r.top + roots[i].oy + sy - 4) + 'px;width:' + Math.round(r.width + 8) + 'px;height:' + Math.round(r.height + 8) + 'px'
    document.body.appendChild(d)
    return { left: Math.round(r.left + roots[i].ox), top: Math.round(r.top + roots[i].oy), width: Math.round(r.width), height: Math.round(r.height) }
  }
  return null
})`;

export const UNMARK_SRC = `(function () {
  var d = document.getElementById('ab-mark')
  if (d) d.parentNode.removeChild(d)
  var marks = document.querySelectorAll('[data-ab-pick]')
  for (var i = 0; i < marks.length; i++) marks[i].removeAttribute('data-ab-pick')
  return true
})`;

/** 页面滚了多少（截图裁剪要用页面坐标，不是视口坐标）。 */
export const SCROLL_SRC = `(function () { return { x: Math.round(scrollX || 0), y: Math.round(scrollY || 0) } })`;

/** 把外面的 spec 补成页面里能用的形状（region 用 0~1 的比例，别写死像素）。 */
export function normalizeSpec(spec) {
  const s = spec || {}
  const region = s.region || { top: 0, left: 0, right: 1, bottom: 1 }
  return {
    text: String(s.text || ''),
    flags: s.flags || 'u',
    region: {
      top: Number(region.top) || 0,
      left: Number(region.left) || 0,
      right: region.right == null ? 1 : Number(region.right),
      bottom: region.bottom == null ? 1 : Number(region.bottom),
    },
    maxTextLen: s.maxTextLen || 24,
    ancestorText: s.ancestorText ? String(s.ancestorText) : '',
    maxWidth: s.maxWidth || 0,
    maxHeight: s.maxHeight || 0,
    minWidth: s.minWidth || 10,
    minHeight: s.minHeight || 10,
    up: s.up == null ? 4 : Number(s.up),
    raw: Boolean(s.raw),
    unique: s.unique !== false,
  }
}

/**
 * 从 9 个采样点里挑一个可点的点：中心优先，其次离中心最近的好点。
 * 好点不足 5 个（或没有）就返回 null —— 交给上层「不点」。
 */
export function choosePoint(points) {
  const list = Array.isArray(points) ? points : []
  const good = list.filter((p) => p && p.ok)
  if (good.length < 5) return null
  const center = list[4]
  if (center && center.ok) return { x: center.x, y: center.y }
  const cx = center ? center.x : good[0].x
  const cy = center ? center.y : good[0].y
  let best = null
  let bestD = Infinity
  for (const p of good) {
    const d = (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy)
    if (d < bestD) { bestD = d; best = p }
  }
  return best ? { x: best.x, y: best.y } : null
}

/** 同一个文字、矩形几乎重合的候选（内层 span 和外层按钮）算一个：留最里面那个。 */
export function collapseNested(list) {
  const arr = [...(Array.isArray(list) ? list : [])].sort((a, b) => (a.area || 0) - (b.area || 0))
  const out = []
  const overlap = (a, b) => {
    const r = a.rect || {}
    const q = b.rect || {}
    const wr = r.right == null ? r.left + r.width : r.right
    const hr = r.bottom == null ? r.top + r.height : r.bottom
    const wq = q.right == null ? q.left + q.width : q.right
    const hq = q.bottom == null ? q.top + q.height : q.bottom
    const iw = Math.max(0, Math.min(wr, wq) - Math.max(r.left, q.left))
    const ih = Math.max(0, Math.min(hr, hq) - Math.max(r.top, q.top))
    const small = Math.min(Math.max(1, (r.width || 0) * (r.height || 0)), Math.max(1, (q.width || 0) * (q.height || 0)))
    return (iw * ih) / small
  }
  for (const c of arr) {
    const dup = out.some((k) => String(k.text || '') === String(c.text || '') && overlap(k, c) >= 0.8)
    if (!dup) out.push(c)
  }
  return out
}

/** 候选唯一性：只允许一个候选；多个就是「分不清」，宁可不动。 */
export function pickUnique(list) {
  const arr = Array.isArray(list) ? list : []
  if (arr.length === 0) return { ok: false, reason: '没有候选' }
  if (arr.length > 1) return { ok: false, reason: '候选不唯一（' + arr.length + ' 个）', list: arr }
  return { ok: true, cand: arr[0] }
}

/** 元素签名比对：确认这一下点的还是刚才准备的那个东西。 */
export function sameSig(a, b) {
  return String(a || '') === String(b || '') && String(a || '') !== ''
}

/** 把命中校验结果写成一句人话，进日志和私聊。 */
export function describeHit(hit) {
  if (!hit) return '没做命中校验'
  if (hit.ok) return '命中校验过了（' + hit.good + '/9 个采样点落在目标上）'
  const covered = (hit.points || []).filter((p) => !p.ok).slice(0, 2).map((p) => p.hit).join('、')
  return '命中校验没过（只有 ' + (hit.good || 0) + '/9 点命中' + (covered ? '，挡在上面的是：' + covered : '') + '）'
}
