/**
 * TandemMcp — the claude.ai-facing MCP server (Streamable HTTP / SSE).
 *
 * Built on Cloudflare's `McpAgent` (from the `agents` package); it is itself a
 * Durable Object (binding MCP_OBJECT). Every tool forwards an HTTP-shaped RPC
 * down the tunnel to the Mac bridge via the singleton TunnelDO. The Worker is
 * dumb plumbing: the bridge owns the live tmux-hosted Claude Code sessions and
 * the zero-API relay loop, and is the trust boundary.
 *
 * ENGINE = tmux (see spec §1b/§2). A "session" is a REAL interactive `claude`
 * TUI in a tmux session "ccm-<name>" on the owner's Mac, billed against their
 * subscription — NOT `claude -p` / the Messages API. The autonomous capability
 * is a TWO-session relay (a lead + a worker, both interactive), NOT an API brain.
 *
 * SAFETY: every tool here causes REAL Claude Code to run on the owner's Mac and may
 * read/edit/delete files and run shell commands, on their subscription. The tool
 * descriptions say so loudly so claude.ai surfaces the blast radius.
 *
 * POLL CONTRACT: send_to_session / start_relay are held-open but may return
 * before the work is done ({status:"running", cursor}). When a tool returns
 * status:"running", the model MUST poll read_session / read_relay with the
 * returned cursor until read reports idle:true (a session turn is done) or the
 * relay transcript shows a DONE marker / running:false.
 */

import { McpAgent } from 'agents/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ICON_DATA_URI, ICON_MIME } from './icon'
import { TUNNEL_SINGLETON_NAME, type Env } from './types'
import { sanitizeBridgeId, DEFAULT_BRIDGE_ID as FALLBACK_BRIDGE_ID } from './bridge-id'
import {
  resolveDefaultMachine,
  formatOfflineMessage,
  formatAmbiguousMessage,
  isOfflineError,
} from './machine-resolve'
import { configureFabricTools, type FabricToolServer } from '../../src/fabric/mcp-tools.ts'

/** Standing warning prepended to every tool description. */
const BLAST_RADIUS =
  'WARNING: this controls REAL terminal sessions on the owner\'s personal Mac. The ' +
  'session/drive tools can reach ANY live tmux pane on the machine — not just ' +
  'Claude Code, but Codex, or a bare login shell (the engine is auto-detected) — ' +
  'and may type into it, read it, interrupt it, or kill it. Anything run that way ' +
  '(Claude Code included) executes on the owner\'s subscription and may read, edit, or ' +
  'delete files and run shell commands. Treat every call as a real, irreversible ' +
  'action on a real machine.'

type RpcMethod = 'GET' | 'POST'

/** Any agent name (the harness name rule of harnesses/SCHEMA.md); the bridge decides. */
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

/** Shared description for the optional `machine` selector on every session/relay tool. */
const MACHINE_DESC =
  'Which Mac to run on, e.g. "laptop" or "desktop". If omitted, uses the only ' +
  'connected machine, or the configured default when several are connected ' +
  '(call list_machines to see what is online).'

/** OAuth props are set by the hub's own sign-in (auth-gate.ts), never by tool input. */
interface FabricOAuthProps extends Record<string, unknown> { userId?: unknown }

export class TandemMcp extends McpAgent<Env, unknown, FabricOAuthProps> {
  server = new McpServer({
    name: 'tandem',
    version: '0.1.0',
    icons: [{ src: ICON_DATA_URI, mimeType: ICON_MIME, sizes: ['640x640'] }],
  })

