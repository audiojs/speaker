export interface SpeakerOptions {
  sampleRate?: number
  channels?: number
  bitDepth?: 8 | 16 | 24 | 32
  bufferSize?: number
  backend?: 'miniaudio' | 'process' | 'null'
}

export interface WriteFn {
  (chunk: Buffer | Uint8Array | AudioBuffer | null, cb?: (err: Error | null, frames?: number) => void): void
  end(): void
  flush(cb?: () => void): void
  close(): void
  backend: string
}

declare function speaker(opts?: SpeakerOptions): WriteFn

declare namespace speaker {
  /** Consume an async iterable of PCM chunks through the speaker. */
  function from(source: AsyncIterable<Buffer | Uint8Array | AudioBuffer>, opts?: SpeakerOptions): Promise<void>
}

export default speaker
