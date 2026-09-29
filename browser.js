/**
 * @module audio-speaker/browser
 *
 * Browser audio output via Web Audio API: one AudioWorklet per speaker, fed the chunks as they are written, so they
 * play back to back without a gap. The page shares one AudioContext per sample rate (or uses the one passed).
 * A write's callback fires once less than `bufferSize` ms waits to play: the next chunk arrives before this one ends.
 */
const WORKLET = `registerProcessor('audio-speaker', class extends AudioWorkletProcessor {
  constructor() {
    super()
    this.q = []; this.o = 0; this.played = 0; this.done = false
    this.port.onmessage = e => { if (e.data === 'close') this.done = true; else this.q.push(e.data) }
  }
  process(i, o) {
    let out = o[0], n = out[0].length, f = 0, told = false
    while (f < n && this.q.length) {
      let c = this.q[0], k = Math.min(n - f, c[0].length - this.o)
      for (let ch = 0; ch < out.length; ch++) out[ch].set(c[Math.min(ch, c.length - 1)].subarray(this.o, this.o + k), f)
      this.o += k; f += k
      if (this.o === c[0].length) { this.q.shift(); this.o = 0; told = true }
    }
    this.played += f
    if (told) this.port.postMessage(this.played)
    return !this.done
  }
})`

const contexts = new Map(), modules = new WeakMap()
let url = null
const shared = rate => {
  let ctx = contexts.get(rate)
  if (!ctx || ctx.state === 'closed') contexts.set(rate, ctx = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' }))
  return ctx
}
const load = ctx => {
  let p = modules.get(ctx)
  if (!p) modules.set(ctx, p = ctx.audioWorklet.addModule(url ??= URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))))
  return p
}

export default function Speaker(opts = {}) {
  const ctx = opts.context || shared(opts.sampleRate || 44100)
  const channels = opts.channels || 2
  const bitDepth = opts.bitDepth || 16
  const ahead = (opts.bufferSize ?? 100) / 1000 * ctx.sampleRate

  let node = null, queued = 0, played = 0, closed = false, waits = [], flushes = []
  const ready = load(ctx).then(() => {
    node = new AudioWorkletNode(ctx, 'audio-speaker', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [channels] })
    node.connect(ctx.destination)
    node.port.onmessage = e => { played = e.data; drain() }
  })
  ready.catch(() => {})

  write.end = () => write.flush(close)
  // after the writes before it have queued (they wait on the same module load)
  write.flush = cb => { ready.then(() => { if (queued <= played) cb?.(); else flushes.push(cb) }, () => cb?.()) }
  write.close = close
  write.context = ctx
  write.backend = 'webaudio'

  return write

  function write(chunk, cb) {
    if (chunk == null) { write.flush(() => { close(); cb?.(null) }); return }
    if (closed) { cb?.(null); return }
    // resume a suspended context (autoplay policy)
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    let data = planar(chunk), frames = data[0].length
    ready.then(() => {
      if (closed) return cb?.(null)
      node.port.postMessage(data, data.map(d => d.buffer))
      queued += frames
      waits.push({ frames, cb })
      drain()
    }, err => cb?.(err))
  }

  // callbacks fire while what waits to play is under the buffer; flushes once it has all played
  function drain() {
    while (waits.length && queued - played <= ahead) { let w = waits.shift(); w.cb?.(null, w.frames) }
    if (flushes.length && played >= queued) for (let f of flushes.splice(0)) f?.()
  }

  function close() {
    if (closed) return
    closed = true
    for (let w of waits.splice(0)) w.cb?.(null, 0)
    for (let f of flushes.splice(0)) f?.()
    ready.then(() => { node.port.postMessage('close'); node.port.onmessage = null; node.disconnect() }, () => {})
  }

  // interleaved PCM bytes (8-bit unsigned, 16-bit int or 32-bit float) or an AudioBuffer → a Float32Array per channel
  function planar(chunk) {
    if (chunk.getChannelData) return Array.from({ length: channels }, (_, c) => chunk.getChannelData(Math.min(c, chunk.numberOfChannels - 1)).slice())
    let bytes = bitDepth / 8, n = (chunk.length / bytes / channels) | 0, view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    return Array.from({ length: channels }, (_, c) => {
      let out = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        let at = (i * channels + c) * bytes
        out[i] = bitDepth === 32 ? view.getFloat32(at, true) : bitDepth === 16 ? view.getInt16(at, true) / 32768 : (view.getUint8(at) - 128) / 128
      }
      return out
    })
  }
}

/**
 * Consume an async iterable of PCM chunks through the speaker.
 * @param {AsyncIterable} source - async iterable yielding PCM buffers
 * @param {object} opts - speaker options (sampleRate, channels, bitDepth, etc.)
 * @returns {Promise<void>} resolves when source is exhausted
 */
Speaker.from = async function(source, opts) {
  const write = Speaker(opts)
  try {
    for await (let chunk of source) {
      await new Promise((resolve, reject) => write(chunk, err => err ? reject(err) : resolve()))
    }
  } finally {
    await new Promise(r => write(null, r))
  }
}
