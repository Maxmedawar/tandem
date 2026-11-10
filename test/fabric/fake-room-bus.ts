/**
 * An in-memory stand-in for the embedded bus.
 *
 * It exists to reach the states a real fabricd reaches only under a race or a
 * crash: an acknowledgement lost after the event was stored, a fetch truncated
 * by its byte budget, a retained window that has dropped its oldest events.
 * Those are exactly the states the projection has to survive, so they need to
 * be reachable on purpose rather than waited for.
 *
 * Everything it does that is not a hook matches fabricd, including the part
 * that matters most for reconciliation: one stream per project, with every
 * room's events sharing its sequence space. A double that gave each room its
 * own sequences would make a gap check look exact that is not.
 */
import type {
  BusFetchResult, BusProjectFetchInput, BusProjectInput,
  BusPublishInput, BusPublishResult, BusRoomInfo, RoomBus,
} from '../../src/fabric/bus-contract.ts'

interface StoredEvent {
  readonly sequence: number
  readonly room: string
  readonly payload: string
  readonly publishedAtMs: number
  readonly messageId: string
}

interface Stream {
  events: StoredEvent[]
  nextSequence: number
  /** Sequences dropped from the front, as a retained-window bound would. */
  firstRetained: number
}

export interface FakeRoomBusHooks {
  /**
   * Runs after a sequence is reserved and before the event becomes visible to
   * a fetch. JetStream assigns a sequence when it accepts a message, so an
   * event can hold a lower sequence than one another caller has already read
   * past - the window where a projection can be stepped over.
   */
  beforeVisible?: (input: BusPublishInput, sequence: number) => Promise<void> | void
  /** Runs after an event is stored and before its acknowledgement returns. */
  afterStore?: (input: BusPublishInput, sequence: number) => Promise<void> | void
  /** Throws instead of returning the acknowledgement, leaving it stored. */
  loseAck?: (input: BusPublishInput, sequence: number) => boolean
  /** Caps how many events one fetch returns, as a byte budget would. */
  maxEventsPerFetch?: number
}

export class FakeRoomBus implements RoomBus {
  readonly hooks: FakeRoomBusHooks
  readonly #streams = new Map<string, Stream>()

  constructor(hooks: FakeRoomBusHooks = {}) {
    this.hooks = hooks
  }

  #key(owner: string, project: string): string {
    return JSON.stringify([owner, project])
  }

  #stream(owner: string, project: string): Stream {
    const key = this.#key(owner, project)
    let stream = this.#streams.get(key)
    if (!stream) {
      stream = { events: [], nextSequence: 1, firstRetained: 1 }
      this.#streams.set(key, stream)
    }
    return stream
  }

  /** Drops the oldest retained events, as a byte or age bound would. */
  ageOut(owner: string, project: string, count: number): void {
    const stream = this.#stream(owner, project)
    stream.events = stream.events.slice(count)
    stream.firstRetained = stream.events[0]?.sequence ?? stream.nextSequence
  }

  /** Stores a payload the bridge would never write, to test a hostile log. */
  injectRaw(owner: string, project: string, room: string, payload: string): number {
    const stream = this.#stream(owner, project)
    const sequence = stream.nextSequence
    stream.nextSequence += 1
    stream.events.push({ sequence, room, payload, publishedAtMs: 0, messageId: `raw-${sequence}` })
    return sequence
  }

  async publish(input: BusPublishInput): Promise<BusPublishResult> {
    const stream = this.#stream(input.owner, input.project)
    const existing = stream.events.find(event => event.messageId === input.messageId)
    if (existing) return { sequence: existing.sequence, duplicate: true }

    const sequence = stream.nextSequence
    stream.nextSequence += 1
    await this.hooks.beforeVisible?.(input, sequence)
    stream.events.push({
      sequence, room: input.room, payload: input.payload,
      publishedAtMs: sequence, messageId: input.messageId,
    })
    stream.events.sort((left, right) => left.sequence - right.sequence)

    await this.hooks.afterStore?.(input, sequence)
    if (this.hooks.loseAck?.(input, sequence)) {
      // Stored, but the caller never learns the sequence - the crash window
      // the projection has to be able to close on its own.
      throw new Error('acknowledgement lost')
    }
    return { sequence, duplicate: false }
  }

  async projectFetch(input: BusProjectFetchInput): Promise<BusFetchResult> {
    const stream = this.#stream(input.owner, input.project)
    const after = stream.events.filter(event => event.sequence > input.afterSequence)
    const cap = Math.min(input.limit, this.hooks.maxEventsPerFetch ?? input.limit)
    const events = after.slice(0, cap)
    return {
      events: events.map(event => ({
        sequence: event.sequence, payload: event.payload, publishedAtMs: event.publishedAtMs,
      })),
      lastSequence: events.length > 0 ? events[events.length - 1]!.sequence : input.afterSequence,
    }
  }

  async projectInfo(input: BusProjectInput): Promise<BusRoomInfo> {
    const stream = this.#stream(input.owner, input.project)
    if (stream.events.length === 0) return { firstSequence: 0, lastSequence: 0, messages: 0 }
    return {
      firstSequence: stream.events[0]!.sequence,
      lastSequence: stream.events[stream.events.length - 1]!.sequence,
      messages: stream.events.length,
    }
  }

  /** How many events the log holds for a room, regardless of projection. */
  stored(owner: string, project: string, room: string): number {
    return this.#stream(owner, project).events.filter(event => event.room === room).length
  }
}
