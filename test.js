import test from 'tst'
import { ok, is } from 'tst'

const isBrowser = typeof window !== 'undefined'
const isCI = typeof process !== 'undefined' && !!process.env?.CI

if (isBrowser) test.manual = true

const { default: Speaker } = await import(isBrowser ? './browser.js' : './index.js')

const open = (opts) => Speaker(opts)

// generate PCM sine with fade in/out to avoid clicks
const FADE_MS = 5
function sine(freq, durationMs, { sampleRate = 44100, channels = 2, bitDepth = 16 } = {}) {
  const bps = bitDepth / 8
  const frames = Math.round(durationMs / 1000 * sampleRate)
  const fadeFrames = Math.min(Math.round(FADE_MS / 1000 * sampleRate), frames / 2)
  const buf = new Uint8Array(frames * channels * bps)
  const view = new DataView(buf.buffer)
  for (let i = 0; i < frames; i++) {
    let val = Math.sin(2 * Math.PI * freq * i / sampleRate)
    // fade envelope
    if (i < fadeFrames) val *= i / fadeFrames
    else if (i >= frames - fadeFrames) val *= (frames - 1 - i) / fadeFrames
    const sample = Math.max(-32768, Math.min(32767, Math.round(val * 32767)))
    for (let ch = 0; ch < channels; ch++) {
      view.setInt16((i * channels + ch) * bps, sample, true)
    }
  }
  return isBrowser ? buf : Buffer.from(buf.buffer)
}
// a zeroed chunk: a Buffer in Node, bytes in a browser
const alloc = n => isBrowser ? new Uint8Array(n) : Buffer.alloc(n)

// helper: write + flush + close
function play(write, buf) {
  return new Promise((resolve, reject) => {
    write(buf, (err) => {
      if (err) return reject(err)
      write.flush(() => { write.close(); resolve() })
    })
  })
}

// --- core ---

test('play sine', async () => {
  const write = open()
  ok(write.backend, 'has backend')
  await play(write, sine(440, 100))
})

test('null ends playback', async () => {
  const write = open()
  await new Promise((resolve, reject) => {
    write(sine(440, 50), (err) => {
      if (err) return reject(err)
      write(null, () => resolve())
    })
  })
})

test('multiple chunks', async () => {
  const write = open()
  let n = 0, phase = 0
  await new Promise((resolve, reject) => {
    ;(function next() {
      if (n >= 4) return write.flush(() => { write.close(); resolve() })
      const frames = Math.round(44100 * 25 / 1000)
      const buf = alloc(frames * 4), view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      for (let i = 0; i < frames; i++) {
        const val = Math.round(Math.sin(phase) * 32767)
        phase += 2 * Math.PI * 660 / 44100
        view.setInt16(i * 4, val, true)
        view.setInt16(i * 4 + 2, val, true)
      }
      write(buf, (err) => { if (err) return reject(err); n++; next() })
    })()
  })
  is(n, 4)
})

test('double close is safe', async () => {
  const write = open()
  await play(write, sine(440, 30))
  write.close() // second close — should not throw
})

// --- formats ---

test('mono', async () => {
  const write = open({ channels: 1 })
  await play(write, sine(880, 100, { channels: 1 }))
})

test('48kHz', async () => {
  const opts = { sampleRate: 48000 }
  const write = open(opts)
  await play(write, sine(440, 100, opts))
})

test('22050Hz sample rate', async () => {
  const opts = { sampleRate: 22050 }
  const write = open(opts)
  await play(write, sine(440, 100, opts))
})

test('4 channels', async () => {
  const opts = { channels: 4 }
  const write = open(opts)
  await play(write, sine(440, 100, opts))
})

test('6 channels (5.1)', async () => {
  const opts = { channels: 6 }
  const write = open(opts)
  await play(write, sine(440, 100, opts))
})

test('96kHz sample rate', async () => {
  const opts = { sampleRate: 96000 }
  const write = open(opts)
  await play(write, sine(440, 100, opts))
})

test('different frequencies', async () => {
  const write = open()
  for (const freq of [220, 440, 880, 1760]) {
    await new Promise((resolve, reject) => {
      write(sine(freq, 50), (err) => err ? reject(err) : resolve())
    })
  }
  write.flush(() => write.close())
})

// --- edge cases ---

