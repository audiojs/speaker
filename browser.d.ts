export interface BrowserSpeakerOptions {
  sampleRate?: number
  channels?: number
  bitDepth?: 8 | 16 | 32
  /** ms of audio queued ahead before a write's callback waits (default 100) */
  bufferSize?: number
  /** play into this context; default: one shared per sample rate on the page */
  context?: AudioContext
}

export interface WriteFn {
  (chunk: Uint8Array | AudioBuffer | null, cb?: (err: Error | null, frames?: number) => void): void
  end(): void
  flush(cb?: () => void): void
  close(): void
  /** the AudioContext it plays into */
  context: AudioContext
  backend: 'webaudio'
}

declare function Speaker(opts?: BrowserSpeakerOptions): WriteFn

declare namespace Speaker {
  /** Consume an async iterable of PCM chunks through the speaker. */
  function from(source: AsyncIterable<Uint8Array | AudioBuffer>, opts?: BrowserSpeakerOptions): Promise<void>
}

export default Speaker
