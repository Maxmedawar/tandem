#!/bin/bash
export PATH="/opt/homebrew/bin:/opt/homebrew/bin:/Users/yaqubramzan/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd /Users/yaqubramzan/tandem || exit 1
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg 8787 2>/dev/null || true
exec "/opt/homebrew/bin/node" --env-file=.env src/server.ts