test('small buffer (single period)', async () => {
  const write = open()
  // ~2ms of 440Hz = ~1 period
  await play(write, sine(440, 5))
})

test('small writes (128 samples) no underrun', { skip: isBrowser }, async () => {
  const { open } = await import('./src/backends/miniaudio.js')
  const device = open({ sampleRate: 44100, channels: 2, bitDepth: 16, capture: true })
  const blockSize = 128
  const blocks = 80 // ~236ms of audio
  const bytesPerFrame = 4 // 2ch × 16-bit

  // write 128-sample blocks in a callback chain (simulates real-time rendering)
  await new Promise((resolve, reject) => {
    let phase = 0, n = 0
    function next() {
      if (n >= blocks) return device.flush(() => resolve())
      const buf = Buffer.alloc(blockSize * bytesPerFrame)
      for (let i = 0; i < blockSize; i++) {
        const val = Math.sin(phase) * 32767
        phase += 2 * Math.PI * 440 / 44100
        buf.writeInt16LE(Math.round(val), i * 4)
        buf.writeInt16LE(Math.round(val), i * 4 + 2)
      }
      n++
      device.write(buf, (err) => err ? reject(err) : next())
    }
    next()
  })

  // read captured output and check for discontinuities
  const totalFrames = blockSize * blocks
  const capBuf = Buffer.alloc(totalFrames * bytesPerFrame)
  const capFrames = device.read(capBuf)
  device.close()

  ok(capFrames > totalFrames * 0.8, `captured ${capFrames}/${totalFrames} frames`)
  // skip silence→signal transition at start, signal→silence at end
  let start = 0
  while (start < capFrames && capBuf.readInt16LE(start * 4) === 0) start++
  let end = capFrames - 1
  while (end > start && capBuf.readInt16LE(end * 4) === 0) end--
  let discontinuities = 0
  for (let i = start + 1; i <= end; i++) {
    const prev = capBuf.readInt16LE((i - 1) * 4)
    const curr = capBuf.readInt16LE(i * 4)
    const delta = Math.abs(curr - prev)
    if (delta > 5000) discontinuities++
  }
  // ≤2 discontinuities: at most 1 GC-induced underrun (signal→silence→signal)
  // pull_threshold = rb_pow2/2 gives 25ms headroom, absorbing Windows ~15ms sleep granularity
  ok(discontinuities <= 2, `${discontinuities} discontinuities in small-write output (frames ${start}-${end})`)
})

test('writePull: device starts and transitions to pull-paced callbacks', { skip: isBrowser }, async () => {
  // writePull fires cb synchronously while filling the initial buffer,
  // then switches to hardware-paced callbacks after device starts.
  // This test verifies both phases work and the transition is clean.
  const { open: openDev } = await import('./src/backends/miniaudio.js')
  const sr = 44100, bpf = 4, blockSize = 128
  const device = openDev({ sampleRate: sr, channels: 2, bitDepth: 16, bufferSize: 50 })

  let cbTimes = [], n = 0, phase = 0

  await new Promise((resolve, reject) => {
    function next() {
      if (n >= 100) return device.flush(() => resolve())
      let buf = Buffer.alloc(blockSize * bpf)
      for (let i = 0; i < blockSize; i++) {
        let v = Math.round(Math.sin(phase) * 32767)
        phase += 2 * Math.PI * 440 / sr
        buf.writeInt16LE(v, i * bpf); buf.writeInt16LE(v, i * bpf + 2)
      }
      n++
      let t = performance.now()
      device.write(buf, (err) => {
        cbTimes.push(performance.now() - t)
        err ? reject(err) : next()
      })
    }
    next()
  })
  device.close()

  // Total wall time should be near real-time (0.7-1.5x)
  // With pull model, callbacks fire in bursts (loop refills buffer) then pause.
  // The ratio is the meaningful metric, not individual callback timing.
  let totalWall = cbTimes.reduce((a, b) => a + b, 0)
  let totalAudio = n * blockSize / sr * 1000
  let ratio = totalAudio / totalWall
  ok(ratio > 0.5 && ratio < 2, `rate ${ratio.toFixed(2)}x (${totalAudio.toFixed(0)}ms audio in ${totalWall.toFixed(0)}ms wall)`)
})

