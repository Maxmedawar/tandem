/**
 * hub-rpc.ts: a request frame from the hub becomes a route() call in
 * ./router.ts, and the router's result becomes the response frame.
 *
 * The body is base64, then UTF-8, then JSON; no body or bad JSON is `{}`, and any
 * other parsed value goes to route() unchanged so its statuses hold. Hub headers
 * are ignored: none grants or changes anything. A router throw answers 500
 * `internal_error`; its message goes to stderr only. A response frame over the
 * link cap is answered 413 `payload_too_large` instead of being sent. The agent filter and
 * the read log lines live in route(), so hub calls and local MCP calls get the same ones.
 *
 * A path starting `/fabric/` goes to the fabric router instead, with the frame's
 * `trusted_surface` marker (only the hub's /__fabric-rpc route sets it; without it the
 * answer is 403) and this process's fabric store, if one is open (none: 503).
 *
 * A path starting `/transcripts/` goes to this process's own transcript search
 * (./transcripts/search.ts, opened on first use): POST `/transcripts/search` and
 * `/transcripts/get` with an object body answer its status and body; any other method or
 * path there is 404, any other body 400.
 *
 * The path `/usage` is the `usage` tool asked at the hub (U-R1A-52): POST with no body or
 * `{ refresh?: boolean }` answers this process's usage report (./usage/report.ts, made on first
 * use); any other method is 404, any other body 400.
 *
 * The path `/remote/command` is a signed command from another computer (U-R1A-36B): POST goes to
 * ./remote-command.ts handleRemoteCommand with the parsed body (it decides by the envelope's
 * signature and this computer's control_from, never by a hub header); any other method there is 404.
 *
 * fabricForward is the other direction, for a computer with no store: its local MCP
 * servers pass each fabric call over HTTPS to the hub's link route, and the hub sends it
 * to the memory home. HTTPS, not a frame: the stdio server has no link socket.
 *
 * Signed memory answers (U-R1A-31C-1; the hub never vouches): each forwarded call carries a fresh
 * `tandem-memory-challenge`; the home signs its answer with its device key over ANSWER_TEXT
 * (memoryAnswerText: the challenge, the call's method, path and input, the answer's status and
 * exact body bytes) in `tandem-memory-answer: v1 <id> <key> <sig>`; the caller takes the answer
 * only when that id and key are one entry of its OWN verified roster. Unsigned, it takes only the
 * hub's own error bodies, which carry no memory data.
 */
import { createHash, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { openDeviceKey, verifySignature, type DeviceKey } from './device-keys.ts'
import { routeFabricRpc } from './fabric/rpc-router.ts'
import type { LocalFabricHost } from './fabric/local-fabric-host.ts'
import { deriveBridgeId, hubProofHeader, MAX_FRAME_BYTES } from './hub-link.ts'
import { handleRemoteCommand } from './remote-command.ts'
import { readRoster } from './roster.ts'
import { route } from './router.ts'
import type { TranscriptSearch } from './transcripts/search.ts'
import type { UsageReport } from './usage/report.ts'
import { CCM_FRAME_TYPES, type CcmHttpRequestFrame, type CcmHttpResponseFrame } from '../hub/src/protocol.ts'
import { PROOF_HEADER } from '../hub/src/devices.ts'

function parseBody(base64: string | undefined): unknown {
  if (!base64) return {}
  try {
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))
  } catch {
    return {}
  }
}

/** `sign` gives the extra headers for the exact status and body bytes sent (a signed memory answer). */
function response(requestId: string, status: number, body: unknown, sign?: (status: number, bytes: Buffer) => Record<string, string[]>): CcmHttpResponseFrame {
  const bytes = Buffer.from(JSON.stringify(body ?? null), 'utf8')
  const frame: CcmHttpResponseFrame = {
    type: CCM_FRAME_TYPES.httpResponse,
    request_id: requestId,
    status_code: status,
    headers: { 'content-type': ['application/json'], ...sign?.(status, bytes) },
    body_base64: bytes.toString('base64'),
  }
  // The link cap holds in this direction too: a frame over it can cost the bridge its socket.
  if (status !== 413 && Buffer.byteLength(JSON.stringify(frame), 'utf8') > MAX_FRAME_BYTES) {
    return response(requestId, 413, { error: 'payload_too_large' }, sign)
  }
  return frame
}

