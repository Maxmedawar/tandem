/**
 * Shared MCP server builder for tandem.
 *
 * Defines the one seven-tool surface used by both transports:
 *   - src/public-server.ts: OAuth-protected Streamable HTTP (production)
 *   - src/http-mcp.ts: explicit legacy bearer-header migration only
 *   - src/stdio-server.ts: stdio for local desktop apps (no tunnel, no token)
 *
 * Each local tool call reaches the router (../bridge/router.ts) in-process. The same
 * proven handlers regardless of transport. The cwd allowlist, relay isolation,
 * and audit log all live in the router and apply identically to both paths.
 *
 * IMPORT-ORDER CAVEAT: importing this module pulls in the router, which builds
 * the cwd ALLOWLIST from env at module load. Entrypoints must bridge the
 * TANDEM_* env vars to the engine's CCM_* names BEFORE importing this module
 * (both entrypoints use a dynamic `await import(...)` after env setup).
 *
 * The tool surface contains seven tools. read_session is folded into
 * send_to_session (empty text = poll mode); the four relay tools are folded into
 * one `relay` tool with an `action`. The underlying routes are unchanged, so the
 * full capability set remains reachable.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { routeForTest } from "../bridge/router.ts";
import {
  dispatchListDevices,
  dispatchListSessions,
  dispatchOpenSession,
  dispatchSessionOp,
} from "../bridge/fleet-dispatch.ts";
import { createFleetRuntime, type FleetRuntime } from "../bridge/fleet-runtime.ts";
import { ICON_MIME, ICON_DATA_URI } from "./icon.ts";

/** Standing warning prepended to every tool description (real machine, real actions). */
const BLAST_RADIUS =
  "WARNING: this controls a REAL interactive engine session on the host machine. Claude " +
  "Code in tmux is the default. codex/shell/hermes are " +
  "DISABLED unless the host explicitly enables them (TANDEM_ENABLED_ENGINES); shell, " +
  "if enabled, is arbitrary OS-user command execution starting in the allowlisted cwd, " +
  "not a sandbox. May read, edit, or delete files and run shell commands in the chosen " +
  "working directory. Treat every call as a real action.";

const q = (params: Record<string, string | number | undefined>) => {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) usp.set(k, String(v));
  const s = usp.toString();
  return s ? `?${s}` : "";
};

/** Run a route call and wrap the bridge result as an MCP text content block. */
async function call(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  rawQuery = "",
) {
  const result = await routeForTest(method, path, body, rawQuery);
  return { content: [{ type: "text" as const, text: JSON.stringify(result.body) }] };
}

/** Wraps an already-computed { status, body } (local OR fleet-routed) the
 *  same way `call()` wraps a direct router result. Status is intentionally
 *  dropped from the text body, matching call()'s existing shape exactly. */
function wrap(result: { status: number; body: unknown }) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result.body) }] };
}

/**
 * Builds the MCP server. `fleet`, when supplied, is the SAME FleetRuntime the
 * production HTTP entrypoint shares with its private fleet listener.
 * Every tool call below routes through bridge/fleet-dispatch.ts, which
 * falls back to the exact pre-Phase-3 local behavior whenever no `device` is
 * given and the call resolves to local (see fleet-dispatch.ts for the full
 * resolution rules). The stdio transport uses a local-only runtime, so callers
 * get the same device-aware schema without opening a network listener.
 */
