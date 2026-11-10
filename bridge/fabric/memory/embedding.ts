import { createHash } from 'node:crypto'

export const DEFAULT_EMBEDDING_DIMENSIONS = 96

/** A deliberately small stable seam. Providers must be local unless a future caller explicitly opts in elsewhere. */
export interface EmbeddingProvider {
  readonly id: string
  readonly dimensions: number
  readonly offline: true
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>
}

const SYNONYMS: Readonly<Record<string, string>> = Object.freeze({
  automobile: 'car', vehicle: 'car', gasoline: 'fuel', petrol: 'fuel', requires: 'need', required: 'need', needs: 'need',
  rotate: 'rotation', rotating: 'rotation', database: 'db', encryption: 'crypto', deploy: 'deployment', region: 'location',
})

/**
 * Feature-hashed token/character-ngram embeddings. This is not a remote model:
 * it is deterministic, dependency-free, bounded, and suitable as the packaged
 * offline baseline behind the provider seam.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'tandem-hash-embedding-v1'
  readonly dimensions = DEFAULT_EMBEDDING_DIMENSIONS
  readonly offline = true as const

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map(text => this.embedOne(text))
  }

  embedOne(text: string): readonly number[] {
    const values = new Float32Array(this.dimensions)
    const normalized = text.normalize('NFKC').toLocaleLowerCase('en-US')
    const words = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []
    const features: string[] = []
    for (const raw of words) {
      const word = SYNONYMS[raw] ?? raw
      features.push(`w:${word}`)
      const padded = `^${word}$`
      for (let i = 0; i + 2 < padded.length; i++) features.push(`c:${padded.slice(i, i + 3)}`)
    }
    for (let i = 0; i + 1 < words.length; i++) features.push(`b:${SYNONYMS[words[i]!] ?? words[i]}_${SYNONYMS[words[i + 1]!] ?? words[i + 1]}`)
    for (const feature of features) {
      const digest = createHash('sha256').update(feature).digest()
      const index = digest.readUInt32LE(0) % this.dimensions
      values[index] += (digest[4]! & 1) === 0 ? 1 : -1
    }
    let norm = 0
    for (const value of values) norm += value * value
    if (norm > 0) { norm = Math.sqrt(norm); for (let i = 0; i < values.length; i++) values[i] /= norm }
    return [...values]
  }
}