export const MEMORY_CHALLENGE_HEADER = 'tandem-memory-challenge'
export const MEMORY_ANSWER_HEADER = 'tandem-memory-answer'
const CHALLENGE = /^[A-Za-z0-9_-]{22}$/
const ANSWER = /^v1 ([a-z0-9._-]{1,64}) ([A-Za-z0-9_-]{43}) ([A-Za-z0-9_-]{86})$/
const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

/** The text a memory home signs for one answer. Its first line is used by no proof, roster, offer or envelope. */
export function memoryAnswerText(a: { id: string; key: string; challenge: string; method: string; path: string; input: unknown; status: number; body: Uint8Array }): string {
  return ['tandem-memory-answer-v1', a.id, a.key, a.challenge, a.method, a.path, sha256Hex(JSON.stringify(a.input ?? null)), String(a.status), sha256Hex(a.body)].join('\n')
}

/** `body.input` when `body` is an object, else undefined. */
const inputOf = (body: unknown): unknown => (typeof body === 'object' && body !== null ? (body as { input?: unknown }).input : undefined)

/** A link URL's origin as HTTP: `wss://` becomes `https://`, `ws://` becomes `http://`; nothing else changes. */
export function hubHttpOrigin(wsOrigin: string): string {
  return wsOrigin.replace(/^ws(s?):\/\//, 'http$1://')
}

export interface FabricForward {
  forward(path: string, body: unknown): Promise<unknown>
}

const HUB_UNREACHABLE = Object.freeze({
  error: 'memory_home_offline',
  message: 'memory home offline: this computer cannot reach the hub',
})

const UNVERIFIED = Object.freeze({
  error: 'memory_home_unverified',
  message: 'memory home unverified: the answer was not signed by a computer in this roster',
})

/**
 * The hub's own answers, each under the one status the hub gives it: the only ones taken unsigned.
 * None carries text from outside this computer: five are fixed, and the conflict answer may name
 * only computers of this computer's own roster, in the hub's exact sentence (isHubConflict).
 */
const HUB_BODIES: readonly { status: number; body: Record<string, string> }[] = [
  { status: 503, body: { error: 'memory_home_offline', message: 'memory home offline: the computer that holds memory is not connected to the hub' } },
  {
    status: 503,
    body: {
      error: 'memory_home_not_in_roster',
      message: 'memory home not in roster: the computer that holds memory is not in the roster the hub holds; trust it from a computer in the roster',
    },
  },
  { status: 504, body: { error: 'gateway_timeout' } },
  { status: 413, body: { error: 'payload_too_large' } },
  { status: 400, body: { error: 'fabric_request_invalid' } },
]

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The hub's 409 for two or more memory homes: ids of `members` only, sorted, each once, and the hub's sentence. */
function isHubConflict(body: Record<string, unknown>, members: { id: string }[] | undefined): boolean {
  const machines = body.machines
  if (body.error !== 'memory_home_conflict' || !Array.isArray(machines) || machines.length < 2 || !members) return false
  if (!machines.every((m, i) => typeof m === 'string' && members.some((member) => member.id === m) && (i === 0 || machines[i - 1] < m))) return false
  return body.message === `more than one computer holds a memory store (${machines.join(', ')}); turn the store off on all but one`
}

function isHubBody(status: number, body: unknown, members: { id: string }[] | undefined): boolean {
  if (!isPlain(body)) return false
  const keys = Object.keys(body).sort().join()
  if (keys === 'error,machines,message') return status === 409 && isHubConflict(body, members)
  return HUB_BODIES.some((hub) => hub.status === status && Object.keys(hub.body).sort().join() === keys && Object.keys(hub.body).every((k) => body[k] === hub.body[k]))
}

/** This computer's own verified roster as { id, key }, read at each call; undefined when there is none or it is refused. */
function rosterMembers(): { id: string; key: string }[] | undefined {
  return readRoster()?.map((e) => ({ id: e.id, key: e.key }))
}

/**
 * POSTs `body` to `<hub>/__tunnel/fabric-rpc<path>` with the link token as bearer, a
 * `tandem-proof` over the exact bytes sent (id `bridgeId`, else this computer's link id; key
 * `key`, else this computer's device key) and a fresh `tandem-memory-challenge`. An answer signed
 * over that challenge by a computer in `trusted()` (default: this computer's verified roster,
 * read at each call; a throw counts as none) is taken: its JSON whatever the status, a non-JSON
 * one `fabric_unavailable`. Unsigned, only one of the hub's own error bodies under the hub's own
 * status is taken (a conflict only when it names computers of that roster); anything else is
 * memory_home_unverified. No answer (network error, 120 s) or
 * no usable device key is memory_home_offline. The token is only ever in the header.
 */
export function fabricForward(config: {
  url: string
  token: string
  bridgeId?: string
  key?: DeviceKey
  trusted?: () => { id: string; key: string }[] | undefined
}): FabricForward {
  const base = `${hubHttpOrigin(config.url)}/__tunnel/fabric-rpc`
  const trusted = config.trusted ?? rosterMembers
  return {
    async forward(path, body) {
      const challenge = randomBytes(16).toString('base64url')
      let status: number
      let answerHeader: string | null
      let bytes: Buffer
      try {
        const target = `${base}${path}`
        const sent = JSON.stringify(body)
        const proof = hubProofHeader(config.key ?? openDeviceKey(), {
          url: config.url,
          method: 'POST',
          path: new URL(target).pathname,
          id: config.bridgeId ?? deriveBridgeId(process.env.TANDEM_HUB_LINK_ID, hostname()),
          body: sent,
        })
        const answer = await fetch(target, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.token}`, 'content-type': 'application/json', [PROOF_HEADER]: proof, [MEMORY_CHALLENGE_HEADER]: challenge,
          },
          body: sent,
          signal: AbortSignal.timeout(120_000),
        })
        status = answer.status
        answerHeader = answer.headers.get(MEMORY_ANSWER_HEADER)
        bytes = Buffer.from(await answer.arrayBuffer())
      } catch {
        return { ...HUB_UNREACHABLE }
      }
      let parsed: unknown
      let json = true
      try {
        parsed = JSON.parse(bytes.toString('utf8'))
      } catch {
        json = false
      }
      let members: { id: string; key: string }[] | undefined
      try {
        members = trusted()
      } catch {
        members = undefined
      }
      const signed = ANSWER.exec(answerHeader ?? '')
      if (signed) {
        const [, id, key, sig] = signed
        const text = memoryAnswerText({ id, key, challenge, method: 'POST', path, input: inputOf(body), status, body: bytes })
        if (members?.some((m) => m.id === id && m.key === key) && verifySignature(key, text, sig)) {
          return json ? parsed : { error: 'fabric_unavailable' }
        }
      }
      return json && isHubBody(status, parsed, members) ? parsed : { ...UNVERIFIED }
    },
  }
}

/** Who signs this computer's memory answers: its link id and its device key. */
export interface MemoryHomeSigner {
  id: string
  key: Pick<DeviceKey, 'publicKey' | 'sign'>
}

/** The `tandem-memory-answer` header for one answer, or none (no usable key: the caller refuses it). */
function signAnswer(frame: CcmHttpRequestFrame, challenge: string, input: unknown, home: MemoryHomeSigner | undefined) {
  return (status: number, bytes: Buffer): Record<string, string[]> => {
    let signer: MemoryHomeSigner
    try {
      signer = home ?? { id: deriveBridgeId(process.env.TANDEM_HUB_LINK_ID, hostname()), key: openDeviceKey() }
    } catch {
      return {}
    }
    const text = memoryAnswerText({
      id: signer.id, key: signer.key.publicKey, challenge, method: frame.method.toUpperCase(), path: frame.path, input, status, body: bytes,
    })
    return { [MEMORY_ANSWER_HEADER]: [`v1 ${signer.id} ${signer.key.publicKey} ${signer.key.sign(text)}`] }
  }
}

let transcripts: Promise<TranscriptSearch> | undefined

async function transcriptRequest(frame: CcmHttpRequestFrame): Promise<CcmHttpResponseFrame> {
  const action = frame.path === '/transcripts/search' ? 'search' : frame.path === '/transcripts/get' ? 'get' : undefined
  if (!action || frame.method.toUpperCase() !== 'POST') return response(frame.request_id, 404, { error: 'not found' })
  let body: unknown = null
  if (frame.body_base64) {
    try {
      body = JSON.parse(Buffer.from(frame.body_base64, 'base64').toString('utf8'))
    } catch {
      body = null
    }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return response(frame.request_id, 400, { error: 'body: must be an object' })
  try {
    transcripts ??= import('./transcripts/search.ts').then((m) => m.openTranscriptSearch())
    const search = await transcripts
    const result = action === 'search' ? await search.search(body) : await search.get(body)
    return response(frame.request_id, result.status, result.body)
  } catch {
    transcripts = undefined
    return response(frame.request_id, 500, { error: 'search unavailable' })
  }
}

let report: Promise<UsageReport> | undefined

async function usageRequest(frame: CcmHttpRequestFrame): Promise<CcmHttpResponseFrame> {
  if (frame.method.toUpperCase() !== 'POST') return response(frame.request_id, 404, { error: 'not found' })
  let body: unknown = {}
  if (frame.body_base64) {
    try {
      body = JSON.parse(Buffer.from(frame.body_base64, 'base64').toString('utf8'))
    } catch {
      body = null
    }
  }
  const ok = typeof body === 'object' && body !== null && !Array.isArray(body) &&
    Object.keys(body).every((k) => k === 'refresh') && ['undefined', 'boolean'].includes(typeof (body as { refresh?: unknown }).refresh)
  if (!ok) return response(frame.request_id, 400, { error: 'body: only refresh (true or false)' })
  try {
    report ??= import('./usage/report.ts').then((m) => m.createUsageReport())
    return response(frame.request_id, 200, await (await report).read({ refresh: (body as { refresh?: boolean }).refresh }))
  } catch {
    report = undefined
    process.stderr.write('hub-rpc: usage report failed\n')
    return response(frame.request_id, 500, { error: 'usage unavailable' })
  }
}

/**
 * `home`: who signs a `/fabric/` answer whose request carries a challenge (tests); default this
 * computer's link id and device key, opened at signing time.
 */
export async function handleHubRequest(frame: CcmHttpRequestFrame, fabric?: LocalFabricHost, home?: MemoryHomeSigner): Promise<CcmHttpResponseFrame> {
  if (frame.path.startsWith('/transcripts/')) return transcriptRequest(frame)
  if (frame.path === '/usage') return usageRequest(frame)
  if (frame.path === '/remote/command') {
    if (frame.method.toUpperCase() !== 'POST') return response(frame.request_id, 404, { error: 'not found' })
    try {
      const result = await handleRemoteCommand(parseBody(frame.body_base64))
      return response(frame.request_id, result.status, result.body)
    } catch (error) {
      process.stderr.write(`hub-rpc: remote command failed: ${error instanceof Error ? error.message : String(error)}\n`)
      return response(frame.request_id, 500, { error: 'internal_error' })
    }
  }
  if (frame.path.startsWith('/fabric/')) {
    const body = parseBody(frame.body_base64)
    const challenges = frame.headers?.[MEMORY_CHALLENGE_HEADER]
    const challenge = challenges?.length === 1 && CHALLENGE.test(challenges[0]) ? challenges[0] : undefined
    // A copy taken before the router runs: the signed input is the one the caller sent.
    const sign = challenge === undefined ? undefined : signAnswer(frame, challenge, structuredClone(inputOf(body)), home)
    try {
      const result = await routeFabricRpc({
        trust: frame.trusted_surface,
        client: fabric?.client,
        method: frame.method.toUpperCase(),
        path: frame.path,
        body,
      })
      return response(frame.request_id, result.status, result.body, sign)
    } catch {
      return response(frame.request_id, 503, { error: 'fabric_unavailable' }, sign)
    }
  }
  try {
    const method = frame.method.toUpperCase()
    const query = new URLSearchParams(frame.raw_query ?? '')
    // route() reads the body as an object; any other JSON value passes unchanged (see the file comment).
    const body = parseBody(frame.body_base64) as Record<string, unknown>
    const result = await route({ method, path: frame.path, query, body })
    return response(frame.request_id, result.status, result.body)
  } catch (error) {
    process.stderr.write(`hub-rpc: router failed: ${error instanceof Error ? error.message : String(error)}\n`)
    return response(frame.request_id, 500, { error: 'internal_error' })
  }
}
