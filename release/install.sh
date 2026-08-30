#!/bin/sh
# VideoDraft CLI installer — https://videodraft.ai/cli
#   curl -fsSL https://videodraft.ai/install.sh | sh
#
# Thin wrapper over npm: verifies Node >= 20, installs the `videodraft`
# package globally, and points at alternatives when npm isn't available.
set -eu

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
err() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || err "Node.js >= 20.18.1 is required. Install it from https://nodejs.org or via brew install node, then re-run."

# Precise check (a dependency, undici, needs >= 20.18.1) — not just the major.
node -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit((a>20||(a===20&&(b>18||(b===18&&c>=1))))?0:1)' \
  || err "Node.js >= 20.18.1 is required (found $(node -v)). Upgrade node, then re-run."

command -v npm >/dev/null 2>&1 || err "npm not found. Install Node.js from https://nodejs.org (includes npm), then re-run."

bold "Installing videodraft via npm…"
npm install -g videodraft

bold "Installed $(videodraft --version 2>/dev/null || echo videodraft)."
printf '\nGet started:\n  videodraft login\n  videodraft generate image "a red fox in snow" --download ./out/\n\nDocs: https://videodraft.ai/cli\n'
