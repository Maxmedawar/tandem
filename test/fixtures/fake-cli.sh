#!/bin/sh
# fake-cli.sh: a made-up CLI agent for test/engines/harness-engine.test.ts.
# It prints its arguments, then the prompt "fake> "; each line it reads is one turn:
#   slow   prints "fake is thinking", waits 12 s, then replies
#   ask    asks "Allow fake to go on? (y/n)" and reads the answer
#   other  replies "reply: <line>" at once
# With "trust" as its first argument it first prints a trust-folder question it never reads.
printf 'argc=%s\n' "$#"
for a in "$@"; do printf 'arg=[%s]\n' "$a"; done
if [ "${1:-}" = trust ]; then printf 'Do you trust this folder?\n'; fi
while printf 'fake> '; IFS= read -r line; do
  case $line in
    slow) printf 'fake is thinking'; sleep 12; printf '\nreply: slow done\n' ;;
    ask) printf 'Allow fake to go on? (y/n)'; IFS= read -r answer; printf 'reply: answered %s\n' "$answer" ;;
    *) printf 'reply: %s\n' "$line" ;;
  esac
done
