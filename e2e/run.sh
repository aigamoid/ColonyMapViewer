#!/usr/bin/env bash
# 実ブラウザ(ヘッドレス Chrome + CDP)で検索→ルート探索→案内開始→表示モード切替までを通し検証する。
# 前提: macOS の Google Chrome、Node 22+（グローバル WebSocket 使用）。
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT=9222

npm run build
(npm run dev > /tmp/colony-vite.log 2>&1 &)
sleep 3

"$CHROME" --headless=new --no-sandbox \
  --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader \
  --remote-debugging-port=$PORT --user-data-dir="$(mktemp -d)" \
  --window-size=1200,780 about:blank > /tmp/colony-chrome.log 2>&1 &
CHROME_PID=$!
sleep 3

set +e
node e2e/e2e.mjs
RC=$?
set -e

kill "$CHROME_PID" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
echo "screenshot: /tmp/e2e-final.png"
exit $RC
