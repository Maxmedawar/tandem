#!/bin/sh
# Prints one line per required tool with its version; exit 1 if any is missing or too old.
rc=0
show() { # name hint version-cmd...
  n=$1; h=$2; shift 2
  if command -v "$n" >/dev/null 2>&1; then
    printf '%s %s\n' "$n" "$("$@" 2>&1 | head -n 1)"
  else
    printf 'MISSING %s (%s)\n' "$n" "$h"; rc=1
  fi
}
show node 'brew install node' node --version
if command -v node >/dev/null 2>&1; then
  node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" \
    || { echo 'TOO OLD node (need 22.13 or newer)'; rc=1; }
fi
show podman 'brew install podman' podman --version
show gitleaks 'brew install gitleaks' gitleaks version
if command -v gitleaks >/dev/null 2>&1; then
  case $(gitleaks version 2>&1 | head -n 1) in
    8.*|v8.*) ;;
    *) echo 'WRONG VERSION gitleaks (need major 8)'; rc=1 ;;
  esac
fi
show wrangler 'npm install -g wrangler' wrangler --version
show opencode 'brew install opencode' opencode --version
show pi 'npm install -g @earendil-works/pi-coding-agent' pi --version
exit $rc
