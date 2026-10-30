// 打包模块到输出目录，并写 release.json。
// node scripts/pack.mjs --out dist [--only a,b] [--missing]    --missing：只打还没发布过的版本

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ROOT, listModules, packModule, readManifest, tagOf } from './lib.mjs'

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : '' }
const out = resolve(ROOT, arg('--out') || 'dist')
const only = new Set(arg('--only').split(',').filter(Boolean))
const tags = new Set(process.argv.includes('--missing') ? execFileSync('git', ['tag', '-l'], { cwd: ROOT, encoding: 'utf8' }).split('\n') : [])

const built = []
for (const mod of listModules()) {
  if (only.size && !only.has(mod.id)) continue
  if (tags.has(tagOf(mod.id, readManifest(mod.dir).version))) continue
  const entry = packModule(mod, out)
  built.push(entry)
  console.log(`✓ ${entry.file}（${entry.size} 字节，sha256 ${entry.sha256}）`)
}
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'release.json'), JSON.stringify(built, null, 2) + '\n')
console.log(`打包了 ${built.length} 个模块`)
