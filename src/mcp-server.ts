/**
 * Shared MCP server builder for tandem.
 *
 * Defines the ONE tool surface (7 tools) used by BOTH transports:
 *   - src/http-mcp.ts   — Streamable-HTTP behind TANDEM_TOKEN (web/tunnel use)
 *   - src/stdio-server.ts — stdio for local desktop apps (no tunnel, no token)
 *
 * Each tool calls the local router (../bridge/router.ts) in-process — the same
 * proven handlers regardless of transport. The cwd allowlist, relay isolation,
 * and audit log all live in the router and apply identically to both paths.
 *
 * IMPORT-ORDER CAVEAT: importing this module pulls in the router, which builds
 * the cwd ALLOWLIST from env at module load. Entrypoints must bridge the
 * TANDEM_* env vars to the engine's CCM_* names BEFORE importing this module
 * (both entrypoints use a dynamic `await import(...)` after env setup).
 *
 * Tool surface is consolidated (phase 3): 6 tools, plus `completions` (phase 4,
 * a read-only reader over the Stop-hook completion feed) = 7. read_session is folded into
 * send_to_session (empty text = poll mode); the four relay tools are folded into
 * one `relay` tool with an `action`. The underlying routes are unchanged, so the
 * full capability set remains reachable.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { routeForTest } from "../bridge/router.ts";
import { ICON_MIME, ICON_DATA_URI } from "./icon.ts";

/** Standing warning prepended to every tool description (real machine, real actions). */
const BLAST_RADIUS =
  "WARNING: this runs REAL Claude Code on the host machine (an interactive claude " +
  "TUI in tmux, on the user's subscription) and may read, edit, or delete files and " +
  "run shell commands in the chosen working directory. Treat every call as a real action.";

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

