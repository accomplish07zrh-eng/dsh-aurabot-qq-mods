// 生成 modules/README.md：按分类列出全部模块。node scripts/catalog.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CATEGORIES, MODULES_DIR, listModules, readManifest } from './lib.mjs'

const FILE = join(MODULES_DIR, 'README.md')
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

export function renderCatalog(mods = listModules().map((m) => readManifest(m.dir))) {
  const out = ['# 模块目录', '', '这个文件由 `npm run catalog` 生成，不要手改。', '', '每个模块一个文件夹：`modules/<id>/`。格式见 [模块规范](../docs/MODULE_SPEC.md)，第一次提交看 [提交教程](../docs/TUTORIAL.md)。', '']
  for (const [key, label] of Object.entries(CATEGORIES)) {
    const list = mods.filter((m) => m.category === key).sort((a, b) => a.id.localeCompare(b.id))
    if (!list.length) continue
    out.push(`## ${label}`, '', '| 模块 | 版本 | 作者 | 说明 |', '|---|---|---|---|')
    for (const m of list) out.push(`| [${cell(m.name)}](${m.id}/) | ${m.version} | ${cell(m.author)} | ${cell(m.description)} |`)
    out.push('')
  }
  return out.join('\n')
}

export function catalogFresh() {
  try { return readFileSync(FILE, 'utf8') === renderCatalog() } catch (error) { return false }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(FILE, renderCatalog())
  console.log('写好了 modules/README.md')
}
