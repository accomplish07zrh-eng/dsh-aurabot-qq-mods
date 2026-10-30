#!/usr/bin/env bash
# 重新生成 index.json 并推到 registry 分支（第一次会建这个分支）。内容没变就不提交。
set -euo pipefail

if git fetch -q origin +refs/heads/registry:refs/remotes/origin/registry 2>/dev/null; then
  git worktree add -q -B registry .registry origin/registry
else
  git worktree add -q --orphan -b registry .registry
fi

previous=()
if [ -f .registry/index.json ]; then previous=(--previous .registry/index.json); fi
node scripts/publish-index.mjs --release "${1:-dist/release.json}" "${previous[@]}" --out .registry/index.json

cd .registry
git add index.json
if git diff --cached --quiet; then
  echo "索引没有变化"
  exit 0
fi
git commit -q -m "index: 更新模块索引"
git push -q origin registry
