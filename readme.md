# @audio/speaker [![test](https://github.com/audiojs/speaker/actions/workflows/test.yml/badge.svg)](https://github.com/audiojs/speaker/actions/workflows/test.yml) [![npm](https://img.shields.io/npm/v/@audio/speaker)](https://npmjs.org/package/@audio/speaker)

Output audio data to speaker in node or browser.

## Usage

```js
import speaker from '@audio/speaker'

let write = speaker({
  sampleRate: 44100,
  channels: 2,
  bitDepth: 16,
  // bufferSize: 50,       // ring buffer ms (default 50)
  // backend: 'miniaudio', // force backend
})

write(pcmBuffer, (err) => {
  // ready for next chunk
})
write(null) // end playback
```

### Async iterable

Consume an async iterable source directly:

```js
import speaker from '@audio/speaker'

await speaker.from(audioSource, { sampleRate: 44100, channels: 2 })
```

### Stream

```js
import SpeakerWritable from '@audio/speaker/stream'

source.pipe(SpeakerWritable({ sampleRate: 44100, channels: 2 }))
```

## Backends

Tried in order; first successful one wins.

| Backend | How | Latency | Install |
|---|---|---|---|
| `miniaudio` | N-API addon wrapping [miniaudio.h](https://github.com/mackron/miniaudio) | Low | Prebuilt via `@audio/speaker-*` packages |
| `process` | Pipes PCM to ffplay/sox/aplay | High | System tool must be installed |
| `null` | Silent, maintains timing contract | — | Built-in (CI/headless fallback) |
| `webaudio` | Web Audio API (browser only) | Low | Built-in |

## API

### `write = speaker(opts?)`

Returns a sink function. Options:

- `sampleRate` — default `44100`
- `channels` — default `2`
- `bitDepth` — `8`, `16` (default), `24`, `32`
- `bufferSize` — ring buffer in ms, default `50`
- `backend` — force a specific backend

### `write(buffer, cb?)`

Write PCM data. Accepts `Buffer`, `Uint8Array`, or `AudioBuffer`. Callback fires when ready for next chunk.

### `write(null)`

End playback. Flushes remaining audio then closes device.

### `write.flush(cb?)`

Wait for buffered audio to finish playing.

### `write.close()`

Immediately close the audio device.

### `write.backend`

Name of the active backend (`'miniaudio'`, `'process'`, `'null'`, `'webaudio'`).

## Building

```sh
npm run build          # compile native addon locally
npm test               # run tests
```

## Publishing

```sh
# JS-only change (no native code changed):
npm version patch && git push && git push --tags
npm publish

# Native code changed — rebuild platform packages:
npm version patch && git push && git push --tags
gh run watch                    # wait for CI
rm -rf artifacts
gh run download --dir artifacts \
  -n speaker-darwin-arm64 -n speaker-darwin-x64 \
  -n speaker-linux-x64 -n speaker-linux-arm64 -n speaker-win32-x64

# (fallback) If darwin-x64 CI is unavailable, cross-compile locally
npx node-gyp@latest rebuild --arch=x64
mkdir -p artifacts/speaker-darwin-x64
cp build/Release/speaker.node artifacts/speaker-darwin-x64/

for pkg in packages/speaker-*/; do
  cp artifacts/$(basename $pkg)/speaker.node $pkg/
  (cd $pkg && npm publish)
done
npm publish
```

## License

MIT

<a href="https://github.com/krishnized/license/">ॐ</a>