  async init(): Promise<void> {
    /* ---- capability #1: drive a local interactive Claude Code session ---- */

    this.server.registerTool(
      'list_sessions',
      {
        title: 'List terminal / Claude Code sessions',
        description:
          `${BLAST_RADIUS}\n\n` +
          'List terminal sessions on the owner\'s Mac: ALL LIVE tmux panes (each tagged ' +
          'with its detected engine — claude, codex, or shell — plus its real tmux ' +
          'name and a "tmux attach -t <tmuxName>" hint) first, then recent local ' +
          'Claude Code AND Codex history. Read-only; does not start or send ' +
          'anything. Sorted most-recent first. Use the returned id as the name for ' +
          'send_to_session / read_session / interrupt_session / close_session. ' +
          'Also lists Hermes sessions (engine:"hermes"): writable WebUI agent ' +
          'sessions (writable:true, drivable) and read-only channel conversations ' +
          'like Telegram/WhatsApp (writable:false — readable, not sendable). ' +
          'NOTE: a Codex pane NOT spawned by the bridge may surface under ' +
          'engine:"shell" (codex runs as a node process, so it is detected by ' +
          'foreground command); this is cosmetic — it drives identically — until a ' +
          'content signature is added.',
        inputSchema: {
          limit: z.number().int().positive().optional()
            .describe('Maximum sessions to return (default 20).'),
          project: z.string().optional()
            .describe('Optional project/cwd substring filter.'),
          engine: z.string().regex(AGENT_NAME).optional()
            .describe('Filter by engine: any agent name (default "all"). "terminal" is an alias for bare-shell panes.'),
          machine: z.string().optional().describe(MACHINE_DESC),
        },
      },
      async ({ limit, project, engine, machine }) => {
        const query = buildQuery({ limit, project, engine })
        return this.toolResult(await this.rpc(`/sessions${query}`, 'GET', undefined, machine))
      },
    )

    this.server.registerTool(
      'open_session',
      {
        title: 'Open a Claude Code (or other engine) session',
        description:
          `${BLAST_RADIUS}\n\n` +
          'Spawn a fresh, visible, INTERACTIVE session inside tmux on the owner\'s Mac ' +
          '(tmux session "ccm-<name>") in the given working directory, and return ' +
          '{ name, cwd, engine, attachHint }. No agent is on by default and engine is ' +
          'required: an omitted one gets a 400 naming the enabled agents. Pass engine ' +
          'to launch claude, codex or a bare login shell. Idempotent: ' +
          're-opening an existing live name reuses it. cwd is allowlisted by the ' +
          'bridge (default the home dir); a cwd outside the allowlist is rejected ' +
          '(the allowlist still gates SPAWNING, even though driving existing panes ' +
          'is unrestricted). The owner can run the returned attachHint to watch or type ' +
          'alongside.',
        inputSchema: {
          name: z.string().optional()
            .describe('Short session name (A-Z a-z 0-9 . _ -). Becomes tmux "ccm-<name>". Auto-generated if omitted.'),
          cwd: z.string().optional()
            .describe('Working directory to launch in. Must be on the bridge allowlist (default $HOME).'),
          engine: z.string().regex(AGENT_NAME).optional()
            .describe('Engine to launch, required (no agent is on by default; an omitted one gets a 400 naming the enabled agents): any agent name, e.g. the claude / codex / grok / gemini CLI (all on the owner\'s own subscription, no API), or "shell" for a bare login shell. The bridge refuses an unknown or disabled one.'),
          machine: z.string().optional().describe(MACHINE_DESC),
        },
      },
      async ({ name, cwd, engine, machine }) =>
        this.toolResult(await this.rpc('/sessions/open', 'POST', { name, cwd, engine }, machine)),
    )

    this.server.registerTool(
      'send_to_session',
      {
        title: 'Send a prompt / keystrokes to a terminal session',
        description:
          `${BLAST_RADIUS}\n\n` +
          'Type into ANY live terminal session on the owner\'s Mac and wait (held open) ' +
          'for that turn to finish, returning { status, report, cursor }. ' +
          'status "done" = the engine\'s working marker cleared; status "quiet" = ' +
          'a codex or shell pane printed nothing for its stability window and gave ' +
          'no completion signal, so it may still be working. The name ' +
          'may be ANY live tmux pane (from list_sessions) — a Claude Code session, ' +
          'a codex session, or a bare shell — not just a ccm-* session the bridge ' +
          'spawned; an unknown live pane is adopted on first use (engine ' +
          'auto-detected). For a bare shell this submits a command line. It may ' +
          'also be a Hermes session id: a writable WebUI AGENT session is driven ' +
          '(this fires a REAL Hermes agent turn that may take actions), but a ' +
          'Hermes CHANNEL conversation (Telegram/WhatsApp, key "agent:…") is ' +
          'READ-ONLY and returns { status:"error" } with a refusal — you cannot ' +
          'message channel contacts through this tool. If the turn runs past the ' +
          'tunnel window the bridge returns { status:"running", name, cursor } — ' +
          'when you see that, IMMEDIATELY call read_session in a loop with the ' +
          'returned cursor until read_session returns idle:true, then read the ' +
          'final report.',
        inputSchema: {
          name: z.string()
            .describe('Name of a live session: the id from list_sessions (a ccm- bare name, a live tmux pane\'s real name, or a Hermes session id).'),
          text: z.string()
            .describe('The instruction / command line to type into the session.'),
          engine: z.string().regex(AGENT_NAME).optional()
            .describe('Optional engine hint: any agent name. Use "hermes" to drive a Hermes WebUI agent session by id; tmux hints help when adopting an unknown pane.'),
          waitForTurn: z.boolean().optional()
            .describe('Block until the turn completes (default true). The bridge always caps the wait and may return status:"running".'),
          machine: z.string().optional().describe(MACHINE_DESC),
        },
      },
      async ({ name, text, engine, waitForTurn, machine }) =>
        this.toolResult(
          await this.rpc(`/sessions/${encodeURIComponent(name)}/send`, 'POST', {
            text,
            engine,
            waitForTurn,
          }, machine),
        ),
    )

    this.server.registerTool(
      'read_session',
      {
        title: 'Read a terminal session transcript',
        description:
          `${BLAST_RADIUS}\n\n` +
          'Read the transcript of ANY live terminal session WITHOUT sending ' +
          'anything — the review/audit + poll primitive. Works for any live tmux ' +
          'pane (claude, codex, or a bare shell); an unknown live pane is adopted ' +
          'on first use. Also reads a Hermes session by id (both writable agent ' +
          'sessions AND read-only channel conversations — reading is always safe ' +
          'and fires no agent turn). Returns { text, cursor, idle, state }: state ' +
          '"quiet" = a codex or shell pane printed nothing for its stability window ' +
          'and gave no completion signal, so it may still be working; state "done" ' +
          '= the engine\'s working marker cleared (ready for input); idle is true ' +
          'for both. idle:false (state "working") means the turn is still working. ' +
          'Hermes reads omit state. Pass the returned cursor back as ' +
          'sinceCursor to page incrementally. This is how you poll a ' +
          '{status:"running"} send to completion: loop read_session until idle:true.',
        inputSchema: {
          name: z.string().describe('Name of the session to read (id from list_sessions).'),
          sinceCursor: z.number().int().nonnegative().optional()
            .describe('Cursor (byte offset / message index) from a previous read/send; returns only newer transcript.'),
          engine: z.string().regex(AGENT_NAME).optional()
            .describe('Optional engine hint: any agent name. Use "hermes" to read a Hermes session by id; tmux hints help when adopting an unknown pane.'),
          machine: z.string().optional().describe(MACHINE_DESC),
        },
      },
      async ({ name, sinceCursor, engine, machine }) => {
        const query = buildQuery({ cursor: sinceCursor, engine })
        return this.toolResult(
          await this.rpc(`/sessions/${encodeURIComponent(name)}/read${query}`, 'GET', undefined, machine),
        )
      },
    )

    this.server.registerTool(
      'interrupt_session',
      {
        title: 'Interrupt a terminal session',
        description:
          `${BLAST_RADIUS}\n\n` +
          'Stop a runaway turn in ANY live session. The interrupt keystrokes come ' +
          'from the session\'s engine (claude: Escape then Ctrl-C; codex / bare ' +
          'shell: Ctrl-C). Works on any live tmux pane (adopted on first use). The ' +
          'session stays open. Returns { ok, name }.',
        inputSchema: {
          name: z.string().describe('Name of the session to interrupt (id from list_sessions).'),
          machine: z.string().optional().describe(MACHINE_DESC),
        },
      },
      async ({ name, machine }) =>
        this.toolResult(
          await this.rpc(`/sessions/${encodeURIComponent(name)}/interrupt`, 'POST', undefined, machine),
        ),
    )

    this.server.registerTool(
      'close_session',
      {
        title: 'Close a terminal session',
        description:
          `${BLAST_RADIUS}\n\n` +
          'KILL a live tmux session on the owner\'s Mac (ends whatever is running in it — ' +
          'a Claude Code / codex TUI or a bare shell). Works on ANY live tmux pane, ' +
          'not just ccm-* sessions the bridge spawned, so use it deliberately. ' +
          'Idempotent — closing an already-gone session still returns ok. Returns ' +
          '{ ok, name }.',
        inputSchema: {
          name: z.string().describe('Name of the session to close (id from list_sessions).'),
          machine: z.string().optional().describe(MACHINE_DESC),
        },
      },
      async ({ name, machine }) =>
        this.toolResult(
          await this.rpc(`/sessions/${encodeURIComponent(name)}/close`, 'POST', undefined, machine),
        ),
    )

    /* ---- capability #2: zero-API two-session autonomous relay ---- */

    this.server.registerTool(
      'start_relay',
      {
        title: 'Start an autonomous two-session relay',
        description:
          `${BLAST_RADIUS}\n\n` +
          'Kick off a NO-HUMAN-IN-THE-LOOP relay on the owner\'s Mac: TWO interactive ' +
          'Claude Code sessions (a "lead" strategist/reviewer and a "worker" that ' +
          'does the hands-on work) message each other until the lead says DONE, a ' +
          'hard max-turn cap is hit, a wall-clock cap passes, or it is stopped. ' +
          'Both run on the owner\'s subscription (zero API). This will autonomously edit ' +
          'files and run commands. Returns { status:"running", loopId, leadName, ' +
          'workerName, cursor }. Watch it with read_relay (poll with the cursor); ' +
          'barge in with inject_to_relay; halt with stop_relay.',
        inputSchema: {
          goal: z.string()
            .describe('The objective the lead should drive the worker to achieve.'),
          cwd: z.string().optional()
            .describe('Working directory for the relay\'s sessions (allowlisted; default $HOME).'),
          maxTurns: z.number().int().positive().optional()
            .describe('Hard cap on lead<->worker turns (bridge clamps to a safe ceiling; default 24).'),
          machine: z.string().optional().describe(MACHINE_DESC),
        },
      },
      async ({ goal, cwd, maxTurns, machine }) =>
        this.toolResult(await this.rpc('/relay/start', 'POST', { goal, cwd, maxTurns }, machine)),
    )

    this.server.registerTool(
      'read_relay',
      {
        title: 'Read an autonomous relay transcript',
        description:
          `${BLAST_RADIUS}\n\n` +
          'Read the lead<->worker conversation for a relay loop WITHOUT sending ' +
          'anything. Returns { text, cursor, running }: running:false means the ' +
          'loop has finished (look for a "DONE" / "relay finished" marker in the ' +
          'text). Pass the returned cursor back as sinceCursor to page ' +
          'incrementally and watch both sides talk while the loop runs.',
        inputSchema: {
          loopId: z.string().describe('Id of the relay loop (from start_relay).'),
          sinceCursor: z.number().int().nonnegative().optional()
            .describe('Cursor (byte offset) from a previous read; returns only newer transcript.'),
          machine: z.string().optional().describe(MACHINE_DESC),
        },
      },
      async ({ loopId, sinceCursor, machine }) => {
        const query = buildQuery({ cursor: sinceCursor })
        return this.toolResult(
          await this.rpc(`/relay/${encodeURIComponent(loopId)}/read${query}`, 'GET', undefined, machine),
        )
      },
    )

    this.server.registerTool(
      'stop_relay',
      {
        title: 'Stop an autonomous relay',
        description:
          `${BLAST_RADIUS}\n\n` +
          'Halt a running relay loop on the owner\'s Mac: flips it off and interrupts ' +
          'the session currently mid-turn so it stops promptly. Returns ' +
          '{ ok, running }.',
        inputSchema: {
          loopId: z.string().describe('Id of the relay loop to stop.'),
          machine: z.string().optional().describe(MACHINE_DESC),
        },
      },
      async ({ loopId, machine }) =>
        this.toolResult(await this.rpc(`/relay/${encodeURIComponent(loopId)}/stop`, 'POST', undefined, machine)),
    )

    this.server.registerTool(
      'inject_to_relay',
      {
        title: 'Inject a message into an autonomous relay',
        description:
          `${BLAST_RADIUS}\n\n` +
          'Barge in on a running relay: deliver a message to the lead (e.g. ' +
          'course-correct, add a constraint, or answer a question) that it will ' +
          'see at the top of its next turn. The loop keeps running autonomously ' +
          'after. Returns { ok }.',
        inputSchema: {
          loopId: z.string().describe('Id of the relay loop to inject into.'),
          message: z.string().describe('The message to deliver to the lead.'),
          machine: z.string().optional().describe(MACHINE_DESC),
        },
      },
      async ({ loopId, message, machine }) =>
        this.toolResult(
          await this.rpc(`/relay/${encodeURIComponent(loopId)}/inject`, 'POST', { message }, machine),
        ),
    )

    /* ---- capability #3: see which Macs are connected (read-only) ---- */

    this.server.registerTool(
      'list_machines',
      {
        title: 'List connected Macs',
        description:
          'Read-only. List which Macs (bridge_ids) are currently connected to the ' +
          'tunnel, plus the configured default. Does NOT run anything on any ' +
          'machine. Use this to choose a `machine` value for the session/relay ' +
          'tools, and to see which machine an omitted `machine` would resolve to. ' +
          'Returns { connected, default, defaultOnline }.',
        inputSchema: {},
      },
      async () => {
        const connected = await this.fetchConnectedMachines()
        const def = this.defaultMachine()
        return this.toolResult({ connected, default: def, defaultOnline: connected.includes(def) })
      },
    )

    /* ---- capability #4: rooms, memory and projects (the bridge's fabric store) ---- */

    // Memory has one home computer (the bridge that opened the store); the TunnelDO sends
    // every fabric call there. The tools are listed on every session with no readiness
    // probe, so a session opened while the home is offline still lists them and each call
    // says why. The owner comes from the OAuth props only.
    try {
      await configureFabricTools(this.server as unknown as FabricToolServer, {
        enabled: '1',
        oauthSubject: this.props!.userId, // ! keeps the throw-then-fail-closed path if props are absent
        readiness: false,
        rpc: (path, body) => this.fabricRpc(path, body),
      })
    } catch {
      // A hashing or registration failure leaves the fabric tools out and keeps the session tools.
    }
  }

