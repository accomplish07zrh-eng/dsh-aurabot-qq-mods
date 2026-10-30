// 跑模块测试时提供插件环境：node --import ./scripts/plugin-env.mjs --test ...
// AURABOT_PLUGIN_DIR 指向插件源码（dsh-aurabot-qq 的工作副本），测试里的 __lib 从那里取内部文件。

import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = process.env.AURABOT_PLUGIN_DIR
if (!dir) throw new Error('要设 AURABOT_PLUGIN_DIR：指向 dsh-aurabot-qq 的工作副本')
const src = join(resolve(dir), 'src') + '/'
const { lib, loadLib } = await import(pathToFileURL(join(src, 'core/modules.js')).href)
await loadLib()
globalThis.aurabot = { lib, src: pathToFileURL(src).href }
