#!/usr/bin/env node
// fake-dialog.mjs: a made-up first-run dialog for test/dialogs.test.ts.
// Usage: fake-dialog.mjs <screen file> <start highlight index> <key-log path>
// The screen file is plain text; each line starting "@ " is one option. Option <index> is drawn
// with the highlight "❯ " in front, the others with spaces (index -1: no highlight drawn). Every
// key read is appended to the key log, one per line (Up, Down, Enter, or the character itself).
// Up/Down move the highlight and redraw. Enter chooses the highlighted option; a letter or digit
// chooses the option whose text ends with whitespace and that character. A choice prints
// "chose: <option>" then the prompt "fake> " (the RULES prompt of the test). When the screen
// file's first line is "#again", a choice draws the dialog again instead, under "(asked again)".
import { appendFileSync, readFileSync } from 'node:fs'

const [file, start, log] = process.argv.slice(2)
const raw = readFileSync(file, 'utf8').split('\n')
const again = raw[0] === '#again'
const lines = again ? raw.slice(1) : raw
const options = lines.filter((l) => l.startsWith('@ ')).map((l) => l.slice(2))
let at = Number(start)
let header = ''
let chosen = false

function draw() {
  let i = 0
  const body = lines.map((l) => (l.startsWith('@ ') ? `${i++ === at ? ' ❯ ' : '   '}${l.slice(2)}` : l))
  process.stdout.write(`\x1b[2J\x1b[H${header}${body.join('\n')}\n`)
}

function choose(option) {
  if (again) {
    header = '(asked again)\n'
    draw()
    return
  }
  chosen = true
  process.stdout.write(`\x1b[2J\x1b[Hchose: ${option}\nfake> `)
}

draw()
process.stdin.setRawMode(true)
process.stdin.on('data', (buf) => {
  for (const key of buf.toString('utf8').match(/\x1b\[[AB]|\x1bO[AB]|[\s\S]/g) ?? []) {
    const name = /^\x1b[[O]A$/.test(key) ? 'Up' : /^\x1b[[O]B$/.test(key) ? 'Down' : key === '\r' || key === '\n' ? 'Enter' : key
    appendFileSync(log, `${name}\n`)
    if (name === '\x03') process.exit(0)
    if (chosen || options.length === 0) continue
    if (name === 'Up' || name === 'Down') {
      if (at < 0) continue
      at = (at + (name === 'Down' ? 1 : options.length - 1)) % options.length
      draw()
    } else if (name === 'Enter') {
      if (at >= 0) choose(options[at])
    } else if (/^[a-z0-9]$/.test(name)) {
      const hit = options.find((o) => new RegExp(`\\s${name}$`).test(o))
      if (hit !== undefined) choose(hit)
    }
  }
})
