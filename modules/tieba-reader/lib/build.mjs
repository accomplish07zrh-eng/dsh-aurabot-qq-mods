import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const source = fileURLToPath(new URL('../', import.meta.url));
export async function buildExtension(target = join(source, '.build')) {
  mkdirSync(target, { recursive: true });
  const result = await build({ absWorkingDir: source, entryPoints: [join(source, 'index.mjs')], bundle: true, write: false, metafile: true, format: 'esm', platform: 'node', target: 'node22', charset: 'utf8', legalComments: 'eof' });
  mkdirSync(join(target, 'lib'), { recursive: true });
  for (const name of ['browser.cjs', 'session.cjs', 'login.cjs']) copyFileSync(join(source, 'lib', name), join(target, 'lib', name));
  for (const name of ['panel.js', 'README.md', 'LICENSE']) copyFileSync(join(source, name), join(target, name));
  // 把实际打入运行包的依赖许可证一并发布，保留各项目的版权声明。
  const notices = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    const file = resolve(source, input);
    if (!file.split(sep).includes('node_modules')) continue;
    let dir = dirname(file);
    while (dir !== dirname(dir)) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate) && JSON.parse(readFileSync(candidate, 'utf8')).name) break;
      dir = dirname(dir);
    }
    const pkgFile = join(dir, 'package.json');
    if (!existsSync(pkgFile)) throw new Error(`找不到依赖信息：${input}`);
    const dep = JSON.parse(readFileSync(pkgFile, 'utf8'));
    const licenseFile = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING'].map(name => join(dir, name)).find(existsSync);
    const license = licenseFile ? readFileSync(licenseFile, 'utf8').trim()
      : `原 npm 包未附许可证文件。许可证：${dep.license || '未知'}；作者：${typeof dep.author === 'string' ? dep.author : dep.author?.name || '未知'}；主页：${dep.homepage || ''}`;
    notices.set(`${dep.name}@${dep.version}`, license);
  }
  writeFileSync(join(target, 'THIRD-PARTY-NOTICES.md'), '# 第三方许可证\n\n' + [...notices].sort(([a], [b]) => a.localeCompare(b)).map(([name, license]) => `## ${name}\n\n${license}\n`).join('\n'));
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module' }, null, 2));
  // 单个打包入口避免安装期间出现依赖解析竞争。
  writeFileSync(join(target, 'index.mjs.next'), result.outputFiles[0].contents);
  renameSync(join(target, 'index.mjs.next'), join(target, 'index.mjs'));
  return target;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) console.log('运行包已生成：' + await buildExtension());
