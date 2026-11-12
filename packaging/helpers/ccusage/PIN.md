# ccusage helper pin

Tandem reads tokens and cost per account with [ccusage](https://github.com/ccusage/ccusage) (MIT,
`LICENSE` in this folder, byte for byte the npm package's). The release ships only its native
binary, unchanged, as `libexec/ccusage`; the npm package's `bin` (`src/cli.js`) is a Node launcher
whose only job is to find that binary in the platform package and run it with the same arguments,
so it is not shipped.

- Version: `ccusage@20.0.49` (npm; MIT; its optional packages `@ccusage/ccusage-<os>-<arch>@20.0.49`
  hold the native binary).
- Source commit: `ccusage/ccusage@37c8acd1a8a1742b0e4e6fa3f658139f6404100e`
  (`apps/ccusage/package.json` there says `"version": "20.0.49"`).
- Command, once per account folder: `ccusage <agent> daily --json --offline`, as in the pinned
  README (`ccusage claude daily`, `ccusage codex daily`, `ccusage opencode daily`,
  `ccusage grok daily`, `ccusage antigravity daily`; `--json`; `--offline` = the embedded price
  table, no price fetch).

| Platform | Package | Integrity |
|---|---|---|
| darwin-arm64 | `@ccusage/ccusage-darwin-arm64@20.0.49` | `sha512-nEYFIyA1WaAOLPTw5JHFShgQbkDArravcGzEopVz/rIWJuZmfMvE4CCJ111A0thCn72TzJi3/q+ByNOfGGXh/Q==` |
| darwin-x64 | `@ccusage/ccusage-darwin-x64@20.0.49` | `sha512-OOrqJ7T3Uxee+J8+nyui0SAszxHY93J/T4gU0X8HgrP7qEXw7dioR46XjAyXtoryZMF+t87FbPye/FJ6qdRrWg==` |
| linux-arm64 | `@ccusage/ccusage-linux-arm64@20.0.49` | `sha512-c1/4mP5kRNnq65HIoG6F5gvzETAYoocVuDO5N6gaP0n4vR5g58iIe2KVkoERemmKsXVWpI0cp6bsLYfTvFFmRQ==` |
| linux-x64 | `@ccusage/ccusage-linux-x64@20.0.49` | `sha512-MITIo4RpJuskZqpk80VrZ8uE6QsN3uJFY3R0NXO2jZOB1qL7MqVkYuGQC0lFqsTp5ux6UC/nOa+ZubaP3ED/nQ==` |

Each tarball is `https://registry.npmjs.org/@ccusage/ccusage-<platform>/-/ccusage-<platform>-20.0.49.tgz`.
`fetch.sh [<platform>] <out-file>` fetches it, checks it against the integrity above, and writes
`package/bin/ccusage` to `<out-file>`; `packaging/build-release.sh` runs it for the release's
platform. A new pin changes the version, the commit, the four integrities here and in `fetch.sh`,
and `LICENSE` if it changed.