export function buildMcpServer(): McpServer {
  // `icons` rides in the server's implementation info (a self-contained data:
  // URI, so no public URL is needed) — a spec-aware client renders the Claude
  // Code crab next to the connector / its tools. The HTTP transport's
  // /favicon.ico + /icon.png routes cover clients that instead fetch the
  // origin's favicon.
  const server = new McpServer({
    name: "tandem",
    version: "0.1.0",
    icons: [{ src: ICON_DATA_URI, mimeType: ICON_MIME, sizes: ["640x640"] }],
  });

  /* ---- sessions ---- */

  server.tool(
    "open_session",
    `${BLAST_RADIUS}\n\nSpawn a fresh, visible, INTERACTIVE Claude Code session in tmux ("ccm-<name>") in the given working directory; returns { name, cwd, attachHint }. Idempotent. cwd must be on the bridge allowlist. Launches in skip-permissions (autonomous) mode by default so turns don't stall on allow-prompts (set TANDEM_SKIP_PERMISSIONS=0 to disable); the cwd allowlist is enforced BEFORE spawn regardless, so this never widens reachable directories. Optional model/effort are session-scoped (claude --model / --effort).`,
    {
      name: z.string().optional().describe("Short name (A-Z a-z 0-9 . _ -); auto-generated if omitted."),
      cwd: z.string().optional().describe("Working dir; must be on the allowlist (default the configured cwd)."),
      model: z.string().optional().describe("Session model: alias (default|opus|sonnet|haiku) or a full claude-* id. Session-scoped; unsupported values are rejected (400)."),
      effort: z.string().optional().describe("Thinking effort: low|medium|high|xhigh|max. Session-scoped; unsupported values are rejected (400)."),
    },
    async ({ name, cwd, model, effort }) => call("POST", "/sessions/open", { name, cwd, model, effort }),
  );

  server.tool(
    "list_sessions",
    `${BLAST_RADIUS}\n\nList Claude Code sessions: LIVE tmux sessions the bridge is driving (with a "tmux attach -t ccm-<name>" hint) first, then recent local history. Read-only.`,
    { limit: z.number().int().positive().optional(), project: z.string().optional() },
    async ({ limit, project }) => call("GET", "/sessions", {}, q({ limit, project }).slice(1)),
  );

  server.tool(
    "send_to_session",
    `${BLAST_RADIUS}\n\nSend a prompt to a live session and wait (BOUNDED by TANDEM_WAIT_MS) for the turn to finish, returning { status, report, cursor }. If the turn is still running at the cap it returns { status:"running", cursor } — call again to keep waiting (never an infinite internal loop). POLL MODE: omit/empty 'text' to just fetch new output since 'cursor' without sending a new instruction → { text, cursor, idle } (idle:true means the turn is done). When a turn finishes the bridge ALSO emits a completion event (see README "Completion events"), so polling is optional.\n\nSLASH COMMANDS: any slash command sent as 'text' reaches the TUI verbatim and executes — e.g. "/status", "/mcp", "/model opus", "/goal ...", and custom commands. PER-TURN OVERRIDE: optional model/effort set the model/thinking effort for this turn via in-session controls applied before the prompt (these also persist as the saved default for new sessions; for strictly session-scoped control set them at open_session instead).`,
    {
      name: z.string(),
      text: z.string().optional().describe("Instruction OR a slash command (verbatim). Omit/empty = poll mode (read new output only)."),
      cursor: z.number().int().nonnegative().optional().describe("Poll mode: byte cursor from a previous result; returns only newer output."),
      model: z.string().optional().describe("Override model for this turn: default|opus|sonnet|haiku or a full claude-* id. Unsupported values rejected (400)."),
      effort: z.string().optional().describe("Override thinking effort for this turn: low|medium|high|xhigh|max. Unsupported values rejected (400)."),
    },
    async ({ name, text, cursor, model, effort }) =>
      call("POST", `/sessions/${encodeURIComponent(name)}/send`, { text: text ?? "", cursor, model, effort }),
  );

  server.tool(
    "interrupt_session",
    `${BLAST_RADIUS}\n\nStop a runaway turn (sends Escape / Ctrl-C to the TUI). The session stays open. Returns { ok, name }.`,
    { name: z.string() },
    async ({ name }) => call("POST", `/sessions/${encodeURIComponent(name)}/interrupt`),
  );

  server.tool(
    "close_session",
    `${BLAST_RADIUS}\n\nKill the live tmux session (ends the interactive TUI). Idempotent. Returns { ok, name }.`,
    { name: z.string() },
    async ({ name }) => call("POST", `/sessions/${encodeURIComponent(name)}/close`),
  );

  server.tool(
    "completions",
    `Read the completion feed written by the Stop hook — "what finished since I last looked", in ONE call. Read-only; touches no session and runs nothing.\n\nThe hook fires at every TURN END, not once per session, so by default this COLLAPSES to the newest record per session_id (set all_turns=true for the raw per-turn feed). Returns { completions:[{ session_id, brand, cwd, finished_at }], cursor, truncated }, newest first.\n\nCURSOR LOOP: pass the returned 'cursor' back as 'since' next time to get only what finished since — the compare is strict, so nothing repeats. Records carry NO tmux session name: join 'cwd' (or 'session_id') against list_sessions to tie a completion back to a live session. 'truncated' means more exists beyond the tail window or the limit.`,
    {
      since: z.string().optional().describe("ISO-8601 Z timestamp or a prior cursor; returns only records strictly newer."),
      session: z.string().optional().describe("Exact session_id, or a substring matched against brand/cwd."),
      limit: z.number().int().positive().optional().describe("Max records, newest first (default 20, max 500)."),
      all_turns: z.boolean().optional().describe("true = every raw turn-end record; default false = newest per session."),
    },
    async ({ since, session, limit, all_turns }) =>
      call("GET", "/completions", {}, q({ since, session, limit, all_turns: all_turns ? "true" : undefined }).slice(1)),
  );

  /* ---- relay (one tool, five actions) ---- */

  server.tool(
    "relay",
    `${BLAST_RADIUS}\n\nControl the autonomous, NO-HUMAN-IN-THE-LOOP lead/worker relay (two interactive Claude Code sessions that message each other). The lead is a PERSISTENT manager: when a task finishes it PARKS (stays alive, idle) and waits for the next task instead of dying; it tears down on stop, an idle-timeout, when it asks an unanswered question too long, or when it escalates terminal "BLOCKED". action:\n- "start": begin a relay — needs { goal, cwd?, maxTurns? } → { status:"running", loopId, leadName, workerName }\n- "read": fetch the lead<->worker transcript — needs { loopId, cursor? } → { text, cursor, running } (running:false = finished)\n- "enqueue": give the parked/running manager the NEXT task — needs { loopId, task } → { ok, queued }. ALSO the channel to ANSWER a question: if the manager asked NEEDS_INPUT and is awaiting an answer, the first enqueue is treated as that answer and RESUMES the same task.\n- "inject": steer the lead mid-task (only while a task is actively RUNNING; rejected while parked/awaiting-answer — use enqueue to answer) — needs { loopId, message }\n- "stop": halt promptly — needs { loopId }\nNotifications: routine task completions are SILENT (logged, no phone push); the manager buzzes the phone only when it NEEDS YOUR ANSWER (urgent, stays alive) or is FULLY FINISHED; a terminal BLOCKED emits an urgent escalation (see README "Completion events").`,
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