export function buildMcpServer(fleet?: FleetRuntime): McpServer {
  const runtime = fleet ?? createFleetRuntime({ localEngines: ["claude"] });
  // `icons` rides in the server's implementation info (a self-contained data:
  // URI, so no public URL is needed). A spec-aware client renders the Tandem
  // agent mark next to the connector and its tools. The HTTP transport's
  // /favicon.ico + /icon.png routes cover clients that instead fetch the
  // origin's favicon.
  const server = new McpServer({
    name: "tandem",
    version: "0.1.0",
    icons: [{ src: ICON_DATA_URI, mimeType: ICON_MIME, sizes: ["640x640"] }],
  });

  /* ---- sessions ---- */

  const deviceParamDescription =
    "Fleet device id to route to, or \"local\" for this hub. Omit to use the configured default device or the sole online device (local counts as one) uniquely capable of the requested engine; an unresolvable ambiguity fails with a 409 listing candidates. A composite \"device:localName\" session name implies its device and must not conflict with an explicit device here (400 if it does).";

  server.tool(
    "open_session",
    `${BLAST_RADIUS}\n\nOpen or attach to a visible interactive session. Supported engine ids are claude, codex, shell, and hermes. Claude is enabled by default; every other engine needs host opt-in and must be available. Claude, Codex, and shell run in tmux and require an admitted start cwd. Hermes attaches only to an explicitly allowlisted writable agent id through a loopback gateway and does not accept cwd.\n\nClaude permission bypass is off by default. model and effort are also Claude-only. Unknown, disabled, unavailable, or incompatible options fail before spawn or gateway contact. A remote open returns a stable global name in the form "<deviceId>:<localName>". Preserve that exact name for later calls so routing cannot drift.`,
    {
      name: z.string().optional().describe("Short name (A-Z a-z 0-9 . _ -); auto-generated if omitted. For engine=hermes this is the writable agent id (required, must be allowlisted)."),
      cwd: z.string().optional().describe("Working dir; must be on the allowlist (default the configured cwd). Not supported for engine=hermes."),
      model: z.string().optional().describe("Claude-only session model: alias (default|opus|sonnet|haiku) or a full claude-* id. Rejected (400) for any other engine."),
      effort: z.string().optional().describe("Claude-only thinking effort: low|medium|high|xhigh|max. Rejected (400) for any other engine."),
      engine: z.enum(["claude", "codex", "shell", "hermes"]).optional().describe("Engine to drive this session. Defaults to claude. codex/shell/hermes require TANDEM_ENABLED_ENGINES opt-in."),
      device: z.string().optional().describe(deviceParamDescription),
    },
    async ({ name, cwd, model, effort, engine, device }) => {
      return wrap(await dispatchOpenSession(runtime, { name, cwd, model, effort, engine, device }));
    },
  );

  server.tool(
    "list_sessions",
    `${BLAST_RADIUS}\n\nRead-only. List live sessions Tandem owns and can drive on the local hub or one selected device. Tandem does not scan arbitrary tmux sessions or return history. Remote ids are rewritten as stable "<deviceId>:<localName>" names and include device and localName fields.`,
    {
      limit: z.number().int().positive().optional(),
      project: z.string().optional(),
      device: z.string().optional().describe("Fleet device id to list, or omit for local."),
    },
    async ({ limit, project, device }) => {
      return wrap(await dispatchListSessions(runtime, device, { limit, project }));
    },
  );

  server.tool(
    "send_to_session",
    `${BLAST_RADIUS}\n\nSend one instruction to a live session and wait up to TANDEM_WAIT_MS. A bounded timeout returns status "running" and a cursor; poll again with empty text and that cursor instead of resending the instruction. status "done" means the engine signalled the turn finished; status "quiet" means a Codex or shell pane printed nothing for its stability window and gave no completion signal, so the turn may still be working. Empty text reads only newer output and returns idle plus state ("working", "done" or "quiet") once the pane is still. Completion events are also written as described in README.\n\nSlash commands and shell lines are passed through verbatim and execute in the target session. Optional model and effort controls are Claude-only and are rejected for every other engine.`,
    {
      name: z.string().describe("A bare local name (always local), or a fleet-routed \"<deviceId>:<localName>\" name returned by open_session/list_sessions."),
      text: z.string().optional().describe("Instruction OR a slash command (verbatim). Omit/empty = poll mode (read new output only)."),
      cursor: z.number().int().nonnegative().optional().describe("Poll mode: byte cursor from a previous result; returns only newer output."),
      model: z.string().optional().describe("Claude-only: override model for this turn (default|opus|sonnet|haiku or a full claude-* id). Rejected (400) for any other engine."),
      effort: z.string().optional().describe("Claude-only: override thinking effort for this turn (low|medium|high|xhigh|max). Rejected (400) for any other engine."),
      device: z.string().optional().describe(deviceParamDescription),
    },
    async ({ name, text, cursor, model, effort, device }) => {
      return wrap(await dispatchSessionOp(runtime, "send", name, device, { text: text ?? "", cursor, model, effort }));
    },
  );

  server.tool(
    "interrupt_session",
    `${BLAST_RADIUS}\n\nStop a runaway turn (sends Escape / Ctrl-C to the TUI). The session stays open. Returns { ok, name }.`,
    {
      name: z.string().describe("A bare local name (always local), or a fleet-routed \"<deviceId>:<localName>\" name returned by open_session/list_sessions."),
      device: z.string().optional().describe(deviceParamDescription),
    },
    async ({ name, device }) => {
      return wrap(await dispatchSessionOp(runtime, "interrupt", name, device, {}));
    },
  );

  server.tool(
    "close_session",
    `${BLAST_RADIUS}\n\nKill the live tmux session (ends the interactive TUI). Idempotent. Returns { ok, name }.`,
    {
      name: z.string().describe("A bare local name (always local), or a fleet-routed \"<deviceId>:<localName>\" name returned by open_session/list_sessions."),
      device: z.string().optional().describe(deviceParamDescription),
    },
    async ({ name, device }) => {
      return wrap(await dispatchSessionOp(runtime, "close", name, device, {}));
    },
  );

  server.tool(
    "list_devices",
    "List this hub and every connected fleet device. Returns { devices: [{ id, name, online, engines }] } with exactly those four fields. IP addresses, hostnames, usernames, tailnet identities, filesystem paths, tokens, and nonces are never included.",
    {},
    async () => {
      return wrap(dispatchListDevices(runtime));
    },
  );

  /* ---- relay (one tool, five actions) ---- */

  server.tool(
    "relay",
    `${BLAST_RADIUS}\n\nControl the optional persistent Claude-only lead and worker loop. This is not the general multi-engine fleet mechanism and cannot route to a device. start requires TANDEM_ALLOW_BYPASS=1 and fails before opening sessions when bypass is off. The lead parks after a task and can accept more work until stopped or bounded cleanup ends the loop.\n\nActions: start begins a goal; read fetches transcript output; enqueue supplies the next task or answers NEEDS_INPUT; inject steers an actively running task; stop ends the loop. Completion and escalation events follow the README notification policy.`,
    {
      action: z.enum(["start", "read", "inject", "stop", "enqueue"]),
      goal: z.string().optional().describe('action=start: the relay objective.'),
      cwd: z.string().optional().describe('action=start: working dir (allowlisted).'),
      maxTurns: z.number().int().positive().optional().describe('action=start: per-task hard cap on turns.'),
      loopId: z.string().optional().describe('action=read|inject|stop|enqueue: the loop id from start.'),
      cursor: z.number().int().nonnegative().optional().describe('action=read: byte cursor to page from.'),
      message: z.string().optional().describe('action=inject: steer a RUNNING task (rejected while parked).'),
      task: z.string().optional().describe('action=enqueue: the next task, OR the answer to a NEEDS_INPUT question.'),
    },
    async ({ action, goal, cwd, maxTurns, loopId, cursor, message, task }) => {
      const id = encodeURIComponent(loopId ?? "");
      switch (action) {
        case "start":
          return call("POST", "/relay/start", { goal, cwd, maxTurns });
        case "read":
          return call("GET", `/relay/${id}/read`, {}, q({ cursor }).slice(1));
        case "enqueue":
          return call("POST", `/relay/${id}/enqueue`, { task });
        case "inject":
          return call("POST", `/relay/${id}/inject`, { message });
        case "stop":
          return call("POST", `/relay/${id}/stop`);
      }
    },
  );

  return server;
}
