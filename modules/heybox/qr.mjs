// 扫码登录只由面板主动发起；与普通请求共用客户端的限速和风控状态。
import { encodeQrPng } from './qrpng.mjs'

export function mergeSetCookies(cookies, setCookies) {
  const out = { ...cookies }
  for (const raw of setCookies || []) {
    const first = String(raw).split(';', 1)[0]
    const i = first.indexOf('=')
    if (i > 0) out[first.slice(0, i).trim()] = first.slice(i + 1).trim()
  }
  return out
}

export const cookieHeader = (cookies) => Object.entries(cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ')
const keepCookies = (cookies) => Object.fromEntries(Object.entries(cookies).filter(([k]) => /^(pkey|user_pkey|x_xhh_tokenid|heybox_id|user_heybox_id|_user_token)$/.test(k)))

export async function startQrLogin(client) {
  const { data, setCookies } = await client.request({ path: '/account/get_qrcode_url', params: { app: 'web' }, cookie: '', captureCookies: true })
  const qrUrl = data?.result?.qr_url
  if (!qrUrl) throw new Error('接口没有返回二维码地址')
  let token
  try { token = new URL(qrUrl).searchParams.get('qr') } catch { /* 地址格式不对 */ }
  if (!token) throw new Error('二维码地址里没有 qr token')
  return { qrUrl, token, expire: Number(data.result.expire) || 120, png: encodeQrPng(qrUrl), cookies: mergeSetCookies({}, setCookies) }
}

// 有效账号必须明确返回账号 ID；空结果不能当作验证通过。
export async function verifyCookie(client, cookie, riskToken) {
  const data = await client.request({ path: '/account/restore_login', cookie, allowCooldownRisk: riskToken })
  const r = data.result || {}
  const profile = r.profile || r.account_detail || {}
  const heyboxId = String(profile.heybox_id ?? profile.userid ?? r.heybox_id ?? r.account_detail?.userid ?? '').trim()
  return { verified: Boolean(heyboxId), heyboxId, nickname: String(profile.username ?? profile.nickname ?? '') }
}

export async function pollQrLogin(client, token, sessionCookies) {
  const { data, setCookies } = await client.request({ path: '/account/qr_state', params: { app: 'web', qr: token }, cookie: cookieHeader(sessionCookies), captureCookies: true })
  const cookies = mergeSetCookies(sessionCookies, setCookies)
  const result = data.result || {}
  const state = String(result.error || 'unknown')
  if (state !== 'ok') return { state, cookies }
  if (result.pkey) cookies.pkey = String(result.pkey)
  if (result.user_pkey) cookies.user_pkey = String(result.user_pkey)
  const id = String(result.profile?.heybox_id ?? result.account_detail?.userid ?? result.heybox_id ?? '')
  if (id) { cookies.heybox_id = id; cookies.user_heybox_id = id }
  const kept = keepCookies(cookies)
  const cookie = cookieHeader(kept)
  if (!kept.pkey && !kept.user_pkey) return { state, cookies, hasPkey: false, verified: false }
  try {
    const check = await verifyCookie(client, cookie)
    return { state, cookies, cookie, hasPkey: true, ...check }
  } catch (error) {
    return { state, cookies, hasPkey: true, verified: false, verifyError: error.message }
  }
}
