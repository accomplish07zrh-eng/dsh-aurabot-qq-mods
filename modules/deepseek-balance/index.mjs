/** @type {import('../aurabot').AurabotModule} */

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
const TIMEOUT_MS = 8000
const CACHE_MS = 30_000

// 同一份余额在 30 秒内不重复请求，避免群里连着刷触发词
let cache = { at: 0, text: '' }
// 记住上一次的开关状态：从关到开时清掉缓存，避免刚打开就看到旧数字
let wasEnabled = false

// 触发词可以写多个，用逗号或空格分开
function triggerList(settings) {
  return String(settings.trigger || '余额')
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// 接口返回的是字符串金额，统一显示成两位小数
function money(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(2) : '0.00'
}

function formatBalance(data) {
  const infos = Array.isArray(data && data.balance_infos) ? data.balance_infos : []
  const parts = []
  for (const info of infos) {
    if (!info) continue
    const symbol = info.currency === 'USD' ? '$' : '¥'
    parts.push(`${symbol}${money(info.total_balance)}`)
    const granted = Number(info.granted_balance)
    const topped = Number(info.topped_up_balance)
    if ((granted > 0) || (topped > 0)) {
      parts.push(`（赠送 ${money(info.granted_balance)} / 充值 ${money(info.topped_up_balance)}）`)
    }
  }
  if (!parts.length) return '查到了，但账户里没有余额信息。'
  const head = data && data.is_available === false ? '余额不足，API 调用会被拒绝：' : 'DeepSeek 余额：'
  return head + parts.join(' ')
}

function requestBalance(base, key) {
  return fetch(`${base}/user/balance`, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
}

async function queryBalance(api) {
  const s = api.settings()
  const key = String(s.apiKey || '').trim()
  if (!key) {
    return { ok: false, message: '还没配置 DeepSeek API Key：面板「已安装」页找到本模块，填好 Key 再保存。' }
  }

  const base = String(s.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_BASE_URL

  let res
  try {
    res = await requestBalance(base, key)
    // 官方余额接口在根路径，不在 /v1 下；填了 /v1 又撞到 404 时自动退回根路径再试一次
    if ((res.status === 404 || res.status === 405) && /\/v1$/i.test(base)) {
      res = await requestBalance(base.replace(/\/v1$/i, ''), key)
    }
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { ok: false, message: `查询超时（${TIMEOUT_MS / 1000} 秒），等会儿再试？` }
    }
    return { ok: false, message: `连不上 ${base}：${(err && err.message) || err}` }
  }

  const raw = await res.text().catch(() => '')
  let data = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    data = null
  }

  if (res.status === 401) return { ok: false, message: 'API Key 无效或已过期，去 platform.deepseek.com 重新生成一个。' }
  if (res.status === 403) return { ok: false, message: '这个 Key 没有查询余额的权限（403）。' }
  if (!res.ok) {
    const detail = (data && data.error && data.error.message) || (raw ? raw.slice(0, 120) : '')
    return { ok: false, message: `查询失败（HTTP ${res.status}）${detail ? '：' + detail : ''}` }
  }
  if (!data) return { ok: false, message: '接口返回的内容不是 JSON，可能被网关改写了。' }

  return { ok: true, message: formatBalance(data) }
}

export default {
  id: 'deepseek-balance',
  name: 'DeepSeek 余额',
  version: '1.1.1',
  api: 1,
  description: '让ta知道你的DeepSeek账户还有多少钱',
  defaults: {
    enabled: false,
    trigger: '余额',
    apiKey: '',
    allowOthers: false,
    baseUrl: DEFAULT_BASE_URL,
  },
  settings: [
    { key: 'enabled', label: '模块开关', type: 'switch', hint: '默认关闭。打开后才会响应触发词；关掉后完全不响应，也不发任何请求' },
    { key: 'trigger', label: '触发词', type: 'text', hint: '可以写多个，用逗号或空格分开', placeholder: '余额' },
    { key: 'apiKey', label: 'DeepSeek API Key', type: 'password', hint: '在 platform.deepseek.com 的「API keys」页创建，以 sk- 开头' },
    { key: 'allowOthers', label: '群友也能查', type: 'switch', hint: '关着时只有主人能查，别人发触发词会收到一句提示' },
    { key: 'baseUrl', label: '接口地址', type: 'text', hint: '一般不用改；走中转/代理时填你自己的地址', placeholder: DEFAULT_BASE_URL },
  ],

  setup(api) {
    api.on('message', async (msg) => {
      const settings = api.settings()

      // 模块开关：关着时什么都不做，消息照常交给她
      if (settings.enabled === false) {
        wasEnabled = false
        return false
      }
      if (!wasEnabled) {
        cache = { at: 0, text: '' }
        wasEnabled = true
      }

      const text = String(msg.text || '').trim()
      if (!text) return false

      const hit = triggerList(settings).some((word) => word.toLowerCase() === text.toLowerCase())
      if (!hit) return false

      if (!api.isOwner(msg.userId) && !settings.allowOthers) {
        await api.reply(msg, '这个只有主人能查哦～')
        return true
      }

      const now = Date.now()
      if (cache.text && now - cache.at < CACHE_MS) {
        await api.reply(msg, cache.text)
        return true
      }

      const result = await queryBalance(api)
      if (result.ok) {
        cache = { at: now, text: result.message }
      } else {
        api.log.warn('[deepseek-balance] 查询失败：' + result.message)
      }
      await api.reply(msg, result.message)
      return true
    })
  },
}
