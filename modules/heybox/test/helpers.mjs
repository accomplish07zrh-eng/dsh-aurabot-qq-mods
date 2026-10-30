import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeyboxClient } from '../api.mjs'
import { createHeybox } from '../site.mjs'

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers })
export const ok = (result = {}) => json({ status: 'ok', result })
export const defer = () => {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

export function fixture({ config = {}, fetcher = async () => { throw new Error('禁止联网') }, onebot, hub, initialState, now = new Date(2026, 5, 8, 10).getTime() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'heybox-test-'))
  let time = now
  const cfg = {
    enabled: true, dryRun: false, ownerQQ: '12345678', speakUp: { awakeFrom: 0, awakeTo: 24 },
    heybox: { enabled: true, autoBrowse: true, cookie: 'pkey=old; heybox_id=1', maxRunsPerDay: 6, intervalHours: 4, ...config.heybox },
    ...Object.fromEntries(Object.entries(config).filter(([k]) => k !== 'heybox')),
  }
  const calls = []
  const turns = []
  const sends = []
  const bot = onebot || { call: async (...args) => { sends.push(args); return { message_id: 1 } } }
  const chat = hub || { runSystemTurn: async (...args) => { turns.push(args); return JSON.stringify({ note: '发现一个有趣的帖子', share: '', linkId: '' }) } }
  const stateFile = join(dir, 'state.json')
  if (initialState) writeFileSync(stateFile, JSON.stringify(initialState))
  const hb = createHeybox({
    getConfig: () => cfg,
    setCookie: (value) => { cfg.heybox.cookie = value },
    hub: chat, onebot: bot, stateFile, credFile: join(dir, 'missing.json'), now: () => time,
    clientFactory: (options) => new HeyboxClient({ ...options, random: () => 0.5, delay: async (ms) => { time += ms }, fetchImpl: async (...args) => { calls.push(args); return fetcher(...args) } }),
  })
  return { hb, cfg, calls, turns, sends, stateFile, get time() { return time }, set time(v) { time = v }, close() { hb.dispose(); rmSync(dir, { recursive: true, force: true }) } }
}
