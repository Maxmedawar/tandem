# fleetbus to Tandem

A fleet skill that says `fleetbus send`, `fleetbus inbox` or `fleetbus ls` switches to Tandem by
changing one word. Tandem's mail is stored, delivered once and read under an untrusted label; the
sender is worked out by the runtime (the session's own caller token, or the owner), never taken
from what the caller says.

| fleetbus | tandem |
| --- | --- |
| `fleetbus send <machine:session> MSG` | `tandem mail send <computer>:<session> MSG` (a session on this computer: `tandem mail send <session> MSG`; `--level fyi\|ask\|interrupt`, fyi by default) |
| `fleetbus inbox` | `tandem mail inbox` (inside a session: its own inbox; the owner adds `--name <session>`; `--peek` lists without marking) |
| `fleetbus ls [--all]` | `tandem mail ls [--all]` (`--all` adds the other computers' sessions) |

`tandem mail send` takes messages up to about 8 KiB (the control socket's request cap); the mail_send tool takes up to 16 KiB.

- `fleetbus broadcast`: not in Tandem yet (R1b)
- `fleetbus hold`: not in Tandem yet (R1b)
- `fleetbus release`: not in Tandem yet (R1b)
- `fleetbus holds`: not in Tandem yet (R1b)
- `fleetbus check-heavy`: not in Tandem yet (R1b)
- `fleetbus hook`: not in Tandem yet (R1b)
- `fleetbus whoami`: not in Tandem yet (R1b)
