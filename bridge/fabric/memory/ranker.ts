import { cosineSimilarity } from './vector-store.ts'

export interface RankableMemory {
  readonly id: string
  readonly text: string
  readonly importance: number
  readonly updatedAt: string
  readonly lexical: number
  readonly vector?: ArrayLike<number>
}

export function extractEntities(text: string): ReadonlySet<string> {
  const tokens = text.normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) ?? []
  return new Set(tokens.map(value => value.toLocaleLowerCase('en-US')))
}

export function hybridScore(memory: RankableMemory, query: string, queryVector: readonly number[], nowMs: number): number {
  const vector = memory.vector ? Math.max(0, cosineSimilarity(queryVector, memory.vector)) : 0
  const ageDays = Math.max(0, nowMs - Date.parse(memory.updatedAt)) / 86_400_000
  const recency = Math.exp(-ageDays / 180)
  const queryEntities = extractEntities(query)
  const memoryEntities = extractEntities(memory.text)
  let overlap = 0
  for (const entity of queryEntities) if (memoryEntities.has(entity)) overlap++
  const entity = queryEntities.size ? overlap / queryEntities.size : 0
  return memory.lexical * .35 + vector * .35 + memory.importance * .15 + recency * .08 + entity * .07
}

export function normalizeMemoryText(text: string): string {
  return text.normalize('NFKC').trim().replace(/[.?!]+$/u, '').replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}