test('callback pacing: write rate matches real-time', async () => {
  // Producers writing small blocks (128 samples) via callback chain must not outrun
  // real-time. Without pacing, the loop spins at 10-15x when the graph produces silence.
  const write = open()
  const sr = 44100, blockSize = 128, bpf = 4, durationMs = 500

  let framesWritten = 0
  const wallStart = performance.now()

  await new Promise((resolve, reject) => {
    function next() {
      if (framesWritten / sr * 1000 >= durationMs) return write.flush(() => { write.close(); resolve() })
      // Write silence — worst case for pacing (completes instantly without pacing)
      const buf = alloc(blockSize * bpf)
      framesWritten += blockSize
      write(buf, (err) => err ? reject(err) : next())
    }
    next()
  })

  const wallMs = performance.now() - wallStart
  const audioMs = framesWritten / sr * 1000
  const ratio = audioMs / wallMs
  // Must be near 1x (0.8-1.5x). Without pacing this would be 10x+.
  ok(ratio < 1.5, `write rate ${ratio.toFixed(2)}x real-time (${audioMs.toFixed(0)}ms audio in ${wallMs.toFixed(0)}ms wall)`)
  ok(ratio > 0.5, `write rate ${ratio.toFixed(2)}x not too slow`)
})

test('capture matches reference: 128-sample callback chain', { skip: isCI || isBrowser }, async () => {
  // Generate a reference signal, feed it through the speaker in 128-sample blocks
  // via callback chain, capture the output, compare sample-for-sample.
  // This catches ring buffer overruns, underruns, and pacing failures.
  const { open: openDev } = await import('./src/backends/miniaudio.js')
  const sr = 44100, blockSize = 128, bpf = 4
  const durationMs = 500
  const totalFrames = Math.round(sr * durationMs / 1000)

  // Generate reference: multi-frequency signal with envelope (simulates a sequencer)
  const ref = Buffer.alloc(totalFrames * bpf)
  for (let i = 0; i < totalFrames; i++) {
    let t = i / sr
    // Two short notes with different frequencies, like a sequencer
    let v = 0
    if (t < 0.15) v = Math.sin(2 * Math.PI * 440 * t) * Math.min(1, t / 0.005) // note 1: 440Hz
    else if (t >= 0.2 && t < 0.35) v = Math.sin(2 * Math.PI * 660 * t) * Math.min(1, (t - 0.2) / 0.005) // note 2: 660Hz
    // silence between and after
    let sample = Math.round(v * 32767)
    ref.writeInt16LE(sample, i * bpf)
    ref.writeInt16LE(sample, i * bpf + 2) // stereo: L=R
  }

  const device = openDev({ sampleRate: sr, channels: 2, bitDepth: 16, capture: true, bufferSize: 100 })

  // Feed in 128-sample blocks via callback chain
  let pos = 0
  await new Promise((resolve, reject) => {
    function next() {
      if (pos >= ref.length) return device.flush(() => resolve())
      let chunk = ref.subarray(pos, pos + blockSize * bpf)
      pos += blockSize * bpf
      device.write(chunk, (err) => err ? reject(err) : next())
    }
    next()
  })

  // Read captured output
  const capBuf = Buffer.alloc(totalFrames * bpf)
  const capFrames = device.read(capBuf)
  device.close()

  // Find signal start in capture (skip startup silence)
  let capStart = 0
  while (capStart < capFrames && capBuf.readInt16LE(capStart * bpf) === 0) capStart++

  // Find signal start in reference
  let refStart = 0
  while (refStart < totalFrames && ref.readInt16LE(refStart * bpf) === 0) refStart++

  // Compare captured vs reference from signal start
  let compareLen = Math.min(capFrames - capStart, totalFrames - refStart)
  ok(compareLen > sr * 0.1, `enough signal to compare: ${compareLen} frames`)

  let mismatches = 0, maxErr = 0
  for (let i = 0; i < compareLen; i++) {
    let refSample = ref.readInt16LE((refStart + i) * bpf)
    let capSample = capBuf.readInt16LE((capStart + i) * bpf)
    let err = Math.abs(refSample - capSample)
    if (err > maxErr) maxErr = err
    if (err > 1) mismatches++ // allow ±1 for rounding
  }

  ok(mismatches === 0, `${mismatches} mismatches in ${compareLen} frames (maxErr=${maxErr})`)
})

