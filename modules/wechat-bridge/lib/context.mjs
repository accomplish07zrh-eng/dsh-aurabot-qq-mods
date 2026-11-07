const HOUR = 3600_000
const dayKey = (date) => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0'),
].join('-')

export function ownerChat(qq) {
  return { kind: 'private', chatId: 'private:' + qq, userId: qq }
}

export function recentOwnerChat(api, binding, { wechatOnly = false } = {}) {
  const memory = api.config().memory
  if (!memory?.enabled || memory.shortTerm === false || !api.use('memory')) return []
  const now = Date.now()
  const hours = Number(memory.shortTermHours ?? 2)
  const since = now - (hours > 0 && Number.isFinite(hours) ? Math.min(hours, 24) : 2) * HOUR
  const days = [...new Set([dayKey(new Date(since)), dayKey(new Date(now))])]
  const chatId = ownerChat(binding.qq).chatId
  const byPlatform = { qq: [], wechat: [] }
  for (const day of days) {
    for (const row of api.core.hub.chatLogOf(day)) {
      if (!row || row.chatId !== chatId || !Number.isFinite(row.t) || row.t < since || row.t > now ||
        row.forgottenAt || row.kind === 'seen' || (row.via && row.via !== binding.via)) continue
      const bot = row.who === 'bot' && !row.uid
      if (!bot && String(row.uid) !== binding.qq) continue
      const text = String(row.text || '').replace(/\s+/g, ' ').trim()
      if (!text || text.startsWith('【系统') || /微信绑定 \d{8}/.test(text)) continue
      const platform = row.via ? 'wechat' : 'qq'
      if (wechatOnly && platform !== 'wechat') continue
      byPlatform[platform].push({
        t: row.t, who: bot ? '你' : '主人', platform: platform === 'wechat' ? '微信' : 'QQ',
        text: [...text].slice(0, 120).join('').replace(/[（(]/g, '〔').replace(/[）)]/g, '〕'),
      })
    }
  }
  const last = (rows) => rows.sort((a, b) => a.t - b.t).slice(-6)
  return [...last(byPlatform.qq), ...last(byPlatform.wechat)].sort((a, b) => a.t - b.t)
}

export function qqPrompt(api, binding, content, info) {
  if (!binding || !Array.isArray(content) || info?.chat?.kind !== 'private' ||
    info.chat.chatId !== ownerChat(binding.qq).chatId || String(info.chat.userId) !== binding.qq ||
    String(info.senderId) !== binding.qq ||
    (info.extraSenders || []).some((sender) => String(sender) !== binding.qq) ||
    /^(?:请|麻烦|你)?\s*(?:忘掉|忘记|别记|不要记)/.test(String(info.queryText || '').trim())) return content
  const rows = recentOwnerChat(api, binding, { wechatOnly: true })
  if (!rows.length) return content
  const text = rows.map((row) => row.who + '：' + row.text).join('\n')
  // Keep the host's memory-block marker so its outbound cleaner recognizes this context.
  return [{
    type: 'text',
    text: '（你最近在别的聊天里说过的话。以下是你与同一位主人在微信的私聊记录。把这些记录当作对话背景，按当前 QQ 消息回复：\n' + text + '\n）',
  }, ...content]
}
