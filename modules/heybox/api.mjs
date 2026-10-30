// 小黑盒 web 接口的签名与请求底座。
//
// 签名（hkey）来自前端 Tr 函数的等价实现：
//   · ALPHABET 字符集映射
//   · MD5 尾部 6 字节全部参与校验和（前 4 个位混合 + 后 2 个原样，6 个一起求和 %100）
//   · 写接口额外要 _rnd：HMAC-SHA256，盐值来自前端源码
//
// 图片上传走腾讯云 COS 直传四步（info → token → PUT → callback），签名是标准 COS XML API。

import crypto from 'node:crypto'

export const API_BASE = 'https://api.xiaoheihe.cn'
export const WEB_BASE = 'https://www.xiaoheihe.cn'

const ALPHABET = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89'
const HMAC_SALT = 'Z7mFG4tQp9Ws2LxB8H'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// web 端通用参数（与真实请求一致）
export const BASE_PARAMS = {
  os_type: 'web',
  app: 'heybox',
  client_type: 'web',
  version: '999.0.4',
  web_version: '3.0',
  x_client_type: 'web',
  x_app: 'heybox_website',
  x_os_type: 'Windows',
  device_info: 'Chrome',
  device_id: '2c2fef8385ccef915e3b3caf94e3aa06',
}