  /**
   * Forward an HTTP-shaped RPC to the Mac bridge through the singleton TunnelDO.
   * The DO frames it as tunnel_http_request, awaits tunnel_http_response, and
   * returns it. We parse the bridge JSON and hand it back (including
   * {status:"running"} so the model can poll).
   */
  private async rpc(
    path: string,
    method: RpcMethod,
    body?: unknown,
    machine?: string,
  ): Promise<unknown> {
    // Decide which Mac this RPC targets BEFORE sending. Explicit machine -> let
    // the DO route (and reject with a rich body if offline). No machine ->
    // consult /__status and apply the default rule; a none/ambiguous outcome is
    // returned as the tool result without sending any RPC.
    const resolved = await this.resolveTarget(machine)
    if ('error' in resolved) return resolved.error

    const stub = this.env.TUNNEL.get(this.env.TUNNEL.idFromName(TUNNEL_SINGLETON_NAME))

    // Hoisted header construction (the Phase 2 gotcha): headers used to be built
    // ONLY inside the `body !== undefined` branch, so GET-style tools could not
    // carry any header. Build it unconditionally so GET or POST can set the
    // x-ccm-bridge-id target.
    const headers: Record<string, string> = {}
    const init: RequestInit = { method }
    if (body !== undefined) {
      init.body = JSON.stringify(body)
      headers['content-type'] = 'application/json'
    }
    if (resolved.header) headers['x-ccm-bridge-id'] = resolved.header
    init.headers = headers

    const res = await stub.fetch(`https://do/__rpc${path}`, init)
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {}
    } catch {
      // Non-JSON (e.g. an upstream error body) — surface it verbatim.
      parsed = { error: 'bad_bridge_response', status: res.status, body: text }
    }
    // UX: turn the DO's {error:'bridge_offline', requested, connected} into a
    // readable message naming the unknown machine and listing what IS connected.
    if (isOfflineError(parsed)) {
      return {
        ...parsed,
        message: formatOfflineMessage(parsed.requested ?? machine ?? '', parsed.connected ?? []),
      }
    }
    return parsed
  }

  /**
   * A fabric call: POST to the DO's /__fabric-rpc<path> with no machine header (the DO sends
   * it to the memory home) and return the DO's JSON as it is: the home's answer,
   * memory_home_offline, memory_home_conflict or gateway_timeout. Non-JSON is fabric_unavailable.
   */
  private async fabricRpc(path: string, body: unknown): Promise<unknown> {
    const stub = this.env.TUNNEL.get(this.env.TUNNEL.idFromName(TUNNEL_SINGLETON_NAME))
    const res = await stub.fetch(`https://do/__fabric-rpc${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    try {
      return JSON.parse(await res.text()) as unknown
    } catch {
      return { error: 'fabric_unavailable' }
    }
  }

  /** The operator default machine, sanitized to match the stored bid: ids. Falls
   *  back to the untagged-socket id when TANDEM_DEFAULT_MACHINE is unset (e.g. in tests). */
  private defaultMachine(): string {
    return this.env.TANDEM_DEFAULT_MACHINE ? sanitizeBridgeId(this.env.TANDEM_DEFAULT_MACHINE) : FALLBACK_BRIDGE_ID
  }

  /** Ask the TunnelDO which bridge_ids are currently connected. */
  private async fetchConnectedMachines(): Promise<string[]> {
    const stub = this.env.TUNNEL.get(this.env.TUNNEL.idFromName(TUNNEL_SINGLETON_NAME))
    try {
      const res = await stub.fetch('https://do/__status')
      const data = (await res.json()) as { connected?: string[] }
      return Array.isArray(data.connected) ? data.connected : []
    } catch {
      return [] // unreachable DO -> behave as "nothing connected"
    }
  }

  /** Resolve the effective target header for an RPC. Explicit machine passes
   *  through (DO sanitizes + routes); no machine applies the default rule. */
  private async resolveTarget(machine?: string): Promise<{ header?: string } | { error: unknown }> {
    if (machine) return { header: machine }
    const connected = await this.fetchConnectedMachines()
    const def = this.defaultMachine()
    const r = resolveDefaultMachine(connected, def)
    if (r.kind === 'ok') return { header: r.target }
    if (r.kind === 'none') {
      return { error: { error: 'no_machines', message: 'No Macs are connected to the tunnel.' } }
    }
    return {
      error: {
        error: 'ambiguous_machine',
        message: formatAmbiguousMessage(r.connected, def),
        connected: r.connected,
      },
    }
  }

  /** Wrap a bridge result as an MCP text content block. */
  private toolResult(result: unknown): { content: { type: 'text'; text: string }[] } {
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
}

/** Build a `?a=b&c=d` query string, dropping undefined values. */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) usp.set(key, String(value))
  }
  const qs = usp.toString()
  return qs ? `?${qs}` : ''
}