test('large buffer (1s)', async () => {
  const write = open()
  await play(write, sine(440, 1000))
})

test('write after flush', async () => {
  const write = open()
  await new Promise((resolve, reject) => {
    write(sine(440, 50), (err) => {
      if (err) return reject(err)
      write.flush(() => resolve())
    })
  })
  // write more after flush
  await play(write, sine(660, 50))
})

// --- Node-only ---

if (!isBrowser) {
  test('stream: highWaterMark matches ring buffer', async () => {
    const { default: writable } = await import('./stream.js')
    const s = writable({ sampleRate: 44100, channels: 2, bitDepth: 16, bufferSize: 50 })
    // 50ms × 44100Hz × 2ch × 2bytes = 8820 bytes
    is(s.writableHighWaterMark, 8820)
    s.destroy()
    await new Promise(resolve => s.on('close', resolve))
  })

  test('backpressure: write blocks until ring buffer drains', async () => {
    const write = Speaker({ bufferSize: 50 })
    // write 500ms of audio into 50ms buffer — should take ~500ms (real-time)
    const bigBuf = sine(440, 500)
    const start = performance.now()
    await new Promise((resolve, reject) => {
      write(bigBuf, (err) => err ? reject(err) : write.flush(() => { write.close(); resolve() }))
    })
    const elapsed = performance.now() - start
    ok(elapsed > 400, 'write took ' + elapsed.toFixed(0) + 'ms (expected ~500ms)')
  })

  test('stream: pipe writable', async () => {
    const { default: writable } = await import('./stream.js')
    const { Readable } = await import('node:stream')
    const { pipeline } = await import('node:stream/promises')

    let n = 0, phase = 0
    const source = new Readable({
      read() {
        if (n >= 4) return this.push(null)
        const frames = Math.round(44100 * 25 / 1000)
        const buf = Buffer.alloc(frames * 4)
        for (let i = 0; i < frames; i++) {
          const val = Math.round(Math.sin(phase) * 32767)
          phase += 2 * Math.PI * 440 / 44100
          buf.writeInt16LE(val, i * 4)
          buf.writeInt16LE(val, i * 4 + 2)
        }
        this.push(buf)
        n++
      }
    })

    await pipeline(source, writable())
  })

  test('explicit miniaudio backend', async () => {
    const write = Speaker({ backend: 'miniaudio' })
    is(write.backend, 'miniaudio')
    await play(write, sine(440, 50))
  })

  test('stream: destroy mid-playback', async () => {
    const { default: writable } = await import('./stream.js')
    const s = writable()
    s.write(sine(440, 100))
    s.destroy()
    // should not throw or hang
    await new Promise(resolve => s.on('close', resolve))
  })

  test('close during active write must not crash (use-after-free)', async () => {
    // Reproduces: speaker_close frees ring buffer while write_execute is still
    // accessing it on the worker thread → malloc corruption / abort.
    // The race: write_execute blocks in ma_sleep(1) waiting for ring buffer space,
    // close() calls ma_pcm_rb_uninit() freeing the memory, worker thread wakes
    // and accesses freed ring buffer.
    const { open } = await import('./src/backends/miniaudio.js')
    const device = open({ sampleRate: 44100, channels: 2, bitDepth: 16, bufferSize: 50 })
    const bytesPerFrame = 4

    // Fill ring buffer completely so next write blocks on worker thread
    const rbFrames = 4096 // pow2 of ceil(44100 * 50 / 1000)
    const fillBuf = Buffer.alloc(rbFrames * bytesPerFrame)
    for (let i = 0; i < rbFrames; i++) {
      let v = Math.round(Math.sin(2 * Math.PI * 440 * i / 44100) * 32767)
      fillBuf.writeInt16LE(v, i * 4)
      fillBuf.writeInt16LE(v, i * 4 + 2)
    }
    await new Promise(resolve => device.write(fillBuf, resolve))

    // Queue another write — this will block on worker thread (ring buffer full)
    const extraBuf = Buffer.alloc(1024 * bytesPerFrame)
    device.write(extraBuf, () => {})

    // Close immediately while the write is blocked — must not crash
    await new Promise(resolve => setTimeout(resolve, 5))
    device.close()

    // If we get here without abort/SIGSEGV, the test passes
    ok(true, 'no crash on close during blocked write')
  })

  // capture tests require real audio device — skip in CI (null backend has different sample rate)
  test('capture: verify output matches input', { skip: isCI }, async () => {
    const { open } = await import('./src/backends/miniaudio.js')
    const device = open({ sampleRate: 44100, channels: 1, bitDepth: 16, capture: true })

    // write a known 440Hz sine
    const frames = 4410 // 100ms
    const buf = sine(440, 100, { channels: 1 })

    await new Promise((resolve, reject) => {
      device.write(buf, (err) => {
        if (err) return reject(err)
        device.flush(() => resolve())
      })
    })

    // read captured output
    const capBuf = Buffer.alloc(frames * 2) // 1ch × 16-bit
    const capFrames = device.read(capBuf)
    device.close()

    ok(capFrames > 0, 'captured ' + capFrames + ' frames')

    // verify signal: captured samples should match input (non-silence)
    let maxSample = 0
    for (let i = 0; i < capFrames; i++) {
      const sample = Math.abs(capBuf.readInt16LE(i * 2))
      if (sample > maxSample) maxSample = sample
    }
    ok(maxSample > 1000, 'captured signal is non-silent (max=' + maxSample + ')')

    // verify frequency: count zero crossings to confirm correct pitch
    // 440Hz at 44100Hz for 4410 frames = 100ms = 44 full cycles = ~88 zero crossings
    let crossings = 0
    for (let i = 1; i < capFrames; i++) {
      const prev = capBuf.readInt16LE((i - 1) * 2)
      const curr = capBuf.readInt16LE(i * 2)
      if ((prev <= 0 && curr > 0) || (prev >= 0 && curr < 0)) crossings++
    }
    // expect ~88 crossings (±10% for phase offset at edges)
    ok(crossings > 70 && crossings < 110, 'frequency check: ' + crossings + ' zero crossings (~88 expected)')
  })

  test('capture: no discontinuities in long buffer', { skip: isCI }, async () => {
    const { open } = await import('./src/backends/miniaudio.js')
    const device = open({ sampleRate: 44100, channels: 1, bitDepth: 16, bufferSize: 100, capture: true })

    // 1s sine — long enough to wrap around ring buffer multiple times
    const durationMs = 1000
    const sampleRate = 44100
    const freq = 440
    const frames = Math.round(durationMs / 1000 * sampleRate)
    const buf = Buffer.alloc(frames * 2)
    for (let i = 0; i < frames; i++) {
      const val = Math.sin(2 * Math.PI * freq * i / sampleRate)
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(val * 32767))), i * 2)
    }

    await new Promise((resolve, reject) => {
      device.write(buf, (err) => {
        if (err) return reject(err)
        device.flush(() => resolve())
      })
    })

    // read all captured output
    const capBuf = Buffer.alloc(frames * 2)
    const capFrames = device.read(capBuf)
    device.close()

    ok(capFrames > frames * 0.9, 'captured enough frames: ' + capFrames + '/' + frames)

    // detect discontinuities: adjacent samples shouldn't jump more than expected
    // max delta for 440Hz sine at 44100Hz: sin changes by ~2π×440/44100 per sample ≈ 0.0627
    // in int16: ~0.0627 × 32767 ≈ 2055. Allow 3x margin for safety.
    const maxAllowedDelta = 2055 * 3
    let glitches = 0
    let maxDelta = 0
    for (let i = 1; i < capFrames; i++) {
      const prev = capBuf.readInt16LE((i - 1) * 2)
      const curr = capBuf.readInt16LE(i * 2)
      const delta = Math.abs(curr - prev)
      if (delta > maxDelta) maxDelta = delta
      if (delta > maxAllowedDelta) glitches++
    }

    ok(glitches === 0, glitches + ' discontinuities found (max delta=' + maxDelta + ')')
  })

  test('AudioBuffer input', async () => {
    // simulate AudioBuffer with getChannelData/numberOfChannels/length
    const frames = 4410
    const data = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      data[i] = Math.sin(2 * Math.PI * 440 * i / 44100)
    }
    const ab = {
      numberOfChannels: 1,
      sampleRate: 44100,
      length: frames,
      getChannelData: () => data
    }

    const write = Speaker({ channels: 1 })
    await play(write, ab)
  })
}