// 真实存在的分区（网上抄来的 58144 之类并不存在，会一直报「错误的帖子类型」）
export const TOPICS = {
  7214: '盒友杂谈',
  18745: '数码硬件',
  806933: 'AI',
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex')

// GF(2^8) 风格的双倍运算，与前端 w3 等价
const dbl = (v) => ((v << 1) ^ (v & 128 ? 27 : 0)) & 255
const thr = (v) => dbl(v) ^ v
const nin = (v) => thr(dbl(v))
const elv = (v) => nin(thr(dbl(v)))
const tht = (v) => elv(v) ^ nin(v) ^ thr(v)

const mix4 = (a, b, c, d) => [
  tht(a) ^ elv(b) ^ nin(c) ^ thr(d),
  thr(a) ^ tht(b) ^ elv(c) ^ nin(d),
  nin(a) ^ thr(b) ^ tht(c) ^ elv(d),
  elv(a) ^ nin(b) ^ thr(c) ^ tht(d),
]

const mapChars = (value, alphabet) => {
  let out = ''
  for (const ch of String(value)) out += alphabet[ch.charCodeAt(0) % alphabet.length]
  return out
}

/** 按路径 + 时间戳 + nonce 算 hkey（7 字符：5 位前缀 + 2 位校验和） */
export function hkey(path, timestamp, nonce) {
  const norm = '/' + String(path).split('/').filter(Boolean).join('/') + '/'
  const comps = [
    mapChars(timestamp, ALPHABET.slice(0, -2)),
    mapChars(norm, ALPHABET),
    mapChars(nonce, ALPHABET),
  ]
  const max = Math.max(...comps.map((c) => c.length))
  let interleaved = ''
  for (let k = 0; k < max; k += 1) {
    for (const c of comps) if (k < c.length) interleaved += c[k]
  }
  const digest = md5(interleaved.slice(0, 20))
  const tail = [...digest.slice(-6)].map((c) => c.charCodeAt(0))
  const mixed = [...mix4(tail[0], tail[1], tail[2], tail[3]), tail[4], tail[5]]
  const checksum = String(mixed.reduce((a, b) => a + b, 0) % 100).padStart(2, '0')
  return mapChars(digest.slice(0, 5), ALPHABET.slice(0, -4)) + checksum
}

/** 生成 nonce：32 位大写 hex */
export function makeNonce(timestamp = Math.floor(Date.now() / 1000)) {
  return md5(`${timestamp}${Date.now()}${Math.random()}`).toUpperCase()
}

/** 写接口附加签名 _rnd */
export function rndSignature(nonce, time) {
  const message = `${HMAC_SALT}${nonce}${time}:${nonce}`
  return '15:' + crypto.createHmac('sha256', HMAC_SALT).update(message).digest('hex')
}

/** 一次性生成 hkey / _time / nonce（可选 _rnd） */
export function signParams(path, { workshop = false, timestamp, nonce } = {}) {
  const t = timestamp ?? Math.floor(Date.now() / 1000)
  const n = nonce ?? makeNonce(t)
  const out = { hkey: hkey(path, t, n), _time: t, nonce: n }
  if (workshop) out._rnd = rndSignature(n, t)
  return out
}

/** 腾讯云 COS 直传签名（标准 COS XML API，临时密钥） */
export function cosSign({ secretId, secretKey, path, host, contentLength, keyTime }) {
  const hmac1 = (key, msg) => crypto.createHmac('sha1', key).update(msg).digest('hex')
  const signKey = hmac1(secretKey, keyTime)
  const httpString = `put\n${path}\n\ncontent-length=${contentLength}&host=${host}\n`
  const stringToSign = `sha1\n${keyTime}\n${sha1(httpString)}\n`
  const signature = hmac1(signKey, stringToSign)
  return 'q-sign-algorithm=sha1'
    + `&q-ak=${encodeURIComponent(secretId)}`
    + `&q-sign-time=${keyTime}&q-key-time=${keyTime}`
    + '&q-header-list=content-length;host&q-url-param-list='
    + `&q-signature=${signature}`
}

/** 统一的失败语义：登录态 / 验证码 / 限流都要能分辨，上层才能给出对的提示 */
export class HeyboxError extends Error {
  constructor(message, code = 'api', extra = {}) {
    super(message)
    this.name = 'HeyboxError'
    this.code = code
    this.extra = extra
  }
}

const AUTH_STATUS = new Set(['relogin', 'not_login', 'need_login', 'login_required', 'need_google_check'])
const CAPTCHA_STATUS = new Set(['show_captcha', 'need_captcha'])

/**
 * 小黑盒 HTTP 客户端。串行限速 + 熔断，写请求永不自动重试。
 * @param {object} opts
 * @param {string} opts.cookie 整串 Cookie（pkey + x_xhh_tokenid）
 * @param {number} [opts.interval] 请求最小间隔（毫秒）
 * @param {number} [opts.timeout] 单请求超时（毫秒）
 */
export class HeyboxClient {
  constructor({ cookie = '', interval = 900, timeout = 25000 } = {}) {
    this.cookie = cookie
    this.interval = interval
    this.timeout = timeout
    this.lastAt = 0
    this.calls = 0
  }

  get loggedIn() {
    return /pkey=|user_pkey=/.test(this.cookie)
  }

  /** 从 Cookie 里取 heybox_id（网页端每个请求都会带上它，缺了会被当成未登录） */
  get heyboxId() {
    const m = String(this.cookie || '').match(/heybox_id=(\d+)/)
    return m ? m[1] : ''
  }

  async #throttle() {
    const wait = this.interval - (Date.now() - this.lastAt)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }

  /**
   * 发一个请求，返回解析好的 data（status=ok 才有值）。
   * @param {object} req
   * @param {string} req.path
   * @param {object} [req.params] 业务参数
   * @param {string} [req.method] GET（默认）/ POST
   * @param {object} [req.body] POST 表单
   * @param {boolean} [req.workshop] 写接口附加 _rnd
   * @param {boolean} [req.captureCookies] 需要读 Set-Cookie
   */
  async request({ path, params = {}, method = 'GET', body, workshop = false, signed = true, captureCookies = false } = {}) {
    if (!path || !path.startsWith('/')) throw new HeyboxError('path 必须以 / 开头', 'input')
    if (method !== 'GET' && !this.loggedIn) throw new HeyboxError('写操作需要登录：先在面板里填 Cookie', 'auth')

    await this.#throttle()
    this.lastAt = Date.now()
    this.calls += 1

    const query = { ...BASE_PARAMS }
    // 网页端每个请求都带 heybox_id，缺了会被当成未登录
    if (this.heyboxId) query.heybox_id = this.heyboxId
    Object.assign(query, params)
    if (signed) Object.assign(query, signParams(path, { workshop }))

    const url = new URL(API_BASE + path)
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue
      url.searchParams.set(k, String(v))
    }

    const headers = { 'user-agent': UA, accept: 'application/json, text/plain, */*', referer: WEB_BASE + '/', origin: WEB_BASE }
    if (this.cookie) headers.cookie = this.cookie

    let payload
    if (body !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
      const form = new URLSearchParams()
      for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) form.set(k, String(v))
      payload = form.toString()
    }

    let res
    try {
      res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(this.timeout) })
    } catch (err) {
      throw new HeyboxError(`网络请求失败：${err?.message ?? err}`, 'network')
    }

    if (res.status === 401 || res.status === 403) throw new HeyboxError('小黑盒返回 401/403：登录态可能失效', 'auth')
    if (res.status === 429) throw new HeyboxError('小黑盒限流（429）：已停止', 'rate_limit')

    let data
    try {
      data = await res.json()
    } catch {
      throw new HeyboxError(`响应不是 JSON（HTTP ${res.status}）`, 'protocol')
    }

    const setCookies = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    const wrap = (v) => (captureCookies ? { data: v, setCookies } : v)

    if (!res.ok) throw new HeyboxError(`HTTP ${res.status}：${data?.msg ?? data?.message ?? '未知错误'}`, 'http', { status: res.status })

    const status = data?.status
    if (status === 'ok') return wrap(data)
    if (AUTH_STATUS.has(status)) throw new HeyboxError(`登录态失效（${status}）：请重新登录`, 'auth')
    if (CAPTCHA_STATUS.has(status)) throw new HeyboxError(`小黑盒要求验证码（${status}）：请到网页完成验证后重试`, 'captcha')
    throw new HeyboxError(`小黑盒拒绝（${status ?? 'no-status'}）：${data?.msg ?? ''}`.trim(), 'api', { payload: data })
  }

  get(path, params) { return this.request({ path, params }) }
  post(path, body, params) { return this.request({ path, params, method: 'POST', body, workshop: true }) }

  /** PUT 到 COS（不走小黑盒签名） */
  async putCOS(url, buf, { contentType, authorization, sessionToken }) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': contentType, authorization, 'x-cos-security-token': sessionToken, 'user-agent': UA },
      body: buf,
      signal: AbortSignal.timeout(60000),
    })
    if (res.status !== 200 && res.status !== 204) throw new HeyboxError(`COS 直传失败 HTTP ${res.status}`, 'network')
    return true
  }
}
