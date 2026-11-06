// 纯函数：时间解析、登录态判断、签到返回文案。
// 抽出来是为了能单独测（modules/breeze/test/breeze.test.mjs），这里不碰文件、不发请求。

export const SESSION_KEY = 'breeze_blue_session='
export const DEFAULT_TIME = '08:10'

/** 'HH:MM' → [小时, 分钟]；空的或写坏了就按默认 08:10（不能留 NaN，否则判断全错） */
export const hm = (at) => {
  const [h, m] = String(at || DEFAULT_TIME).split(':').map((x) => Number(x))
  return [Number.isFinite(h) ? h : 8, Number.isFinite(m) ? m : 10]
}

/** 'HH:MM' → 分钟数（'9:00' 和 '08:10' 直接比字符串会错） */
export const toMinutes = (at) => {
  const [h, m] = hm(at)
  return h * 60 + m
}

/** 某个时刻是当天第几分钟 */
export const nowMinutes = (date = new Date()) => date.getHours() * 60 + date.getMinutes()

/** 本地日期 → 'YYYY-MM-DD' */
export const formatDate = (date = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

/** 距下一个 'HH:MM' 还有多少毫秒；已经过了就算明天 */
export const msUntil = (at, from = new Date()) => {
  const [h, m] = hm(at)
  const next = new Date(from)
  next.setHours(h, m, 0, 0)
  if (next <= from) next.setDate(next.getDate() + 1)
  return next - from
}

/** 抓到的 cookie 里有没有登录态（值太短的算没有，免得把空串当成登录了） */
export const looksLoggedIn = (parts) =>
  Array.isArray(parts) &&
  parts.some((p) => typeof p === 'string' && p.startsWith(SESSION_KEY) && p.length > SESSION_KEY.length + 5)

/**
 * 把签到接口的返回翻成一句人话。
 * 返回 { message, msg, balance, claimed }：message 带余额，msg 是那句短的。
 */
export const describeClaim = (data = {}) => {
  const got = data.credits_issued ?? data.credits ?? data.amount
  let msg = '领好了'
  if (data.claimed && got) msg = `领到 ${got} 积分`
  else if (data.already_claimed || data.daily_claim_available === false) msg = '今天已经领过了'
  else if (data.claimed === false && !got) msg = '这次没领到（可能已经领过）'
  else if (data.message) msg = String(data.message).slice(0, 80)
  const balance = typeof data.balance === 'number' ? Math.round(data.balance) : null
  return {
    msg,
    balance,
    claimed: Boolean(data.claimed),
    message: balance == null ? msg : `${msg}（余额 ${balance}）`,
  }
}

/** 今天还能不能再试：返回 'skip' 或 'run'，省得在 tick 里堆一堆 if */
export const checkinAction = ({ on, hasCookie, done, day, tries, at, now, maxTries = 3 }) => {
  if (!on) return 'skip'
  if (done && day && done === day) return 'skip'
  if (!hasCookie) return 'skip'
  if (now < toMinutes(at)) return 'skip'
  if ((tries || 0) >= maxTries) return 'skip'
  return 'run'
}
