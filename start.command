#!/bin/sh
set -eu

task_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$task_root"

# Finder and a normal Terminal do not inherit Codex's tool paths.
for task_bin in "$HOME/.local/bin" "$HOME/Library/pnpm" "$HOME/.local/share/pnpm" /opt/homebrew/bin /usr/local/bin; do
  if [ -d "$task_bin" ]; then
    PATH="$PATH:$task_bin"
  fi
done
task_runtime="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
if ! command -v node >/dev/null 2>&1 && [ -x "$task_runtime/node/bin/node" ]; then
  PATH="$PATH:$task_runtime/node/bin"
fi
if ! command -v pnpm >/dev/null 2>&1 && [ -x "$task_runtime/bin/fallback/pnpm" ]; then
  PATH="$PATH:$task_runtime/bin/fallback"
fi
export PATH

if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  echo '未找到 Node.js 或 pnpm。请安装 README 中锁定的版本后重新运行。'
  exit 1
fi
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 19)) { console.error("请使用 Node.js 24.19.0 或更高版本。"); process.exit(1); }'
echo "Node $(node --version) / pnpm $(pnpm --version)"
if [ ! -d node_modules ] || [ ! -d web/node_modules ]; then
  pnpm install --frozen-lockfile
fi
echo '启动后请打开 http://127.0.0.1:5173/ ，按 Control+C 停止服务。'
exec pnpm dev
